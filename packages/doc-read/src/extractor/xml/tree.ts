/** The tree our own XML reader hands to the readers (detachment of
 *  fast-xml-parser, `d2c-propositions/xml/plan.md`, tranche 3): the exact
 *  `preserveOrder` shape `ooxml/xml.ts` and `pipeline/xlsx-page-cells.ts`
 *  walk, built from the tokenizer's events, with the structure checked: tags
 *  matched, one root for an Office part (document), several for storage
 *  XHTML (fragment).
 *  Guards (tranche 4): the nesting depth, where fast-xml-parser puts it, and
 *  the nodes one part may allocate, each checked BEFORE the node exists.
 *  Namespaces (tranche 5): in document mode, each element goes through
 *  `namespaces.ts` before it exists.
 *  NOT here: the lexical rules, the encoding and the attributes of one tag
 *  (`tokenizer.ts`, `decode.ts`), the namespace rules themselves
 *  (`namespaces.ts`), the callers' call shape and options (`xml-parser.ts`).
 *  Called by: the tests of `src/extractor/xml/` only (not wired into the product). */

import { MAX_XML_DEPTH } from "../ooxml/prefixes";
import { NamespaceChecker } from "./namespaces";
import { tokenize, xmlRefusal, type XmlSourceEncoding, type XmlTokenVisitor } from "./tokenizer";

/** One node: `{ [name]: children, ":@"?: attributes }`, or `{ "#text": value }`. */
export type XNode = Record<string, unknown>;

/** `document`: an Office part, XML 1.0 §2.1 production [1] (at most one root
 *  element, none read as empty; around it only white space, comments and PIs,
 *  [27] Misc).
 *  `fragment`: storage XHTML (`lib/xml.ts#serializeXml` writes sibling blocks,
 *  no single root). */
export type XmlMode = "document" | "fragment";

const ATTRS = ":@";

/** The most nodes one part's tree may hold: elements, attributes and text nodes together, each counted before it is
 *  allocated; root-level text, comments and PIs are never allocated, never counted. XML 1.0 sets no limit, fast-xml-parser
 *  has none: a refusal of well-formed XML, our own. Starting value to calibrate, two populations measured on 25/10/2026:
 *  real parts reach 6 852 409 nodes (an xlsx sheet of 50 M characters, versioned fixtures) and 3 769 837 (third-party
 *  corpus); a hostile part at the package's ceiling (`ooxml/package.ts#PART_MAX_BYTES`, 64 MB) reaches 16 M with
 *  `<a/>` alone and 25.6 M with `<a/>x`. About 100 bytes of heap per node (esbuild bundle, Node 22): the bound holds a
 *  tree near 1 GB, not 2.6 GB. It does NOT hold one under Forge's 512 MB: the largest real part already costs ~0.9 GB
 *  with fast-xml-parser (finding written in the delivery note of tranche 4). */
export const MAX_XML_NODES = 10_000_000;

/** §2.3 S. */
const isBlank = (value: string): boolean => {
  for (let k = 0; k < value.length; k++) {
    const c = value.charCodeAt(k);
    if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return false;
  }
  return true;
};

interface OpenElement {
  readonly name: string;
  readonly children: XNode[];
}

/** The visitor that builds the tree; an explicit stack of open elements, never recursion. */
class TreeBuilder implements XmlTokenVisitor {
  readonly roots: XNode[] = [];
  private readonly stack: OpenElement[] = [];

  private nodes = 0;
  /** Document mode only: storage XHTML never declares Confluence's `ac:` and `ri:` prefixes. */
  private readonly namespaces: NamespaceChecker | undefined;

  constructor(
    private readonly mode: XmlMode,
    private readonly maxNodes: number,
    private readonly maxDepth: number,
  ) {
    this.namespaces = mode === "document" ? new NamespaceChecker() : undefined;
  }

  /** Counts `more` nodes about to be allocated; refuses before they exist when they would pass the bound. */
  private count(more: number): void {
    this.nodes += more;
    if (this.nodes > this.maxNodes) throw xmlRefusal("more nodes than the limit");
  }

