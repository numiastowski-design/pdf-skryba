/** The lexical layer of our own XML reader: one linear pass over a part's text that reports start tags with their
 *  attributes, end tags, character data, processing instructions and CDATA sections to a visitor, references decoded
 *  and line ends normalised.
 *  Decides: what is not well-formed XML 1.0 is refused with our own literal, never a fragment of the document; a
 *  document type or markup declaration is refused, never read.
 *  NOT here: the bytes' encoding (`decode.ts`, which tells this module what it found), tag matching and the tree the
 *  readers walk (`tree.ts`), the depth and node guards (`tree.ts`), namespaces (`namespaces.ts`).
 *  Called by: `tree.ts` (`tokenize`), and the tests of `src/extractor/xml/`; `decode.ts` and `namespaces.ts` use its
 *  `xmlRefusal`, `canonicalizeEncodingLabel` and `XmlSourceEncoding`. */

import { ReaderError } from "doc-ir/lib/reader-error";

/**
 * WHAT IS READ (W3C XML 1.0 Fifth Edition). An optional byte-order mark (§4.3.3: the caller decodes with `ignoreBOM`,
 * so U+FEFF reaches us), then an optional XML declaration (§2.8, production XMLDecl: version, then encoding, then
 * standalone, in that order); then start tags, empty-element tags and end tags (§3.1) and character data (§2.4) with
 * the five predefined entity references (§4.6) and character references (§4.1). Every line end is normalised first
 * (§2.11: CR LF and a lone CR become LF), in text AND in attribute values; a `&#13;` reference stays a CR.
 * Attribute values are NOT normalised further (§3.3.3 would turn a tab into a space): a written gap, kept until a
 * decision says otherwise.
 *
 * REFUSED (two readings that diverge: we abstain, the package layer says « damaged »): any entity reference other than
 * the five (no DTD is ever read, so none can be declared: §4.1 WFC Entity Declared), a `&` that starts no reference, a
 * character reference that is not a legal Char (§2.2, §4.1 WFC Legal Character) or spells `&#X`, a character outside
 * Char, `]]>` in character data (§2.4), `<` in an attribute value (§3.1 WFC No < in Attribute Values), an attribute
 * without a quoted value, attributes not separated by white space, a repeated attribute (§3.1 WFC Unique Att Spec), a
 * name outside the Name production (§2.3), a declared encoding other than the one the bytes were decoded from (see
 * ENCODING below). Also refused: element and attribute names that would collide with a JavaScript object's own
 * properties, the tree being built from plain objects (no Office name is one).
 *
 * OTHER MARKUP. A comment (§2.5) is dropped and does NOT end the character data around it: `x<!--c-->y` is one run
 * `xy`. A processing instruction (§2.6) is reported to `instruction` when the visitor has one, and ends the character
 * data before it. Its target is any Name, `toString` included (it never becomes a key of ours). A CDATA section (§2.7)
 * is reported raw to `cdata`, even empty, or to `text` when the visitor has no `cdata` and it is not empty. Refused:
 * `--` inside a comment, a PI whose target is `xml` in any case outside the declaration at the very start (§2.6
 * PITarget, §2.8: the declaration may only come first), a PI target glued to its data, and EVERY other `<!`: a document
 * type declaration, an entity, element, attribute-list or notation declaration, a conditional section. No DTD is ever
 * read, so no entity can ever be declared, so none can expand: refused, never resolved.
 *
 * ENCODING (§4.3.3). `encoding` says what the bytes were decoded from (`decode.ts`, which refuses UTF-16 without a
 * byte-order mark and decodes a declared legacy encoding as declared, decision of 25/10/2026). UTF-16 (little or big
 * endian): a declaration, when there is one, must name `UTF-16`; `UTF-16LE`, `UTF-16BE` and every other name are
 * refused, the mark being what says the byte order. Otherwise the declared name must stand for the encoding the bytes
 * were decoded from (`ISO-8859-1` stands for `windows-1252`, WHATWG Encoding); a name no decoder knows is refused.
 *
 * WORK: one forward pass; nothing is searched twice, no regular expression runs over document text, and a character
 * reference is read digit by digit and refused as soon as its value passes U+10FFFF. One tag holds at most
 * MAX_XML_ATTRIBUTES attributes, refused while the tag is read.
 */

