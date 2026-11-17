/** The GLYPHS a page paints, read by OUR reader: what pdf.js's `showText` carried before its removal (01/11/2026)
 *  (ISO 32000-1:2008 §9.4.3 for the text operators, §9.3.3 for the word space, §9.10.2 for unicode).
 *  Decides: nothing about geometry — no matrix, no position, no order. It only gives the THREE fields that
 *  `glyph-positions.ts` reads from each glyph: its text (`unicode`), its advance in thousandths of an em (`width`) and
 *  whether it carries the word space (`isSpace`). It decides one thing: a font that does not know what a code paints
 *  returns `undefined` rather than an invented character (31/10/2026: "we abstain").
 *  §9.3.3: `Tw` applies only to code 32 of a ONE-byte font — never to a composite font, even if its
 *  code is 32. That was pdf.js's rule, kept and held by measurement.
 *  🔴 ONE PAGE AT A TIME, ON DEMAND (security review of 31/10/2026): the first version returned the glyphs of
 *  ALL the pages at once, so a five-hundred-page document held fifty million objects before anyone
 *  could count — whereas the product bounds one page at a time. Opening therefore reads no
 *  page: it says how many there are, and each page is read when asked for.
 *  NOT here: glyph positions and matrices (`extractor/glyph-positions.ts`), cycles
 *  (`extractor/glyph-runs.ts`), the boundary that chooses the source (`extractor/pdf-source.ts`), the text of a code
 *  (`pdf-fonts/font-text.ts`) and its advance (`pdf-fonts/widths.ts`).
 *  Called by: `extractor/pdf-source.ts` (the whole source), `extractor/pdf-ops-ours.ts` and `extractor/pdf-font-bridge.ts`
 *  (the glyphs of one shown string, and the form-call charge), and the benches `tools/bench/app-caps.ts` and
 *  `tools/bench/corpus-manifest.ts`. */

import { MAX_FORM_CALLS_PER_PAGE } from "./pdf-objects/bounds";
import { readContentOps, type ContentOp } from "./pdf-objects/content";
import { pageContentOf, parsedFormOf } from "./pdf-page-content";
import { openPdfObjects, type PdfObjectsDocument } from "./pdf-objects/document";
import type { PdfDict, PdfValue } from "./pdf-objects/objects";
import { PdfObjectsRefusal } from "./pdf-objects/refusal";
import { fontDeclaredText, fontText, type FontTextMemo } from "./pdf-fonts/font-text";
import type { TableBudget } from "./pdf-fonts/table-budget";
import { unicodeCodeForm, unicodeCodes } from "./pdf-fonts/predefined-cmaps";
import { fontWidths } from "./pdf-fonts/widths";

/** A painted glyph, reduced to what the position layer reads. `undefined` text = we abstain. */
export interface OurGlyph {
  readonly unicode: string | undefined;
  readonly width: number | undefined;
  readonly isSpace: boolean;
  /** WHO read this glyph, and that distinction decides what we publish.
   *  - `"ours"`: read with the font the page declares. A missing `unicode` is then an INFORMED ABSTENTION —
   *    we have the font and its encoding, and nothing says what this code paints. We publish nothing (
   *    31/10/2026: "we abstain"), because pdf.js re-read the glyph NUMBER there as a code point (HISTORICAL).
   *  - `"default-font"`: the page declares NO font under the name used, and we read with the default one,
   *    the same as pdf.js's (`FALLBACK_FONT`). That is a reading, not an abstention.
   *  - `"not-ours"`: we know we LACK the machinery to read this font — a Type0 whose
   *    `/Encoding` is an Adobe PREDEFINED CMap, which only the resources embedded in pdf.js decoded.
   *    This is not a verdict on the file, it is an ignorance on our side. `pdf-glyph-swap.ts` (deleted, see git history) used to leave
   *    pdf.js's glyph intact then; pdf.js being removed (01/11/2026), the glyph has neither text nor advance. Without this
   *    third value, 1 050 words of a real safedocs file fell to 72. A font whose tables threw (`stateOf`) reads the same.
   *    Since 17/11/2026 a page showing such a glyph carries a `pdf-text-unread` notice of reason `font`. */
  readonly read: "ours" | "default-font" | "not-ours";
}

