/** The lexical layer of our own XML reader (detachment of fast-xml-parser,
 *  `d2c-propositions/xml/plan.md`, tranche 1): one linear pass over a part's
 *  text that reports start tags with their attributes, end tags and
 *  character data to a visitor, references decoded and line ends
 *  normalised. What XML 1.0 calls not well-formed is refused with our own
 *  literal, never a fragment of the document. Comments, processing
 *  instructions and CDATA sections are read since tranche 2; a document type
 *  or markup declaration is refused, never read.
 *  NOT here: the bytes' encoding (`decode.ts`, which tells this module what it
 *  found), tag matching and the tree the readers walk (`tree.ts`), the depth
 *  and node guards (`tree.ts`, tranche 4), namespaces (tranche 5).
 *  Called by: `tree.ts`, and the tests of `src/extractor/xml/` (not wired
 *  into the product). */

import { ReaderError } from "doc-ir/lib/reader-error";

/**
 * WHAT IS READ (W3C XML 1.0 Fifth Edition). An optional byte-order mark
 * (§4.3.3: the caller decodes with `ignoreBOM`, so U+FEFF reaches us), then an
 * optional XML declaration (§2.8, production XMLDecl: version, then encoding,
 * then standalone, in that order); then start tags, empty-element tags and end
 * tags (§3.1) and character data (§2.4) with the five predefined entity
 * references (§4.6) and character references (§4.1). Every line end is
 * normalised first (§2.11: CR LF and a lone CR become LF), in text AND in
 * attribute values, as fast-xml-parser does; a `&#13;` reference stays a CR.
 * Attribute values are NOT normalised further (§3.3.3 would turn a tab into a
 * space): fast-xml-parser does not, and the readers were written against its
 * output — a written gap, kept until a decision says otherwise.
 *
 * REFUSED, where fast-xml-parser accepts (two readings that diverge: we
 * abstain, the package layer says « damaged »): any entity reference other
 * than the five (no DTD is ever read, so none can be declared: §4.1 WFC
 * Entity Declared), a `&` that starts no reference, a character reference
 * that is not a legal Char (§2.2, §4.1 WFC Legal Character) or spells `&#X`,
 * a character outside Char, `]]>` in character data (§2.4), `<` in an
 * attribute value (§3.1 WFC No < in Attribute Values), an attribute without
 * a quoted value, attributes not separated by white space, a repeated
 * attribute (§3.1 WFC Unique Att Spec), a name outside the Name production
 * (§2.3), a declared encoding other than the one the bytes were decoded from (the caller has already decoded
 * the bytes as UTF-8: reading on would read wrong; for UTF-16 bytes, see
 * ENCODING below). Also refused: element and
 * attribute names that would collide with a JavaScript object's own
 * properties, the tree being built from plain objects (fast-xml-parser
 * throws on three of them and renames the others; no Office name is one).
 *
 * OTHER MARKUP (tranche 2). A comment (§2.5) is dropped and does NOT end the
 * character data around it: `x<!--c-->y` is one run `xy`, as fast-xml-parser
 * reports it. A processing instruction (§2.6) is reported to `instruction`
 * when the visitor has one, and ends the character data before it (fast-xml-
 * parser makes it a node of its own, which both callers drop). Its target is
 * any Name, `toString` included (it never becomes a key of ours). A CDATA
 * section (§2.7) is reported raw to `cdata`, even empty (fast-xml-parser
 * makes each one a text node of its own), or to `text` when the visitor has
 * no `cdata` and it is not empty. Refused: `--` inside a comment, a PI whose
 * target is `xml` in any case outside the declaration at the very start
 * (§2.6 PITarget, §2.8: the declaration may only come first), a PI target
 * glued to its data, and EVERY other `<!`: a document type declaration, an
 * entity, element, attribute-list or notation declaration, a conditional
 * section. No DTD is ever read, so no entity can ever be declared, so none
 * can expand: refused, never resolved.
 *
 * ENCODING (§4.3.3). `encoding` says what the bytes were decoded from
 * (`decode.ts`, which refuses UTF-16 without a byte-order mark and decodes a
 * declared legacy encoding as declared, option B of 25/10/2026). UTF-16 (little
 * or big endian): a declaration, when there is one, must name `UTF-16`;
 * `UTF-16LE`, `UTF-16BE` and every other name are refused, the mark being
 * what says the byte order. Otherwise the declared name must stand for the
 * encoding the bytes were decoded from (`ISO-8859-1` stands for
 * `windows-1252`, as in every browser); a name no decoder knows is refused.
 *
 * WORK: one forward pass; nothing is searched twice, no regular expression
 * runs over document text, and a character reference is read digit by digit
 * and refused as soon as its value passes U+10FFFF. One tag holds at most
 * MAX_XML_ATTRIBUTES attributes, refused while the tag is read (tranche 4).
 */