export interface XmlTokenVisitor {
  open(name: string, attributes: readonly (readonly [string, string])[], isSelfClosing: boolean): void;
  close(name: string): void;
  /** Never called with an empty string. */
  text(value: string): void;
  /** A CDATA section's raw content, possibly empty. */
  cdata?(value: string): void;
  /** A processing instruction other than the XML declaration. */
  processingInstruction?(target: string, data: string): void;
}

/** What the part's bytes were decoded from (`decode.ts`): UTF-8, UTF-16 in either byte order, or the WHATWG name of a
 *  declared legacy encoding (`windows-1252`, `shift_jis`…), as `TextDecoder#encoding` gives it. */
export type XmlSourceEncoding = "UTF-8" | "UTF-16LE" | "UTF-16BE" | (string & {});

/** The WHATWG name a declared encoding label stands for (`ISO-8859-1` → `windows-1252`), or `undefined` when no
 *  decoder exists for it. Exported for `decode.ts`: one reading of a label. */
export const canonicalizeEncodingLabel = (label: string): string | undefined => {
  try {
    return new TextDecoder(label).encoding;
  } catch {
    return undefined;
  }
};

/** Our refusal: a literal reason, never document content. */
export const xmlRefusal = (reason: string): ReaderError => new ReaderError("EXTRACT_FAILED", `xml: ${reason}`);

/** Names a plain object must not receive as a key: the tree is built from plain objects. */
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
 *  Without it one tag as large as a whole part would hold millions of pairs before any other guard sees them. XML 1.0
 *  sets no limit: a refusal of well-formed XML, our own. Starting value to calibrate: at most 41 on a real tag
 *  (versioned fixtures) and 39 (third-party corpus), measured on 25/10/2026. */
export const MAX_XML_ATTRIBUTES = 4_096;

const PREDEFINED_ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
/** The longest predefined entity name (`quot`, `apos`). */
const LONGEST_PREDEFINED_ENTITY_NAME_LENGTH = 4;
/** The end of the Unicode code space (§2.2 Char), fixed by the standard: not a bound we choose. */
const LAST_UNICODE_CODE_POINT = 0x10ffff;

const LESS_THAN = 0x3c;
const GREATER_THAN = 0x3e;
const AMPERSAND = 0x26;
const SOLIDUS = 0x2f;
const EQUALS_SIGN = 0x3d;
const QUOTATION_MARK = 0x22;
const APOSTROPHE = 0x27;
const QUESTION_MARK = 0x3f;
const EXCLAMATION_MARK = 0x21;
const SEMICOLON = 0x3b;
const NUMBER_SIGN = 0x23;
const CARRIAGE_RETURN = 0x0d;
const LINE_FEED = 0x0a;
const RIGHT_SQUARE_BRACKET = 0x5d;
const HYPHEN_MINUS = 0x2d;

const isSpace = (charCode: number): boolean => charCode === 0x20 || charCode === 0x09 || charCode === LINE_FEED || charCode === CARRIAGE_RETURN;

/** §2.2 Char, for a code point. */
const isChar = (codePoint: number): boolean =>
  codePoint === 0x09 || codePoint === LINE_FEED || codePoint === CARRIAGE_RETURN || (codePoint >= 0x20 && codePoint <= 0xd7ff) || (codePoint >= 0xe000 && codePoint <= 0xfffd) || (codePoint >= 0x10000 && codePoint <= LAST_UNICODE_CODE_POINT);

/** Flat `[low, high, low, high, …]` inclusive ranges: no pair object to allocate or destructure per character. */
type Ranges = readonly number[];