/** §8.10: forms nested deeper are not followed. */
export const MAX_FORM_DEPTH = 8;
/** §8.4.4: as many graphics-state levels as pdf.js kept. */
export const MAX_STATE_DEPTH = 256;
/** Glyphs ONE page may paint.
 *  🔴 WHY (security review of 31/10/2026): one object is made per painted byte, and nothing bounded it.
 *  `MAX_CONTENT_NODES` cannot see it — a painted string is ONE node whatever its length, so a
 *  `Tj` costs two nodes whether it paints two bytes or sixty-four megabytes. A page whose stream decompresses
 *  64 MB of `(AAAA…) Tj` — a bomb of about 70 KB — thus made sixty million objects, on the order of
 *  three gigabytes, while the document budget read 64 MB out of 200.
 *  ARBITRARY threshold: one million, the same order as the operator ceiling. The densest real page measured
 *  carries 8 990 characters (`fixtures/pdf/46` page 10, 03/10/2026), so a hundred times less. */
export const MAX_SHOWN_GLYPHS_PER_PAGE = 1_000_000;

const nameOf = (value: PdfValue | undefined): string | undefined => (value?.kind === "name" ? value.value : undefined);

/** The text state that `q`/`Q` saves and restores — the font IS PART OF IT (§8.4.1, Table 52). */
export interface TextState {
  text: (code: number) => string | undefined;
  width: (code: number) => number | undefined;
  /** The CODES of a painted string. One byte per code for a simple font, two for a Type0 in `Identity`
   *  or `UCS2`, and TWO OR FOUR for a `UTF16`, whose code space carries a range of surrogate
   *  pairs (`pdf-fonts/predefined-cmaps.ts#unicodeCodes`). */
  codesOf: (bytes: Uint8Array) => number[];
  /** True for a ONE-byte-per-code font, the only one to which §9.3.3 applies the word space. */
  singleByte: boolean;
  /** What the CMap DECLARES for a code where the filter refused to publish: the half-pair of an emoji, which a
   *  neighbouring code completes (`pdf-fonts/font-text.ts#fontDeclaredText`). Used for pairing, and nothing else. */
  declared: (code: number) => string | undefined;
  /** Who reads this font: see `OurGlyph.read`. */
  read: OurGlyph["read"];
}

/** 🔴 THE DEFAULT FONT, AND IT IS EXACTLY THE ONE pdf.js USED (31/10/2026: "of course we need a default
 *  font, do as pdf.js").
 *  WHY IT EXISTS: a stream may paint with a name that the page resources do not declare —
 *  `/Helvetica 10 Tf` with no entry in `/Font`. That is outside §9.6, but real producers do it, and
 *  pdf-lib's `pushOperators` is one. Without a default font we had nothing to say about those codes, and a
 *  WHOLE SENTENCE disappeared from a document that pdf.js read correctly
 *  (`pdf-synthetic-italic-order.test.ts`, found by the full `check` of 31/10/2026).
 *  WHAT IT IS WORTH is an external fact, so a TEST holds it and not this comment
 *  (`pdf-glyph-source.test.ts`, "la police par défaut est celle de pdf.js"): Helvetica, WinAnsiEncoding, and
 *  a SIMPLE font — one byte per code.
 *  Written limit, and it was the same as pdf.js's: if the font really used was COMPOSITE, reading
 *  its codes on one byte invents two where one was needed. So we do no worse than what the
 *  product did before the switch, and none of the 304 files measured is in that case. */
