/** What TEXT a glyph code of ONE font paints — the whole unicode layer behind a single function, and the answer
 *  pdf.js used to give us (ISO 32000-1:2008 §9.10.2 for the order below, §9.6.6 for the encodings, §9.10.3 for
 *  `/ToUnicode`).
 *  Decides: THE ORDER, which is the order §9.10.2 gives — `/ToUnicode` first, because it is the font's own
 *  statement about its text; then the glyph NAME its encoding gives, read through Adobe's list; and nothing at
 *  all otherwise, which is an ABSTENTION (`undefined`), never an invented character. A composite font without
 *  `/ToUnicode` falls in that last case: its codes are glyph numbers, and only its font program's CHARSTRINGS —
 *  the encrypted part, which we do not read — could say what they paint.
 *  ⚠️ The rule « we will never read a font program » (Mikolaj, 24/10/2026) was LIFTED, narrowly, on 04/11/2026:
 *  a simple Type 1 font that declares no encoding has its own read from its program's CLEARTEXT header
 *  (`./type1-encoding.ts`). Nothing else of a program is read, and no glyph outline ever is.
 *  NOT here: the data (`./glyph-data.ts`), the CMap reading (`./to-unicode.ts`), the name rules (`./names.ts`),
 *  the widths, the positions — and nothing of pdf.js.
 *  Called by: the POC's tools (`tools/poc/`), and `font-text.test.ts`. */

import type { PdfDict, PdfStream, PdfValue } from "../pdf-objects/objects";
import { encodingNames, textOfGlyphName, type Differences } from "./names";
import { builtInType1Encoding } from "./type1-encoding";
import { textOfUnicodeCode, unicodeCodeForm } from "./predefined-cmaps";
import { chargeTableEntries, type TableBudget } from "./table-budget";
import { readToUnicode, type ToUnicode } from "./to-unicode";

/** What this layer needs of a document: two lookups and the bytes of a stream. */
export interface FontReader {
  resolve(value: PdfValue | undefined): PdfValue | undefined;
  dictOf(value: PdfValue | undefined): PdfDict | undefined;
  streamBytes(stream: PdfStream): Uint8Array;
}

const nameOf = (value: PdfValue | undefined): string | undefined => (value?.kind === "name" ? value.value : undefined);

/** §9.8.2, bit 3 of `/Flags` (symbolic) unless bit 6 (non-symbolic) is also set, as real descriptors do. */
function isSymbolic(reader: FontReader, font: PdfDict): boolean {
  const descendants = reader.resolve(font.get("DescendantFonts"));
  const descendant = descendants?.kind === "array" ? reader.dictOf(descendants.items[0]) : undefined;
  const descriptor = reader.dictOf((descendant ?? font).get("FontDescriptor"));
  const flags = reader.resolve(descriptor?.get("Flags"));
  if (flags?.kind !== "number") return false;
  return (flags.value & 4) !== 0 && (flags.value & 32) === 0;
}

/** §9.6.6.1 Table 114: `/Differences` is a flat array of `code name name …`, one run per number. */
function differencesOf(reader: FontReader, encoding: PdfDict | undefined): Differences[] | undefined {
  const array = reader.resolve(encoding?.get("Differences"));
  if (array?.kind !== "array") return undefined;
  const runs: Differences[] = [];
  let names: string[] = [];
  let code = 0;
  for (const item of array.items) {
    const value = reader.resolve(item);
    if (value?.kind === "number") {
      if (names.length > 0) runs.push({ code, names });
      code = value.value;
      names = [];
    } else if (value?.kind === "name") {
      names.push(value.value);
    }
  }
  if (names.length > 0) runs.push({ code, names });
  return runs;
}

/** §9.6.6: the encoding of a simple font, read ONCE for everyone — the text of a code (`fontText`) and
 *  its advance (`./widths.ts`) must name the SAME glyph.
 *  🔴 Why this function exists (`high` review of 31/10/2026): the two layers read `/Encoding`
 *  separately, and the advances one IGNORED the `/BaseEncoding` of a dictionary `/Encoding`. A non-embedded
 *  Helvetica with `<< /BaseEncoding /WinAnsiEncoding /Differences […] >>` was thus read as WinAnsi for the text
 *  and as Standard for the advances: "é" (0xE9) got the advance of `Oslash`, 889 instead of 556, and the whole
 *  line shifted. Two readings of the same thing always end up diverging.
 *  `builtIn` is the internal encoding of a standard font when it has one (Symbol, ZapfDingbats). */
/** The encoding a simple Type 1 font's own PROGRAM declares, read from its cleartext header only
 *  (`./type1-encoding.ts`, Mikolaj 04/11/2026). Asked for ONLY when the font declares no encoding of its own, so a
 *  file that states its encoding is never second-guessed.
 *  Limits, written: `/FontFile` only — a TrueType program (`/FontFile2`) and a CFF one (`/FontFile3`) are other
 *  formats, unread; and the program is decoded once per FONT, not once per object, so a document naming the same
 *  program from many fonts decodes it many times (nothing is retained beyond 256 names; the bench says the cost). */
