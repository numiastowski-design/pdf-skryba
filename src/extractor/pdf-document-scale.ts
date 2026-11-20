/** What cannot be decided page by page: which lines are page furniture, which
 *  sizes are headings, and where the column cut falls for the whole document.
 *  NOT here: the rules themselves (`layout/page-furniture.ts`,
 *  `layout/heading-sizes.ts`, `layout/gutter.ts`), nor anything about a single
 *  page (`extractor/pdf.ts`).
 *  Called by: `extractor/pdf.ts`. */

import type { PaintedBox } from "../layout/hidden-repaints";
import { detectColumnGutter } from "../layout/geometry";
import { documentColumnCut, documentColumnCuts, documentCutsRanked } from "../layout/gutter";
import { gridCuts } from "../layout/column-grid";
import {
  bodySizeOf,
  DEFAULT_HEADING_SIZE_RATIO,
  MAX_LEVEL,
  sizeClasses,
  type HeadingLevel,
} from "../layout/heading-sizes";
import { isInBand, type GridBand } from "../layout/grid-band";
import { quarterPoint } from "../layout/mode";
import { detectPageFurniture, detectRepeatedHeadBlocks } from "../layout/page-furniture";
import { groupItemsIntoLines } from "./pdf-lines";
import { minOf } from "../lib/extent";
import { toFragment } from "./pdf-model";
import type { PdfTextRun } from "./pdf-source";
import { SAME_LINE_PT } from "../layout/tolerances";

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

export type { GridBand };

/** The decisions that hold for the whole document. */
export interface DocumentScale {
  // Page furniture is published nowhere. Tried then dropped: publishing it once at the foot of the page.
  headingLevelOf: (size: number) => HeadingLevel | undefined;
  /** Whether a size belongs to the document's BODY class — never true when the
   *  headings abstain because the prose is not representative (see below). */
  isBodySize: (size: number) => boolean;
  /** The sizes (quarter-point) that are the BODY of at least one page of the document — the size carrying the most
   *  letters on a page that has `MIN_PAGE_BODY_LETTERS` of them, the measure `scaleOfPage` makes. Such a size is never a
   *  title on any page (06/11/2026, see `scaleOfPage`). */
  pageBodySizes: ReadonlySet<number>;
  /** The dominant abscissa where the columns are cut, if any: for the decisions that know only two bands. */
  gutterCut: number | undefined;
  /** All the cuts of the document, ascending (a four-column page holds three): for the reading in bands. */
  gutterCuts: readonly number[];
  /** The horizontal reach of the document's body text — the last-resort
   *  container of the centred-pair rule (`pdf-line-breaks.ts`). Undefined when
   *  there is no body class. */
  bodyTextArea: { left: number; right: number } | undefined;
}

/** Which signal says "columns". The column cut is decided for the whole document, never per page: page by page, two
 *  pages of identical geometry came out one split and the other braided. Furniture is removed first.
 *  `gutter` is the white band nothing crosses, blind as soon as a piece of furniture closes it. `width` and `chars`
 *  read the repeated left edges of the blocks, proven by equal widths or by close character counts.
 *  `gutter` stays the default until the three have been compared on published pages. */
export type ColumnEvidence = "gutter" | "width" | "chars";

interface DocumentCuts {
  cut: number | undefined;
  all: readonly number[];
}

/** The grid, for the two kinds of evidence that are not the gutter: only the evidence changes, the decision stays
 *  document-wide. */
const gridOfDocument = (
  pages: readonly (readonly PdfTextRun[])[],
  evidence: Exclude<ColumnEvidence, "gutter">,
): DocumentCuts => {
  const { all, dominant } = documentCutsRanked(pages, (page) => gridCuts(page, evidence));
  return { cut: dominant, all };
};

const documentGutters = (
  items: readonly (readonly PdfTextRun[])[],
  furniture: ReadonlySet<PdfTextRun>,
  evidence: ColumnEvidence,
): DocumentCuts => {
  const pages = items.map((rawItems) => rawItems.filter((it) => !furniture.has(it)));
  if (evidence !== "gutter") return gridOfDocument(pages, evidence);
  return { cut: documentColumnCut(pages), all: documentColumnCuts(pages) };
};

/**
 * The styles of a page are decided per page, on the size of each fragment, without undoing the document's hierarchy.
 * The page's body is the size that carries the most letters; it is never a title there, nor is a size within
 * `DEFAULT_HEADING_SIZE_RATIO` of it. Below the body by at least that ratio: small text.
 *
 * A title of the page is a size above the page's body by that ratio, whether the document ranks it or not: a
 * masthead seen once stays a paragraph on the document's scale. The titles of the page are ranked by size; a
 * document class holds one rank, and so do two lone sizes within the ratio of each other. The level is the rank,
 * never above the level the document gives: a page that holds only `h3` sections keeps them `h3`.
 *
 * Accepted cost: lone lines at 1.2 to 1.5 times the body become titles, and sections set at the body size (bold
 * alone) or under the ratio are not found. A page with fewer letters than this has no body (a cover, a lone title)
 * and keeps the document's scale as it is.
 */