const isInRanges = (codePoint: number, ranges: Ranges): boolean => {
  for (let lowIndex = 0; lowIndex < ranges.length; lowIndex += 2) if (codePoint >= ranges[lowIndex]! && codePoint <= ranges[lowIndex + 1]!) return true;
  return false;
};

/** §2.3 NameStartChar: letters first (the common case), then `:` and `_`, then the rest. */
const NAME_START_RANGES: Ranges = [
  0x61, 0x7a, 0x41, 0x5a, 0x3a, 0x3a, 0x5f, 0x5f, 0xc0, 0xd6, 0xd8, 0xf6, 0xf8, 0x2ff, 0x370, 0x37d, 0x37f, 0x1fff, 0x200c, 0x200d, 0x2070, 0x218f, 0x2c00, 0x2fef, 0x3001,
  0xd7ff, 0xf900, 0xfdcf, 0xfdf0, 0xfffd, 0x10000, 0xeffff,
];

/** §2.3 NameChar beyond NameStartChar: `-`, `.`, digits, U+00B7, combining marks, U+203F-2040. */
const NAME_EXTRA_RANGES: Ranges = [0x2d, 0x2e, 0x30, 0x39, 0xb7, 0xb7, 0x300, 0x36f, 0x203f, 0x2040];

const isNameStart = (codePoint: number): boolean => isInRanges(codePoint, NAME_START_RANGES);

const isNameChar = (codePoint: number): boolean => isNameStart(codePoint) || isInRanges(codePoint, NAME_EXTRA_RANGES);

/** The value of a digit in decimal, or in hexadecimal when `isHexadecimal` (§4.1 allows both cases), else -1. */
const getDigitValue = (charCode: number, isHexadecimal: boolean): number => {
  if (charCode >= 0x30 && charCode <= 0x39) return charCode - 0x30;
  if (!isHexadecimal) return -1;
  if (charCode >= 0x61 && charCode <= 0x66) return charCode - 0x57;
  if (charCode >= 0x41 && charCode <= 0x46) return charCode - 0x37;
  return -1;
};

const getCodeUnitWidth = (codePoint: number): number => (codePoint > 0xffff ? 2 : 1);

const DECLARATION_ORDER: readonly string[] = ["version", "encoding", "standalone"];
const VERSION_NUMBER_PATTERN = /^1\.\d+$/;
const ENCODING_NAME_PATTERN = /^[A-Za-z][\w.-]*$/;
/** A pseudo-attribute value is short (§2.8: VersionNum, EncName, yes|no): never search far. */
const DECLARATION_VALUE_SEARCH = 64;

/** Judges a declaration pseudo-attribute value as soon as it is read. */
const checkDeclarationValue = (pseudoAttributeName: string, value: string, encoding: XmlSourceEncoding): void => {
  if (pseudoAttributeName === "version" && !VERSION_NUMBER_PATTERN.test(value)) throw xmlRefusal("malformed XML declaration");
  if (pseudoAttributeName === "standalone" && value !== "yes" && value !== "no") throw xmlRefusal("malformed XML declaration");
  if (pseudoAttributeName !== "encoding") return;
  if (!ENCODING_NAME_PATTERN.test(value)) throw xmlRefusal("malformed XML declaration");
  if (encoding === "UTF-16LE" || encoding === "UTF-16BE") {
    if (value.toLowerCase() !== "utf-16") throw xmlRefusal("declared encoding does not match the bytes");
    return;
  }
  const declaredEncoding = canonicalizeEncodingLabel(value);
  if (declaredEncoding === undefined) throw xmlRefusal("unknown encoding declared");
  if (declaredEncoding !== (encoding === "UTF-8" ? "utf-8" : encoding)) throw xmlRefusal("declared encoding does not match the bytes");
};

/** One forward pass over `source`; `position` is the read position, shared by the methods below. */
class Lexer {
  private position = 0;
  private readonly sourceLength: number;

