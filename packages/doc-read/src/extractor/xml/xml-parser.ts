/** The call shape of fast-xml-parser as the product's two callers write it,
 *  answered by our own reader (detachment of fast-xml-parser,
 *  `d2c-propositions/xml/plan.md`, tranche 7): `XMLParser` for an Office part
 *  (`ooxml/xml.ts`), `XMLFragmentParser` for storage XHTML
 *  (`pipeline/xlsx-page-cells.ts`), each built once with the caller's own
 *  options and called as `.parse(text)`; only the options they write exist (`XMLParser` also takes a part's bytes, or
 *  text with the encoding its decoding found).
 *  The switch was one import line in each caller (26/10/2026).
 *  NOT here: the reading itself (`xml/tree.ts`, `xml/tokenizer.ts`,
 *  `xml/namespaces.ts`, `xml/decode.ts`), canonical prefixes and the DTD guard
 *  on the raw text (`ooxml/xml.ts`).
 *  Called by: `ooxml/xml.ts`, `pipeline/xlsx-page-cells.ts`. */

import { ReaderError } from "doc-ir/lib/reader-error";
import { DECLARATION_MAX_BYTES, decodeXmlPart } from "./decode";
import type { XmlSourceEncoding } from "./tokenizer";
import { buildTree, MAX_XML_NODES, type XmlMode, type XNode } from "./tree";

/** The nesting bound of storage XHTML: fast-xml-parser's own default `maxNestedTags` (5.11.2,
 *  `OptionsBuilder.js`), which `pipeline/xlsx-page-cells.ts` inherits today by passing none. Kept so the switch
 *  changes no answer (reading rule of 25/10/2026); a table in a frame is five elements deep (frame, table, tbody, tr,
 *  td): far from the bound on the pages our renderer writes. Raising it to `MAX_XML_DEPTH` is a product decision (D2 of tranche 4),
 *  not this module's. */
export const MAX_STORAGE_XHTML_DEPTH = 100;

/** The option values both callers write, each the ONLY value this reader has (any other is a caller's bug). */
const FIXED: Readonly<Record<string, unknown>> = {
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  trimValues: false,
  parseTagValue: false,
  htmlEntities: true,
};

/** Keys that may be absent: `parseAttributeValue` (ooxml/xml.ts writes `false`, fast-xml-parser's default) and
 *  `maxNestedTags`. `processEntities` is not one: no DTD is ever read, so no entity is ever declared; the five predefined
 *  ones and character references are always decoded, and none expands. */
const OPTIONAL = new Set(["parseAttributeValue", "maxNestedTags"]);

interface CommonOptions {
  readonly preserveOrder: true;
  readonly ignoreAttributes: false;
  readonly attributeNamePrefix: "";
  readonly trimValues: false;
  readonly parseTagValue: false;
  readonly parseAttributeValue?: false;
  readonly htmlEntities: true;
}

export interface FragmentParserOptions extends CommonOptions {
  readonly maxNestedTags?: number;
}

export interface PartParserOptions extends CommonOptions {
  readonly maxNestedTags: number;
}

/** A caller's bug, never a document's: a plain Error, not our refusal (`ReaderError`). */
const misuse = (what: string): Error => new Error(`xml-parser: ${what}`);

const isDepth = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1;

/** The depth the options ask for, after checking every key is one the callers write, with their value. */
const checkedDepth = (options: Readonly<Record<string, unknown>>, fallback: number): number => {
  for (const [key, value] of Object.entries(options)) {
    if (!Object.hasOwn(FIXED, key) && !OPTIONAL.has(key)) throw misuse(`unsupported option ${key}`);
    if (Object.hasOwn(FIXED, key) && value !== FIXED[key]) throw misuse(`unsupported value for ${key}`);
  }
  for (const key of Object.keys(FIXED)) if (!Object.hasOwn(options, key)) throw misuse(`missing option ${key}`);
  if (options.parseAttributeValue !== undefined && options.parseAttributeValue !== false) throw misuse("unsupported value for parseAttributeValue");
  const depth = options.maxNestedTags ?? fallback;
  if (!isDepth(depth)) throw misuse("unsupported value for maxNestedTags");
  return depth;
};

const read = (source: string, mode: XmlMode, depth: number, encoding = "UTF-8"): XNode[] => buildTree(source, mode, encoding, MAX_XML_NODES, depth);

const readBytes = (bytes: Uint8Array, depth: number): XNode[] => {
  const { text, encoding } = decodeXmlPart(bytes);
  return read(text, "document", depth, encoding);
};

const MISMATCH = "xml: declared encoding does not match the bytes";
const ASCII_ONLY = /^[\x00-\x7f]*$/;

/** The only WHATWG encoding whose ASCII bytes are not its own text: ESC starts a charset switch (stateful). */
const STATEFUL = "iso-2022-jp";

/** The WHATWG name the opening declaration of `text` stands for, or `undefined` when its head does not decode alone. */
const declaredEncodingOf = (text: string): string | undefined => {
  try {
    return decodeXmlPart(new TextEncoder().encode(text.slice(0, DECLARATION_MAX_BYTES))).encoding;
  } catch {
    return undefined;
  }
};

/** The retry after the tokenizer's agreement check refused `text`: see `readText`. `refusal` is what to throw when it stays refused. */
const retryUnderDeclaration = (text: string, depth: number, refusal: unknown): XNode[] => {
  const ascii = ASCII_ONLY.test(text);
  const encoding = declaredEncodingOf(text);
  if (encoding === undefined) {
    if (!ascii) throw refusal;
    return readBytes(new TextEncoder().encode(text), depth);
  }
  if (ascii) return encoding === STATEFUL ? readBytes(new TextEncoder().encode(text), depth) : read(text, "document", depth, encoding);
  if (encoding !== "windows-1252" || text.includes("\uFFFD")) throw refusal;
  return read(text, "document", depth, encoding);
};

