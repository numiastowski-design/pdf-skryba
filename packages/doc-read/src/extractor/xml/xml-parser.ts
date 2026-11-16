/** The two parser classes of our own XML reader, with the call shape the product's two callers write: `XmlParser` for
 *  an Office part (`ooxml/xml.ts`), `XmlFragmentParser` for storage XHTML (`src/conservation/xlsx-page-cells.ts`), each
 *  built once with the caller's own options and called as `.parse(text)`; `XmlParser` also takes a part's bytes, or
 *  text with the encoding its decoding found.
 *  Decides: which options exist (only the ones the callers write, each with the only value this reader has; anything
 *  else is a caller's bug) and how text of unknown encoding is read.
 *  NOT here: the reading itself (`xml/tree.ts`, `xml/tokenizer.ts`, `xml/namespaces.ts`, `xml/decode.ts`), canonical
 *  prefixes and the DTD guard on the decoded text (`ooxml/xml.ts`).
 *  Called by: `ooxml/xml.ts`, and `src/conservation/xlsx-page-cells.ts` through `lib/index.ts`. */

import { ReaderError } from "doc-ir/lib/reader-error";
import { DECLARATION_MAX_BYTES, decodeXmlPart } from "./decode";
import type { XmlSourceEncoding } from "./tokenizer";
import { buildTree, MAX_XML_NODES, type XmlMode, type XNode } from "./tree";

/** The nesting bound of storage XHTML when the caller passes none. Kept at 100 so the reader changes no answer
 *  (reading rule of 25/10/2026). Raising it to `MAX_XML_DEPTH` is a product decision, not this module's. */
export const MAX_STORAGE_XHTML_DEPTH = 100;

/** The option values both callers write, each the ONLY value this reader has (any other is a caller's bug). */
const FIXED_OPTION_VALUES: Readonly<Record<string, unknown>> = {
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  trimValues: false,
  parseTagValue: false,
  htmlEntities: true,
};

/** Keys that may be absent: `parseAttributeValue` (the only value it takes is `false`) and `maxNestedTags`.
 *  `processEntities` is not one: no DTD is ever read, so no entity is ever declared; the five predefined ones and
 *  character references are always decoded, and none expands. */
const OPTIONAL_OPTION_KEYS = new Set(["parseAttributeValue", "maxNestedTags"]);

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
const createMisuseError = (what: string): Error => new Error(`xml-parser: ${what}`);

const isValidDepth = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1;

/** Throws unless every key is one the callers write, with the value they write, and no fixed key is missing. */
const assertSupportedOptions = (options: Readonly<Record<string, unknown>>): void => {
  for (const [key, value] of Object.entries(options)) {
    if (!Object.hasOwn(FIXED_OPTION_VALUES, key) && !OPTIONAL_OPTION_KEYS.has(key)) throw createMisuseError(`unsupported option ${key}`);
    if (Object.hasOwn(FIXED_OPTION_VALUES, key) && value !== FIXED_OPTION_VALUES[key]) throw createMisuseError(`unsupported value for ${key}`);
  }
  for (const key of Object.keys(FIXED_OPTION_VALUES)) if (!Object.hasOwn(options, key)) throw createMisuseError(`missing option ${key}`);
  if (options.parseAttributeValue !== undefined && options.parseAttributeValue !== false) throw createMisuseError("unsupported value for parseAttributeValue");
};

/** The depth the options ask for (`fallback` when they name none), after checking the options are supported. */
const resolveMaxDepth = (options: Readonly<Record<string, unknown>>, fallback: number): number => {
  assertSupportedOptions(options);
  const maxDepth = options.maxNestedTags ?? fallback;
  if (!isValidDepth(maxDepth)) throw createMisuseError("unsupported value for maxNestedTags");
  return maxDepth;
};

const readTree = (source: string, mode: XmlMode, maxDepth: number, encoding = "UTF-8"): XNode[] => buildTree(source, mode, encoding, MAX_XML_NODES, maxDepth);

const readPartBytes = (bytes: Uint8Array, maxDepth: number): XNode[] => {
  const { text, encoding } = decodeXmlPart(bytes);
  return readTree(text, "document", maxDepth, encoding);
};

const ENCODING_MISMATCH_MESSAGE = "xml: declared encoding does not match the bytes";
const ASCII_ONLY = /^[\x00-\x7f]*$/;

/** `iso-2022-jp` is stateful (WHATWG Encoding): an ESC starts a charset switch, so its ASCII bytes need not be its own
 *  text and the whole text must be re-read as bytes. */
const STATEFUL_ENCODING = "iso-2022-jp";

/** The WHATWG name the opening declaration of `text` stands for, or `undefined` when its head does not decode alone. */
const findDeclaredEncoding = (text: string): string | undefined => {
  try {
    return decodeXmlPart(new TextEncoder().encode(text.slice(0, DECLARATION_MAX_BYTES))).encoding;
  } catch {
    return undefined;
  }
};

const readTextAsBytes = (text: string, maxDepth: number): XNode[] => readPartBytes(new TextEncoder().encode(text), maxDepth);