export const MIN_PAGE_BODY_LETTERS = 400;

/** A SIZE WITH FEWER LETTERS THAN THIS ON THE PAGE TAKES NO RANK: the drop cap « C' » of the newspaper's front page (36 pt,
 *  two letters) took a rank of its own between the 54 pt title and the 24 pt masthead line. A title has words. */
export const MIN_RANK_LETTERS = 3;

export interface PageScale {
  headingLevelOf: (size: number) => HeadingLevel | undefined;
  isBodySize: (size: number) => boolean;
  /** Smaller than the page's body by at least the heading ratio: « Small text ». */
  isSmallSize: (size: number) => boolean;
}

/** Letters and digits per quarter-point size on a page, rotated runs left out. */
const lettersBySizeOf = (items: readonly PdfTextRun[]): Map<number, number> => {
  const charsBySize = new Map<number, number>();
  for (const it of items) {
    if (it.rotated || it.text.trim().length === 0) continue;
    let letters = 0;
    for (const ch of it.text) if (LETTER_OR_DIGIT.test(ch)) letters++;
    const size = quarterPoint(it.fontSize);
    charsBySize.set(size, (charsBySize.get(size) ?? 0) + letters);
  }
  return charsBySize;
};

/** The ranks of a page's title sizes, largest first: a size of the same document class as the rank's first joins it; a
 *  lone size within the ratio of a lone first joins it too. The level is the rank, never above the document's. */
const rankedLevels = (
  titles: readonly number[],
  documentLevelOf: (size: number) => HeadingLevel | undefined,
  ratio: number,
): Map<number, HeadingLevel> => {
  const levels = new Map<number, HeadingLevel>();
  let rank = 0;
  let first: number | undefined;
  for (const size of titles) {
    const documentLevel = documentLevelOf(size);
    const sameClass = first !== undefined && documentLevel !== undefined && documentLevelOf(first) === documentLevel;
    const sameLone =
      first !== undefined &&
      documentLevel === undefined &&
      documentLevelOf(first) === undefined &&
      first / size < ratio;
    if (!sameClass && !sameLone) {
      rank += 1;
      first = size;
    }
    levels.set(size, Math.min(Math.max(rank, documentLevel ?? 1), MAX_LEVEL) as HeadingLevel);
  }
  return levels;
};

/** THE BODY OF EACH PAGE, as `scaleOfPage` measures it (raw items, turned runs left out): a size that is the body of one
 *  page is body text of this document, whatever the document-wide classes made of it (06/11/2026). */
const pageBodySizesOf = (items: readonly (readonly PdfTextRun[])[]): Set<number> => {
  const sizes = new Set<number>();
  for (const rawItems of items) {
    const letters = lettersBySizeOf(rawItems);
    const body = bodySizeOf(letters);
    if (body !== undefined && (letters.get(body) ?? 0) >= MIN_PAGE_BODY_LETTERS) sizes.add(body);
  }
  return sizes;
};