function programEncodingOf(reader: FontReader, font: PdfDict): readonly string[] | undefined {
  const subtype = nameOf(reader.resolve(font.get("Subtype")));
  if (subtype !== "Type1" && subtype !== "MMType1") return undefined;
  const descriptor = reader.dictOf(font.get("FontDescriptor"));
  const file = reader.resolve(descriptor?.get("FontFile"));
  if (file?.kind !== "stream") return undefined;
  try {
    return builtInType1Encoding(reader.streamBytes(file));
  } catch {
    // A stream we cannot decode says nothing, and the abstention stands: never a guessed encoding.
    return undefined;
  }
}

export function encodingChoiceOf(reader: FontReader, font: PdfDict, builtIn?: string): Parameters<typeof encodingNames>[0] {
  const encoding = reader.resolve(font.get("Encoding"));
  const dict = encoding?.kind === "dict" ? encoding.entries : undefined;
  const named = nameOf(encoding) ?? nameOf(reader.resolve(dict?.get("BaseEncoding")));
  const base = named ?? builtIn;
  const builtInTable = base === undefined ? programEncodingOf(reader, font) : undefined;
  return {
    base,
    differences: differencesOf(reader, dict),
    symbolic: isSymbolic(reader, font),
    ...(builtInTable === undefined ? {} : { builtInTable }),
  };
}

/** The `/ToUnicode` tables already read for a document, by OBJECT — the key is the offset of the first data byte
 *  of the stream, which identifies the object without `PdfStream` carrying its number.
 *  🔴 WHY (security review of 31/10/2026): the table was read and retained per font DICTIONARY. Five
 *  hundred fonts naming the same sixty-byte object — `beginbfrange <0000><FFFF><0041>` — thus retained
 *  five hundred tables of 65,536 entries, about three gigabytes, for a 60 KB file whose document budget
 *  only saw 500 × 60 bytes. `undefined` in the table memoises a CMap we refused, so as not to
 *  re-read it for every font. */
export type FontTextMemo = Map<number, ToUnicode | undefined>;

/** The `/ToUnicode` table of a font, or `undefined` when it has none or it cannot be read. */
function toUnicodeOf(reader: FontReader, font: PdfDict, memo: FontTextMemo | undefined, budget: TableBudget | undefined): ToUnicode | undefined {
  const stream = reader.resolve(font.get("ToUnicode"));
  if (stream?.kind !== "stream") return undefined;
  if (memo?.has(stream.start) === true) return memo.get(stream.start);
  let table: ToUnicode | undefined;
  try {
    table = readToUnicode(reader.streamBytes(stream));
  } catch {
    // A CMap we refuse says nothing; the encoding may still answer.
    table = undefined;
  }
  // Charged when the table is made, once per OBJECT (the memo answers the others): a table is kept for the whole document.
  if (table !== undefined) chargeTableEntries(budget, table.text.size + table.rejected.size);
  memo?.set(stream.start, table);
  return table;
}

/** What this font's `/ToUnicode` DECLARES for a code where `fontText` refuses to publish — the half-pair
 *  of an emoji, which a NEIGHBOURING code completes. `undefined` everywhere else.
 *  Who calls it and why: `extractor/pdf-glyph-source.ts`, the only one to see the sequence of painted codes, pairs these
 *  half-pairs (Mikolaj, 31/10/2026: "we have to do it ourselves", for emojis). It is therefore not a
 *  second reading of the CMap: it is the SAME table, whose refused part is exposed. */
export function fontDeclaredText(reader: FontReader, font: PdfDict, memo?: FontTextMemo, budget?: TableBudget): (code: number) => string | undefined {
  const toUnicode = toUnicodeOf(reader, font, memo, budget);
  return (code) => toUnicode?.rejected.get(code);
}

/** The text each code of this font paints. Read once per font; the function it returns is pure.
 *  `memo` shares the `/ToUnicode` tables between the fonts of one document; without it, each font re-reads and
 *  retains its own (see `FontTextMemo`). */
export function fontText(reader: FontReader, font: PdfDict, memo?: FontTextMemo, budget?: TableBudget): (code: number) => string | undefined {
  const toUnicode = toUnicodeOf(reader, font, memo, budget);
  const composite = nameOf(reader.resolve(font.get("Subtype"))) === "Type0";

  if (composite) {
    // 🔴 A PREDEFINED `UniXXX-UCS2-[HV]` CMAP HAS THE CODE POINT ITSELF AS ITS CODE (31/10/2026): its code
    // space is the BMP minus the surrogates, so the code reads as is, with no embedded table. See
    // `./predefined-cmaps.ts` for the source and for what the other families would require.
    // THE ORDER OF §9.10.2 IS KEPT: `/ToUnicode` first — it is the font's statement about its text —,
    // identity next. Without this identity, two real safedocs lost their whole English body
    // (1,050 words expected, 72 read).
    const encoding = nameOf(reader.resolve(font.get("Encoding")));
    const form = encoding === undefined ? undefined : unicodeCodeForm(encoding);
    return (code) => {
      const mapped = toUnicode?.text.get(code);
      if (mapped !== undefined) return mapped;
      if (form === undefined) return undefined;
      return textOfUnicodeCode(code);
    };
  }

  const names = encodingNames(encodingChoiceOf(reader, font));

  return (code) => {
    const mapped = toUnicode?.text.get(code);
    if (mapped !== undefined) return mapped;
    const name = code >= 0 && code < 256 ? (names[code] as string) : "";
    return textOfGlyphName(name);
  };
}