export interface XmlTokenVisitor {
  open(name: string, attributes: readonly (readonly [string, string])[], selfClosing: boolean): void;
  close(name: string): void;
  /** Never called with an empty string. */
  text(value: string): void;
  /** A CDATA section's raw content, possibly empty. */
  cdata?(value: string): void;
  /** A processing instruction other than the XML declaration. */
  instruction?(target: string, data: string): void;
}

/** What the part's bytes were decoded from (`decode.ts`): UTF-8, UTF-16 in either byte order, or the WHATWG name of a
 *  declared legacy encoding (`windows-1252`, `shift_jis`…), as `TextDecoder#encoding` gives it. */
export type XmlSourceEncoding = "UTF-8" | "UTF-16LE" | "UTF-16BE" | (string & {});

/** The WHATWG name a declared encoding label stands for (`ISO-8859-1` → `windows-1252`), or `undefined` when no
 *  decoder exists for it. Exported for `decode.ts`: one reading of a label. */
export const canonicalEncoding = (label: string): string | undefined => {
  try {
    return new TextDecoder(label).encoding;
  } catch {
    return undefined;
  }
};

/** Our refusal: a literal reason, never document content. */
export const xmlRefusal = (reason: string): ReaderError => new ReaderError("EXTRACT_FAILED", `xml: ${reason}`);

/** Names a plain object must not receive as a key: fast-xml-parser's three
 *  « critical » ones and the properties it renames. */
const JS_RESERVED_NAMES: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "hasOwnProperty",
  "toString",
  "valueOf",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

/** The most attributes one start tag may carry: the next one is refused before it is read, so the element never exists.
 *  Without it one 64 MB tag (`ooxml/package.ts#PART_MAX_BYTES`) holds millions of pairs before any other guard
 *  sees them. XML 1.0 sets no limit, fast-xml-parser has none: a refusal of well-formed XML, our own. Starting value to
 *  calibrate: at most 41 on a real tag (versioned fixtures) and 39 (third-party corpus), measured on 25/10/2026;
 *  4 096 pairs cost well under a megabyte. */
export const MAX_XML_ATTRIBUTES = 4_096;

const PREDEFINED: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
/** The longest predefined entity name (`quot`, `apos`). */
const LONGEST_PREDEFINED = 4;
/** The end of the Unicode code space (§2.2 Char), fixed by the standard: not a bound we choose. */
const LAST_UNICODE_CODE_POINT = 0x10ffff;

const LT = 0x3c;
const GT = 0x3e;
const AMP = 0x26;
const SLASH = 0x2f;
const EQ = 0x3d;
const QUOT = 0x22;
const APOS = 0x27;
const QUESTION = 0x3f;
const BANG = 0x21;
const SEMI = 0x3b;
const HASH = 0x23;
const CR = 0x0d;
const LF = 0x0a;
const RBRACKET = 0x5d;
const HYPHEN = 0x2d;

const isSpace = (c: number): boolean => c === 0x20 || c === 0x09 || c === LF || c === CR;

/** §2.2 Char, for a code point. */
const isChar = (cp: number): boolean =>
  cp === 0x09 || cp === LF || cp === CR || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= LAST_UNICODE_CODE_POINT);

/** Flat `[low, high, low, high, …]` inclusive ranges: no pair object to allocate or destructure per character. */
type Ranges = readonly number[];

const inRanges = (cp: number, ranges: Ranges): boolean => {
  for (let k = 0; k < ranges.length; k += 2) if (cp >= ranges[k]! && cp <= ranges[k + 1]!) return true;
  return false;
};

