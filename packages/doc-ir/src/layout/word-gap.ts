/** THE ONE THRESHOLD that says whether the gap between two GLYPHS is a word break.
 *  Decides: nothing by itself — it holds the value, its source and its two populations. Its callers apply it at the
 *  same granularity: glyph to glyph, in the page flow (`extractor/glyph-runs.ts`) and inside a table cell
 *  (`layout/cell-text.ts`).
 *  NOT here: the gap between two FRAGMENTS of a logical line — NOT the same decision —, which has its own
 *  measured populations and its own value of 0.15 (`extractor/pdf-lines.ts`); the gap that closes a RUN altogether
 *  (`RUN_GAP_EM`, 0.6); the letter-spacing ceiling of a cell (`layout/cell-text.ts#TRACKING_MAX_EM`, 1); and the
 *  hyphen junction (`layout/cut-word.ts`).
 *  Called by: `extractor/glyph-runs.ts`, `layout/cell-text.ts`.
 *
 * 🔴 WHY IT LIVES HERE SINCE 03/11/2026, AND WHAT THE EVENING CORRECTED. The value was written TWICE at this
 * granularity: in `glyph-runs.ts` and, copied by hand, in `layout/cell-text.ts`, whose own comment said it was taking
 * « the page flow's own value ». Two copies of one decision drift. ⚠️ I first read the 0.15 of `pdf-lines.ts` as a
 * third copy and raised this one to match: WRONG, and a test said so within the hour — `glyph-runs.test.ts` pins 0.1
 * to its SOURCE, Poppler's `TextOutputDev.cc` line 2773. Two granularities, two sourced values, one real duplicate.
 *
 * WHERE 0.1 COMES FROM, AND WHAT IT IS NOT. `glyph-runs.test.ts` pins it citing Poppler's `TextOutputDev.cc` line
 * 2773 — but **Poppler is no longer in the product** (Mikolaj, 03/11/2026: « poppler on a viré il y a longtemps »), so
 * that is the value's HISTORY, not a second reading that still agrees with us today. The test builds a case around the
 * value; it does not show that 0.1 beats 0.15.
 *
 * THE TWO POPULATIONS, measured on 405 563 glyph pairs (15/10/2026, cell path, against Poppler as the reference
 * reader OF THAT TIME — the reference is PDFium since 29/10/2026): pairs INSIDE a word have p99 = 0.024 em and a
 * maximum of 0.446 em (figures spread one by one, which `LETTER_SPACED_TOKENS` refuses separately); pairs BETWEEN two
 * words with no blank glyph have a median of 0.345 em.
 *
 * 🔴 SO 0.1 AND 0.15 BOTH SIT IN THE EMPTY INTERVAL, and nothing measured separates them. 0.1 is KEPT for exactly one
 * reason: moving it changes the published text of every PDF, and no measurement says the other value is better. The
 * question « which of the two at the glyph level » belongs to the bench, on the corpus, not to a comment.
 *
 * ⚠️ AND IT IS NOT THE MECHANISM OF THE BROKEN-WORD FAMILY, measured the same evening: « op erations: » survives this
 * threshold at 0.5 em. Its cause is a blank glyph with no horizontal room
 * (`layout/cell-text.ts#withoutOverdrawnBlanks`). Three hypotheses were spent here for nothing; the note stays so the
 * fourth reader does not spend a fourth.
 */
export const WORD_GAP_EM = 0.1;