  constructor(
    private readonly source: string,
    private readonly visitor: XmlTokenVisitor,
    private readonly encoding: XmlSourceEncoding,
  ) {
    this.sourceLength = source.length;
  }

  run(): void {
    const { source } = this;
    if (source.charCodeAt(0) === 0xfeff) this.position = 1;
    if (this.isAtDeclaration()) this.readDeclaration();
    while (this.position < this.sourceLength) {
      if (source.charCodeAt(this.position) !== LESS_THAN || source.startsWith("<!--", this.position)) {
        const value = this.readText();
        if (value.length > 0) this.visitor.text(value);
        continue;
      }
      this.readMarkup();
    }
  }

  private isAtDeclaration(): boolean {
    const after = this.source.charCodeAt(this.position + 5);
    return this.source.startsWith("<?xml", this.position) && (isSpace(after) || after === QUESTION_MARK);
  }

  /** The markup starting at `position` (on `<`, not on a comment): an end tag, a start tag, a processing instruction or a CDATA section. */
  private readMarkup(): void {
    const next = this.source.charCodeAt(this.position + 1);
    if (next === SOLIDUS) {
      this.readEndTag();
      return;
    }
    if (next === QUESTION_MARK) {
      this.readInstruction();
      return;
    }
    if (next === EXCLAMATION_MARK) {
      this.readCdata();
      return;
    }
    this.readStartTag();
  }

  /** The code point at `at` (a well-formed surrogate pair read as one), or -1 at the end. */
  private codePointAt(at: number): number {
    return at < this.sourceLength ? (this.source.codePointAt(at) ?? -1) : -1;
  }

  /** A Name starting at `position`; leaves `position` after it. `isObjectKey`: the name becomes a key of a plain object. */
  private readName(isObjectKey = true): string {
    const start = this.position;
    const first = this.codePointAt(this.position);
    if (first < 0 || !isNameStart(first)) throw xmlRefusal("malformed name");
    this.position += getCodeUnitWidth(first);
    for (let codePoint = this.codePointAt(this.position); codePoint >= 0 && isNameChar(codePoint); codePoint = this.codePointAt(this.position)) this.position += getCodeUnitWidth(codePoint);
    const name = this.source.slice(start, this.position);
    if (isObjectKey && JS_RESERVED_NAMES.has(name)) throw xmlRefusal("name reserved by JavaScript objects");
    return name;
  }

  private skipSpaces(): boolean {
    const start = this.position;
    while (this.position < this.sourceLength && isSpace(this.source.charCodeAt(this.position))) this.position++;
    return this.position > start;
  }

  /** A reference starting at `position` (on `&`); leaves `position` after its `;`. */
  private readReference(): string {
    this.position++;
    if (this.source.charCodeAt(this.position) !== NUMBER_SIGN) return this.readEntityReference();
    this.position++;
    return this.readCharacterReference();
  }

  /** A character reference after `&#`; leaves `position` after its `;`. */
  private readCharacterReference(): string {
    const isHexadecimal = this.source.charCodeAt(this.position) === 0x78; // x; §4.1 spells it lower-case only
    if (isHexadecimal) this.position++;
    const radix = isHexadecimal ? 16 : 10;
    let value = 0;
    let digits = 0;
    for (; this.position < this.sourceLength; this.position++, digits++) {
      const digit = getDigitValue(this.source.charCodeAt(this.position), isHexadecimal);
      if (digit < 0) break;
      value = value * radix + digit;
      if (value > LAST_UNICODE_CODE_POINT) throw xmlRefusal("character reference out of range");
    }
    if (digits === 0 || this.source.charCodeAt(this.position) !== SEMICOLON) throw xmlRefusal("malformed character reference");
    this.position++;
    if (!isChar(value)) throw xmlRefusal("character reference to a forbidden character");
    return String.fromCodePoint(value);
  }

