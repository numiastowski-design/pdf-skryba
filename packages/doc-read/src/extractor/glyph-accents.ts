/** An accent and the letter it sits on, read as ONE character (ISO 32000-1 §9.4.4 for the glyph positions this uses;
 *  Unicode Annex #15 for the normalisation).
 *  Decides: that a SPACING accent whose drawing really sits ON the next glyph, and only then, is replaced by the
 *  precomposed character — the accent's drawing disappears, the letter's slot carries the composed text, and nothing
 *  else moves; that a combination with no precomposed form is an ABSTENTION (both drawings kept), never a base
 *  character followed by a loose mark; that a dotless i or j gets its dot back first, since `ˆ` + `ı` must give `î`.
 *  🔴 WHY A GEOMETRIC GUARD AND NOT THE ORDER OF THE DRAWINGS. Measured on 443 PDFs, two real documents paint a `´`
 *  BETWEEN two letters without covering either: composing on the order alone turned « nature´s » into « natureś » and
 *  « d´a » into « dá » — an INVENTED letter, the gravest defect this product can produce. The two populations are
 *  cleanly apart: an accent sitting on its letter is 0.000 em of centre gap (median; 0.041 at worst, 554 occurrences),
 *  a `´` between two letters is 0.335 and 0.403 em (2 occurrences).
 *  WHY IT EXISTS: `sd-7133949.pdf` (MiKTeX pdfTeX) published « donn ́ees », with a REAL SPACE inside the word, so not
 *  one of its accented words could be found by Confluence search — which is the product's purpose. The cause is not
 *  the step back of `glyph-runs.ts` (a diagnosis of mine that measurement killed) but NFKC: `pdf-source.ts#normalizeUnicode`
 *  decomposes U+00B4 into U+0020 + U+0301. Acute, dieresis, cedilla and macron decompose that way; grave and
 *  circumflex do not — which is exactly why « mati`eres » stayed glued while « donn ́ees » came apart, at equal step back.
 *  NOT here: the glyph positions (`./glyph-positions.ts`), the runs and their thresholds (`./glyph-runs.ts`, untouched),
 *  the normalisation of the published text (`./pdf-source.ts`), the cells (`layout/cell-text.ts` — which reads these
 *  same glyphs, so it is repaired by the same stone).
 *  Called by: `./glyph-positions.ts#filteredGlyphs`, after `dropDoubleDraws`, and `glyph-accents.test.ts`. */

import type { GlyphFragment } from "./glyph-positions";

/** The spacing accents a document paints as their own drawing, and the combining mark each one means (Unicode names). */
const MARK_OF: ReadonlyMap<string, string> = new Map([
  ["´", "́"], // acute
  ["`", "̀"], // grave
  ["ˆ", "̂"], // circumflex
  ["˜", "̃"], // small tilde
  ["¯", "̄"], // macron
  ["˘", "̆"], // breve
  ["˙", "̇"], // dot above
  ["¨", "̈"], // diaeresis
  ["˚", "̊"], // ring above
  ["˝", "̋"], // double acute
  ["ˇ", "̌"], // caron
  ["¸", "̧"], // cedilla
  ["˛", "̨"], // ogonek
]);

/** ASCII `^` and `~` are DELIBERATELY absent: they are real characters, and the same specimen writes R formulas with them. */

/** A dotless i or j must get its dot back before composing: NFC on `ı` + U+0302 keeps two characters, and « connaître » stays unfindable. */
const DOTLESS: ReadonlyMap<string, string> = new Map([
  ["ı", "i"],
  ["ȷ", "j"],
]);

/** Horizontal distance between the two centres, over the letter's size, beyond which the accent is NOT on the letter.
 *  Starting value to calibrate, two populations measured on 443 PDFs (04/11/2026): on its letter, 0.000 em median and
 *  0.041 em at worst over 554 occurrences; between two letters, 0.335 and 0.403 em over 2 occurrences. */
export const CENTRE_EM = 0.1;

/** How high above the letter's baseline the accent may be drawn, over the letter's size. Starting value to calibrate:
 *  TeX raises the accent of a CAPITAL by 0.276 em (measured, `95.17 2.76 Td` at 10 pt) — which is also why this cannot be
 *  done in `glyph-runs.ts`, whose baseline-shift threshold is 0.25 em and would call it a new line. */
export const RAISE_EM = 0.5;

/** Float noise of a composed matrix, as `glyph-runs.ts` reads it: an exact zero would refuse an upright text obtained through a rotation. */
const SAME_RELATIVE = 1e-3;

/** Upright text: the matrix turns nothing. Read with a tolerance, never against an exact zero. */
const isUpright = (g: GlyphFragment): boolean => Math.abs(g.matrix.b) < SAME_RELATIVE && Math.abs(g.matrix.c) < SAME_RELATIVE;

const centre = (g: GlyphFragment): number => g.x + g.width / 2;

/** The one character an accent and the NEXT glyph paint together, or `undefined` when nothing says they belong to each other. */
function composed(accent: GlyphFragment, letter: GlyphFragment | undefined): string | undefined {
  const mark = MARK_OF.get(accent.text);
  if (mark === undefined || letter === undefined || !/^\p{L}$/u.test(letter.text)) return undefined;
  if (accent.font !== letter.font || accent.height !== letter.height) return undefined;
  if (!isUpright(accent) || !isUpright(letter)) return undefined;
  if (Math.abs(centre(accent) - centre(letter)) > CENTRE_EM * letter.height) return undefined;
  if (Math.abs(accent.y - letter.y) > RAISE_EM * letter.height) return undefined;
  const text = `${DOTLESS.get(letter.text) ?? letter.text}${mark}`.normalize("NFC");
  // No precomposed form: we abstain rather than publish a base character trailed by a loose mark.
  return [...text].length === 1 ? text : undefined;
}

/** The page's glyphs with each accent folded into the letter it sits on. The letter's slot is kept — its position, its
 *  size, its run — so nothing downstream moves; only the accent's drawing goes. */
export function composeAccents(glyphs: readonly GlyphFragment[]): GlyphFragment[] {
  const out: GlyphFragment[] = [];
  for (let i = 0; i < glyphs.length; i += 1) {
    const accent = glyphs[i]!;
    const letter = glyphs[i + 1];
    const text = composed(accent, letter);
    if (text === undefined) {
      out.push(accent);
      continue;
    }
    out.push({ ...letter!, text });
    i += 1;
  }
  return out;
}
