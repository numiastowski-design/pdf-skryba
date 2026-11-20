/** The running headers and footers of a document: text recognised by strict
 *  repetition across pages — content, size and position, page numbers
 *  neutralised. Images are not looked at here.
 *  A line that differs from its siblings only by its digits is furniture too
 *  when it touches an exactly repeated line at the same edge; a table band
 *  protects only its upper half (a repeated table header).
 *  An edge line on 3 pages or more whose one figure rises by 1 per page is furniture whatever its words (a
 *  page counter), unless its type is a title's; a long edge block (4 lines or 25 words) needs 3 text pages, or
 *  every text page of its parity.
 *  Also holds a second, riskier rule: blocks repeated at the head of several pages, compared on their exact text
 *  (`detectRepeatedHeadBlocks`).
 *  DETECTION only: nothing is removed from a page (furniture is published). `extractor/pdf-document-scale.ts` uses it to keep
 *  the furniture out of its document-wide measures (heading sizes, column cut, body text area).
 *  NOT here: those measures, nor the heading
 *  rules they are distinguished from (`layout/heading-*.ts`).
 *  Called by: `extractor/pdf-document-scale.ts`. */

import { isInBand, type GridBand } from "./grid-band";
import { SAME_LINE_PT } from "./tolerances";

/**
 * The definition: an element that repeats strictly alike on several pages (content, size and position, page numbers
 * neutralised) is a header or a footer. It is the literature's "page association" (Lin, SPIE Document Recognition
 * and Retrieval, 2003): text similarity and geometric position together.
 *
 * The abscissa is what makes the rule usable: a document title repeated on two pages may differ by a fraction of a
 * point in y and only its x tells it from a footer.
 *
 * Repetition alone is not enough, the line must also be at a page edge: two pages with the same layout repeat all
 * of their content.
 *
 * A table header repeats from page to page too: a line inside the band of a detected grid is never furniture.
 *
 * Tried then dropped: repeating the white instead of the text (what a clear white detaches from the text block, at
 * the same height on two pages). A white between two text lines may hold images, and a page title is geometrically
 * indistinguishable from a running header: no discriminant exists.
 *
 * Tried then dropped: geometry plus a declared `/Artifact` in place of the repetition, for furniture that appears
 * once. Producers declare real content as artifacts (a page title, a letterhead, a list printed at the foot of a
 * letter paper), and "at the edge" is no second witness when the first element of the page is its title. The
 * bottom-only variant was refused too. `extractor/pdf-artifact-furniture.fixtures.test.ts` holds the two specimens.
 */

/** A visual line, reduced to what the comparison needs. */
export interface PageLine {
  /** The line's ordinate, in page space. */
  y: number;
  /** Abscissa of its first fragment: the criterion that saves titles. */
  x: number;
  /** Text size. Two lines of different sizes are not the same line. */
  size: number;
  text: string;
}

/** The vertical band of a detected table, for the extent guard. */
export type TableBand = GridBand;

/** Two positions closer than this are the same position.
 *  Starting value to calibrate: a footer comes back within 0.0 pt, the nearest line that could be mistaken for it
 *  is 17 pt away; one producer only. */
const POSITION_TOLERANCE = SAME_LINE_PT;

/** Two occurrences of one line may differ slightly in size, so strict equality would be too hard. */
const SIZE_TOLERANCE = 0.25;

/** Furniture must repeat on at least this many pages: a two-page document offers no more evidence. */
const MIN_PAGES = 2;

/** Past this multiple of the text size, two lines are not in the same block. It bounds the walk from the edge:
 *  without it a repeated body line is swallowed by the footer whatever the distance between them.
 *  Starting value to calibrate: the two lines of one header block are 1.2 sizes apart, a footer 73 sizes from the
 *  line before it. */
const MAX_RUN_GAP_RATIO = 3;

/** A run may cross ONE larger gap to reach a block that repeats EXACTLY below it (a banner above a lone page number).
 *
 *  VALEUR DE DÉPART À CALIBRER. Measured on the 76 PDFs of the local corpus (<= 15 pages), 14/10/2026: the one real case
 *  (094, Polish form: banner, 34.8 pt gap, page number in 11 pt) is at 3.2 sizes; the bound is twice the ordinary
 *  one. The crossing needs an exact repeat on the far side and an anchored run on this side. */
const MAX_BANNER_GAP_RATIO = 6;

/** A run longer than this that also covers more than half of its page is refused: it swallowed the page, not a block.
 *
 *  VALEUR DE DÉPART À CALIBRER. Measured on the same 76 PDFs, every page that loses lines to the edge walk: legitimate
 *  runs hold 1 to 7 lines (074: 4 above + 3 below), and the one swallowed page pair (024 hydralabplus p6-p7) holds 23 of
 *  23 lines. Short pages that are only furniture (a number alone, 2 of 2 lines) stay below the floor. */
const MAX_FURNITURE_RUN_LINES = 8;

/** A run of this many lines, or of this many words, is a BLOCK, not a line or two of furniture: it must repeat on
 *  `LONG_BLOCK_PAGES_THRESHOLD` pages (or on every page of a shorter document), and it never covers every line of its page.
 *
 *  VALEUR DE DÉPART À CALIBRER. Measured on the 78 « bien construit » Word-made PDFs of the local corpus (<= 15 pages), 15/10/2026:
 *  two section openings that two pages shared were published as furniture and lost 189 words (080 pages 6, 8: « Titre de niveau 1 »
 *  + a 4-line paragraph; 024 pages 6-7: 42 words); the true runs measured then (tool since retired) were 1 to 3 lines and 2 to
 *  20 words (the longest declared header holds 7 lines, 074 Geneva form, repeated on every page). Three pages is the floor
 *  `EDGE_COUNTER_PAGES_THRESHOLD` already uses for the same reason. */
