/** A document's heading levels drawn from its font sizes alone: the body size
 *  (the dominant one), every size at least T times it is a heading, and its level
 *  is the rank of its size among the heading sizes.
 *  NOT here: the per-PAGE scale built on top (`extractor/pdf-document-scale.ts#scaleOfPage`), the
 *  abstention when the prose is not representative (`extractor/pdf-document-scale.ts`),
 *  nor what a heading becomes in the document (`extractor/pdf-paragraphs.ts`).
 *  Called by: `extractor/pdf-document-scale.ts` ; `tools/structure-truth/report.ts` lit le ratio. */

import { modeOf } from "doc-ir/layout/mode";

/**
 * heading-sizes — a document's heading ladder, from its font sizes alone.
 *
 * WHY IT EXISTS. We detected NO heading (Matterhorn 14-001), which loses more
 * than structure: a long page with no headings is unusable to a screen reader
 * and to a table of contents (WCAG 1.3.1, 2.4.6).
 *
 * THE RULE (30/09/2026, after a decision tree and a small network failed to beat it and were NOT embedded): compare
 * each size to the BODY size, not to its neighbour. The body is the dominant
 * size. A size at least T times the body is a heading; its level is its rank
 * among the distinct heading sizes.
 *
 * TRIED AND MEASURED DEAD, so nobody returns to it:
 *
 *  · Cutting the sorted sizes where two NEIGHBOURS differ by a ratio (this
 *    module's rule until 30/09/2026, built on twelve fixtures we wrote, whose
 *    gaps happened to sit in the free interval 1.13 to 1.27). On real Word
 *    exports the ladder is continuous: docx-reel/02 has 11 · 12 · 14 · 16 · 18 ·
 *    20 · 30, every neighbour ratio under 1.2, so the chain merged 12 to 20 into
 *    the body and only the cover size stayed a heading: 16 of 74 headings found,
 *    63 once compared to the body.
 *  · One fixed reference for "above the body is a heading" at ratio 1 (11/09/2026):
 *    it held on no ladder, a dense bulletin put the mode at 6.0 and promoted
 *    almost everything. The body-relative ratio T above is not that: it needs a
 *    distance, not just "above".
 *  · The order of first appearances (14/09/2026): mute on five documents of
 *    eight, wrong on two of the three where it speaks.
 *  · A silhouette score on repeated discrete sizes (11/09/2026): it rewards one
 *    class per size.
 *  · A decision tree and a 14-4-1 network on per-line features (30/09/2026, dev
 *    only, not shipped): neither beats size / body >= 1.2.
 *
 * WRITTEN LIMITS OF THE BODY-RELATIVE RULE, accepted with it:
 *  · On the real school report (fixture bulletin, body 6.5) the sizes 8, 9 and 10,
 *    fields of a header block, are at least 1.2 x the body and become headings
 *    (the old cut kept only 13). Pinned in `heading-sizes.test.ts`.
 *  · A size used by one glyph WITH a letter or digit still takes a rank of its own and
 *    shifts the levels below it; a symbol-only size no longer does (see SYMBOL SIZES).
 *  · Headings at the body size (bold or capitals only) are invisible to size
 *    alone: 48 of the 156 headings measured. The second path
 *    (`layout/heading-rule.ts`) adds some of them.
 */

/**
 * A size is a heading when it is at least this many times the BODY size (the
 * dominant size of the document's prose). Since 30/09/2026 the comparison is
 * against the body, no longer between neighbouring sizes.
 *
 * **VALEUR DE DÉPART À CALIBRER.** Measured on seven real Word 365 exports
 * (docx-reel 01 02 04 06 07 08 10, truth = the .docx's declared headings, lines
 * read by our PDF reader, tables and table-of-contents repeats left out;
 * bench: `npm run structure-truth-bench`):
 *
 *   population  n     size / body
 *   headings    156   min 0.92 · p10 1.00 · median 1.28 · p90 1.82   (48 are
 *                     under 1.05: bold or capitals at the body size, which size
 *                     alone cannot find; the 78 French ones all sit at 1.09 or more)
 *   paragraphs  620   median 1.00 · p99 1.00 · max 1.33   (5 are at 1.05 or more:
 *                     a salutation, a form title, two callouts, a bold lead-in)
 *
 * The populations overlap from 1.09 to 1.33 (headings at 1.09, paragraphs at
 * 1.17 and 1.33), so no value separates them. T over the 7 documents, false
 * headings (table cells and cover lines left out) / headings found out of 156:
 *   1.05  5 / 108    1.10  5 / 101    1.20  2 / 95
 * 1.05 would find the eight 1.09 headings of docx-reel/02 ("Endpoint",
 * "Description") and six bold 1.17 ones of 08, for three more false ones, and
 * it contradicts fixture 18, whose 1.09 gap was written to stay a paragraph.
 * 1.20 is kept: fewest false headings, the value the repository already used.
 *
 * REPOSES SUR SEPT DOCUMENTS, DEUX DE LANGUE FRANÇAISE DE MÊME PRODUCTEUR :
 * un seuil, pas une mesure de l'état de l'art. Les vingt documents réels
 * attendus restent la condition pour qu'il devienne défendable.
 */