const FALLBACK_FONT: PdfDict = new Map<string, PdfValue>([
  ["BaseFont", { kind: "name", value: "Helvetica" }],
  ["Subtype", { kind: "name", value: "Type1" }],
  ["Encoding", { kind: "name", value: "WinAnsiEncoding" }],
]);

/** A font we cannot read: neither text nor advance (`pdf-glyph-swap.ts` (deleted, see git history) used to leave its glyphs to pdf.js, removed on 01/11/2026).
 *  ⚠️ `perGlyph` STILL COUNTS, and that is subtle: it decides how many glyphs our array carries, so whether
 *  the pairing with pdf.js (historical) failed. For a COMPOSITE font we keep two bytes per code — what the fixed-width
 *  predefined CMaps like `UniCNS-UCS2-H` do — so that only THOSE glyphs stay unreadable and
 *  the rest of the page is still read by us. For a MIXED-byte CMap (`90ms-RKSJ-H`) the count
 *  does not fall, we do not know where its glyphs start: that was the fallback on pdf.js, which no longer exists. */
const notOurs = (bytesPerCode: number): TextState => ({
  text: () => undefined,
  width: () => undefined,
  declared: () => undefined,
  codesOf: (bytes) => fixedCodes(bytes, bytesPerCode),
  singleByte: bytesPerCode === 1,
  read: "not-ours",
});

/** The codes of a FIXED-width string: one byte (simple font) or two (composite in `Identity` or `UCS2`).
 *  A byte left over at the end of the string still counts as a code: the NUMBER of glyphs must stay that
 *  of the painted bytes, otherwise the pairing with pdf.js (historical) failed on a malformed file. */
function fixedCodes(bytes: Uint8Array, step: number): number[] {
  const codes: number[] = [];
  for (let at = 0; at < bytes.length; at += step) {
    let code = 0;
    for (let i = 0; i < step && at + i < bytes.length; i += 1) code = code * 256 + (bytes[at + i] as number);
    codes.push(code);
  }
  return codes;
}

/** Before any `Tf`, and for an unreadable font: one byte per code, for lack of better. */
export const UNKNOWN: TextState = notOurs(1);

/** What a page shares with the others: the fonts already read, and the `/ToUnicode` tables already read.
 *  🔴 BOTH ARE AT DOCUMENT SCALE (security review of 31/10/2026): the `/ToUnicode` table was held
 *  per font DICTIONARY, so five hundred fonts naming the same sixty-byte object held five
 *  hundred tables of 65 536 entries — about three gigabytes for a 60 KB file, whose budget saw
 *  only 500 × 60 bytes. A table is read per OBJECT, and once. */
export interface GlyphMemo {
  readonly fonts: Map<PdfDict, TextState>;
  readonly cmaps: FontTextMemo;
  /** The entries of the font tables kept so far, ALL fonts together (`MAX_FONT_TABLE_ENTRIES_PER_DOCUMENT`). */
  readonly tables: TableBudget;
}

/** An empty memo: one per DOCUMENT, so the font-table budget is the document's. */
export const newGlyphMemo = (): GlyphMemo => ({ fonts: new Map(), cmaps: new Map(), tables: { entries: 0 } });

