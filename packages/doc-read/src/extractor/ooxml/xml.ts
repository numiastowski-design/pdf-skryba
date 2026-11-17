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
import { XmlParser } from "../xml/xml-parser";

import { canonicalPrefixOf, MAX_XML_DEPTH, renamed } from "./prefixes";

// Moved to the leaf `prefixes.ts` (our XML reader imports it there, never this module: `xml/import-direction.test.ts`);
// re-exported so the importers of this module do not change.
export { CANONICAL_PREFIX, canonicalPrefixOf, MAX_XML_DEPTH, renamed, type PrefixScope } from "./prefixes";

/** One node of the reader's `preserveOrder` output (built by `xml/tree.ts`): `{ [tag]: children,
 *  ":@": attributes }`, or `{ "#text": value }` for character data. */
export type XNode = Record<string, unknown>;

// There is NO bound on entity references (a `MAX_ENTITY_REFERENCES` of 16 M was removed on 26/10/2026, on review): our
// reader cannot expand any entity. It refuses every entity but the five predefined (`xml/tokenizer.ts`) and every `<!`
// but CDATA, and a character reference is one code point, so no reference ever yields more text than it spells
// ("billion laughs" needs a declared entity). A part full of `&lt;` is read whole, bounded by the part ceiling
// (`package.ts#PART_MAX_BYTES`). Each DTD is refused as well (`DECLARES_DTD`).

// The options are the call shape the reader accepts (`xml/xml-parser.ts`).
// preserveOrder keeps sibling order across different tags — a run, then a hyperlink, then a run — which a tag-grouped
// shape would lose.
// parseTagValue: false, or a `<w:t>2</w:t>` would come back as the NUMBER 2.