  /** One of the five predefined entity references after `&`; leaves `position` after its `;`. */
  private readEntityReference(): string {
    const start = this.position;
    while (this.position < this.sourceLength && this.position - start <= LONGEST_PREDEFINED_ENTITY_NAME_LENGTH && this.source.charCodeAt(this.position) !== SEMICOLON) this.position++;
    const replacement = this.source.charCodeAt(this.position) === SEMICOLON ? PREDEFINED_ENTITIES[this.source.slice(start, this.position)] : undefined;
    if (replacement === undefined) throw xmlRefusal("entity reference other than the five predefined ones");
    this.position++;
    return replacement;
  }

  /** Checks the character at `position` against §2.2 Char and returns its width in code units. */
  private checkedWidth(): number {
    const codePoint = this.codePointAt(this.position);
    // A lone surrogate comes back from codePointAt as itself, outside Char.
    if (!isChar(codePoint)) throw xmlRefusal("forbidden character");
    return getCodeUnitWidth(codePoint);
  }

  /** A comment starting at `position` (on `<!--`); leaves `position` after its `-->`. */
  private skipComment(): void {
    this.position += 4;
    for (;;) {
      if (this.position >= this.sourceLength) throw xmlRefusal("unterminated comment");
      if (this.source.charCodeAt(this.position) === HYPHEN_MINUS && this.source.charCodeAt(this.position + 1) === HYPHEN_MINUS) {
        if (this.source.charCodeAt(this.position + 2) !== GREATER_THAN) throw xmlRefusal("'--' inside a comment");
        this.position += 3;
        return;
      }
      this.position += this.checkedWidth();
    }
  }

  /** Raw characters from `position` up to `terminator` (excluded), checked against Char, line ends normalised; leaves `position` after
   *  `terminator`. `terminator` is compared only where its first character stands: each position is looked at a bounded number of times. */
  private readUntil(terminator: string, unterminated: string): string {
    const first = terminator.charCodeAt(0);
    let decodedText = "";
    let runStart = this.position;
    for (;;) {
      if (this.position >= this.sourceLength) throw xmlRefusal(unterminated);
      const charCode = this.source.charCodeAt(this.position);
      if (charCode === first && this.source.startsWith(terminator, this.position)) break;
      if (charCode === CARRIAGE_RETURN) {
        decodedText = this.appendNormalizedLineEnd(decodedText, runStart);
        runStart = this.position;
      } else {
        this.position += this.checkedWidth();
      }
    }
    decodedText += this.source.slice(runStart, this.position);
    this.position += terminator.length;
    return decodedText;
  }

  /** A processing instruction starting at `position` (on `<?`). */
  private readInstruction(): void {
    this.position += 2;
    if (this.position >= this.sourceLength) throw xmlRefusal("unterminated processing instruction");
    const target = this.readName(false);
    if (target.toLowerCase() === "xml") throw xmlRefusal("reserved processing instruction target");
    if (this.source.startsWith("?>", this.position)) {
      this.position += 2;
      this.visitor.processingInstruction?.(target, "");
      return;
    }
    if (!this.skipSpaces()) {
      if (this.position >= this.sourceLength) throw xmlRefusal("unterminated processing instruction");
      throw xmlRefusal("malformed processing instruction");
    }
    const data = this.readUntil("?>", "unterminated processing instruction");
    this.visitor.processingInstruction?.(target, data);
  }

  /** A CDATA section starting at `position` (on `<!`, not `<!--`); any other `<!` is refused. */
  private readCdata(): void {
    if (!this.source.startsWith("<![CDATA[", this.position)) throw xmlRefusal("document type or markup declaration");
    this.position += 9;
    const value = this.readUntil("]]>", "unterminated CDATA section");
    if (this.visitor.cdata) {
      this.visitor.cdata(value);
      return;
    }
    if (value.length > 0) this.visitor.text(value);
  }

  /** A CR (alone or before an LF) at `position` read as one LF; returns the text so far with it appended. */
  private appendNormalizedLineEnd(decodedText: string, runStart: number): string {
    const text = decodedText + this.source.slice(runStart, this.position) + "\n";
    this.position += this.source.charCodeAt(this.position + 1) === LINE_FEED ? 2 : 1;
    return text;
  }

