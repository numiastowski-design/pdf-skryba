/** "Nothing invisible" (09/10/2026; functional specification §4): nothing a PDF viewer does not show is
 *  published, nor expected by the text control. Decides: whether the mode 3 glyphs of a page are dropped
 *  (`dropsModeHidden`), and how many glyphs a page may show before the filter is skipped (`MAX_FILTERED_GLYPHS`,
 *  `countShownGlyphs`). The operators themselves are read by `glyph-positions.ts#readGlyphs`. NOT here: the crop box
 *  (text outside it is cut where the page reads glyphs: a straddling word keeps its visible letters only
 *  09/10/2026, choice B), and the per-glyph verdict (`glyph-positions.ts#isGlyphDropped`).
 *  Called by: `pdf-source.ts`, once per page, and `glyph-runs.ts`: a hidden glyph makes no run, so the published page
 *  and the control both read runs built without it, and there is ONE source of truth for "invisible".
 *
 *  Hidden means (ISO 32000-1): text rendering mode 3 (§9.3.6, Table 106; mode 7, clip only, is published: 09/10/2026), or optional content whose group is OFF
 *  in the default configuration (§8.11.4, /OCProperties /D). Mode 3 text is dropped only on a page that also has
 *  visible text: a page whose every glyph is mode 3 is an OCR layer over a scan, which stays
 *  published (accepted limit, 09/10/2026: a scan that also carries a small visible stamp loses its OCR layer).
 *  Removed 02/11/2026: `dropHiddenRuns`, the pairing of pdf.js's text cycles with our glyphs; nothing called it since
 *  pdf.js left the product (git history keeps it). */

import type { GlyphFragment } from "./glyph-positions";

/** A page with more glyphs than this is not filtered: the glyph keys and the origin index the pairing used to build
 *  cost about 620 bytes per glyph (440 MB for 710 000, past Forge's 512 MB). Starting value, to be calibrated; the largest real page measured holds
 *  8 990 characters (fixtures/pdf/46, page 10). Bias, chosen: the hidden text of a hostile page may be published;
 *  nothing visible is lost. */
export const MAX_FILTERED_GLYPHS = 100_000;

/** The glyphs the page's text-showing operators paint, counted WITHOUT building them (`readGlyphs` allocates one
 *  object each): lets the caller skip the filter on a hostile page before paying its heap. */
export function countShownGlyphs(ops: readonly { op: string; args: unknown }[]): number {
  let n = 0;
  for (const { op, args } of ops) {
    if (op !== "showText" && op !== "showSpacedText") continue;
    const items = Array.isArray(args) ? (args[0] as unknown) : undefined;
    if (!Array.isArray(items)) continue;
    for (const item of items) if (typeof item !== "number") n += 1;
    if (n > MAX_FILTERED_GLYPHS) return n;
  }
  return n;
}

/** Are the mode 3 glyphs of this page dropped? Only when the page also paints visible text (`glyphs` is `readGlyphs`'s
 *  output, `hidden` set): a page whose every glyph is invisible is an OCR layer over a scan. The ONE rule, for the
 *  pages whose runs are built from glyphs (`glyph-runs.ts`). */
export const dropsModeHidden = (glyphs: readonly GlyphFragment[]): boolean =>
  glyphs.some((g) => g.hidden === undefined && g.unpainted === undefined && !g.isSpace && g.text.trim() !== "");
