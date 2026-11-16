/** The text of a run that came out letter-spaced (« L I V R E T », as pdf.js read such text, removed 1/11/2026) taken back from the glyphs at the same place, when both readings agree on the letters.
 *  NOT here: reading the runs or the glyphs (`extractor/pdf-source.ts`, `extractor/glyph-positions.ts`), a table cell's text, which is already built from the glyphs (`layout/cell-text.ts`), nor the conservation check (`pipeline/text-conservation.ts`).
 *  Called by: `extractor/pdf.ts`, once per page, before anything reads the runs. */

/**
 * THE DEFECT (defect G, diagnosed on fixture 26, 22/09/2026). Canva writes
 * « LIVRET » one glyph per `Tj`, 0.257 em apart. pdf.js read each gap as a
 * space and handed back « L I V R E T »: the text path published it so, and a
 * search for « livret » did not find it. The glyphs, rebuilt from the content
 * stream, carry the letters and only the document's real spaces.
 *
 * THE RULE (decided by 22/09/2026). Outside a table, a run
 * letter-spaced takes the glyphs' text ONLY if both readings hold the same
 * characters once every space is removed. Otherwise we abstain and the run
 * keeps its own text. A document that spaces its own letters with real space
 * glyphs (« V I N E T I A », 0000846) reads the same both ways: nothing moves.
 *
 * A RUN THAT ALSO HOLDS A WORD abstains (22/09/2026): in
 * « Chapitre S T A M P S » with no real space glyph, the glyphs read
 * « ChapitreSTAMPS » and nothing tells the word boundary from a letter gap.
 * Every token of the run must be a single character.
 *
 * REMAINING LIMIT, not guarded: a document that letter-spaces WITHOUT a real
 * space glyph between its words would come out glued (« LIVRETD’ACCUEIL »).
 * Only a limit on the gap between glyphs would tell, and that is a threshold
 * with no population to calibrate it on. Measured on
 * the 39 French/English corpus PDFs, 22/09/2026: the rule changes 6 runs
 * (26 ×3, 0000523, 0000602 ×2), each made of single characters only, and no
 * gap between their glyphs is wider than their letter gap (0.257 em on 26,
 * under 0.03 em elsewhere): no word boundary is hidden there. Published, 3
 * paragraphs change; 26's cover sits in a table, already read from glyphs.
 */

import { collapseBlanks } from "doc-ir/lib/blanks";
import type { GlyphFragment } from "./glyph-positions";
import { glyphsOfRun, sortedByBaseline, START_WINDOW } from "./glyph-window";
import type { PdfTextRun } from "./pdf-source";

/** At least four single characters in a row, one space apart: what the text runs
 *  make of a letter-spaced word (pdf.js did the same). Value from the diagnostic (« S T A M P S »,
 *  « P a g e »), not calibrated: only the concordance below decides. */
const LETTER_SPACED = /(?:(?<![\p{L}\p{N}])[\p{L}\p{N}’'] ){3,}[\p{L}\p{N}’'](?![\p{L}\p{N}])/u;


const withoutSpaces = (s: string): string => s.replace(/\s+/gu, "");

/** `respacedText` over glyphs sorted by `y` lazily: `byY` is only called once a run passes the guards, so only a page
 *  with a letter-spaced run pays for the sort, and `respaceLetterSpacedRuns` pays it once per page. */
const respacedTextFrom = (run: PdfTextRun, byY: () => readonly GlyphFragment[]): string | undefined => {
  if (run.rotated || !LETTER_SPACED.test(run.text)) return undefined;
  if (run.text.split(/\s+/u).some((token) => [...token].length > 1)) return undefined;
  // Space glyphs stay (word cuts) and the glyph START decides: see `glyph-window.ts` for why this differs from links.
  const read = collapseBlanks(
    glyphsOfRun(run, byY(), START_WINDOW)
      .map((g) => g.text)
      .join(""),
  );
  if (read.length === 0 || withoutSpaces(read) !== withoutSpaces(run.text)) return undefined;
  const text = `${run.text.slice(0, run.text.length - run.text.trimStart().length)}${read}${run.text.slice(run.text.trimEnd().length)}`;
  return text === run.text ? undefined : text;
};

/** The glyphs' text for `run`, or `undefined` when the run is not letter-spaced
 *  or the two readings disagree. */
export const respacedText = (run: PdfTextRun, glyphs: readonly GlyphFragment[]): string | undefined =>
  respacedTextFrom(run, () => sortedByBaseline(glyphs));

/** A page's runs, each letter-spaced one replaced by a copy carrying the
 *  glyphs' text; every other run is the same object. `onRespaced` hears each
 *  copy with its source run. */
export const respaceLetterSpacedRuns = (
  runs: readonly PdfTextRun[],
  glyphs: readonly GlyphFragment[],
  onRespaced: (copy: PdfTextRun, source: PdfTextRun) => void = () => undefined,
): PdfTextRun[] => {
  let sorted: GlyphFragment[] | undefined;
  const byY = (): GlyphFragment[] => (sorted ??= sortedByBaseline(glyphs));
  return runs.map((run) => {
    const text = respacedTextFrom(run, byY);
    if (text === undefined) return run;
    const copy = { ...run, text, letterSpaced: true as const };
    onRespaced(copy, run);
    return copy;
  });
};
