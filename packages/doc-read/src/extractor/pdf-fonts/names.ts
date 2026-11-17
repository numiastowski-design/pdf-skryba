/** From a glyph NAME to the text it paints, and from a simple font's `/Encoding` to its 256 names
 *  (ISO 32000-1:2008 §9.6.6 and Annex D for the encodings, §9.10.2 for what a name says of its text, plus
 *  Adobe's `uniXXXX` / `uXXXXXX` conventions).
 *  Decides: that a name we cannot read gives `undefined` — an ABSTENTION, never an invented character, because
 *  this is where fabricated words would come from; that a variant suffix is dropped (`a.sc` is an `a`, §9.10.2);
 *  that a SYMBOLIC font with no `/Encoding` gets NO name at all, since its encoding lives in its font program,
 *  which we do not read — while its `/Differences` are kept, being declared rather than guessed; and that a
 *  non-symbolic font with no `/Encoding` falls back to Standard (§9.6.6.2).
 *  WHY IT EXISTS: it is the second half of what pdf.js did for us until its removal (1/11/2026), and the bigger one — 72 % of the bytes
 *  painted by our corpus come from fonts with NO `/ToUnicode` (measured on 31/10/2026).
 *  NOT here: the data itself and its two sources (`./glyph-data.ts`, generated), `/ToUnicode`
 *  (`./to-unicode.ts`), the widths, the font programs — and nothing of pdf.js.
 *  Called by: `./font-text.ts`, and `names.test.ts`. */

import {
  GLYPH_LIST,
  STANDARD_METRICS,
  MACROMAN_ENCODING,
  STANDARD_ENCODING,
  SYMBOL_ENCODING,
  WINANSI_ENCODING,
  ZAPF_ENCODING,
} from "./glyph-data";

/** The largest code point Unicode defines (U+10FFFF): beyond it a `uXXXXXX` name means nothing. */
const MAX_CODE_POINT = 0x10ffff;

/** A code point that really designates a character.
 *  🔴 `high` review of 31/10/2026: `String.fromCodePoint` accepts D800-DFFF, so `uniD800` returned a lone HALF of a
 *  surrogate pair — an invalid character that would travel up to the page. Adobe's list
 *  excludes them too (0000-D7FF and E000-FFFF). U+0000 is set aside for the same reason as elsewhere: it is not
 *  the content of a document, and we publish nothing invisible. */
export const isRealCharacter = (value: number): boolean =>
  value > 0 && value <= MAX_CODE_POINT && !(value >= 0xd800 && value <= 0xdfff);

const UNI = /^uni([0-9A-Fa-f]{4})+$/;
const U_FORM = /^u([0-9A-Fa-f]{4,6})$/;
/** Names that stand for a glyph NUMBER, not a character: there is no text to be had, and guessing invents words. */
const GLYPH_NUMBER = /^(?:g|cid|glyph|index|G)\d+$/;

/** The text a glyph name paints, or `undefined` when nothing says what it is. */
export function textOfGlyphName(name: string): string | undefined {
  if (name === "") return undefined;

  const known = GLYPH_LIST.get(name);
  if (known !== undefined) return known;

  // §9.10.2: a name may carry a variant suffix after a period; the base name is what it paints.
  const dot = name.indexOf(".");
  if (dot > 0) return textOfGlyphName(name.slice(0, dot));

  // 🔴 A COMPOUND NAME IS SPLIT ON `_` (specification of Adobe's list, and it is the one our header
  // invokes for `uniXXXX`): `f_i` is the "fi" ligature, `uni0066_uni0069` too. Without this splitting we
  // abstained, so we LOST the word — and zero lost words is the product's priority (`medium` review of
  // 31/10/2026). A component we cannot read makes the whole name abstain: better nothing than half
  // a ligature.
  if (name.includes("_")) return textOfComposedName(name);

  if (GLYPH_NUMBER.test(name)) return undefined;

  const uni = UNI.exec(name);
  if (uni !== null) return textOfUniName(name);

  const single = U_FORM.exec(name);
  if (single !== null) {
    const value = Number.parseInt(single[1] as string, 16);
    return isRealCharacter(value) ? String.fromCodePoint(value) : undefined;
  }

  return undefined;
}

/** The text of a name with `_` components: all of them or nothing. */
function textOfComposedName(name: string): string | undefined {
  let composed = "";
  for (const part of name.split("_")) {
    const piece = part === "" ? undefined : textOfGlyphName(part);
    if (piece === undefined) return undefined;
    composed += piece;
  }
  return composed;
}

/** The text of a `uniXXXX…` name (groups of four hexadecimal digits, already checked by `UNI`). */
function textOfUniName(name: string): string | undefined {
  const hex = name.slice(3);
  let text = "";
  for (let at = 0; at < hex.length; at += 4) {
    const value = Number.parseInt(hex.slice(at, at + 4), 16);
    if (!isRealCharacter(value)) return undefined;
    text += String.fromCodePoint(value);
  }
  return text;
}

/** One `/Differences` run (Table 114): a starting code, then the names that follow it. */
export interface Differences {
  readonly code: number;
  readonly names: readonly string[];
}