/** §2.3 NameStartChar: letters first (the common case), then `:` and `_`, then the rest. */
const NAME_START_RANGES: Ranges = [
  0x61, 0x7a, 0x41, 0x5a, 0x3a, 0x3a, 0x5f, 0x5f, 0xc0, 0xd6, 0xd8, 0xf6, 0xf8, 0x2ff, 0x370, 0x37d, 0x37f, 0x1fff, 0x200c, 0x200d, 0x2070, 0x218f, 0x2c00, 0x2fef, 0x3001,
  0xd7ff, 0xf900, 0xfdcf, 0xfdf0, 0xfffd, 0x10000, 0xeffff,
];

/** §2.3 NameChar beyond NameStartChar: `-`, `.`, digits, U+00B7, combining marks, U+203F-2040. */
const NAME_EXTRA_RANGES: Ranges = [0x2d, 0x2e, 0x30, 0x39, 0xb7, 0xb7, 0x300, 0x36f, 0x203f, 0x2040];

const isNameStart = (cp: number): boolean => inRanges(cp, NAME_START_RANGES);

const isNameChar = (cp: number): boolean => isNameStart(cp) || inRanges(cp, NAME_EXTRA_RANGES);

/** The value of a digit in decimal, or in hexadecimal when `hex` (§4.1 allows both cases), else -1. */
const digitValue = (c: number, hex: boolean): number => {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (!hex) return -1;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  return -1;
};

const width = (cp: number): number => (cp > 0xffff ? 2 : 1);

const DECLARATION_ORDER: readonly string[] = ["version", "encoding", "standalone"];
const VERSION_NUM = /^1\.\d+$/;
const ENC_NAME = /^[A-Za-z][\w.-]*$/;
/** A pseudo-attribute value is short (§2.8: VersionNum, EncName, yes|no): never search far. */
const DECLARATION_VALUE_SEARCH = 64;

/** Judges a declaration pseudo-attribute value as soon as it is read. */
const checkDeclarationValue = (key: string, value: string, encoding: XmlSourceEncoding): void => {
  if (key === "version" && !VERSION_NUM.test(value)) throw xmlRefusal("malformed XML declaration");
  if (key === "standalone" && value !== "yes" && value !== "no") throw xmlRefusal("malformed XML declaration");
  if (key !== "encoding") return;
  if (!ENC_NAME.test(value)) throw xmlRefusal("malformed XML declaration");
  if (encoding === "UTF-16LE" || encoding === "UTF-16BE") {
    if (value.toLowerCase() !== "utf-16") throw xmlRefusal("declared encoding does not match the bytes");
    return;
  }
  const declared = canonicalEncoding(value);
  if (declared === undefined) throw xmlRefusal("unknown encoding declared");
  if (declared !== (encoding === "UTF-8" ? "utf-8" : encoding)) throw xmlRefusal("declared encoding does not match the bytes");
};

/** One forward pass over `source`; `i` is the read position, shared by the methods below. */
class Lexer {
  private i = 0;
  private readonly n: number;

  constructor(
    private readonly source: string,
    private readonly visitor: XmlTokenVisitor,
    private readonly encoding: XmlSourceEncoding,
  ) {
    this.n = source.length;
  }

  run(): void {
    const { source } = this;
    if (source.charCodeAt(0) === 0xfeff) this.i = 1;
    if (this.atDeclaration()) this.readDeclaration();
    while (this.i < this.n) {
      if (source.charCodeAt(this.i) !== LT || source.startsWith("<!--", this.i)) {
        const value = this.readText();
        if (value.length > 0) this.visitor.text(value);
        continue;
      }
      this.readMarkup();
    }
  }

  private atDeclaration(): boolean {
    const after = this.source.charCodeAt(this.i + 5);
    return this.source.startsWith("<?xml", this.i) && (isSpace(after) || after === QUESTION);
  }

  /** The markup starting at `i` (on `<`, not on a comment): an end tag, a start tag, a processing instruction or a CDATA section. */
  private readMarkup(): void {
    const next = this.source.charCodeAt(this.i + 1);
    if (next === SLASH) this.readEndTag();
    else if (next === QUESTION) this.readInstruction();
    else if (next === BANG) this.readCdata();
    else this.readStartTag();
  }