  /** Character data from `position` up to the next `<` that does not open a comment, or the end. */
  private readText(): string {
    let decodedText = "";
    let runStart = this.position;
    while (this.position < this.sourceLength) {
      const charCode = this.source.charCodeAt(this.position);
      if (charCode === LESS_THAN) {
        if (!this.source.startsWith("<!--", this.position)) break;
        decodedText += this.source.slice(runStart, this.position);
        this.skipComment();
        runStart = this.position;
      } else if (charCode === AMPERSAND) {
        decodedText += this.source.slice(runStart, this.position) + this.readReference();
        runStart = this.position;
      } else if (charCode === CARRIAGE_RETURN) {
        decodedText = this.appendNormalizedLineEnd(decodedText, runStart);
        runStart = this.position;
      } else if (charCode === RIGHT_SQUARE_BRACKET && this.source.startsWith("]]>", this.position)) {
        throw xmlRefusal("']]>' in character data");
      } else {
        this.position += this.checkedWidth();
      }
    }
    return decodedText + this.source.slice(runStart, this.position);
  }

  /** A quoted attribute value starting at `position` (on its quote); leaves `position` after the closing quote. */
  private readAttributeValue(): string {
    const quote = this.source.charCodeAt(this.position);
    if (quote !== QUOTATION_MARK && quote !== APOSTROPHE) throw xmlRefusal("attribute value without quotes");
    this.position++;
    let decodedText = "";
    let runStart = this.position;
    for (;;) {
      if (this.position >= this.sourceLength) throw xmlRefusal("unterminated attribute value");
      const charCode = this.source.charCodeAt(this.position);
      if (charCode === quote) break;
      if (charCode === LESS_THAN) throw xmlRefusal("'<' in an attribute value");
      if (charCode === AMPERSAND) {
        decodedText += this.source.slice(runStart, this.position) + this.readReference();
        runStart = this.position;
      } else if (charCode === CARRIAGE_RETURN) {
        decodedText = this.appendNormalizedLineEnd(decodedText, runStart);
        runStart = this.position;
      } else {
        this.position += this.checkedWidth();
      }
    }
    decodedText += this.source.slice(runStart, this.position);
    this.position++;
    return decodedText;
  }

  /** One `name = "value"` attribute starting at `position`. */
  private readAttribute(): [string, string] {
    const attribute = this.readName();
    this.skipSpaces();
    if (this.source.charCodeAt(this.position) !== EQUALS_SIGN) throw xmlRefusal("attribute without a value");
    this.position++;
    this.skipSpaces();
    return [attribute, this.readAttributeValue()];
  }

  /** A start or empty-element tag starting at `position` (on `<`). */
  private readStartTag(): void {
    this.position++;
    const name = this.readName();
    const attributes: [string, string][] = [];
    let seenAttributeNames: Set<string> | undefined;
    for (;;) {
      const hasWhiteSpace = this.skipSpaces();
      if (this.position >= this.sourceLength) throw xmlRefusal("unterminated tag");
      if (this.endsStartTag(name, attributes)) return;
      if (!hasWhiteSpace) throw xmlRefusal("attributes not separated by white space");
      if (attributes.length === MAX_XML_ATTRIBUTES) throw xmlRefusal("more attributes on one element than the limit");
      const attribute = this.readAttribute();
      seenAttributeNames ??= new Set();
      if (seenAttributeNames.has(attribute[0])) throw xmlRefusal("repeated attribute");
      seenAttributeNames.add(attribute[0]);
      attributes.push(attribute);
    }
  }