export const scaleOfPage = (
  items: readonly PdfTextRun[],
  scale: Pick<DocumentScale, "headingLevelOf" | "isBodySize" | "pageBodySizes">,
): PageScale => {
  const charsBySize = lettersBySizeOf(items);
  const body = bodySizeOf(charsBySize);
  if (body === undefined || (charsBySize.get(body) ?? 0) < MIN_PAGE_BODY_LETTERS)
    return { ...scale, isSmallSize: () => false };
  const ratio = DEFAULT_HEADING_SIZE_RATIO;
  // A size the document ranks stays a title on every page; only the body band of this page demotes it. Tried then
  // dropped: the gate "at least the ratio above the page's body" for ranked sizes too, which lost the sections set
  // just under the ratio. A size the document does not rank must pass that gate.
  //
  // AND A SIZE THAT IS THE BODY OF A PAGE OF THE DOCUMENT IS A HEADING ON NO PAGE (06/11/2026, `pageBodySizes`).
  // Measured on p4 of the Alouette bulletin (fixture 58 p2, `corpus-local/diag-alouette-tailles.ts`): the programme in
  // 7.5 pt holds 2,972 letters and is the body of the page; the Argument and "Informations pratiques" in 9 pt hold
  // 1,739, and 9 pt is the body of p3 (6,960 letters). Yet the DOCUMENT ranks 9 pt as `h6`: on four-column pages,
  // almost every 9 pt line overlaps the gutter (the 14/09 rule above) and drops out of the distribution,
  // so 7.5 pt becomes the document's body and 9 pt a heading class. On p4, 9 / 7.5 = 1.2 exactly: the prose
  // passed the gate and came out as `<h6>`, sentence by sentence. A size that carries the body of a whole page is
  // not a heading style; the page reads it as paragraphs.
  // TRIED THEN DROPPED THE SAME DAY: "a size of the document's body BAND (`isBodySize`) is never a
  // heading" — no effect here (9 pt is not in it), and 08-ontario fell from 8 headings found to 0 on the structure-truth bench:
  // its Word sections sit at 1.17 of the body, inside the band. The band is too wide; the measured body of a page is not.
  const isTitle = (size: number): boolean => {
    if (scale.pageBodySizes.has(size)) return false;
    return scale.headingLevelOf(size) !== undefined
      ? !(size < body * ratio && size * ratio > body)
      : size >= body * ratio;
  };
  const titles = [...charsBySize.entries()]
    .filter(([size, letters]) => letters >= MIN_RANK_LETTERS && isTitle(size))
    .map(([size]) => size)
    .sort((a, b) => b - a);
  const levels = rankedLevels(titles, scale.headingLevelOf, ratio);
  return {
    headingLevelOf: (size) => levels.get(quarterPoint(size)),
    isBodySize: (size) => {
      const q = quarterPoint(size);
      return q < body * ratio && q * ratio > body;
    },
    isSmallSize: (size) => quarterPoint(size) * ratio <= body,
  };
};

/** The runs of the lines that overlap their page's column gutter (`decideDocumentScale`, third exclusion). */
const gutterStraddlers = (linesByPage: readonly PdfTextRun[][][]): Set<PdfTextRun> => {
  const straddlesGutter = new Set<PdfTextRun>();
  linesByPage.forEach((lines) => {
    const gutter = detectColumnGutter(lines.map((line) => line.map(toFragment)));
    if (gutter === undefined) return;
    for (const line of lines) {
      const real = line.filter((it) => it.text.trim().length > 0);
      const left = real.some((it) => it.x + it.width <= gutter.start + SAME_LINE_PT);
      const right = real.some((it) => it.x >= gutter.end - SAME_LINE_PT);
      if (left && right) for (const it of real) straddlesGutter.add(it);
    }
  });
  return straddlesGutter;
};

/** The leftmost and rightmost edges of the body-size text of the whole document, furniture and detected grids excluded. */
const bodyTextAreaOf = (
  items: readonly PdfTextRun[][],
  bandsByPage: readonly (readonly GridBand[])[],
  furniture: ReadonlySet<PdfTextRun>,
  isBodySize: (size: number) => boolean,
): { left: number; right: number } | undefined => {
  let areaLeft = Infinity;
  let areaRight = -Infinity;
  for (const [pageIndex, pageItems] of items.entries()) {
    const bands = bandsByPage[pageIndex] ?? [];
    for (const it of pageItems) {
      if (furniture.has(it) || it.rotated || it.text.trim().length === 0 || !isBodySize(it.fontSize)) continue;
      if (isInBand(it.y + it.fontSize / 2, bands)) continue;
      areaLeft = Math.min(areaLeft, it.x);
      areaRight = Math.max(areaRight, it.x + it.width);
    }
  }
  return areaRight > areaLeft ? { left: areaLeft, right: areaRight } : undefined;
};