const xmlParser = new XmlParser({
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
 *  we have no use for one, and a DTD is how a part would declare entities that expand (review of
 *  27/09/2026 night, finding 8). Matched on the DECODED text (see `parseXml`): a `<!DOCTYPE`
 *  inside a comment is refused too — ugly and visible, never a document
 *  that expands in silence. */
const DECLARES_DTD = /<!DOCTYPE/i;

const ATTRIBUTES_KEY = ":@";

export const qualifiedNameOf = (node: XNode): string | undefined =>
  Object.keys(node).find((key) => key !== ATTRIBUTES_KEY);

export const childNodesOf = (node: XNode): XNode[] => {
  const tag = qualifiedNameOf(node);
  if (tag === undefined) return [];
  const value = node[tag];
  return Array.isArray(value) ? (value as XNode[]) : [];
};

export const attributesOf = (node: XNode): Record<string, string> =>
  (node[ATTRIBUTES_KEY] as Record<string, string> | undefined) ?? {};

export const attributeOf = (node: XNode, name: string): string | undefined => attributesOf(node)[name];

export const findChild = (node: XNode, tag: string): XNode | undefined =>
  childNodesOf(node).find((kid) => qualifiedNameOf(kid) === tag);

export const findChildren = (node: XNode, tag: string): XNode[] =>
  childNodesOf(node).filter((kid) => qualifiedNameOf(kid) === tag);

/** Every descendant tagged `tag`, in document order; a match is not searched inside. */
export const findDescendants = (node: XNode, tag: string, found: XNode[] = []): XNode[] => {
  for (const kid of childNodesOf(node)) {
    if (qualifiedNameOf(kid) === tag) found.push(kid);
    else findDescendants(kid, tag, found);
  }
  return found;
};

/** The frame of a `w:drawing`: its `wp:inline`, else its `wp:anchor`. */
export const findDrawingFrame = (drawing: XNode): XNode | undefined =>
  findChild(drawing, "wp:inline") ?? findChild(drawing, "wp:anchor");

/** The `a:graphic/a:graphicData` of a drawing's frame. */
export const findGraphicData = (frame: XNode): XNode | undefined =>
  findChild(findChild(frame, "a:graphic") ?? {}, "a:graphicData");

/** Whether `predicate` holds for the node ITSELF or for any element below it (depth first, the node first, stopping at the first yes). */
export const hasMatchingNode = (node: XNode, predicate: (node: XNode) => boolean): boolean =>
  predicate(node) || childNodesOf(node).some((kid) => hasMatchingNode(kid, predicate));

/** The `w:val` of the child tagged `tag` (undefined when the parent or the child is missing). */
export const valOfChild = (parent: XNode | undefined, tag: string): string | undefined => {
  const childElement = parent ? findChild(parent, tag) : undefined;
  return childElement ? attributeOf(childElement, "w:val") : undefined;
};

/** The concatenated character data directly under this element. */
export const textContentOf = (node: XNode): string =>
  childNodesOf(node)
    .map((kid) => (typeof kid["#text"] === "string" ? kid["#text"] : ""))
    .join("");

/**
 * `mc:Choice`'s `Requires` names namespaces by PREFIX, bound on some
 * ancestor the canonical tree no longer carries. Its value is rewritten here,
 * where the scope is known: each prefix becomes its namespace's canonical
 * prefix, or `?<prefix>` for a namespace the reader does not know or a prefix
 * nothing binds — never mistaken for one it knows (review of 27/09/2026
 * night, finding 12; `objects.ts#chosenContent` reads it).
 */
const canonicalizeRequires = (value: string, scope: ReadonlyMap<string, string>): string =>
  value
    .split(/\s+/)
    .filter((prefix) => prefix.length > 0)
    .map((prefix) => {
      const uri = scope.get(prefix);
      return (uri === undefined ? undefined : canonicalPrefixOf(uri)) ?? `?${prefix}`;
    })
    .join(" ");

/** The scope in force inside an element: `scope` plus the namespaces its own `xmlns` attributes declare (`scope` itself when none). */
const withNamespaceDeclarations = (
  attributeEntries: readonly (readonly [string, string])[],
  scope: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> => {
  let innerScope: Map<string, string> | undefined;
  for (const [name, value] of attributeEntries) {
    if (name !== "xmlns" && !name.startsWith("xmlns:")) continue;
    innerScope ??= new Map(scope);
    innerScope.set(name === "xmlns" ? "" : name.slice("xmlns:".length), value);
  }
  return innerScope ?? scope;
};

const canonicalizeAttributes = (
  attributeEntries: readonly (readonly [string, string])[],
  canonicalTag: string,
  scope: ReadonlyMap<string, string>,
): Record<string, string> =>
  Object.fromEntries(
    attributeEntries.map(([name, value]) => [
      renamed(name, scope, true),
      canonicalTag === "mc:Choice" && name === "Requires" ? canonicalizeRequires(value, scope) : value,
    ]),
  );

const canonicalize = (nodes: readonly XNode[], scope: ReadonlyMap<string, string>): XNode[] =>
  nodes.flatMap((node): XNode[] => {
    if ("#text" in node) return [node];
    const tag = qualifiedNameOf(node);
    if (tag === undefined) return [];
    const attributeEntries = Object.entries(attributesOf(node));
    const innerScope = withNamespaceDeclarations(attributeEntries, scope);
    const canonicalTag = renamed(tag, innerScope, false);
    const canonicalNode: XNode = { [canonicalTag]: canonicalize(childNodesOf(node), innerScope) };
    if (attributeEntries.length > 0)
      canonicalNode[ATTRIBUTES_KEY] = canonicalizeAttributes(attributeEntries, canonicalTag, innerScope);
    return [canonicalNode];
  });

/** The part's root element, or `undefined` when the text holds none. Throws
 *  on a DTD, or on what the parser refuses (nesting past `MAX_XML_DEPTH`,
 *  malformed XML, any entity but the five predefined): the package layer turns every throw into
 *  the format's own « damaged » message. */
export const parseXml = (input: string | Uint8Array): XNode | undefined => {
  // A part's bytes are decoded ONCE, here: the DTD guard tests that DECODED text (a UTF-16 part has no ASCII `<!DOCTYPE`
  // in its bytes) and the reader gets the same text with the encoding found, so it neither decodes nor guesses again.
  // Bare text (tests) is guessed by the reader.
  const { text, encoding } = typeof input === "string" ? { text: input, encoding: undefined } : decodeXmlPart(input);
  if (DECLARES_DTD.test(text)) throw new Error("docx-reader: a DTD declaration (forbidden by OPC)");
  const nodes = canonicalize(
    encoding === undefined ? xmlParser.parse(text) : xmlParser.parse(text, encoding),
    new Map(),
  );
  return nodes.find((node) => qualifiedNameOf(node) !== undefined && !("#text" in node));
};
