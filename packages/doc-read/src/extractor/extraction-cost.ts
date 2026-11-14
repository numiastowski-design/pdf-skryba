/** What an extraction COSTS in work rather than in seconds: calls and volumes,
 *  counted deterministically, so a regression shows up as a number and not as
 *  a stopwatch reading.
 *  NOT here: any timing, and no decision — nothing in the extraction branches
 *  on these counters.
 *  The counters are those of the PDF path. Called by: `extractor/{pdf,pdf-open,pdf-page-figures,pdf-source,
 *  pdf-model,pdf-table-detector}.ts` record; `pipeline/extraction-cost.test.ts` is what reads the totals. */

/**
 * extraction-cost — what an extraction COSTS, in work and not in seconds.
 *
 * WHY THIS MODULE EXISTS. The repository no longer had any regression detector
 * on extraction: the only stand-in was a test stopwatch, and
 * a stopwatch measures the machine as much as the code. Measured on 14/09/2026 on
 * five fresh processes, the same extraction: **2,353 · 6,082 · 5,807 · 5,692 ·
 * 5,673 ms**. A variance of a factor of two and a half, without a line changing —
 * a signal drowned in its own noise.
 *
 * WHAT WE COUNT INSTEAD, AND WHY IT IS DETERMINISTIC. CALLS and
 * VOLUMES, never time. `src/extractor` and `src/layout` contain no
 * `Math.random`, `Date.now`, `new Date` nor `performance.now` — the repository rule
 * forbids it — and no `Promise.all/race/any`: extraction is strictly
 * sequential. The only collection iterations are over `Map`s
 * (insertion order) and over the frozen operators object of our reader. Determinism is
 * not hoped for, it follows from rules already kept.
 *
 * VERIFIED: three extractions of the same document yield counters identical
 * to the unit, while the duration varies by a factor of thirty on `05a` (1,105 ms
 * · 36 ms · 40 ms). Determinism is the measure, never speed.
 *
 * TWO FAMILIES, AND THEY DO NOT WATCH THE SAME THING.
 *
 *  A — THE ENTRIES INTO THE READER (`docOpens`; before the removal of pdf.js, on 01/11/2026,
 *      also `extractTextItems`, `getPage`, `getOperatorList`). These are the calls that cost an analysis or a page
 *      rendering. A regression that re-reads a page, reopens the document or adds
 *      a pass makes them rise. This is the family that found, the very day
 *      it was designed, that every PDF was analysed TWICE.
 *
 *  B — THE VOLUME WALKED IN OUR CODE (`operatorsWalked`, `glyphFragments`). Narrow
 *      scope, and it must be written as such: B watches the work of OUR code
 *      on ORDINARY digital documents, where A is almost flat — `16`
 *      makes 922 operators and 5,035 glyphs for THREE calls to the reader (pdf.js, at the time). A
 *      regression in our glyph walk would only be seen there.
 *
 * ⚠️ WHAT IT WILL NOT SEE, and it must be read before believing it broad:
 *
 *  - **A regression at a CONSTANT number of operations.** An allocation added
 *    in a hot loop, a conversion redone on every iteration, a regular
 *    expression recompiled, a buffer copied once too many: not a counter moves. It
 *    catches ALGORITHMIC work, never the CONSTANT FACTOR.
 *  - **A regression in the reader itself** — an object walk made
 *    slower leaves all the counters identical.
 *  - **Memory pressure**, which appears in no count.
 *
 * Put differently: it detects "we do MORE things", never "each thing
 * costs MORE".
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ AND A FIXTURE LIMIT, PAID FOR TO LEARN IT (14/09/2026)
 * ═══════════════════════════════════════════════════════════════════════════
 * **A SET OF GOLDENS CAN VALIDATE A WRONG MODEL.** This is not a fear,
 * it is what happened.
 *
 * Before the boundary work, the cost was PREDICTED from a model
 * read in the code — `getPage = P + G`, where P is the number of pages and G the
 * number of pages whose glyphs are rebuilt. This model was right
 * on the four goldens of the time, to within seven counters, on all four
 * documents. It was WRONG: it assumed glyph reconstruction
 * only took place for pages carrying a grid — which the
 * comment in `pdf.ts` asserted — whereas it took place on ALL of them.
 *
 * It was right because **the four fixtures of the time all had
 * G = P**: each of their pages carries text. The discriminant was
 * exercised by none of them. It was `05b`, OUTSIDE the goldens, that revealed the gap —
 * 40 `getPage`, 40 `getOperatorList` and 200 operators decoded for ZERO
 * glyphs produced.
 *
 * **THE REPOSITORY RULE ALREADY APPLIED AND WAS NOT KEPT**: "a fixture
 * is only worth what it exercises". The accident "G = P everywhere" had even
 * been WRITTEN in the prediction, without drawing the consequence — that a
 * set where a discriminant is constant cannot test it.
 *
 * **WHAT WAS DONE**: `05d-Dossier-Mixte` entered the goldens. Three
 * pages, of which TWO without text — the mixed case, strictly stronger than an
 * entirely scanned document, and under the upcoming 15-page ceiling.
 *
 * **WHAT REMAINS TRUE**: look, for each counted quantity, for which
 * fixture makes it VARY. If none does, the counter watches nothing
 * — it confirms a constant.
 */

/** The counters of an extraction. Integers, nothing else.
 *
 *  These names are also the keys serialised in `golden/extraction-cost/*.json`. */
export interface ExtractionCost {
  /** Complete analyses of the document by our reader. Only one is needed. */
  docOpens: number;
  /** Named operators that OUR code walks, cumulated. */
  operatorsWalked: number;
  /** Glyph fragments that OUR code builds, cumulated. */
  glyphFragments: number;
  /** Openings of the document by `pdf-lib`, to read its large images. Zero without them. */
  pdfLibOpens: number;
  /** Large-image paintings read from the PDF structure, once PLACED: decoration
   *  and images dropped by a rendered table are excluded. An object painted twice is read twice
   *  (57R on fixture 24). */
  imagesRead: number;
}

export const emptyExtractionCost = (): ExtractionCost => ({
  docOpens: 0,
  operatorsWalked: 0,
  glyphFragments: 0,
  pdfLibOpens: 0,
  imagesRead: 0,
});

/** The increment is ALWAYS done at the call site, never in a loop: the
 *  cost of the counter stays proportional to the number of calls, not to the volume. */
export const count = (cost: ExtractionCost | undefined, key: keyof ExtractionCost, by = 1): void => {
  if (cost !== undefined) cost[key] += by;
};

/**
 * What a RISE of each counter means.
 *
 * The failure message is made of this. A message that gives two numbers
 * invites updating the golden; a message that says what the number MEANS
 * forces understanding it first.
 *
 * The golden keys moved from French to these identifiers on 21/09/2026, in a
 * commit that did nothing else: every value was compared before and after
 * through the rename map, 70 of 70 identical. A golden is a recorded
 * measurement, so its keys only ever move in a commit that moves no number.
 */
export const COUNTERS: Record<keyof ExtractionCost, { rise: string }> = {
  docOpens: { rise: "le document est analysé plusieurs fois" },
  operatorsWalked: { rise: "notre code parcourt plus d'opérateurs" },
  glyphFragments: { rise: "notre code construit plus de glyphes" },
  pdfLibOpens: { rise: "le document est ouvert par pdf-lib plus souvent" },
  imagesRead: { rise: "notre code lit plus d'images dans le PDF" },
};
