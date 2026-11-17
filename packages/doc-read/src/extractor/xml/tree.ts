/** The tree our own XML reader hands to the readers: the `preserveOrder` shape (`{ [tag]: children, ":@": attributes }`
 *  nodes) that `ooxml/xml.ts` and `src/conservation/xlsx-page-cells.ts` walk, built from the tokenizer's events, with
 *  the structure checked: tags matched, one root for an Office part (document), several for storage XHTML (fragment).
 *  Decides: the structure refusals, the nesting depth and the number of nodes one part may allocate, each checked
 *  BEFORE the node exists; in document mode, each element goes through `namespaces.ts` before it exists.
 *  NOT here: the lexical rules, the encoding and the attributes of one tag (`tokenizer.ts`, `decode.ts`), the namespace
 *  rules themselves (`namespaces.ts`), the callers' call shape and options (`xml-parser.ts`).
 *  Called by: `xml/xml-parser.ts`, and the tests of `src/extractor/xml/`. */

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

const ATTRIBUTES_KEY = ":@";

/** The most nodes one part's tree may hold: elements, attributes and text nodes together, each counted before it is
 *  allocated; root-level text, comments and PIs are never allocated, never counted. XML 1.0 sets no limit: a refusal
 *  of well-formed XML, our own. Starting value to calibrate, two populations measured on 25/10/2026: real parts reach
 *  6 852 409 nodes (an xlsx sheet of 50 M characters, versioned fixtures) and 3 769 837 (third-party corpus), a hostile
 *  part at the package's part ceiling reaches 16 M to 25.6 M nodes, 1.6 to 2.6 times the bound. It bounds the tree's memory; it is not a
 *  promise to fit any host's memory limit. */
export const MAX_XML_NODES = 10_000_000;

/** §2.3 S. */
const isXmlWhiteSpace = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const charCode = value.charCodeAt(index);
    if (charCode !== 0x20 && charCode !== 0x09 && charCode !== 0x0a && charCode !== 0x0d) return false;
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

  private nodeCount = 0;
  /** Document mode only: storage XHTML never declares Confluence's `ac:` and `ri:` prefixes. */
  private readonly namespaceChecker: NamespaceChecker | undefined;

  constructor(
    private readonly mode: XmlMode,
    private readonly maxNodes: number,
    private readonly maxDepth: number,
  ) {
    this.namespaceChecker = mode === "document" ? new NamespaceChecker() : undefined;
  }

  /** Counts `more` nodes about to be allocated; refuses before they exist when they would pass the bound. */
  private countNodes(more: number): void {
    this.nodeCount += more;
    if (this.nodeCount > this.maxNodes) throw xmlRefusal("more nodes than the limit");
  }

  open(name: string, attributes: readonly (readonly [string, string])[], isSelfClosing: boolean): void {
    const parent = this.stack.at(-1);
    if (!parent && this.mode === "document" && this.roots.length > 0) throw xmlRefusal("more than one root element");
    // A start tag is refused when more than `maxDepth` (MAX_XML_DEPTH for an Office part) elements are already open; an
    // empty-element tag is never checked, so it may sit one level further (held by `guards.test.ts`).
    if (!isSelfClosing && this.stack.length > this.maxDepth) throw xmlRefusal("elements nested past the depth limit");
    this.countNodes(1 + attributes.length);
    this.namespaceChecker?.open(name, attributes, isSelfClosing);
    const children: XNode[] = [];
    const node: XNode = { [name]: children };
    // The tokenizer refuses a repeated attribute and the names a plain object must not receive as keys.
    if (attributes.length > 0) node[ATTRIBUTES_KEY] = Object.fromEntries(attributes);
    (parent ? parent.children : this.roots).push(node);
    if (!isSelfClosing) this.stack.push({ name, children });
  }

  close(name: string): void {
    const openElement = this.stack.pop();
    if (!openElement) throw xmlRefusal("end tag without a start tag");
    if (openElement.name !== name) throw xmlRefusal("end tag does not match its start tag");
    this.namespaceChecker?.close();
  }

  text(value: string): void {
    const openElement = this.stack.at(-1);
    if (openElement) {
      this.appendText(openElement, value);
      return;
    }
    if (this.mode === "document" && !isXmlWhiteSpace(value)) throw xmlRefusal("text outside the root element");
  }

  private appendText(openElement: OpenElement, value: string): void {
    this.countNodes(1);
    openElement.children.push({ "#text": value });
  }

  cdata(value: string): void {
    // A CDATA section is character data (§2.7), never Misc: outside the root of a document, even a blank one is refused.
    if (this.stack.length === 0 && this.mode === "document") throw xmlRefusal("text outside the root element");
    const openElement = this.stack.at(-1);
    if (!openElement) return;
    this.appendText(openElement, value);
  }

  finish(): XNode[] {
    if (this.stack.length > 0) throw xmlRefusal("unclosed element");
    return this.roots;
  }
}

/**
 * The shape: text at the root and processing-instruction nodes (the declaration included) are not in the tree. Inside
 * an element, every text event is a node of its own: the tokenizer already joins text across a comment and ends it at
 * a PI and at each CDATA section (an empty section is kept). `":@"` exists only when the element has attributes, in
 * the order written, after the name key.
 *
 * REFUSED (reading rule of 25/10/2026: no valid Office part holds them, XML 1.0 §2.1 [1] and §3 WFC Element Type
 * Match): an end tag that does not match its start tag, an end tag with no start tag, an element still open at the end;
 * in `document` mode also a second root, character data or CDATA outside the root. A part with no element and no text
 * is NOT refused (middle ground, 25/10/2026: refuse what would publish wrong, read as empty what holds no content): it
 * gives `[]`, which `ooxml/xml.ts` reads as an absent part.
 *
 * GUARDS: past `maxDepth` (MAX_XML_DEPTH, the bound `ooxml/xml.ts` passes; the storage XHTML caller passes none and
 * gets its default, `xml-parser.ts`) and past `maxNodes` nodes (MAX_XML_NODES; the tests pass a smaller bound to check
 * the counting, the product never does), the part is refused before the next node exists. Every refusal of ours is a
 * literal, never document content.
 *
 * NAMESPACES (document mode): a part that is not namespace-well-formed (`namespaces.ts`) is refused; it is well-formed
 * XML 1.0, so the refusal is ours alone. Names stay as written.
 */
export function buildTree(
  source: string,
  mode: XmlMode,
  encoding: XmlSourceEncoding = "UTF-8",
  maxNodes = MAX_XML_NODES,
  maxDepth = MAX_XML_DEPTH,
): XNode[] {
  const builder = new TreeBuilder(mode, maxNodes, maxDepth);
  tokenize(source, builder, encoding);
  return builder.finish();
}