  /** The code point at `at` (a well-formed surrogate pair read as one), or -1 at the end. */
  private codePointAt(at: number): number {
    return at < this.n ? (this.source.codePointAt(at) ?? -1) : -1;
  }

  /** A Name starting at `i`; leaves `i` after it. `objectKey`: the name becomes a key of a plain object. */
  private readName(objectKey = true): string {
    const start = this.i;
    const first = this.codePointAt(this.i);
    if (first < 0 || !isNameStart(first)) throw xmlRefusal("malformed name");
    this.i += width(first);
    for (let cp = this.codePointAt(this.i); cp >= 0 && isNameChar(cp); cp = this.codePointAt(this.i)) this.i += width(cp);
    const name = this.source.slice(start, this.i);
    if (objectKey && JS_RESERVED_NAMES.has(name)) throw xmlRefusal("name reserved by JavaScript objects");
    return name;
  }

  private skipSpaces(): boolean {
    const start = this.i;
    while (this.i < this.n && isSpace(this.source.charCodeAt(this.i))) this.i++;
    return this.i > start;
  }

  /** A reference starting at `i` (on `&`); leaves `i` after its `;`. */
  private readReference(): string {
    this.i++;
    if (this.source.charCodeAt(this.i) !== HASH) return this.readEntityReference();
    this.i++;
    return this.readCharacterReference();
  }

  /** A character reference after `&#`; leaves `i` after its `;`. */
  private readCharacterReference(): string {
    const hex = this.source.charCodeAt(this.i) === 0x78; // x; §4.1 spells it lower-case only
    if (hex) this.i++;
    const radix = hex ? 16 : 10;
    let value = 0;
    let digits = 0;
    for (; this.i < this.n; this.i++, digits++) {
      const digit = digitValue(this.source.charCodeAt(this.i), hex);
      if (digit < 0) break;
      value = value * radix + digit;
      if (value > LAST_UNICODE_CODE_POINT) throw xmlRefusal("character reference out of range");
    }
    if (digits === 0 || this.source.charCodeAt(this.i) !== SEMI) throw xmlRefusal("malformed character reference");
    this.i++;
    if (!isChar(value)) throw xmlRefusal("character reference to a forbidden character");
    return String.fromCodePoint(value);
  }

  /** One of the five predefined entity references after `&`; leaves `i` after its `;`. */
  private readEntityReference(): string {
    const start = this.i;
    while (this.i < this.n && this.i - start <= LONGEST_PREDEFINED && this.source.charCodeAt(this.i) !== SEMI) this.i++;
    const replacement = this.source.charCodeAt(this.i) === SEMI ? PREDEFINED[this.source.slice(start, this.i)] : undefined;
    if (replacement === undefined) throw xmlRefusal("entity reference other than the five predefined ones");
    this.i++;
    return replacement;
  }

  /** Checks the character at `i` against §2.2 Char and returns its width in code units. */
  private checkedWidth(): number {
    const cp = this.codePointAt(this.i);
    // A lone surrogate comes back from codePointAt as itself, outside Char.
    if (!isChar(cp)) throw xmlRefusal("forbidden character");
    return width(cp);
  }

  /** A comment starting at `i` (on `<!--`); leaves `i` after its `-->`. */
  private skipComment(): void {
    this.i += 4;
    for (;;) {
      if (this.i >= this.n) throw xmlRefusal("unterminated comment");
      if (this.source.charCodeAt(this.i) === HYPHEN && this.source.charCodeAt(this.i + 1) === HYPHEN) {
        if (this.source.charCodeAt(this.i + 2) !== GT) throw xmlRefusal("'--' inside a comment");
        this.i += 3;
        return;
      }
      this.i += this.checkedWidth();
    }
  }

  /** Raw characters from `i` up to `end` (excluded), checked against Char, line ends normalised; leaves `i` after
   *  `end`. `end` is compared only where its first character stands: each position is looked at a bounded number of times. */
  private readUntil(end: string, unterminated: string): string {
    const first = end.charCodeAt(0);
    let out = "";
    let runStart = this.i;
    for (;;) {
      if (this.i >= this.n) throw xmlRefusal(unterminated);
      const c = this.source.charCodeAt(this.i);
      if (c === first && this.source.startsWith(end, this.i)) break;
      if (c === CR) {
        out = this.lineEnd(out, runStart);
        runStart = this.i;
      } else {
        this.i += this.checkedWidth();
      }
    }
    out += this.source.slice(runStart, this.i);
    this.i += end.length;
    return out;
  }