/** The functions of a font, built once per font dictionary. */
export function stateOf(doc: PdfObjectsDocument, declared: PdfDict | undefined, memo: GlyphMemo): TextState {
  // No font under this name: the default one, as pdf.js does (see `FALLBACK_FONT`).
  const font = declared ?? FALLBACK_FONT;
  const known = memo.fonts.get(font);
  if (known !== undefined) return known;

  // 🔴 WHAT WE CANNOT READ, AND SAY SO INSTEAD OF ABSTAINING (31/10/2026, found by the full
  // `check`). A Type0 whose `/Encoding` is an Adobe PREDEFINED CMap (`UniCNS-UCS2-H`, `90ms-RKSJ-H`…)
  // asks for two things we do not have: the code → CID table of that CMap, and its split into bytes,
  // which is not uniformly two for all of them (§9.7.5, §9.7.6.2). Only the Adobe CMap resources
  // embedded in pdf.js decoded them (HISTORICAL: removed on 01/11/2026). Abstaining here dropped 1 050 words of a real safedocs file to 72, and
  // an English title came out as "Ể Ệ ƯƠ". So we left those glyphs to pdf.js, intact; today they are said to be unread (`read: "not-ours"`).
  // `Identity-H`/`Identity-V` stay ours: the code IS the CID, and that is the encoding of the 1 156 Type0 fonts
  // of the 304 files measured.
  const composite = nameOf(doc.resolve(font.get("Subtype"))) === "Type0";
  const encoding = composite ? nameOf(doc.resolve(font.get("Encoding"))) : undefined;
  // `Identity-H/V`: the code IS the CID. A `UniXXX-{UCS2,UTF16}-[HV]`: the code IS the Unicode code point,
  // so its TEXT is read (`pdf-fonts/predefined-cmaps.ts`) even if its advance needs the CID and abstains.
  const codeForm = encoding === undefined ? undefined : unicodeCodeForm(encoding);
  if (composite && encoding?.startsWith("Identity") !== true && codeForm === undefined) {
    const state = notOurs(2);
    memo.fonts.set(font, state);
    return state;
  }

  let state: TextState;
  try {
    state = {
      text: fontText(doc, font, memo.cmaps, memo.tables),
      declared: fontDeclaredText(doc, font, memo.cmaps, memo.tables),
      width: fontWidths(doc, font, memo.tables),
      // A `UTF16` cuts its codes itself: two bytes, four for a surrogate pair.
      codesOf: (bytes) => codesOfString(bytes, codeForm, composite),
      singleByte: !composite,
      read: declared === undefined ? "default-font" : "ours",
    };
  } catch (error) {
    // A refusal of the document (budget exhausted, unreadable stream) stays a refusal: we do not turn it into an abstention.
    if (error instanceof PdfObjectsRefusal) throw error;
    // A font we cannot read does not fail the page, and gets NO stand-in table (17/11/2026): its glyphs carry
    // `read: "not-ours"`, neither text nor advance, and the page says its words are missing when the filter of the published text would have kept them
    // (`glyph-positions.ts#unreadFontKept`).
    state = UNKNOWN;
  }
  memo.fonts.set(font, state);
  return state;
}

/** The codes of a painted string: a `UTF16` CMap cuts its own codes, any other font has a fixed width. */
function codesOfString(bytes: Uint8Array, codeForm: ReturnType<typeof unicodeCodeForm>, composite: boolean): number[] {
  if (codeForm === "utf16") return unicodeCodes(bytes, "utf16");
  return fixedCodes(bytes, composite ? 2 : 1);
}

/** What a page has already painted and unrolled, so that the ceilings apply to the PAGE and not to one operator. */
export interface GlyphBudget {
  painted: number;
  /** Form XObjects expanded so far (`MAX_FORM_CALLS_PER_PAGE`). */
  forms: number;
}

/** Counts one more form expansion on the page, and refuses the page past the ceiling. */
export function chargeFormCall(budget: Pick<GlyphBudget, "forms">): void {
  budget.forms += 1;
  if (budget.forms > MAX_FORM_CALLS_PER_PAGE) throw new PdfObjectsRefusal("forms-too-many");
}

const isHighSurrogate = (text: string | undefined): boolean =>
  text?.length === 1 && text.charCodeAt(0) >= 0xd800 && text.charCodeAt(0) <= 0xdbff;
const isLowSurrogate = (text: string | undefined): boolean =>
  text?.length === 1 && text.charCodeAt(0) >= 0xdc00 && text.charCodeAt(0) <= 0xdfff;

