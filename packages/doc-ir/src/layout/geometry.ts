/** The pure geometric reading of a page: one file per decision, re-exported
 *  here so a caller keeps a single import.
 *  NOT here: any decision at all. The shared shapes are in
 *  `layout/geometry-types.ts`, what counts as the same position in
 *  `layout/position-clusters.ts`, the painted paths in
 *  `layout/painted-paths.ts`, the grid a page draws in
 *  `layout/vector-grid.ts`, the cells whose four sides are painted in
 *  `layout/intersection-cells.ts`, the grid a page only aligns in
 *  `layout/aligned-grid.ts`, where the fragments land in
 *  `layout/fragment-cells.ts`, the dominant body size in
 *  `layout/text-size.ts`, and table-or-columns in
 *  `layout/column-discriminant.ts`.
 *  Called by: `extractor/pdf-table-detector.ts`, `extractor/pdf.ts` and the
 *  other `extractor/pdf-*.ts`, the other `layout/` modules, `core/entities.ts`,
 *  `tools/pdf-geometry-probe.ts`. */

/**
 * `layout/geometry` — LAYOUT ANALYSIS, a PURE family of modules.
 *
 * Named and moved out of `extractor/` on 09/09/2026. It lived under
 * `extractor/pdf-table-geometry.ts` and no longer belonged there: it is
 * neither an extractor nor table-specific — it also carries the column
 * discriminant (point 13) and the vertical rhythm. That move changed NO
 * behaviour; it moved a badly drawn boundary.
 *
 * WHAT "PURE" MEANS HERE, AND IT IS A CONSTRAINT, NOT A DESCRIPTION: **no file
 * of this family imports anything from outside it.** No Forge, no IRDoc, no
 * `core/`, no `unpdf`, no `pdfjs-dist`, not one npm dependency. They take
 * numbers — segments already in page space, fragments already positioned — and
 * return a structure. Any regression of that property shows up as an `import`
 * line reaching out of `layout/`, and must be refused in review.
 *
 * Two concrete benefits, not theoretical ones:
 *  1. the design decisions (tolerances, what counts as "a grid") are tested
 *     with synthetic coordinates written by hand, without loading a PDF reader —
 *     which is why these tests are NOT in the `pdf` vitest project;
 *  2. the family stays measurable by a third party who has neither Confluence,
 *     nor Forge, nor the rest of the code. Extracting it one day must stay
 *     trivial; no separate npm package today — a single caller, a release cycle
 *     for nothing.
 *
 * WHERE THE BOUNDARY RUNS. PDF-specific decoding — walking a real operator
 * list, following the graphics state stack, reading text items — stays
 * UPSTREAM, in `extractor/pdf-table-detector.ts`. Rebuilding page coordinates
 * from the operator stream (text state machine and CTM) is on the same side,
 * deliberately: that is format decoding, and it is the part we got wrong (see
 * `docs/INVENTAIRE-PDFJS-UNPDF.md` [purged 27/09/2026, git history] §5). It therefore needs its own tests,
 * there.
 *
 * What this family never does: XHTML rendering, IRDoc, model call, Confluence
 * write.
 *
 * ABSTENTION IS A FIRST-ORDER OUTPUT, not a detail. It exists today in three
 * shapes — `PdfTableOrigin` equal to `"no-grid"`, an `undefined` grid when none
 * can be built, and a non-empty `CellAssignment.ambiguous`. **Unifying them
 * waits for a measurement** (git history, écart 16): unifying now would freeze
 * a contract that is going to move.
 *
 * Coordinate convention, identical to `pdf.ts` (PDF space: y grows upwards, so
 * reading top to bottom means y DECREASING) — `rowBoundaries` is sorted
 * descending for the same reason `pdf.ts` computes its paragraph-break gap as
 * `prev.y - line.y`.
 */

export type {
  CellRect,
  ClassifiedLine,
  Fragment,
  LineSegment,
  MergedCell,
  MergeMap,
  Matrix2D,
  PdfTableDetection,
  PdfTableOrigin,
  TableGrid,
} from "./geometry-types";
export { clusterPositions } from "./position-clusters";
export {
  applyMatrix,
  classifyLineSegment,
  composeMatrix,
  IDENTITY_MATRIX,
  positionKey,
  subpathsToSegments,
  translateMatrix,
} from "./painted-paths";
export { buildGridFromVectorLines, buildGridsFromVectorLines, withoutImageFrames } from "./vector-grid";
export { findCellsByIntersection, isBoxesInVoidsRegion } from "./intersection-cells";
export {
  buildGridFromAlignedRows,
  detectAlignedColumns,
  hasWeakTabularitySignal,
  identifyAlignedTableLines,
} from "./aligned-grid";
export { assignFragmentsToCells, groupFragmentsIntoRowBands, groupFragmentsIntoVisualLines } from "./fragment-cells";
export { dominantTextSize } from "./text-size";
export {
  detectColumnGutter,
  hasRepeatedSecondRhythm,
  looksLikeTextColumns,
  verticalRhythm,
} from "./column-discriminant";