/** The retry after the tokenizer's agreement check refused `text`: see `readTextOfUnknownEncoding`. `refusal` is what to throw when it stays refused. */
const retryUnderDeclaration = (text: string, maxDepth: number, refusal: unknown): XNode[] => {
  const isAscii = ASCII_ONLY.test(text);
  const encoding = findDeclaredEncoding(text);
  if (encoding === undefined && !isAscii) throw refusal;
  if (encoding === undefined) return readTextAsBytes(text, maxDepth);
  if (isAscii && encoding === STATEFUL_ENCODING) return readTextAsBytes(text, maxDepth);
  if (isAscii) return readTree(text, "document", maxDepth, encoding);
  if (encoding !== "windows-1252" || text.includes("\uFFFD")) throw refusal;
  return readTree(text, "document", maxDepth, encoding);
};

/** Text whose encoding the caller does NOT know (not what the product calls: `parseXml` decodes a part once itself and
 *  gives `parse(text, encoding)`; the tests hand bare text). The encoding has to be GUESSED, which is the only reason
 *  this path has a rule of its own. Its declaration naming another encoding is checked at the very start of the
 *  tokenizer, so the retry costs one ASCII scan: ASCII text is the same under every ASCII-compatible encoding, so it is
 *  read through `decode.ts` as the bytes it was. Accented text under a Windows-1252 declaration follows the « prefer
 *  UTF-8 » rule of `decode.ts` (decision of the maintainer, 26/10/2026): it is the UTF-8 its bytes would be, read as it
 *  stands, unless it holds U+FFFD, which says the bytes were not legal UTF-8 and the text is gibberish already: refused.
 *  Any other encoding with non-ASCII text: refused (no discriminant, we do not decide).
 *  Bias, written: a LITERAL U+FFFD (bytes EF BF BD) under a Windows-1252 declaration is read by the bytes path (legal
 *  UTF-8) and refused here, where it cannot be told from a replacement character; the product never calls this path.
 *  Only the declaration decides the encoding, so only the first `DECLARATION_MAX_BYTES` are encoded and decoded to learn
 *  its name, not the whole text; the ORIGINAL string is then read under it. Same refusals, same results as the
 *  whole-text path: that path stays for the one stateful encoding (its ESC sequences change the text) and for any head
 *  that does not decode alone (a refusal the whole text would raise too, or an escape sequence cut by the head). */
const readTextOfUnknownEncoding = (text: string, maxDepth: number): XNode[] => {
  try {
    return readTree(text, "document", maxDepth);
  } catch (error) {
    if (!(error instanceof ReaderError && error.message === ENCODING_MISMATCH_MESSAGE)) throw error;
    return retryUnderDeclaration(text, maxDepth, error);
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
 * - `parse(text)` is kept for the callers that have only text (the tests): deleting it would convert every test for no
 *   gain in the product. It must GUESS the encoding, and is ALIGNED with the bytes rule rather than left to contradict
 *   it: ASCII text is read, accented text under Windows-1252 is read as the UTF-8 it is unless it holds U+FFFD, any
 *   other is refused (« declared encoding does not match the bytes »), never read as gibberish;
 *   `readTextOfUnknownEncoding` has the rule and its one written bias.
 *
 * What `parse` returns: no text node at the root, no `?…` node (declaration, PIs). A refusal is
 * `ReaderError("EXTRACT_FAILED", "xml: …")`, a literal.
 */
export class XmlParser {
  private readonly maxDepth: number;

  constructor(options: PartParserOptions) {
    if ((options as { maxNestedTags?: unknown }).maxNestedTags === undefined) throw createMisuseError("maxNestedTags is required for an Office part");
    this.maxDepth = resolveMaxDepth(options as unknown as Record<string, unknown>, 0);
  }

  /** `encoding` is the one `decodeXmlPart` returned for the bytes `text` came from: the caller's word, not checked here. */
  parse(text: string, encoding: XmlSourceEncoding): XNode[];
  parse(input: string | Uint8Array): XNode[];
  parse(input: string | Uint8Array, encoding?: XmlSourceEncoding): XNode[] {
    if (typeof input !== "string") return readPartBytes(input, this.maxDepth);
    return encoding === undefined ? readTextOfUnknownEncoding(input, this.maxDepth) : readTree(input, "document", this.maxDepth, encoding);
  }
}

/** Storage XHTML (`lib/xml.ts#serializeXml` writes sibling blocks): several
 *  roots, prefixes never declared (Confluence's `ac:` and `ri:`), text between
 *  roots dropped, under the same guards; depth `MAX_STORAGE_XHTML_DEPTH`
 *  unless `maxNestedTags` says otherwise. */
export class XmlFragmentParser {
  private readonly maxDepth: number;

  constructor(options: FragmentParserOptions) {
    this.maxDepth = resolveMaxDepth(options as unknown as Record<string, unknown>, MAX_STORAGE_XHTML_DEPTH);
  }

  parse(text: string): XNode[] {
    return readTree(text, "fragment", this.maxDepth);
  }
}
