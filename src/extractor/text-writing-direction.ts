/** Whether a text matrix turns the WRITING direction of its text.
 *  Decides: the one definition of a turned text (a quarter turn, half a turn, any angle) shared by the runs, the glyphs and the rotated readers.
 *  NOT here: what is done with a turned text (`extractor/pdf-rotated-lines.ts`, `extractor/pdf-rotated-words.ts`), where a run closes (`glyph-runs.ts`).
 *  Called by: `extractor/glyph-runs.ts`, `extractor/pdf-source.ts`, `extractor/pdf-rotated-lines.ts`, `extractor/pdf-rotated-words.ts`. */

/** The writing axis is `(a, b)`. It turns when `|b|` exceeds this × `|a|` (float noise of composed matrices; a quarter turn gives
 *  `a` = 6e-16 and `b` = 10, so the test is relative to `a`, never to `b` alone). Valeur de départ à calibrer: the corpus holds no matrix between. */
const TURN_EPSILON = 1e-6;

/** A shear alone (`c` != 0, `b` = 0, `a` > 0: a synthetic italic) does NOT turn the text: its direction is still left to right. */
export const writingDirectionTurned = ({ a, b }: { a: number; b: number }): boolean =>
  Math.abs(b) > TURN_EPSILON * Math.abs(a) || a < 0;