export interface EncodingChoice {
  /** The `/Encoding` name or `/BaseEncoding`, when the font gives one. */
  readonly base: string | undefined;
  readonly differences: readonly Differences[] | undefined;
  /** §9.8.2, bit 3 of `/Flags`: a symbolic font's encoding is its own, which only its program declares. */
  readonly symbolic: boolean;
  /** The 256 names the font PROGRAM declares, when we could read them (`./type1-encoding.ts`, 04/11/2026).
   *  Used ONLY when the font declares no base encoding: a declared `/Encoding` is the font's own statement about its
   *  codes (§9.6.6) and wins over its program — including a base we do not know, which keeps naming nothing. */
  readonly builtInTable?: readonly string[];
}

const BY_NAME: Readonly<Record<string, readonly string[]>> = {
  StandardEncoding: STANDARD_ENCODING,
  WinAnsiEncoding: WINANSI_ENCODING,
  MacRomanEncoding: MACROMAN_ENCODING,
  // The INTERNAL encodings of Symbol and ZapfDingbats, which their AFMs declare: a symbolic font has its
  // own (§9.6.6.1), and these two are the only ones whose clause gives the table.
  SymbolEncoding: SYMBOL_ENCODING,
  ZapfDingbatsEncoding: ZAPF_ENCODING,
};

/** The 14 names that `STANDARD_METRICS` carries: the source of truth for "is it a standard font". */
const STANDARD_METRIC_FONTS: ReadonlySet<string> = new Set(STANDARD_METRICS.keys());

/** §9.6.2.2, Table 109: the 14 standard fonts, and the aliases real producers write for them. A font whose
 *  `/BaseFont` is one of these needs no `/Widths`: its metrics are a known datum (`./glyph-data.ts`). */
const STANDARD_ALIASES: Readonly<Record<string, string>> = {
  Arial: "Helvetica",
  "Arial-Bold": "Helvetica-Bold",
  "Arial-BoldItalic": "Helvetica-BoldOblique",
  "Arial-Italic": "Helvetica-Oblique",
  ArialMT: "Helvetica",
  ArialNarrow: "Helvetica",
  "Arial-BoldMT": "Helvetica-Bold",
  "Arial-ItalicMT": "Helvetica-Oblique",
  "Arial-BoldItalicMT": "Helvetica-BoldOblique",
  CourierNew: "Courier",
  "CourierNew-Bold": "Courier-Bold",
  "CourierNew-BoldItalic": "Courier-BoldOblique",
  "CourierNew-Italic": "Courier-Oblique",
  CourierNewPSMT: "Courier",
  Helv: "Helvetica",
  TimesNewRoman: "Times-Roman",
  "TimesNewRoman-Bold": "Times-Bold",
  "TimesNewRoman-BoldItalic": "Times-BoldItalic",
  "TimesNewRoman-Italic": "Times-Italic",
  TimesNewRomanPSMT: "Times-Roman",
  "TimesNewRomanPS-BoldMT": "Times-Bold",
  "TimesNewRomanPS-ItalicMT": "Times-Italic",
  "TimesNewRomanPS-BoldItalicMT": "Times-BoldItalic",
  Times: "Times-Roman",
  ZapfDingbats: "ZapfDingbats",
  Symbol: "Symbol",
};

/** The standard font a `/BaseFont` names, subset prefix removed (§9.6.4: `ABCDEF+Name`), or `undefined`. */
export function standardFontOf(baseFont: string | undefined): string | undefined {
  if (baseFont === undefined) return undefined;
  const name = baseFont.replace(/^[A-Z]{6}\+/, "");
  if (STANDARD_METRIC_FONTS.has(name)) return name;
  return Object.hasOwn(STANDARD_ALIASES, name) ? STANDARD_ALIASES[name] : undefined;
}

/** The 256 names an encoding gives. An empty string is a code the encoding does not name. */
export function encodingNames({ base, differences, symbolic, builtInTable }: EncodingChoice): readonly string[] {
  const table = base !== undefined && Object.hasOwn(BY_NAME, base) ? BY_NAME[base] : undefined;
  // 🔴 A NAMED BASE WE DO NOT KNOW DOES NOT FALL BACK TO STANDARD (`high` review of 31/10/2026):
  // `MacExpertEncoding` is a LEGAL base (Table 114, Annex D.4) that we do not implement, and reading it as
  // Standard would give ordinary letters where the font carries small capitals and old-style
  // figures — wrong words, without refusal. An unknown base therefore names NOTHING, and only its `/Differences`
  // speak.
  const unknownBase = base !== undefined && table === undefined;
  const empty = Array.from({ length: 256 }, () => "");
  // A symbolic font with no declared encoding: only its PROGRAM can say what its codes mean (§9.6.6.1), and since
  // 04/11/2026 we read that program's cleartext header when it carries one (`./type1-encoding.ts`). Without it,
  // nothing here can say, and the abstention stands — as it did for every such font before that date.
  const ownTable = base === undefined ? builtInTable : undefined;
  const names = [...(table ?? ownTable ?? (symbolic || unknownBase ? empty : STANDARD_ENCODING))];

  for (const run of differences ?? []) {
    for (const [offset, name] of run.names.entries()) {
      const code = run.code + offset;
      if (code >= 0 && code < 256) names[code] = name;
    }
  }
  return names;
}
