/** A docx, pptx or xlsx part parsed into an ORDERED element tree whose names are
 *  canonical: whatever prefix a producer bound to a namespace, the reader sees
 *  `w:`, `p:`, `r:`, `wp:`, `a:`, `pic:`, `wps:`, `wpg:`, `mc:`, `m:`, `v:`, `c:`, and also `dgm:`/`dsp:` (SmartArt),
 *  `rel:`, `ct:`, `xdr:` and the empty prefix of spreadsheetml.
 *  NOT here: what any element means (`docx-reader/body.ts` and its siblings),
 *  nor where a part lives in the archive (`ooxml/package.ts`).
 *  Called by: `ooxml/package.ts`, and every docx-reader and
 *  pptx-reader module that walks a tree. */

/* eslint-disable sonarjs/no-clear-text-protocols -- the http:// strings are OOXML namespace URIs, matched byte for byte; nothing is ever fetched from them */
import { decodeXmlPart } from "../xml/decode";
import { XMLParser } from "../xml/xml-parser";

import { canonicalPrefixOf, MAX_XML_DEPTH, renamed } from "./prefixes";

// Moved to the leaf `prefixes.ts` (our XML reader imports it there, never this module: `xml/import-direction.test.ts`);
// re-exported so the importers of this module do not change.
export { CANONICAL_PREFIX, canonicalPrefixOf, MAX_XML_DEPTH, renamed, type PrefixScope } from "./prefixes";

/** One node of the reader's `preserveOrder` output (the shape fast-xml-parser gave, kept by `xml/tree.ts`): `{ [tag]: children,
 *  ":@": attributes }`, or `{ "#text": value }` for character data. */
export type XNode = Record<string, unknown>;

// There is NO bound on entity references any more (it was `MAX_ENTITY_REFERENCES`, 16 M, removed 26/10/2026 on review).
// fast-xml-parser expanded entities, so it counted them; our reader cannot expand any: it refuses every entity but the
// five predefined (`xml/tokenizer.ts`) and every `<!` but CDATA, and a character reference is one code point, so no
// reference ever yields more text than it spells ("billion laughs" needs a declared entity). A part with 16 M `&lt;`
// is read whole, bounded by the part ceiling (`package.ts#PART_MAX_BYTES`). Each DTD is refused as well (`DECLARES_DTD`).

// preserveOrder keeps sibling order across different tags — a run, then a
// hyperlink, then a run — which the default tag-grouped shape loses.
// parseTagValue: false, or a `<w:t>2</w:t>` would come back as the NUMBER 2.
// htmlEntities: true, or numeric character references (`&#233;`) stay
// undecoded: fast-xml-parser 5 only decodes the five predefined XML entities
// without it.

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  htmlEntities: true,
  maxNestedTags: MAX_XML_DEPTH,
});

/** A DTD is refused in every part. ECMA-376 Part 2 (OPC) forbids DTD
 *  declarations in the PACKAGE's own XML parts (content types, relationships,
 *  properties, signatures; 4th edition [M1.18]: « treat … as an error »);
 *  Part 1 says nothing for the format's parts. Refused everywhere for safety:
 *  no producer writes one, and a DTD is how a part would declare entities that expand (review of
 *  27/09/2026 night, finding 8). Matched on the raw text: a `<!DOCTYPE`
 *  inside a comment is refused too — ugly and visible, never a document
 *  that expands in silence. */
const DECLARES_DTD = /<!DOCTYPE/i;


const ATTRS = ":@";

export const tagOf = (node: XNode): string | undefined => Object.keys(node).find((k) => k !== ATTRS);

export const kids = (node: XNode): XNode[] => {
  const tag = tagOf(node);
  if (tag === undefined) return [];
  const value = node[tag];
  return Array.isArray(value) ? (value as XNode[]) : [];
};

export const attrs = (node: XNode): Record<string, string> => (node[ATTRS] as Record<string, string> | undefined) ?? {};

export const attr = (node: XNode, name: string): string | undefined => attrs(node)[name];

export const child = (node: XNode, tag: string): XNode | undefined => kids(node).find((c) => tagOf(c) === tag);

export const children = (node: XNode, tag: string): XNode[] => kids(node).filter((c) => tagOf(c) === tag);

/** Every descendant tagged `tag`, in document order; a match is not searched inside. */
export const descendants = (node: XNode, tag: string, out: XNode[] = []): XNode[] => {
  for (const k of kids(node)) {
    if (tagOf(k) === tag) out.push(k);
    else descendants(k, tag, out);
  }
  return out;
};