  open(name: string, attributes: readonly (readonly [string, string])[], selfClosing: boolean): void {
    const parent = this.stack.at(-1);
    if (!parent && this.mode === "document" && this.roots.length > 0) throw xmlRefusal("more than one root element");
    // Exactly fast-xml-parser's `maxNestedTags` with the product's options (5.11.2): a start tag is refused when more
    // than `maxDepth` (MAX_XML_DEPTH for an Office part) elements are already open; an empty-element tag is never
    // checked, so it may sit one level further. Both readers refuse the same parts.
    if (!selfClosing && this.stack.length > this.maxDepth) throw xmlRefusal("elements nested past the depth limit");
    this.count(1 + attributes.length);
    this.namespaces?.open(name, attributes, selfClosing);
    const children: XNode[] = [];
    const node: XNode = { [name]: children };
    // The tokenizer refuses a repeated attribute and the names a plain object must not receive as keys.
    if (attributes.length > 0) node[ATTRS] = Object.fromEntries(attributes);
    (parent ? parent.children : this.roots).push(node);
    if (!selfClosing) this.stack.push({ name, children });
  }

  close(name: string): void {
    const top = this.stack.pop();
    if (!top) throw xmlRefusal("end tag without a start tag");
    if (top.name !== name) throw xmlRefusal("end tag does not match its start tag");
    this.namespaces?.close();
  }

  text(value: string): void {
    const top = this.stack.at(-1);
    if (top) {
      this.count(1);
      top.children.push({ "#text": value });
    } else if (this.mode === "document" && !isBlank(value)) throw xmlRefusal("text outside the root element");
  }

  cdata(value: string): void {
    // A CDATA section is character data (§2.7), never Misc: outside the root of a document, even a blank one is refused.
    if (this.stack.length === 0 && this.mode === "document") throw xmlRefusal("text outside the root element");
    const top = this.stack.at(-1);
    if (!top) return;
    this.count(1);
    top.children.push({ "#text": value });
  }

  finish(): XNode[] {
    if (this.stack.length > 0) throw xmlRefusal("unclosed element");
    return this.roots;
  }
}

/**
 * The shape matches fast-xml-parser 5.11.2 with the callers' options, minus
 * what both callers drop (the comparison view of the plan): text at the root
 * and processing-instruction nodes, the declaration included. Inside an
 * element, every text event is a node of its own: the tokenizer already joins
 * text across a comment and ends it at a PI and at each CDATA section (an
 * empty section is kept: fast-xml-parser keeps it). `":@"` exists only when
 * the element has attributes, in the order written, after the name key.
 *
 * REFUSED, where fast-xml-parser reads on (reading rule of 25/10/2026: no
 * valid Office part holds them, XML 1.0 §2.1 [1] and §3 WFC Element Type
 * Match): an end tag that does not match its start tag, an end tag with no
 * start tag, an element still open at the end; in `document` mode also a
 * second root, character data or CDATA outside the root. A part with no
 * element and no text is NOT refused (middle ground, Mikolaj, 25/10/2026:
 * refuse what would publish wrong, read as empty what holds no content): it
 * gives `[]`, as fast-xml-parser does, which `ooxml/xml.ts` reads as an
 * absent part.
 *
 * GUARDS (tranche 4): past the depth fast-xml-parser allows (`maxDepth`:
 * MAX_XML_DEPTH, the bound `ooxml/xml.ts` passes it; the storage XHTML
 * caller passes none and gets its default, `xml-parser.ts`, tranche 7), and past
 * `maxNodes` nodes (MAX_XML_NODES; the tests pass a smaller bound to check the
 * counting, the product never does), the part is refused before the next node
 * exists. Every refusal of ours is a literal, never document content.
 *
 * NAMESPACES (tranche 5, document mode): a part that is not namespace-well-
 * formed (`namespaces.ts`) is refused; it is well-formed XML 1.0, which
 * fast-xml-parser reads, so the refusal is ours alone. Names stay as written.
 */
export function buildTree(source: string, mode: XmlMode, encoding: XmlSourceEncoding = "UTF-8", maxNodes = MAX_XML_NODES, maxDepth = MAX_XML_DEPTH): XNode[] {
  const builder = new TreeBuilder(mode, maxNodes, maxDepth);
  tokenize(source, builder, encoding);
  return builder.finish();
}