/** The glyphs of a painted string, cut according to the font's code width.
 *  🔴 THE PAIRING OF HALF-PAIRS IS DONE HERE (31/10/2026: "we have to do it ourselves", for
 *  emojis), because this is the only place that sees the SEQUENCE of painted codes. A producer may write the
 *  UTF-16 units as CIDs — FreeMono and DejaVuSans by LibreOffice do —, so an emoji takes two
 *  neighbouring codes whose CMap each declares one half. `pdf-fonts/to-unicode.ts` refuses them one by one, rightly,
 *  and keeps what it declared (`state.declared`): two halves THAT FOLLOW EACH OTHER and complete each other
 *  spell a real character, which is returned on the FIRST of the two glyphs.
 *  What we do NOT pair, and each has its test: a high half followed by something else, a low half that
 *  comes first, and two halves separated by the end of a text operator — there, nothing says they are
 *  the same letters, and pairing would invent a character. Before this pairing, pdf.js returned the emoji PLUS an invented
 *  astral character (U+B0000); we returned nothing of the two. */
export function glyphsOfString(bytes: Uint8Array, state: TextState, into: OurGlyph[], budget: GlyphBudget): void {
  const codes = state.codesOf(bytes);

  for (const [index, code] of codes.entries()) {
    budget.painted += 1;
    if (budget.painted > MAX_SHOWN_GLYPHS_PER_PAGE) throw new PdfObjectsRefusal("glyphs-too-many");
    let unicode = state.text(code);
    if (unicode === "") {
      const mine = state.declared(code);
      const next = codes[index + 1];
      const theirs = next === undefined ? undefined : state.declared(next);
      // A high half FOLLOWED by a low one, in the same painting: the two spell a character.
      if (isHighSurrogate(mine) && isLowSurrogate(theirs)) unicode = `${mine as string}${theirs as string}`;
    }
    into.push({
      unicode,
      width: state.width(code),
      // §9.3.3: the word space applies only to code 32 of a one-byte font.
      isSpace: state.singleByte && code === 32,
      read: state.read,
    });
  }
}

/** A text operator of a page: the glyphs it paints, in stream order. */
export type ShownGlyphs = readonly OurGlyph[];

/** What `walk` shares across a page's streams: the document, the output, the memo and the page's glyph budget. */
interface Walking {
  readonly doc: PdfObjectsDocument;
  readonly into: ShownGlyphs[];
  readonly memo: GlyphMemo;
  readonly budget: GlyphBudget;
}

/** `q` saves the state (up to the depth ceiling), `Q` restores the last one saved; returns the state in force. */
function afterGraphicsState(op: string, state: TextState, saved: TextState[]): TextState {
  if (op === "q") {
    if (saved.length < MAX_STATE_DEPTH) saved.push(state);
    return state;
  }
  return saved.pop() ?? state;
}

/** The glyphs one show operator paints, or `undefined` when the operator shows nothing. */
function shownGlyphs(
  op: string,
  operands: readonly PdfValue[],
  state: TextState,
  budget: GlyphBudget,
): OurGlyph[] | undefined {
  const glyphs: OurGlyph[] = [];
  if (op === "Tj" || op === "'" || op === '"') {
    const shown = operands[operands.length - 1];
    if (shown?.kind === "string") glyphsOfString(shown.bytes, state, glyphs, budget);
    return glyphs;
  }
  if (op === "TJ") {
    const array = operands[0];
    if (array?.kind !== "array") return glyphs;
    for (const item of array.items) if (item.kind === "string") glyphsOfString(item.bytes, state, glyphs, budget);
    return glyphs;
  }
  return undefined;
}

/** The state a `Tf` selects: the named font of the resources, or the default when it names none. */
function fontStateOf(walking: Walking, fonts: PdfDict | undefined, operands: readonly PdfValue[]): TextState {
  const name = nameOf(operands[0]);
  return stateOf(walking.doc, name === undefined ? undefined : walking.doc.dictOf(fonts?.get(name)), walking.memo);
}