const LONG_BLOCK_LINES_THRESHOLD = 4;
const LONG_BLOCK_WORDS_THRESHOLD = 25;
const LONG_BLOCK_PAGES_THRESHOLD = 3;

/** A page counter written as a rising figure inside a long line (« …AWS Schweiz 2 ») needs this many words of text
 *  around the figure, so that a one-per-page title (« Annexe 1 », fixture 19) is never taken for one.
 *
 *  VALEUR DE DÉPART À CALIBRER. Counters measured on the corpus: 9 to 20 words of text (« 1 | G l o s s a i r e »
 *  counts 9 letters as words); the titles to keep apart: 1 word (« Annexe N »). The gap is wide but rests on few
 *  documents. */
const COUNTER_TEXT_WORDS_THRESHOLD = 3;

/** A rising figure in a line that also holds ANOTHER figure which never changes (« September 2021 N SY 2021-22 », « 430 - N »,
 *  « 14/10/2026 0078.docx N ») is a page counter wherever it stands in the line and however few words surround it, provided the
 *  line repeats at the SAME position inside the page edge band on at least this many pages. The words and the place the strict
 *  rule asks for are what keeps a one-per-page title (« Annexe N ») apart; a constant figure beside the rising one, at the edge,
 *  on three pages, is what a running line has and a title has not.
 *
 *  VALEUR DE DÉPART À CALIBRER. Measured on the 78 « bien construit » Word-made PDFs of the local corpus (<= 15 pages), 15/10/2026:
 *  eight documents carry such a counter (3 to 15 pages each, ~544 invented words before); the titles to keep apart (« Annexe N »,
 *  fixture 19; « Article N : … ») hold no second figure or are not in the edge band. Three pages is the floor under which a
 *  coincidence of two lines proves nothing. */
const EDGE_COUNTER_PAGES_THRESHOLD = 3;

/** The relaxed counter rule never takes a line larger than this multiple of the document's body size: a title is clearly
 *  bigger than the text, a running footer is body-sized or a point over it.
 *
 *  VALEUR DE DÉPART À CALIBRER. Footer measured over the body: 1.1 (fixture 39: 11 pt over 10 pt), 0.75 (footers of 122, 157,
 *  176: 9 over 12); title to keep apart: 1.5 (18 over 12, synthetic « Question N of 20 »). Few real titles measured: the gap is wide on paper only. */
const MAX_COUNTER_SIZE_RATIO = 1.2;

/** The largest figure taken for a page counter: a year or a reference number that changes by one per page is not one.
 *  VALEUR DE DÉPART À CALIBRER. Counters measured: 1 to 14 (15 pages at most); the figures to keep apart: years (2023+). */
const MAX_COUNTER_FIGURE = 999;

/** The outer fraction of the page height where running headers and footers live. Unstructured uses 7 % and 93 %.
 *  Used only when the caller knows the page heights.
 *
 *  VALEUR DE DÉPART À CALIBRER. Measured: furniture lines sit at 2 % to 6 % from an edge (074: 2.7 %, 094: 4.6 %); the
 *  repeated body text that must NOT be dropped sits at 7.6 % or more (054 p6: 15.7 %, 120 p7: 12 %, 047 p5: 7.9 %). */
const MAX_EDGE_BAND_FRACTION = 0.07;

/** Page numbers change from page to page: the only variation admitted, neutralised before comparison.
 *
 *  Only what has the shape of a page number is neutralised. Tried then dropped: replacing every number, which made
 *  "Annexe 1", "Annexe 2", "Annexe 3" at one point the same line. A header that changes otherwise than by its page
 *  number is not a header. Also dropped: "furniture is smaller than the body" (repeated headers can be larger) and
 *  "the number follows the page" (a numbered title on its own page follows it too).
 *
 *  The grammar is short and closed:
 *  - a line that is only the number: `3`, `- 3 -`, `3/30`, `3 of 30`;
 *  - a page word followed by the number, anywhere in the line: `p 3`, `p. 3`, `pg 3`, `Page 3`. A glued `P1` is
 *    not one.
 *  An `n/N` behind another word is not a page number.
 *
 *  For furniture detection only. `detectRepeatedHeadBlocks` compares the exact text: neutralising figures there
 *  would make "402" match a lone "4". */