export const DEFAULT_HEADING_SIZE_RATIO = 1.2;

/** Le format de stockage ne connaît que six niveaux. Au-delà, on empile sur le
 *  dernier plutôt que d'émettre un niveau qui n'existe pas. */
export const MAX_LEVEL = 6;

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

/**
 * A document's size classes: its BODY sizes, and the heading level of every size
 * at least `ratio` times the body. The
 * body half serves `extractor/pdf-image-anchors.ts#figureLabelTest` and the body
 * text area, which must know what running text looks like in THIS document
 * without re-deriving it.
 *
 * THE BODY SIZE is the dominant one: the size carrying the most characters (on a
 * strict tie the SMALLEST, body text being smaller than its headings; the repo
 * rules require a deterministic tie-break). The body SET is the band around it,
 * sizes from body / ratio up to (excluding) body x ratio. A size under the band
 * is a caption or a footer, never a heading.
 *
 * THE LEVEL is the rank of the size among the distinct heading sizes, largest
 * first, capped at MAX_LEVEL. Ranks are not cut by ratios: two heading sizes
 * one point apart are two levels, as in a Word style ladder.
 *
 * COVER (13/10/2026). In a document of 2 pages or more, the heading sizes used ONLY on page 1 and LARGER than every
 * heading size used later are cover sizes, all level 1; if no heading size is used after page 1, every page-1-only heading
 * size is one. The other heading sizes rank from 1, largest first. WHY: on the 7 real Word exports of `fixtures/docx-reel` the
 * cover is a Title-style paragraph, and our docx reader (`extractor/docx-reader/styles.ts`) puts Title AND Heading 1 at level 1.
 * The 30/09 objection was fixture 05a, whose PDF ReportLab generated in this repo: its golden was our own choice, not a
 * declared truth. A one-page document has no cover.
 *
 * SYMBOL SIZES. A heading size whose characters hold no letter and no digit takes no rank (its lines stay paragraphs).
 * Applied before the cover rule.
 *
 *
 * `body` is empty only when the document has no sizes at all.
 */
/** The body size: the one carrying the most characters; on a tie the SMALLEST (the body is smaller than the headings). */
export function bodySizeOf(charsBySize: ReadonlyMap<number, number>): number | undefined {
  return modeOf(new Map([...charsBySize].filter(([size, chars]) => size > 0 && chars > 0)), "smallest");
}

export interface SizeFacts {
  pageCount: number;
  /** Letters and digits per size. */
  lettersBySize: ReadonlyMap<number, number>;
  /** 0-based page indexes each size is used on. */
  pagesBySize: ReadonlyMap<number, ReadonlySet<number>>;
}

export function sizeClasses(
  charsBySize: ReadonlyMap<number, number>,
  ratio: number = DEFAULT_HEADING_SIZE_RATIO,
  facts?: SizeFacts,
): { body: ReadonlySet<number>; bodySize: number | undefined; levels: Map<number, HeadingLevel> } {
  const sizes = [...charsBySize.entries()].filter(([size, chars]) => size > 0 && chars > 0).sort((a, b) => a[0] - b[0]);
  if (sizes.length === 0) return { body: new Set(), bodySize: undefined, levels: new Map() };

  const bodySize = bodySizeOf(charsBySize)!;

  const body = new Set(
    sizes.map(([size]) => size).filter((size) => size >= bodySize / ratio && size < bodySize * ratio),
  );
  let headingSizes = sizes
    .map(([size]) => size)
    .filter((size) => size >= bodySize * ratio)
    .sort((a, b) => b - a);

  const levels = new Map<number, HeadingLevel>();
  if (facts === undefined) {
    headingSizes.forEach((size, index) => levels.set(size, Math.min(index + 1, MAX_LEVEL) as HeadingLevel));
    return { body, bodySize, levels };
  }

  headingSizes = headingSizes.filter((size) => (facts.lettersBySize.get(size) ?? 1) > 0);
  const onFirstPageOnly = (size: number): boolean => {
    const pages = facts.pagesBySize.get(size);
    return pages !== undefined && pages.size > 0 && [...pages].every((page) => page === 0);
  };
  const usedLater = (size: number): boolean => [...(facts.pagesBySize.get(size) ?? [])].some((page) => page > 0);
  const largestLater = Math.max(-Infinity, ...headingSizes.filter(usedLater));
  const isCover = (size: number): boolean => facts.pageCount >= 2 && onFirstPageOnly(size) && size > largestLater;

  const sections = headingSizes.filter((size) => !isCover(size));
  for (const size of headingSizes) if (isCover(size)) levels.set(size, 1);
  sections.forEach((size, index) => levels.set(size, Math.min(index + 1, MAX_LEVEL) as HeadingLevel));
  return { body, bodySize, levels };
}