/** Text whose encoding the caller does NOT know (not what the product calls: `parseXml` decodes a part once itself and
 *  gives `parse(text, encoding)`; the tests and the shadow harness hand bare text). The encoding has to be GUESSED, which
 *  is the only reason this path has a rule of its own. Its declaration naming another encoding is checked at the very
 *  start of the tokenizer, so the retry costs one ASCII scan: ASCII text is the same under every ASCII-compatible
 *  encoding, so it is read through `decode.ts` as the bytes it was. Accented text under a Windows-1252 declaration follows
 *  the « prefer UTF-8 » rule of `decode.ts` (product owner, 26/10/2026): it is the UTF-8 its bytes would be, read as it
 *  stands, unless it holds U+FFFD, which says the bytes were not legal UTF-8 and the text is gibberish already: refused.
 *  Any other encoding with non-ASCII text: refused (no discriminant, we do not decide).
 *  Bias, written: a LITERAL U+FFFD (bytes EF BF BD) under a Windows-1252 declaration is read by the bytes path (legal
 *  UTF-8) and refused here, where it cannot be told from a replacement character; the product never calls this path, 0
 *  case measured.
 *  Only the declaration decides the encoding, so only the first `DECLARATION_MAX_BYTES` are encoded and decoded to learn
 *  its name (the retry used to re-encode and re-decode the whole text, up to 64 MB, about 300 MB transient); the ORIGINAL
 *  string is then read under it. Same refusals, same results as the whole-text path: that path stays for the one
 *  stateful encoding (its ESC sequences change the text) and for any head that does not decode alone (a refusal the
 *  whole text would raise too, or an escape sequence cut by the head). */
const readText = (text: string, depth: number): XNode[] => {
  try {
    return read(text, "document", depth);
  } catch (error) {
    if (!(error instanceof ReaderError && error.message === MISMATCH)) throw error;
    return retryUnderDeclaration(text, depth, error);
  }
};

/**
 * An Office part: one root element at most, namespaces checked, under the
 * tree's guards (depth from `maxNestedTags`, which `ooxml/xml.ts` sets
 * to `MAX_XML_DEPTH`; `MAX_XML_NODES`; attributes per tag).
 *
 * Three ways in, one reading. The encoding is either KNOWN (found by `decode.ts`) or GUESSED (bare text):
 * - `parse(text, encoding)` is what the product calls (`ooxml/xml.ts#parseXml` decodes a part ONCE with
 *   `decodeXmlPart`, runs the DTD guard on that text, and gives both here): nothing is decoded again and nothing is
 *   guessed; the tokenizer's agreement check compares the declaration with the encoding `decode.ts` found.
 * - `parse(bytes)` decodes a part's own bytes through `decode.ts` (UTF-16 with its mark, a declared legacy encoding as
 *   declared, Windows-1252 over legal UTF-8 read as UTF-8, illegal bytes refused), then reads as above.
 *   fast-xml-parser's `parse` also takes bytes, but decodes them as UTF-8 whatever they are.
 * - `parse(text)` is kept for the callers that have only text (the tests and the shadow harness: about twenty call
 *   sites build their parts as text; deleting it would convert them all for no gain in the product). It must GUESS the
 *   encoding, and is ALIGNED with the bytes rule rather than left to contradict it: ASCII text is read, accented text
 *   under Windows-1252 is read as the UTF-8 it is unless it holds U+FFFD, any other is refused (« declared encoding does
 *   not match the bytes »), never read as gibberish; `readText` has the rule and its one written bias.
 *
 * What `parse` returns differs from fast-xml-parser only in what both callers
 * drop (the comparison view of the plan): no text node at the root, no `?…`
 * node (declaration, PIs). A refusal is `ReaderError("EXTRACT_FAILED", "xml: …")`,
 * a literal, which `package.ts` turns into « damaged » as it does any throw.
 */
export class XMLParser {
  private readonly depth: number;

  constructor(options: PartParserOptions) {
    if ((options as { maxNestedTags?: unknown }).maxNestedTags === undefined) throw misuse("maxNestedTags is required for an Office part");
    this.depth = checkedDepth(options as unknown as Record<string, unknown>, 0);
  }

  /** `encoding` is the one `decodeXmlPart` returned for the bytes `text` came from: the caller's word, not checked here. */
  parse(text: string, encoding: XmlSourceEncoding): XNode[];
  parse(input: string | Uint8Array): XNode[];
  parse(input: string | Uint8Array, encoding?: XmlSourceEncoding): XNode[] {
    if (typeof input !== "string") return readBytes(input, this.depth);
    return encoding === undefined ? readText(input, this.depth) : read(input, "document", this.depth, encoding);
  }
}

/** Storage XHTML (`lib/xml.ts#serializeXml` writes sibling blocks): several
 *  roots, prefixes never declared (Confluence's `ac:` and `ri:`), text between
 *  roots dropped, under the same guards; depth `MAX_STORAGE_XHTML_DEPTH`
 *  unless `maxNestedTags` says otherwise, as fast-xml-parser. */
export class XMLFragmentParser {
  private readonly depth: number;

  constructor(options: FragmentParserOptions) {
    this.depth = checkedDepth(options as unknown as Record<string, unknown>, MAX_STORAGE_XHTML_DEPTH);
  }

  parse(text: string): XNode[] {
    return read(text, "fragment", this.depth);
  }
}