  /** A processing instruction starting at `i` (on `<?`). */
  private readInstruction(): void {
    this.i += 2;
    if (this.i >= this.n) throw xmlRefusal("unterminated processing instruction");
    const target = this.readName(false);
    if (target.toLowerCase() === "xml") throw xmlRefusal("reserved processing instruction target");
    let data = "";
    if (this.source.startsWith("?>", this.i)) {
      this.i += 2;
    } else {
      if (!this.skipSpaces()) throw xmlRefusal(this.i >= this.n ? "unterminated processing instruction" : "malformed processing instruction");
      data = this.readUntil("?>", "unterminated processing instruction");
    }
    this.visitor.instruction?.(target, data);
  }

  /** A CDATA section starting at `i` (on `<!`, not `<!--`); any other `<!` is refused. */
  private readCdata(): void {
    if (!this.source.startsWith("<![CDATA[", this.i)) throw xmlRefusal("document type or markup declaration");
    this.i += 9;
    const value = this.readUntil("]]>", "unterminated CDATA section");
    if (this.visitor.cdata) this.visitor.cdata(value);
    else if (value.length > 0) this.visitor.text(value);
  }

  /** A CR (alone or before an LF) at `i` read as one LF; returns the text so far with it appended. */
  private lineEnd(out: string, runStart: number): string {
    const text = out + this.source.slice(runStart, this.i) + "\n";
    this.i += this.source.charCodeAt(this.i + 1) === LF ? 2 : 1;
    return text;
  }

  /** Character data from `i` up to the next `<` that does not open a comment, or the end. */
  private readText(): string {
    let out = "";
    let runStart = this.i;
    while (this.i < this.n) {
      const c = this.source.charCodeAt(this.i);
      if (c === LT) {
        if (!this.source.startsWith("<!--", this.i)) break;
        out += this.source.slice(runStart, this.i);
        this.skipComment();
        runStart = this.i;
      } else if (c === AMP) {
        out += this.source.slice(runStart, this.i) + this.readReference();
        runStart = this.i;
      } else if (c === CR) {
        out = this.lineEnd(out, runStart);
        runStart = this.i;
      } else if (c === RBRACKET && this.source.startsWith("]]>", this.i)) {
        throw xmlRefusal("']]>' in character data");
      } else {
        this.i += this.checkedWidth();
      }
    }
    return out + this.source.slice(runStart, this.i);
  }

  /** A quoted attribute value starting at `i` (on its quote); leaves `i` after the closing quote. */
  private readAttributeValue(): string {
    const quote = this.source.charCodeAt(this.i);
    if (quote !== QUOT && quote !== APOS) throw xmlRefusal("attribute value without quotes");
    this.i++;
    let out = "";
    let runStart = this.i;
    for (;;) {
      if (this.i >= this.n) throw xmlRefusal("unterminated attribute value");
      const c = this.source.charCodeAt(this.i);
      if (c === quote) break;
      if (c === LT) throw xmlRefusal("'<' in an attribute value");
      if (c === AMP) {
        out += this.source.slice(runStart, this.i) + this.readReference();
        runStart = this.i;
      } else if (c === CR) {
        out = this.lineEnd(out, runStart);
        runStart = this.i;
      } else {
        this.i += this.checkedWidth();
      }
    }
    out += this.source.slice(runStart, this.i);
    this.i++;
    return out;
  }

  /** One `name = "value"` attribute starting at `i`. */
  private readAttribute(): [string, string] {
    const attribute = this.readName();
    this.skipSpaces();
    if (this.source.charCodeAt(this.i) !== EQ) throw xmlRefusal("attribute without a value");
    this.i++;
    this.skipSpaces();
    return [attribute, this.readAttributeValue()];
  }