/** A `Do` of a Form XObject: its own stream, walked one level deeper. Anything else is ignored. */
function walkForm(
  walking: Walking,
  operands: readonly PdfValue[],
  scope: { readonly resources: PdfDict | undefined; readonly xobjects: PdfDict | undefined },
  depth: number,
  state: TextState,
): void {
  const { doc } = walking;
  const { resources, xobjects } = scope;
  const name = nameOf(operands[0]);
  const target = name === undefined ? undefined : doc.resolve(xobjects?.get(name));
  if (target?.kind !== "stream" || nameOf(doc.resolve(target.dict.get("Subtype"))) !== "Form") return;
  // §8.10.1: the form carries its own resources, or the page's when it declares none.
  const own = doc.dictOf(target.dict.get("Resources")) ?? resources;
  chargeFormCall(walking.budget);
  walk(walking, parsedFormOf(doc, target), own, depth + 1, state);
}

/** The text operators of a stream, in order, forms unrolled as pdf.js unrolled them. */
function walk(
  walking: Walking,
  ops: readonly ContentOp[],
  resources: PdfDict | undefined,
  depth: number,
  inherited: TextState,
): void {
  const fonts = walking.doc.dictOf(resources?.get("Font"));
  const xobjects = walking.doc.dictOf(resources?.get("XObject"));
  let state = inherited;
  const saved: TextState[] = [];

  for (const { op, operands } of ops) {
    if (op === "q" || op === "Q") {
      state = afterGraphicsState(op, state, saved);
      continue;
    }
    if (op === "Tf") {
      state = fontStateOf(walking, fonts, operands);
      continue;
    }
    const glyphs = shownGlyphs(op, operands, state, walking.budget);
    if (glyphs !== undefined) {
      walking.into.push(glyphs);
      continue;
    }
    if (op === "Do" && depth < MAX_FORM_DEPTH) walkForm(walking, operands, { resources, xobjects }, depth, state);
  }
}

/** The glyphs of a document, ONE PAGE AT A TIME. */
export interface OurGlyphSource {
  /** How many pages the document carries. None is read to say it. */
  readonly pageCount: number;
  /** THE open document, shared: the Symbol verdict (`pdf-symbol-page.ts`) reads its font dictionaries. Only
   *  one opening per document — reopening it would cost the whole parse a second time. */
  readonly document: PdfObjectsDocument;
  /** The text operators of the page at index `index`, read at the call.
   *  Throws what our reader throws (`PdfObjectsRefusal`): the caller no longer has a fallback reading (pdf.js's, removed on 01/11/2026). */
  glyphsOfPage(index: number): readonly ShownGlyphs[];
  /** What every page of this document shares: its fonts, its CMaps and the count of table entries kept (a DOCUMENT budget). */
  readonly memo: GlyphMemo;
  /** The entries of the font tables this document has made us keep so far (what `MAX_FONT_TABLE_ENTRIES_PER_DOCUMENT` bounds). */
  tableEntries(): number;
}

/** Opens a document for its glyphs, WITHOUT reading a single page.
 *  Throws what our reader throws if the structure itself cannot be read. */
export function openOurGlyphs(bytes: Uint8Array): OurGlyphSource {
  const doc = openPdfObjects(bytes);
  const pages = doc.pages();
  const memo = newGlyphMemo();

  return {
    pageCount: pages.length,
    document: doc,
    memo,
    tableEntries: () => memo.tables.entries,
    glyphsOfPage: (index) => {
      const page = pages[index];
      if (page === undefined) throw new PdfObjectsRefusal("page-missing");
      const into: ShownGlyphs[] = [];
      walk(
        { doc, into, memo, budget: { painted: 0, forms: 0 } },
        readContentOps(pageContentOf(doc, page)),
        page.resources,
        0,
        UNKNOWN,
      );
      return into;
    },
  };
}