  /** At `position`, a `>` or `/>` ends the start tag: reports the element and returns true. Anything else: false. */
  private endsStartTag(name: string, attributes: readonly (readonly [string, string])[]): boolean {
    const charCode = this.source.charCodeAt(this.position);
    if (charCode === GREATER_THAN) {
      this.position++;
      this.visitor.open(name, attributes, false);
      return true;
    }
    if (charCode !== SOLIDUS) return false;
    if (this.source.charCodeAt(this.position + 1) !== GREATER_THAN) throw xmlRefusal("malformed tag");
    this.position += 2;
    this.visitor.open(name, attributes, true);
    return true;
  }

  /** An end tag starting at `position` (on `</`). */
  private readEndTag(): void {
    this.position += 2;
    const name = this.readName();
    this.skipSpaces();
    if (this.source.charCodeAt(this.position) !== GREATER_THAN) throw xmlRefusal("malformed end tag");
    this.position++;
    this.visitor.close(name);
  }

  /** §2.8 XMLDecl at `position` (on `<?xml` followed by white space). Each
   *  pseudo-attribute is checked as soon as it is read (version first and
   *  required, then encoding, then standalone, each at most once): nothing
   *  is collected before it is judged. */
  private readDeclaration(): void {
    this.position += 5;
    let lastRank = -1;
    for (;;) {
      const hasWhiteSpace = this.skipSpaces();
      if (this.source.startsWith("?>", this.position)) {
        this.position += 2;
        break;
      }
      if (!hasWhiteSpace || this.position >= this.sourceLength) throw xmlRefusal("malformed XML declaration");
      lastRank = this.readPseudoAttribute(lastRank);
    }
    if (lastRank < 0) throw xmlRefusal("malformed XML declaration");
  }

  /** One pseudo-attribute of the declaration at `position`, after the rank `previousRank` of the previous one; returns its own rank. */
  private readPseudoAttribute(previousRank: number): number {
    const start = this.position;
    while (this.position < this.sourceLength && this.source.charCodeAt(this.position) >= 0x61 && this.source.charCodeAt(this.position) <= 0x7a) this.position++;
    const pseudoAttributeName = this.source.slice(start, this.position);
    const rank = DECLARATION_ORDER.indexOf(pseudoAttributeName);
    if (rank <= previousRank || (previousRank < 0 && rank !== 0)) throw xmlRefusal("malformed XML declaration");
    this.skipSpaces();
    if (this.source.charCodeAt(this.position) !== EQUALS_SIGN) throw xmlRefusal("malformed XML declaration");
    this.position++;
    this.skipSpaces();
    const value = this.readDeclarationValue();
    checkDeclarationValue(pseudoAttributeName, value, this.encoding);
    return rank;
  }

  /** A quoted pseudo-attribute value at `position` (on its quote); leaves `position` after the closing quote. */
  private readDeclarationValue(): string {
    const quote = this.source.charCodeAt(this.position);
    if (quote !== QUOTATION_MARK && quote !== APOSTROPHE) throw xmlRefusal("malformed XML declaration");
    let closingQuoteIndex = this.position + 1;
    while (closingQuoteIndex < this.sourceLength && closingQuoteIndex - this.position <= DECLARATION_VALUE_SEARCH && this.source.charCodeAt(closingQuoteIndex) !== quote) closingQuoteIndex++;
    // Our own ceiling (a value of 64 characters or more), not a well-formedness violation: told apart from a quote missing at end of input.
    if (closingQuoteIndex - this.position > DECLARATION_VALUE_SEARCH) throw xmlRefusal("XML declaration value too long");
    if (this.source.charCodeAt(closingQuoteIndex) !== quote) throw xmlRefusal("malformed XML declaration");
    const value = this.source.slice(this.position + 1, closingQuoteIndex);
    this.position = closingQuoteIndex + 1;
    return value;
  }
}

/** Reads `source` and reports its tags and character data to `visitor`.
 *  Throws `xmlRefusal(…)` on the first construct it does not accept. */
export function tokenize(source: string, visitor: XmlTokenVisitor, encoding: XmlSourceEncoding = "UTF-8"): void {
  new Lexer(source, visitor, encoding).run();
}