  /** A start or empty-element tag starting at `i` (on `<`). */
  private readStartTag(): void {
    this.i++;
    const name = this.readName();
    const attributes: [string, string][] = [];
    let seen: Set<string> | undefined;
    for (;;) {
      const spaced = this.skipSpaces();
      if (this.i >= this.n) throw xmlRefusal("unterminated tag");
      if (this.endsStartTag(name, attributes)) return;
      if (!spaced) throw xmlRefusal("attributes not separated by white space");
      if (attributes.length === MAX_XML_ATTRIBUTES) throw xmlRefusal("more attributes on one element than the limit");
      const pair = this.readAttribute();
      seen ??= new Set();
      if (seen.has(pair[0])) throw xmlRefusal("repeated attribute");
      seen.add(pair[0]);
      attributes.push(pair);
    }
  }

  /** At `i`, a `>` or `/>` ends the start tag: reports the element and returns true. Anything else: false. */
  private endsStartTag(name: string, attributes: readonly (readonly [string, string])[]): boolean {
    const c = this.source.charCodeAt(this.i);
    if (c === GT) {
      this.i++;
      this.visitor.open(name, attributes, false);
      return true;
    }
    if (c !== SLASH) return false;
    if (this.source.charCodeAt(this.i + 1) !== GT) throw xmlRefusal("malformed tag");
    this.i += 2;
    this.visitor.open(name, attributes, true);
    return true;
  }

  /** An end tag starting at `i` (on `</`). */
  private readEndTag(): void {
    this.i += 2;
    const name = this.readName();
    this.skipSpaces();
    if (this.source.charCodeAt(this.i) !== GT) throw xmlRefusal("malformed end tag");
    this.i++;
    this.visitor.close(name);
  }

  /** §2.8 XMLDecl at `i` (on `<?xml` followed by white space). Each
   *  pseudo-attribute is checked as soon as it is read (version first and
   *  required, then encoding, then standalone, each at most once): nothing
   *  is collected before it is judged. */
  private readDeclaration(): void {
    this.i += 5;
    let last = -1;
    for (;;) {
      const spaced = this.skipSpaces();
      if (this.source.startsWith("?>", this.i)) {
        this.i += 2;
        break;
      }
      if (!spaced || this.i >= this.n) throw xmlRefusal("malformed XML declaration");
      last = this.readPseudoAttribute(last);
    }
    if (last < 0) throw xmlRefusal("malformed XML declaration");
  }

  /** One pseudo-attribute of the declaration at `i`, after the rank `last` of the previous one; returns its own rank. */
  private readPseudoAttribute(last: number): number {
    const start = this.i;
    while (this.i < this.n && this.source.charCodeAt(this.i) >= 0x61 && this.source.charCodeAt(this.i) <= 0x7a) this.i++;
    const key = this.source.slice(start, this.i);
    const rank = DECLARATION_ORDER.indexOf(key);
    if (rank <= last || (last < 0 && rank !== 0)) throw xmlRefusal("malformed XML declaration");
    this.skipSpaces();
    if (this.source.charCodeAt(this.i) !== EQ) throw xmlRefusal("malformed XML declaration");
    this.i++;
    this.skipSpaces();
    const value = this.readDeclarationValue();
    checkDeclarationValue(key, value, this.encoding);
    return rank;
  }

  /** A quoted pseudo-attribute value at `i` (on its quote); leaves `i` after the closing quote. */
  private readDeclarationValue(): string {
    const quote = this.source.charCodeAt(this.i);
    if (quote !== QUOT && quote !== APOS) throw xmlRefusal("malformed XML declaration");
    let end = this.i + 1;
    while (end < this.n && end - this.i <= DECLARATION_VALUE_SEARCH && this.source.charCodeAt(end) !== quote) end++;
    // Our own ceiling (a value of 64 characters or more), not a well-formedness violation: told apart from a quote missing at end of input.
    if (end - this.i > DECLARATION_VALUE_SEARCH) throw xmlRefusal("XML declaration value too long");
    if (this.source.charCodeAt(end) !== quote) throw xmlRefusal("malformed XML declaration");
    const value = this.source.slice(this.i + 1, end);
    this.i = end + 1;
    return value;
  }
}

/** Reads `source` and reports its tags and character data to `visitor`.
 *  Throws `xmlRefusal(…)` on the first construct it does not accept. */
export function tokenize(source: string, visitor: XmlTokenVisitor, encoding: XmlSourceEncoding = "UTF-8"): void {
  new Lexer(source, visitor, encoding).run();
}
