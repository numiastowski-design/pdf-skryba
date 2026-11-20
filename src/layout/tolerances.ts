/** The shared numeric tolerances of the layout code: one source for values that several modules need to agree on.
 *  NOT here: the comparison (strict or not) and the written reason of each site; the 3 pt ink continuity of
 *  `layout/intersection-cells.ts`, which has its own measured justification.
 *  Called by: `layout/{baseline-lines,fragment-cells,list,merged-cells,page-furniture,position-clusters,vector-grid}.ts`,
 *  `extractor/pdf-{bands,document-scale,line-breaks}.ts`. */

/** Two positions within this many PDF points are the same grid line / tab stop / frame edge. */
export const SAME_POSITION_PT = 2;

/** Two baselines (or edges) within this many PDF points are the same line / alignment. */
export const SAME_LINE_PT = 1;

/** A stroke must span at least this fraction of a grid band or extent to count as part of it. */
export const MIN_COVERAGE = 0.6;
