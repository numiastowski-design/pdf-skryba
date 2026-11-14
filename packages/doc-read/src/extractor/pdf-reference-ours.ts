/** The SECOND READING of a page's text (`PdfReferenceCycle`), built from our own glyph geometry instead of pdf.js's
 *  `getTextContent`: one cycle per shown operator, its letters in paint order, its vertical centre.
 *  Decides: what a cycle holds (the letters of ONE operator, hidden ones left out, in the order the glyphs were painted),
 *  its vertical centre (the mean of `y + height / 2` over its glyphs), its marked-content identifier (`<page>_mc<n>`, the
 *  form the structure tree names its contents with), its artifact flag, and its rotation (a matrix that is not upright).
 *  🔴 The same geometry as the runs: the control compares the LETTERS and their ORDER of two groupings, not two
 *  geometries (Mikolaj, 1/11/2026: the second reading has its own geometry, and this is ours).
 *  NOT here: the note marks (`pdf-source.ts`, from the structure tree), the choice of which page is read this way.
 *  Called by: `extractor/pdf-source.ts`, `pdf-reference-ours.test.ts`. */

import type { GlyphFragment } from "./glyph-positions";
import type { PdfReferenceCycle } from "./pdf-source";

/** A matrix that leaves the glyph upright: its rotation and shear are zero. Anything else is a rotated cycle. */
const UPRIGHT_EPSILON = 1e-9;

/** The reference cycles of a page, from its glyphs in paint order. `pageObjId` is the page's object identifier
 *  (`p<num>R<gen>`), the prefix of its marked-content identifiers. */
export function referenceOfGlyphs(glyphs: readonly GlyphFragment[], pageObjId: string | undefined): PdfReferenceCycle[] {
  const cycles: PdfReferenceCycle[] = [];
  let group: GlyphFragment[] = [];
  const flush = (): void => {
    if (group.length === 0) return;
    cycles.push(cycleOf(group, pageObjId), ...overpaintCopies(group, pageObjId));
    group = [];
  };
  for (const glyph of glyphs) {
    if (glyph.hidden !== undefined) continue;
    if (group.length > 0 && group[0]!.runId !== glyph.runId) flush();
    group.push(glyph);
  }
  flush();
  return cycles;
}

/** A mark painted k times at one point is ONE glyph carrying `paintCount` k (`glyph-positions.ts#collapseOverpaint`), but the text layer
 *  reads k cycles: « Moyennes » three times over a colspan of 3. The k - 1 others are what the table stage records as deliberate removals, so
 *  the reference must still hold them or the control counts the removal against letters that were never there (the bulletin T1: 32 extra
 *  letters). One extra cycle per further painting of each stretch of equally over-painted glyphs. */
function overpaintCopies(group: readonly GlyphFragment[], pageObjId: string | undefined): PdfReferenceCycle[] {
  const copies: PdfReferenceCycle[] = [];
  let start = 0;
  while (start < group.length) {
    const k = group[start]!.paintCount;
    let end = start + 1;
    while (end < group.length && group[end]!.paintCount === k) end += 1;
    if (k > 1) {
      const stretch = cycleOf(group.slice(start, end), pageObjId);
      for (let copy = 1; copy < k; copy += 1) copies.push(stretch);
    }
    start = end;
  }
  return copies;
}

function cycleOf(group: readonly GlyphFragment[], pageObjId: string | undefined): PdfReferenceCycle {
  const first = group[0]!;
  const middle = group.reduce((sum, glyph) => sum + glyph.y + glyph.height / 2, 0) / group.length;
  const rotated = group.some((glyph) => Math.abs(glyph.matrix.b) > UPRIGHT_EPSILON || Math.abs(glyph.matrix.c) > UPRIGHT_EPSILON);
  const mcid = first.mcid;
  return {
    text: group.map((glyph) => glyph.text).join(""),
    middle,
    ...(first.artifact === true ? { artifact: true as const } : {}),
    ...(mcid !== undefined && pageObjId !== undefined ? { markedContentId: `${pageObjId}_mc${mcid}` } : {}),
    ...(rotated ? { rotated: true as const } : {}),
  };
}