/** The frame of a `w:drawing`: its `wp:inline`, else its `wp:anchor`. */
export const drawingFrame = (drawing: XNode): XNode | undefined => child(drawing, "wp:inline") ?? child(drawing, "wp:anchor");

/** The `a:graphic/a:graphicData` of a drawing's frame. */
export const graphicData = (frame: XNode): XNode | undefined => child(child(frame, "a:graphic") ?? {}, "a:graphicData");

/** Whether `pred` holds for the node ITSELF or for any element below it (depth first, the node first, stopping at the first yes). */
export const someDescendant = (node: XNode, pred: (node: XNode) => boolean): boolean => pred(node) || kids(node).some((k) => someDescendant(k, pred));

/** The `w:val` of the child tagged `tag` (undefined when the parent or the child is missing). */
export const valOf = (parent: XNode | undefined, tag: string): string | undefined => {
  const el = parent ? child(parent, tag) : undefined;
  return el ? attr(el, "w:val") : undefined;
};

/** The concatenated character data directly under this element. */
export const textOf = (node: XNode): string =>
  kids(node)
    .map((c) => (typeof c["#text"] === "string" ? c["#text"] : ""))
    .join("");


/**
 * `mc:Choice`'s `Requires` names namespaces by PREFIX, bound on some
 * ancestor the canonical tree no longer carries. Its value is rewritten here,
 * where the scope is known: each prefix becomes its namespace's canonical
 * prefix, or `?<prefix>` for a namespace the reader does not know or a prefix
 * nothing binds — never mistaken for one it knows (review of 27/09/2026
 * night, finding 12; `objects.ts#chosenContent` reads it).
 */
const canonicalRequires = (value: string, scope: ReadonlyMap<string, string>): string =>
  value
    .split(/\s+/)
    .filter((prefix) => prefix.length > 0)
    .map((prefix) => {
      const uri = scope.get(prefix);
      return (uri === undefined ? undefined : canonicalPrefixOf(uri)) ?? `?${prefix}`;
    })
    .join(" ");

const canonicalize = (nodes: XNode[], scope: ReadonlyMap<string, string>): XNode[] =>
  nodes.flatMap((node): XNode[] => {
    if ("#text" in node) return [node];
    const tag = tagOf(node);
    // The `<?xml ...?>` declaration comes back as a node of its own.
    if (tag === undefined || tag.startsWith("?")) return [];
    const own = attrs(node);
    let inner = scope;
    for (const [name, value] of Object.entries(own)) {
      if (name === "xmlns" || name.startsWith("xmlns:")) {
        if (inner === scope) inner = new Map(scope);
        (inner as Map<string, string>).set(name === "xmlns" ? "" : name.slice(6), value);
      }
    }
    const canonicalTag = renamed(tag, inner, false);
    const out: XNode = { [canonicalTag]: canonicalize(kids(node), inner) };
    const entries = Object.entries(own);
    if (entries.length > 0) {
      out[ATTRS] = Object.fromEntries(
        entries.map(([name, value]) => [
          renamed(name, inner, true),
          canonicalTag === "mc:Choice" && name === "Requires" ? canonicalRequires(value, inner) : value,
        ]),
      );
    }
    return [out];
  });

/** The part's root element, or `undefined` when the text holds none. Throws
 *  on a DTD, or on what the parser refuses (nesting past `MAX_XML_DEPTH`,
 *  malformed XML, any entity but the five predefined): the package layer turns every throw into
 *  the format's own « damaged » message. */
export const parseXml = (input: string | Uint8Array): XNode | undefined => {
  // A part's bytes are decoded ONCE, here: the DTD guard reads that text (UTF-16 shows no ASCII `<!DOCTYPE` in its bytes) and
  // the reader gets the same text with the encoding found, so it neither decodes nor guesses again. Bare text (tests) is
  // guessed by the reader.
  const { text, encoding } = typeof input === "string" ? { text: input, encoding: undefined } : decodeXmlPart(input);
  if (DECLARES_DTD.test(text)) throw new Error("docx-reader: a DTD declaration (forbidden by OPC)");
  const nodes = canonicalize((encoding === undefined ? parser.parse(text) : parser.parse(text, encoding)) as XNode[], new Map());
  return nodes.find((n) => tagOf(n) !== undefined && !("#text" in n));
};