export const decideDocumentScale = (
  items: readonly PdfTextRun[][],
  bandsByPage: readonly (readonly GridBand[])[],
  /** The page heights (MediaBox): the page-edge exceptions of the furniture rules need them. */
  pageHeights: readonly number[] = [],
  /** The y of each page's bottom edge in user space (`view[1]`): band tests are made relative to it. */
  pageBottoms: readonly number[] = [],
  /** `fillsByPage` is no longer read: the option stays so that the calls do not break. `evidence`: the signal that
   *  says "columns". Both sit in one object with no default value: six positional parameters pass `max-params`, and
   *  a default in the destructuring is a branch that passes `complexity`. */
  { evidence }: { fillsByPage: ReadonlyMap<number, readonly PaintedBox[]>; evidence: ColumnEvidence },
): DocumentScale => {
  // Page furniture is recognised once for the whole document: the proof of a footer is that it comes back at the
  // same place on another page. The rules receive the bands of the detected tables: a table header repeats from
  // page to page too, and must never be taken for furniture.
  const linesByPage = items.map((pageItems) => groupItemsIntoLines(pageItems));
  const pageLines = linesByPage.map((lines) =>
    lines.map((line) => ({
      y: line[0]!.y,
      x: minOf(line, (it) => it.x),
      size: line[0]!.fontSize,
      text: line.map((it) => it.text).join(""),
    })),
  );

  // Two rules, distinct on purpose: furniture is a repetition at the same place, a repeated head block is a text
  // already seen earlier in the document. The second is the riskier one.
  const furnitureByPage = detectPageFurniture(pageLines, bandsByPage, pageHeights, pageBottoms);
  const repeatedByPage = detectRepeatedHeadBlocks(pageLines, bandsByPage, pageHeights, pageBottoms);

  const removed = (pageIndex: number, lineIndex: number): boolean =>
    furnitureByPage[pageIndex]?.[lineIndex] === true || repeatedByPage[pageIndex]?.[lineIndex] === true;

  const furniture = new Set<PdfTextRun>();
  linesByPage.forEach((lines, pageIndex) => {
    lines.forEach((line, lineIndex) => {
      if (removed(pageIndex, lineIndex)) for (const it of line) furniture.add(it);
    });
  });

  // Heading sizes are decided for the whole document, never per page: the body of one page is not the body of the
  // document, and the same heading would get two levels. Two exclusions: furniture (a footer copyright is no
  // heading) and grids (the sizes of a table say nothing of the prose).
  // The sizes come from the items already read: counting glyphs would cost a second read of the operator stream.
  const charsBySize = new Map<number, number>();
  const lettersBySize = new Map<number, number>();
  const pagesBySize = new Map<number, Set<number>>();
  /** The same distribution over all the text, table bands included: it only tells whether the prose outside the
   *  tables still represents the document. */
  const charsBySizeAll = new Map<number, number>();
  // Third exclusion: the lines that overlap a column gutter. A block set side by side carries no heading: two bands
  // at the top of a page are a letterhead, not a section. No threshold: overlapping is a yes or no. The line leaves
  // the distribution, not only the classification, or its size would stay a heading class no line lives in.
  const straddlesGutter = gutterStraddlers(linesByPage);
  items.forEach((rawItems, pageIndex) => {
    const bands = bandsByPage[pageIndex] ?? [];
    for (const it of rawItems) {
      if (furniture.has(it) || straddlesGutter.has(it)) continue;
      const chars = it.text.replace(/\s/g, "").length;
      if (chars === 0 || !(it.fontSize > 0)) continue;
      const size = quarterPoint(it.fontSize);
      charsBySizeAll.set(size, (charsBySizeAll.get(size) ?? 0) + chars);
      const cy = it.y + it.fontSize / 2;
      if (isInBand(cy, bands)) continue;
      charsBySize.set(size, (charsBySize.get(size) ?? 0) + chars);
      let letters = 0;
      for (const ch of it.text) if (LETTER_OR_DIGIT.test(ch)) letters++;
      lettersBySize.set(size, (lettersBySize.get(size) ?? 0) + letters);
      const pages = pagesBySize.get(size) ?? new Set<number>();
      pages.add(pageIndex);
      pagesBySize.set(size, pages);
    }
  });

  const gutters = documentGutters(items, furniture, evidence);

  // Nothing is ranked when the prose left is not the body of the document: a table that swallows the page leaves
  // crumbs (two legal notices in a footer), and the body computed on them is wrong. No constant: the body measured
  // outside the tables is compared with the body measured on all the text, and when they differ the headings
  // abstain. Tried then dropped: a minimum count of lines, since a body of two lines at the real body size is valid.
  const proseClasses = sizeClasses(charsBySize, undefined, { pageCount: items.length, lettersBySize, pagesBySize });
  const proseIsRepresentative =
    proseClasses.bodySize !== undefined && proseClasses.bodySize === bodySizeOf(charsBySizeAll);
  const classes = proseIsRepresentative
    ? proseClasses
    : { body: new Set<number>(), levels: new Map<number, HeadingLevel>() };
  const headingLevelOf = (size: number): HeadingLevel | undefined => classes.levels.get(quarterPoint(size));
  const isBodySize = (size: number): boolean => classes.body.has(quarterPoint(size));

  // THE BODY TEXT AREA, measured on the whole DOCUMENT: Word's margins hold for
  // every page, and a page carrying only a centred title would otherwise define
  // its area as that title. No constant: the leftmost and rightmost edges of the
  // body-size text, furniture and detected grids excluded.
  const bodyTextArea = bodyTextAreaOf(items, bandsByPage, furniture, isBodySize);

  return {
    headingLevelOf,
    isBodySize,
    pageBodySizes: pageBodySizesOf(items),
    gutterCut: gutters.cut,
    gutterCuts: gutters.all,
    bodyTextArea,
  };
};