const PAGE_NUMBER_ALONE = /^[-–—\s]*\d+(?:\s*(?:\/|sur|of)\s*\d+)?[-–—\s]*$/iu;
/** The words for « page », a written list (FR, EN, DE, ES, IT, PT, PL, NL, SV, DA). `p` alone needs a space after it. */
const PAGE_WORDS = "page|pg\\.?|pag\\.?|pág\\.?|pagina|página|seite|strona|sida|side|bladzijde|str\\.|p\\.|p(?=\\s)";
/** « of » between the page and the total in the same languages (« Strona 4 z 11 »). */
const OF_WORDS = "\\/|sur|of|z|von|de|di|van|av|af";
/** A figure, or a Roman numeral up to 39 (front matter pages; « mix » is not one). */
const PAGE_FIGURE = "(?:\\d+|(?=[ivx])x{0,3}(?:ix|iv|v?i{0,3}))";
const PAGE_NUMBER_AFTER_WORD = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${PAGE_WORDS})\\s*[|:]?\\s*${PAGE_FIGURE}(?:\\s*(?:${OF_WORDS})\\s*\\d+)?(?![\\p{L}\\p{N}])`,
  "giu",
);
/** The figure BEFORE a page word, after a bar: « 12 | Page ». The bar is the evidence; « 3 page » alone is prose. */
const PAGE_NUMBER_BEFORE_WORD = new RegExp(
  `(?<![\\p{L}\\p{N}])${PAGE_FIGURE}\\s*\\|\\s*(?:${PAGE_WORDS})(?![\\p{L}\\p{N}])`,
  "giu",
);
/** Four letters or more, each alone between single spaces (« P a g e », « G l o s s a i r e »): the way Word spaces out some footers. */
const LETTER_SPACED = /(?<![\p{L}\p{N}])\p{L}(?: \p{L}){3,}(?![\p{L}\p{N}])/gu;
export const normalizeText = (text: string): string => {
  const trimmed = text.trim().replace(LETTER_SPACED, (run) => run.replace(/ /g, ""));
  if (PAGE_NUMBER_ALONE.test(trimmed)) return "#";
  return trimmed.replace(PAGE_NUMBER_AFTER_WORD, "p#").replace(PAGE_NUMBER_BEFORE_WORD, "p#");
};

const bucket = (value: number, tolerance: number): number => Math.round(value / tolerance);

/** Are two lines' baselines within `ratio` times the larger size? */
const within = (a: PageLine, b: PageLine, ratio: number): boolean => {
  const size = Math.max(a.size, b.size);
  return size > 0 && Math.abs(a.y - b.y) <= size * ratio;
};

/** Two neighbouring lines belong to one block when their baselines are within `MAX_RUN_GAP_RATIO` of the larger size. */
const contiguous = (a: PageLine, b: PageLine): boolean => within(a, b, MAX_RUN_GAP_RATIO);

/** Does a run of this length swallow its page (see `MAX_FURNITURE_RUN_LINES`)? */
const swallowsPage = (length: number, pageLines: number): boolean =>
  length > MAX_FURNITURE_RUN_LINES && length * 2 > pageLines;

/** What the edge walk and its acceptance tests read about one page. */
interface RunContext {
  lines: readonly PageLine[];
  loose: readonly boolean[];
  exact: readonly boolean[];
  mostlyRepeated: boolean;
  /** On how many pages each line repeats (its exact form, else its digits-free form). */
  support: readonly number[];
  /** On how many pages OF THIS PARITY each line repeats (its position without the abscissa). */
  paritySupport: readonly number[];
  /** How many pages of the document carry text, and how many of them have this page's parity. */
  textPages: number;
  sameParityTextPages: number;
}

/**
 * The lines of one edge run (walked from `from` by `step`) that are furniture, or none. See the walk's comment in
 * `detectPageFurniture` for the rules: loose repeats, one exact anchor, the bounded gap crossing, the page-swallowing bound.
 */
const edgeRun = (page: RunContext, from: number, step: 1 | -1): number[] => {
  const { lines, loose, exact, mostlyRepeated } = page;
  const run: number[] = [];
  let beforeGap: number | undefined;
  for (let i = from; i >= 0 && i < lines.length && loose[i] === true; i += step) {
    if (i !== from && !contiguous(lines[i - step]!, lines[i]!)) {
      const mayCross =
        beforeGap === undefined && !mostlyRepeated && exact[i] === true && run.some((j) => exact[j] === true);
      if (!mayCross || !within(lines[i - step]!, lines[i]!, MAX_BANNER_GAP_RATIO)) break;
      beforeGap = run.length;
    }
    run.push(i);
  }
  if (beforeGap === undefined) dropLabelsOfTheBody(run, page, step);
  const kept = swallowsPage(run.length, lines.length) && beforeGap !== undefined ? run.slice(0, beforeGap) : run;
  if (isFurnitureRun(kept, page)) return kept;
  return supportedEdgePrefix(kept, page);
};

/** The last line of a walked run that stands closer to the line after the run than to the line before it, repeats on fewer than
 *  `LABEL_SUPPORT_RATIO` of the pages the run's strongest line repeats on, is the first line of the
 *  body (a section label such as « Description », repeated at the page top where a page break fell), not the end of the header block: a header
 *  block is detached from the body by a gap larger than its own line spacing, and its lines repeat together. Dropped from the run one line at a
 *  time, never the edge line. The strongest support is capped at the number of text pages (a page counter counts as all of them).
 *  The gap and support tests are both needed: the gap alone drops the last line of a footer printed close to a table (2-page document).
 *  ACCEPTED BIAS (laid, pinned by a test): a header block's own subtitle that is close to the body and repeats on few pages (other text per
 *  chapter) is published once per page, visible, rather than removed. A size guard (never drop a line of the strongest line's size) was tried and
 *  measured 15/10/2026: it kept the subtitle but lost 3 of the 5 saved documents (198 footnote, 208 table cells, 188 cells, all body-sized).
 *  A next line on the same baseline is a neighbouring column, not the body: no drop. */
const dropLabelsOfTheBody = (run: number[], page: RunContext, step: 1 | -1): void => {
  const { lines, support } = page;
  const strongestLine = run.reduce((best, j) => (support[j]! > support[best]! ? j : best), run[0]!);
  const strongest = Math.min(support[strongestLine]!, page.textPages);
  while (run.length > 1) {
    const last = run[run.length - 1]!;
    const next = lines[last + step];
    if (next === undefined || Math.abs(lines[last]!.y - next.y) <= POSITION_TOLERANCE) return;
    const above = Math.abs(lines[run[run.length - 2]!]!.y - lines[last]!.y);
    if (above <= Math.abs(lines[last]!.y - next.y) || support[last]! >= strongest * LABEL_SUPPORT_RATIO) return;
    run.pop();
  }
};

/** See `dropLabelsOfTheBody`.
 *
 *  VALEUR DE DÉPART À CALIBRER. Measured 15/10/2026 on 02-jvmalin (16 pages): the running header repeats on 16 pages, the label « Description » on 3
 *  (ratio 0.19); a header block's lines repeat together (ratio 1). Measured activations on 6 of the 300 Word PDFs of the local corpus (six documents, the five
 *  and 063 named in the commit): the saved lines repeat on 2 to 3 pages against 5 to 26 for the strongest line. The gap rests on few documents. */
const LABEL_SUPPORT_RATIO = 0.5;

/** When a long run is refused only because part of it is a block repeated on too few pages (a footnote shared by two pages, 08 Ontario
 *  p5 and p8, right above « Page 5 of 13 »), the lines from the edge inward that repeat on enough pages by themselves are still
 *  furniture, provided they make a short run with an exact anchor. The refused block itself stays. A run that covers every line of
 *  its page (a template) gives nothing back. */
const supportedEdgePrefix = (run: readonly number[], page: RunContext): number[] => {
  if (run.length === page.lines.length || swallowsPage(run.length, page.lines.length)) return [];
  const prefix: number[] = [];
  for (const i of run) {
    if (!isEnoughSupported(i, page)) break;
    prefix.push(i);
  }
  return prefix.length > 0 && prefix.length < run.length && isFurnitureRun(prefix, page) ? prefix : [];
};

/** Does this line repeat on enough pages, by itself, to be furniture inside a long block (`LONG_BLOCK_PAGES_THRESHOLD`, or its parity)? */
const isEnoughSupported = (i: number, page: RunContext): boolean => {
  const pagesNeeded = Math.min(LONG_BLOCK_PAGES_THRESHOLD, page.textPages);
  return (
    page.support[i]! >= pagesNeeded ||
    (page.sameParityTextPages >= MIN_PAGES && page.paritySupport[i]! >= page.sameParityTextPages)
  );
};

/** Does this walked run stand: it does not swallow its page, holds an exact anchor, and is not an under-supported block? */
const isFurnitureRun = (run: readonly number[], page: RunContext): boolean =>
  !swallowsPage(run.length, page.lines.length) &&
  run.some((i) => page.exact[i] === true) &&
  !isUnderSupportedBlock(run, page);

/** Is this run a BLOCK (`LONG_BLOCK_*_THRESHOLD`) that either covers every line of its page or repeats on too few pages? */
const isUnderSupportedBlock = (run: readonly number[], page: RunContext): boolean => {
  const words = run.reduce(
    (sum, i) =>
      sum +
      page.lines[i]!.text.replace(LETTER_SPACED, (spaced) => spaced.replace(/ /g, ""))
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w !== "").length,
    0,
  );
  if (run.length < LONG_BLOCK_LINES_THRESHOLD && words < LONG_BLOCK_WORDS_THRESHOLD) return false;
  // ACCEPTED COST (laid bias, pinned by a test): in a 3-4 page document a real block of 4 lines or more that opens pages 1 and 3 only
  // is indistinguishable from a mirrored odd-page header, and is removed.
  // Pages without text offer no evidence either way; an odd/even block (a mirrored layout) is judged on the pages of its parity.
  return run.length === page.lines.length || run.some((i) => !isEnoughSupported(i, page));
};

/** Is the line inside the top or bottom edge band of a page of this height, whose view starts at `pageBottom` in user space
 *  (a CropBox may start above 0)? Unknown height: never (the caller keeps the rule that needs no height). */
const atPageEdge = (line: PageLine, pageHeight: number | undefined, pageBottom = 0): boolean => {
  if (pageHeight === undefined || pageHeight <= 0) return false;
  const y = line.y - pageBottom;
  return y >= pageHeight * (1 - MAX_EDGE_BAND_FRACTION) || y <= pageHeight * MAX_EDGE_BAND_FRACTION;
};

/** What a line is compared on (see `detectPageFurniture`): the exact key, the digits-free key, the normalized text. */
interface LineKeys {
  exact: string;
  loose: string;
  text: string;
}

/**
 * The lines that carry a PAGE COUNTER written as a plain figure: one line per page, and across the pages exactly one of its
 * digit runs equals the page index plus a constant while every other run stays put (« …AWS Schweiz 2 »,
 * « file.docx 1 / 7 October 7, 2025 », « 1 | Glossaire »). Such a line repeats by its loose key and its figure follows the page,
 * which is what the exact repeat of a page number says. The text around the figure must be long enough
 * (`COUNTER_TEXT_WORDS_THRESHOLD`): the 15/09/2026 rule stands for short one-per-page titles.
 * A second reading, for the lines the first one cannot take (`EDGE_COUNTER_PAGES_THRESHOLD`): the position is compared without its
 * abscissa (a duplex layout swaps the margins page by page: « 388 - 1 » at x=509, « 388 - 2 » at x=72), a lower-case Roman numeral
 * counts as a figure (the front matter of a Word document: « September 2021 ii SY 2021-22 »), and neither the words nor the
 * place of the figure matter.
 */
const counterLinesOf = (
  pagesLines: readonly (readonly PageLine[])[],
  keys: (line: PageLine) => LineKeys,
  /** Is this line of this page inside the page's top or bottom edge band? (Never, when the heights are unknown.) */
  atEdge: (line: PageLine, page: number) => boolean,
): Set<PageLine> => {
  const bodySize = furnitureBodySizeOf(pagesLines);
  const groups = new Map<string, CounterEntry[]>();
  const relaxedGroups = new Map<string, CounterEntry[]>();
  pagesLines.forEach((lines, page) => {
    for (const line of lines) {
      const entry = counterEntryOf(line, keys(line), {
        page,
        pageCount: pagesLines.length,
        edge: atEdge(line, page),
        bodySize,
      });
      if (entry === undefined) continue;
      if (entry.digits.length > 0) pushTo(groups, keys(line).loose, entry);
      pushTo(relaxedGroups, entry.relaxed.key, entry);
    }
  });
  const found = new Set<PageLine>();
  // Strict: enough words around the figure, and the figure at a place a counter stands.
  for (const group of groups.values()) {
    const texty = group.filter((e) => e.enoughText);
    if (risesWithPage(texty, (e) => ({ digits: e.digits, standalone: e.strict })))
      for (const e of texty) found.add(e.line);
  }
  // Relaxed: a second, constant figure in the line, the same position inside the edge band, on enough pages.
  for (const group of relaxedGroups.values()) {
    if (
      group.length >= EDGE_COUNTER_PAGES_THRESHOLD &&
      group.every((e) => e.edge && !e.oversize) &&
      group[0]!.relaxed.digits.length >= 2 &&
      risesWithPage(group, (e) => e.relaxed)
    ) {
      for (const e of group) found.add(e.line);
    }
  }
  return found;
};

/** The document's body size: the font size that carries the most characters. */
const furnitureBodySizeOf = (pagesLines: readonly (readonly PageLine[])[]): number => {
  const chars = new Map<number, number>();
  for (const lines of pagesLines)
    for (const l of lines) {
      const b = bucket(l.size, SIZE_TOLERANCE);
      chars.set(b, (chars.get(b) ?? 0) + l.text.length);
    }
  let best = 0;
  let bestChars = -1;
  for (const [b, n] of chars) if (n > bestChars || (n === bestChars && b > best)) [best, bestChars] = [b, n];
  return best * SIZE_TOLERANCE;
};

const pushTo = <T>(map: Map<string, T[]>, key: string, value: T): void => {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
};

/** One line read for the page-counter rules (`counterLinesOf`). */
interface CounterEntry {
  line: PageLine;
  page: number;
  digits: number[];
  /** Per digit run: no letter or digit touches it. */
  standalone: boolean[];
  /** Per digit run: standalone AND at a place a counter may stand. */
  strict: boolean[];
  enoughText: boolean;
  edge: boolean;
  /** Larger than the document's body text: a title, never page furniture (relaxed rule only). */
  oversize: boolean;
  /** The Roman-aware reading of the line, for the relaxed rule. */
  relaxed: { key: string; digits: number[]; standalone: boolean[] };
}

const counterEntryOf = (
  line: PageLine,
  { text }: LineKeys,
  { page, pageCount, edge, bodySize }: { page: number; pageCount: number; edge: boolean; bodySize: number },
): CounterEntry | undefined => {
  const romanised = text.replace(ROMAN_FIGURE, (token) => String(romanValueOf(token)));
  const romanRuns = [...romanised.matchAll(/\d+/g)];
  if (romanRuns.length === 0) return undefined;
  const runs = [...text.matchAll(/\d+/g)];
  return {
    line,
    page,
    digits: runs.map((m) => Number(m[0])),
    // A figure glued to letters (« fr5/21 ») is not a page counter, whatever it does from page to page.
    standalone: runs.map((m) => isStandalone(text, m.index, m[0].length)),
    strict: runs.map(
      (m) => isStandalone(text, m.index, m[0].length) && inCounterPlace(text, m.index, m[0].length, pageCount),
    ),
    enoughText: hasCounterText(line.text.trim()),
    edge,
    oversize: line.size > bodySize * MAX_COUNTER_SIZE_RATIO,
    relaxed: {
      key: `${romanised.replace(/\d+/g, "#")}|${romanised === text}|${bucket(line.y, POSITION_TOLERANCE)}|${bucket(line.size, SIZE_TOLERANCE)}`,
      digits: romanRuns.map((m) => Number(m[0])),
      standalone: romanRuns.map(
        (m) => isStandalone(romanised, m.index, m[0].length) || closesWithTotal(romanised, m.index, m[0].length),
      ),
    },
  };
};

/** Is there a digit run that rises by one per page while every other run stays put, over one entry per page? */
const risesWithPage = (
  group: readonly CounterEntry[],
  read: (e: CounterEntry) => { digits: number[]; standalone: readonly boolean[] },
): boolean => {
  if (new Set(group.map((e) => e.page)).size !== group.length || group.length < MIN_PAGES) return false;
  const first = read(group[0]!);
  const firstPage = group[0]!.page;
  const followsPage = (j: number): boolean =>
    group.every((e) => {
      const r = read(e);
      return (
        r.standalone[j] === true &&
        r.digits[j]! <= MAX_COUNTER_FIGURE &&
        r.digits[j]! - e.page === first.digits[j]! - firstPage
      );
    });
  const othersStay = (j: number): boolean =>
    first.digits.every((_, m) => m === j || group.every((e) => read(e).digits[m] === first.digits[m]));
  return first.digits.some((_, j) => followsPage(j) && othersStay(j));
};

/** A lower-case Roman numeral up to 39 standing alone (front matter page numbers); upper case is left alone (« I » is a pronoun). */
const ROMAN_FIGURE = /(?<![\p{L}\p{N}])(?=[ivx])x{0,3}(?:ix|iv|v?i{0,3})(?![\p{L}\p{N}])/gu;
const romanValueOf = (token: string): number => {
  const values: Record<string, number> = { i: 1, v: 5, x: 10 };
  let total = 0;
  for (let i = 0; i < token.length; i++) {
    const v = values[token[i]!]!;
    total += v < (values[token[i + 1] ?? ""] ?? 0) ? -v : v;
  }
  return total;
};

/** Where a page counter may stand: at the START or the END of the line, or followed by its total: « n / TOTAL » anywhere (063),
 *  « n of TOTAL » only when that closes the line (243, 240), TOTAL being the document's own page count. A rising figure anywhere else (« Article 2 : Dispositions
 *  generales », « Step 2 of 3 Choose your plan ») is a one-per-page title, and removing it would lose its words (review 14/10/2026). */
const inCounterPlace = (text: string, index: number | undefined, length: number, pageCount: number): boolean => {
  if (index === undefined) return false;
  const tail = text.slice(index + length);
  if (text.slice(0, index).trim() === "" || tail.trim() === "") return true;
  const total = /^\s*(\/|of|sur|von)\s*(\d+)(?!\d)(.*)$/isu.exec(tail);
  return total !== null && Number(total[2]) === pageCount && (total[1] === "/" || total[3]!.trim() === "");
};

/** A figure followed by « /total » closing the line is still a counter whatever touches it on its LEFT (the check ignores the left side; a printed web
 *  page's footer « …edge_no=…e997b9 1/3 » extracted without the space, 0000523): « N/M » at the end of a line is not an identifier.
 *  Only the relaxed rule reads it, which already demands the edge band, 3 pages, a constant figure and a rise of 1 per page.
 *
 *  VALEUR DE DÉPART À CALIBRER. Measured: the one document (0000523, 3 pages); the glued-figure case to keep apart (« fr5/21 », 047)
 *  is also a rising counter, so nothing measured is lost to this reading. */
const closesWithTotal = (text: string, index: number | undefined, length: number): boolean =>
  index !== undefined && /^\/\d+$/.test(text.slice(index + length));

/** Is the digit run at `index` a token of its own (no letter or digit touching it)? */
const isStandalone = (text: string, index: number | undefined, length: number): boolean =>
  index !== undefined &&
  !/[\p{L}\p{N}]/u.test(text[index - 1] ?? " ") &&
  !/[\p{L}\p{N}]/u.test(text[index + length] ?? " ");

/** Enough words of text around the figure(s) to be a running line and not a title (one letter counts as a word, as
 *  Word spaces out some footers). */
const hasCounterText = (text: string): boolean =>
  text
    .replace(/\d+/g, " ")
    .split(/[^\p{L}]+/u)
    .filter((w) => w !== "").length >= COUNTER_TEXT_WORDS_THRESHOLD;

/** For each key, the set of DISTINCT pages whose items carry it. */
const pagesByKeyOf = <T>(pages: readonly (readonly T[])[], key: (item: T) => string): Map<string, Set<number>> => {
  const pagesByKey = new Map<string, Set<number>>();
  pages.forEach((items, page) => {
    for (const item of items) {
      const k = key(item);
      const seen = pagesByKey.get(k) ?? new Set<number>();
      seen.add(page);
      pagesByKey.set(k, seen);
    }
  });
  return pagesByKey;
};

/** Is the height `y` inside the UPPER half of any band? PDF y grows upward, so `top` > `bottom`. */
const inUpperHalfOfBand = (y: number, bands: readonly TableBand[]): boolean =>
  bands.some((b) => y <= b.top && y >= b.bottom && y >= (b.top + b.bottom) / 2);

/**
 * Limit: lines are grouped by rounding, so two positions closer than the tolerance but on either side of a rounding
 * boundary fall in two groups. A pairwise match would close it, at a quadratic cost over the document's lines.
 */
/** The keys of a line (exact, loose, normalized text), computed once per line. */
const lineKeysMemo = (): ((line: PageLine) => LineKeys) => {
  const keysOf = new WeakMap<PageLine, LineKeys>();
  return (line) => {
    let k = keysOf.get(line);
    if (k === undefined) {
      const text = normalizeText(line.text);
      const where = `|${bucket(line.y, POSITION_TOLERANCE)}|${bucket(line.x, POSITION_TOLERANCE)}|${bucket(line.size, SIZE_TOLERANCE)}`;
      // Loose key: every digit run of the normalized text becomes one placeholder.
      k = { exact: text + where, loose: text.replace(/\d+/g, "#") + where, text };
      keysOf.set(line, k);
    }
    return k;
  };
};

/** The position key of a line (digits free, no abscissa), computed once per line. */
const placeKeyMemo = (keys: (line: PageLine) => LineKeys): ((line: PageLine) => string) => {
  const placeKeysOf = new WeakMap<PageLine, string>();
  return (line) => {
    let k = placeKeysOf.get(line);
    if (k === undefined) {
      k = `${keys(line).text.replace(/\d+/g, "#")}|${bucket(line.y, POSITION_TOLERANCE)}|${bucket(line.size, SIZE_TOLERANCE)}`;
      placeKeysOf.set(line, k);
    }
    return k;
  };
};

/** Per position key: how many pages [even, odd] (by index) carry it. */
const parityCountsOf = (pagesByPlaceKey: ReadonlyMap<string, ReadonlySet<number>>): Map<string, [number, number]> => {
  const parityCountsByPlaceKey = new Map<string, [number, number]>();
  for (const [key, pagesOfKey] of pagesByPlaceKey) {
    const counts: [number, number] = [0, 0];
    for (const p of pagesOfKey) counts[p % 2]!++;
    parityCountsByPlaceKey.set(key, counts);
  }
  return parityCountsByPlaceKey;
};

export function detectPageFurniture(
  pagesLines: readonly (readonly PageLine[])[],
  tableBands: readonly (readonly TableBand[])[] = [],
  /** The page heights, when the caller knows them: they unlock the page-edge exception (a block repeated exactly at
   *  the page edge is furniture even inside a table band). Without them the band protects as before. */
  pageHeights: readonly number[] = [],
  /** The y of each page's bottom edge in user space (`view[1]`), 0 when absent. */
  pageBottoms: readonly number[] = [],
): boolean[][] {
  if (pagesLines.length < MIN_PAGES) return pagesLines.map((lines) => lines.map(() => false));

  const keys = lineKeysMemo();

  /** On how many DISTINCT pages does each form appear? Two occurrences on the same
   *  page prove nothing: furniture repeats across pages, not within one. */
  const pagesByKey = pagesByKeyOf(pagesLines, (line) => keys(line).exact);
  const pagesByLooseKey = pagesByKeyOf(pagesLines, (line) => keys(line).loose);
  const placeKeyOf = placeKeyMemo(keys);
  const pagesByPlaceKey = pagesByKeyOf(pagesLines, placeKeyOf);
  const parityCountsByPlaceKey = parityCountsOf(pagesByPlaceKey);
  const counterLines = counterLinesOf(pagesLines, keys, (line, page) =>
    atPageEdge(line, pageHeights[page], pageBottoms[page] ?? 0),
  );

  // A counter line proved itself by rising with the page: it counts for every page. The position is compared WITHOUT its abscissa:
  // a right-aligned counter moves with its digit count (« Page 9 sur 11 » at x=489, « Page 10 sur 11 » at x=485) and is still
  // the same line of the same block.
  const textPages = pagesLines.filter((l) => l.length > 0).length;
  const textPagesByParity = [0, 1].map(
    (parity) => pagesLines.filter((l, p) => l.length > 0 && p % 2 === parity).length,
  );
  const paritySupportOf = (line: PageLine, page: number): number =>
    counterLines.has(line) ? Infinity : (parityCountsByPlaceKey.get(placeKeyOf(line))?.[page % 2] ?? 0);
  const supportOf = (line: PageLine): number =>
    counterLines.has(line)
      ? Infinity
      : Math.max(pagesByKey.get(keys(line).exact)?.size ?? 0, pagesByPlaceKey.get(placeKeyOf(line))?.size ?? 0);

  return pagesLines.map((lines, page) => {
    const bands = tableBands[page] ?? [];
    const repeatsExactly = (line: PageLine): boolean =>
      (pagesByKey.get(keys(line).exact)?.size ?? 0) >= MIN_PAGES || counterLines.has(line);
    // Rule 2: only the upper half of a band is protected (a repeated table header sits at the top of its table) —
    // unless the line repeats exactly AT THE PAGE EDGE: a letterhead boxed in a one-row grid (074) is not a table header.
    // A band whose lines ALL repeat exactly at the page edge is a banner. A band with any other line is a real table, whose
    // repeated header stays: its words are content, and removing the header on every page loses them (review 14/10/2026).
    const edgeRepeat = (line: PageLine): boolean =>
      repeatsExactly(line) && atPageEdge(line, pageHeights[page], pageBottoms[page] ?? 0);
    // A band that reaches the page edge is a page-wide frame (a cover's border), not a table: it never protects.
    const height = pageHeights[page];
    const bottom = pageBottoms[page] ?? 0;
    const frames = (b: TableBand): boolean =>
      height !== undefined && (b.top - bottom >= height - 1 || b.bottom - bottom <= 1);
    const bannerBands = bands.filter(
      (b) => frames(b) || lines.every((l) => !isInBand(l.y + l.size / 2, [b]) || edgeRepeat(l)),
    );
    const protectedByTable = lines.map(
      (line) =>
        inUpperHalfOfBand(line.y + line.size / 2, bands) &&
        !(edgeRepeat(line) && isInBand(line.y + line.size / 2, bannerBands)),
    );
    const exact = lines.map((line, i) => !protectedByTable[i]! && repeatsExactly(line));
    // Inside a band (either half) only an EXACT repeat counts: amortisation rows at a fixed pitch repeat on every
    // page and differ only by their figures, so a loose-only row must stop the walk, not join a footer run.
    const loose = lines.map(
      (line, i) =>
        exact[i] === true ||
        (!protectedByTable[i]! &&
          !isInBand(line.y + line.size / 2, bands) &&
          (pagesByLooseKey.get(keys(line).loose)?.size ?? 0) >= MIN_PAGES),
    );

    // 🔴 REPETITION IS NOT ENOUGH: THE LINE MUST ALSO BE AT THE EDGE.
    //
    // « They are necessarily the first and the last element of every page » — the
    // second half of the definition. Without it, a document whose pages share the
    // SAME layout sees all its content repeat identically, hence all of it
    // classed as furniture and removed. Measured on 10/09/2026:
    // `fixtures/pdf/11-Brochure-Deux-Colonnes.pdf` has two pages of identical
    // geometry, and an existing test caught it.
    //
    // So we walk in from the TOP and from the BOTTOM while lines repeat, and stop
    // at the first that does not. A multi-line furniture block is still found; a
    // repeated line in the MIDDLE of the page never is.
    // The walk is bounded by GEOMETRY as much as by repetition: two lines more
    // than `MAX_RUN_GAP_RATIO` sizes apart are not one block. Without that bound,
    // a repeated body line is swallowed by the footer just because it precedes it.
    //
    // The walk accepts lines repeated under the LOOSE key (digits free), but the run
    // is furniture ONLY IF it holds at least one EXACT repeat (the anchor). Why: the
    // 15/09/2026 decision is that only a page number may change (fixture 19: « Annexe
    // N » titles, one per page, are content). Measured case, fixture 47, 13/10/2026:
    // « hauts-de-france@example.org5/21 » (page number glued to an address; the address is an example's here)
    // stopped the exact walk at the first line, so the whole 4-line footer stayed.
    // Accepted cost: a line that changes only by its digits,
    // contiguous to an exactly repeated header/footer line at the same edge, is
    // removed with it.
    const furniture = lines.map(() => false);
    //
    // TWO BOUNDS on the walk, both measured on the local corpus (14/10/2026):
    // - ONE larger gap may be crossed (`MAX_BANNER_GAP_RATIO`) to reach a line that repeats EXACTLY, when the run
    //   below the gap is already anchored: a banner above a lone page number (094). A line that repeats only by its
    //   digits never lets the run cross.
    // - A run that would cover more than half of a long page (`MAX_FURNITURE_RUN_LINES`) is refused: it swallowed the
    //   page, not a block (024, two template pages of 23 lines whose only difference is a digit). If the run that
    //   crossed a gap is refused, the run before the gap stands.
    // A page whose lines MOSTLY repeat is a template (the same layout twice, fixture 11), not a body with a banner: no crossing.
    const mostlyRepeated = exact.filter(Boolean).length * 2 > lines.length;
    const support = lines.map(supportOf);
    const paritySupport = lines.map((line) => paritySupportOf(line, page));
    const mark = (from: number, step: 1 | -1): void => {
      for (const i of edgeRun(
        {
          lines,
          loose,
          exact,
          mostlyRepeated,
          support,
          paritySupport,
          textPages,
          sameParityTextPages: textPagesByParity[page % 2]!,
        },
        from,
        step,
      ))
        furniture[i] = true;
    };
    mark(0, 1);
    mark(lines.length - 1, -1);
    return furniture;
  });
}

/**
 * The repeats at the head of a page: a second, riskier rule, kept apart from the first. A producer may redraw the
 * head block of page 1 at the top of a continuation page at another abscissa; relaxing the position in
 * `detectPageFurniture` to catch it would take the document title on page 1.
 *
 * The rule: a text already seen higher in the document that reappears at the head of a later page is a repeat. The
 * first occurrence is kept.
 *
 * Its cost: a sentence legitimately repeated at the top of a page is taken, invisibly. Hence three bounds: never
 * the first page, only at the head of a page, and never past the first line not seen before. The text is compared
 * exactly, digits included.
 *
 * Two conditions more, or an entry of a table of contents takes the section title that opens a later page:
 *  - the first occurrence is itself in the head block of its page (`headBlockLength`);
 *  - it has the same size, within `SIZE_TOLERANCE`.
 * The bias is chosen: a real repeat redrawn at another size stays published twice, visible; a title is not lost.
 *
 * The edge band: real text reopens pages too (a clause, a paragraph, an address block), further from the edge than
 * true repeats. When the caller gives the page heights, a repeat outside `MAX_EDGE_BAND_FRACTION` is kept and stops
 * the descent. Tried then dropped: asking for three pages as well, since a two-page document has real repeats.
 */
export function detectRepeatedHeadBlocks(
  pagesLines: readonly (readonly PageLine[])[],
  tableBands: readonly (readonly TableBand[])[] = [],
  /** The page heights, when the caller knows them: a repeat is then dropped only inside the page's edge band
   *  (a clause that reopens a page 130 pt under the top edge is text, not a redrawn header). */
  pageHeights: readonly number[] = [],
  /** The y of each page's bottom edge in user space (`view[1]`), 0 when absent. */
  pageBottoms: readonly number[] = [],
): boolean[][] {
  /** Exact text → the size buckets under which it appeared at the head of a page. */
  const seenInHead = new Map<string, Set<number>>();
  const sizeKey = (line: PageLine): number => bucket(line.size, SIZE_TOLERANCE);
  const out: boolean[][] = [];

  for (let page = 0; page < pagesLines.length; page++) {
    const lines = pagesLines[page] ?? [];
    const flags = lines.map(() => false);
    const head = headBlockLength(lines, tableBands[page] ?? []);

    if (page > 0) {
      const height = pageHeights[page];
      // The descent stops at the first line never seen at the head, and (heights known) at the first outside the edge band.
      const repeated = (line: PageLine): boolean =>
        seenInHead.get(line.text.trim())?.has(sizeKey(line)) === true &&
        (height === undefined || atPageEdge(line, height, pageBottoms[page] ?? 0));
      for (let i = 0; i < head && repeated(lines[i]!); i++) flags[i] = true;
    }

    for (const line of lines.slice(0, head)) {
      const sizes = seenInHead.get(line.text.trim()) ?? new Set<number>();
      sizes.add(sizeKey(line));
      seenInHead.set(line.text.trim(), sizes);
    }
    out.push(flags);
  }
  return out;
}

/** How many lines, from the top, form the head block of a page: the descent goes on while neighbouring lines stay
 *  contiguous, and never into a table's band. */
function headBlockLength(lines: readonly PageLine[], bands: readonly TableBand[]): number {
  let length = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const previous = lines[i - 1];
    if (previous !== undefined && !contiguous(previous, line)) break;
    if (isInBand(line.y + line.size / 2, bands)) break;
    length = i + 1;
  }
  return length;
}
