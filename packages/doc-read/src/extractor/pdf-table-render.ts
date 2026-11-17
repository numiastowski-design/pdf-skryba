/** One detected grid turned into a table block, its empty columns dropped —
 *  into its cells' blocks, flat, when it has one content column
 *  (`flatOneColumnRegion`) — or nothing at all when the two readings of its
 *  merges disagree. Also WHERE
 *  an image sits among the paragraphs of its cell (`imageFrontier`): an image
 *  that covers several of them passes before the block instead of cutting it.
 *  Holds `JOIN_CELL_LINES`, the one switch that turns cell line joining off.
 *  Also cuts a cell's text into links and raised calls (`cellInlines`, `sup` since 23/10/2026) and records the paintings a collapsed table removes
 *  (`recordCollapsedPaintings`, for the conservation check).
 *  NOT here: how a grid is found (`layout/geometry.ts`,
 *  `extractor/pdf-table-detector.ts`), where a cell's paragraphs begin and end
 *  (`extractor/pdf-cell-paragraphs.ts`), the prose around the table
 *  (`extractor/pdf-page-tables.ts`), nor a table continued on the next page
 *  (tables are not joined across pages).
 *  Called by: `extractor/pdf-page-tables.ts`. */

import type { Inline, IRBlock } from "doc-ir/lib/ir";
import { recomposeCellText } from "doc-ir/layout/cell-text";
import {
  assignFragmentsToCells,
  dominantTextSize,
  type Fragment,
  type MergedCell,
  type MergeMap,
  type TableGrid,
} from "doc-ir/layout/geometry";
import { imageFrontier as sharedImageFrontier } from "doc-ir/layout/image-frontier";
import { headerRowCount } from "doc-ir/layout/merged-cells";
import { joinCutUrlRows } from "./pdf-row-url-join";
import type { GlyphFragment } from "./glyph-positions";
import { gatherRotatedWords } from "./pdf-rotated-words";
import { cellParagraphs, joinCellLines } from "./pdf-cell-paragraphs";
import { fillBetween } from "./pdf-links";

const SPACE = /\s/u;

/**
 * A cell paragraph's inlines, cut at its links and its raised calls (links 07/10/2026; calls 23/10/2026). The links are
 * the ones `pdf-links.ts` tied to the GLYPHS (`hrefOf`), the calls the ones the lines read as raised (`raised`,
 * `layout/cell-text.ts#CellLine.raised`), never a second geometry: each non-space character of `text` is led back to the glyph
 * that paints it by ORDER alone — `fragments` are the paragraph's glyphs in reading order, and `text` is their texts joined,
 * whitespace aside (`CellLine.fragments`). A space or punctuation between two characters of the same link takes it (rule 4,
 * `fillBetween`), except the cell's line break. A `sup` is never filled across a space: a space is plain.
 * Abstention: the two readings disagree (a character that is not the next glyph's) → one plain inline, as before.
 */
const cellInlines = (
  text: string,
  fragments: readonly Fragment[] | undefined,
  hrefOf: ReadonlyMap<Fragment, string>,
  raised?: ReadonlySet<Fragment>,
): Inline[] => {
  const hasRaised = raised !== undefined && fragments !== undefined && fragments.some((f) => raised.has(f));
  if (fragments === undefined || (!hasRaised && (hrefOf.size === 0 || !fragments.some((f) => hrefOf.has(f)))))
    return [{ text }];
  const painted: { char: string; href: string | undefined; sup: boolean }[] = [];
  for (const f of fragments) {
    for (const char of f.text)
      if (!SPACE.test(char)) painted.push({ char, href: hrefOf.get(f), sup: raised?.has(f) === true });
  }
  const targets: string[] = [];
  const linkAt: (number | undefined)[] = new Array<number | undefined>(text.length).fill(undefined);
  const supAt: boolean[] = new Array<boolean>(text.length).fill(false);
  let next = 0;
  for (let c = 0; c < text.length;) {
    const char = String.fromCodePoint(text.codePointAt(c)!);
    if (!SPACE.test(char)) {
      const glyph = painted[next++];
      if (glyph === undefined || glyph.char !== char) return [{ text }];
      if (glyph.href !== undefined) {
        let target = targets.indexOf(glyph.href);
        if (target < 0) target = targets.push(glyph.href) - 1;
        linkAt.fill(target, c, c + char.length);
      }
      if (glyph.sup) supAt.fill(true, c, c + char.length);
    }
    c += char.length;
  }
  if (next !== painted.length) return [{ text }];
  fillBetween(text, linkAt, (i) => targets[i]!);
  // A line break never carries a link: no `<a>` wraps a `<br/>`, and a link split by one is two links with the same
  // target, as in the page flow when the lines differ.
  for (let c = 0; c < text.length; c++) if (text[c] === "\n") linkAt[c] = undefined;
  const inlines: Inline[] = [];
  let lastSup = false;
  for (let c = 0; c < text.length; c++) {
    const href = linkAt[c] === undefined ? undefined : targets[linkAt[c]!];
    const sup = supAt[c]!;
    const last = inlines[inlines.length - 1];
    if (last !== undefined && last.href === href && lastSup === sup) last.text += text[c]!;
    else
      inlines.push({
        text: text[c]!,
        ...(href !== undefined ? { href } : {}),
        ...(sup ? { marks: ["sup" as const] } : {}),
      });
    lastSup = sup;
  }
  return inlines;
};

/** The REAL cells of a row: those the merge map makes START there,
 *  with the fragments of all the boxes they cover,
 *  concatenated in reading order. Without a map, each box is its own
 *  cell — the earlier behaviour, to the line.
 *
 *  A row COVERED by a merge coming from above therefore does not emit the cell
 *  that covers it: it is the filter on `cell.row` that expresses this, and it is what
 *  `rowspan` asks for on the HTML side.
 *
 *  INVARIANT (30/10/2026): a case belongs to ONE merge, and its text is published once. Two merges that overlap used
 *  to collect each the cases they cover, so a shared case came out twice — « LCU » on safedocs 0000523 p1 (3 letters
 *  added, none lost), written as a limit on 22/09/2026 and left unguarded, then « form. Send » and « ministrator » on
 *  06-homes p8, in PRODUCTION since render 117. `ownerAt` already says which merge owns each case: it is read below,
 *  and `pdf-table-overlapping-merges.test.ts` holds it. */
export function cellsOfRow<T>(
  byCase: readonly T[][][],
  rowIndex: number,
  merge: MergeMap | undefined,
): { fragments: T[]; cell: MergedCell }[] {
  if (merge === undefined) {
    return (byCase[rowIndex] ?? []).map((fragments, col) => ({
      fragments,
      cell: { row: rowIndex, col, colspan: 1, rowspan: 1 },
    }));
  }
  return merge.cells
    .filter((cell) => cell.row === rowIndex)
    .map((cell) => {
      const fragments: T[] = [];
      // The merge owner is read ONCE: it does not change from one box to another (review of 30/10/2026).
      const owner = merge.ownerAt[cell.row]?.[cell.col];
      for (let r = cell.row; r < cell.row + cell.rowspan; r++) {
        for (let c = cell.col; c < cell.col + cell.colspan; c++) {
          // A BOX BELONGS TO ONE MERGE ONLY (30/10/2026). The invariant is TEXTUAL: the product promises zero invented
          // words, and two merges that overlap each picked up the shared box — « LCU » twice on
          // safedocs 0000523 p1 (limit written on 22/09/2026 and left without a guard), then « form. Send » and
          // « ministrator » twice on 06-homes p8, IN PRODUCTION since rendering 117. The merge map already says
          // who owns each box (`ownerAt`): we read it, instead of letting two cells help themselves.
          if (merge.ownerAt[r]?.[c] !== owner) continue;
          fragments.push(...(byCase[r]?.[c] ?? []));
        }
      }
      return { fragments, cell };
    });
}

/*
 * NO COLOUR BAR IS PUBLISHED ANY MORE (23/09/2026).
 *
 * What lived here: `cellDataFills`, which output the fills of a cell — a
 * background discarded for its geometry, a fill straddling a boundary dropped —
 * then `renderColorSwatchSvg`, which made an SVG bar of them. It was gap 15,
 * closed on 11/09/2026: a school report card carries its grades in BARS without
 * a single character, and everything disappeared at publication.
 *
 * WHY IT GOES. A bar is not text: neither Confluence nor Rovo reads it,
 * so it serves neither fidelity to the text nor search — the first two
 * commandments. And on the pages republished on 23/09 it HARMS: a
 * blue line under each heading of 0000713, a light-blue band under « Change
 * Your Address » of 0000754, green bars alone on their line in
 * booklet 26, a black bar alone in a cell of 0000523.
 *
 * THE DISCRIMINANT WAS LOOKED FOR AND DOES NOT EXIST. Measured on 23/09 on the 39
 * French and English PDFs, 54 fills published in 8 documents. The two readings
 * proposed separate nothing: « a bar alone on its LINE » keeps the 16
 * lines of 0000713 (their line carries all the prose of the cell); « a bar
 * alone in its CELL » keeps the black bar of 0000523 next to « LCU », which
 * the maintainer wants gone, and the magenta line laid over a screenshot of 0000754.
 * Colour does not separate either — black is decorative here and named by the
 * report card's legend elsewhere. When the discriminant is not defined, we do not
 * decide: we remove everything.
 *
 * THE LOSS, ACCEPTED AND WRITTEN. On the school report card (report card T1, page 2) and
 * on fixture 30, the bars that represent a grade disappear: 5 and 3
 * respectively. The TEXT of their row stays whole — the title of the
 * skill, the grade, the assessment. It is a colour that is lost, not a word.
 *
 * SWATCHES ARE REMOVED TOO (07/10/2026): a cell's disc
 * (`cellDisc`) rendered the cell as an SVG image whose text lived only in
 * the alt attribute — not findable by search. The digit or word of a
 * cell on a disc now comes out as TEXT, like any other. Colour
 * carries nothing for Confluence or Rovo.
 */

/** A large image of the page, not read yet, as a table cell receives it. */
export interface CellImage {
  top: number;
  bottom: number;
  xMin: number;
  xMax: number;
  read: () => IRBlock[] | undefined;
}

/** The images of each REAL cell, keyed `row,col` of the cell's first case: the
 *  case holding the image's centre, then the merged cell that owns that case. */
function imagesPerCell(
  images: readonly CellImage[],
  grid: TableGrid,
  merge: MergeMap | undefined,
): Map<string, CellImage[]> {
  const rows = grid.rowBoundaries;
  const cols = grid.colBoundaries;
  const out = new Map<string, CellImage[]>();
  for (const image of images) {
    const y = (image.top + image.bottom) / 2;
    const x = (image.xMin + image.xMax) / 2;
    const row = Math.max(0, Math.min(rows.length - 2, rows.findIndex((_, i) => i > 0 && y >= rows[i]!) - 1));
    const col = Math.max(0, Math.min(cols.length - 2, cols.findIndex((_, i) => i > 0 && x <= cols[i]!) - 1));
    const owner = merge === undefined ? { row, col } : merge.cells[merge.ownerAt[row]![col]!]!;
    const key = `${owner.row},${owner.col}`;
    out.set(key, [...(out.get(key) ?? []), image]);
  }
  return out;
}

/**
 * THE CELL LINE JOIN, KEPT BEHIND ONE SWITCH (23/09/2026).
 *
 * Set this to `false` and a cell's lines are NEVER joined: every line the PDF
 * drew keeps its own break, and `cellParagraphs` separates them with a `<br/>`
 * inside one paragraph. Nothing else has to change — no other call site, no
 * option, no user-facing setting. **Bump `RENDER_LOGIC_VERSION` when you flip
 * it**, or the pages already published are not rendered again.
 *
 * WHY THE SWITCH EXISTS RATHER THAN A DELETION. The join is RIGHT: over the 39
 * French and English PDFs it never once glued two texts that had to stay apart
 * — the school reports are untouched, « 7,00 » never joins « 6,00 ». But it
 * does LITTLE: 25 paragraphs out of 267 on booklet 26, because only a line that
 * reaches the cell's DRAWN right edge is joined, and few lines of that booklet
 * do. And those 25 are exactly what makes the published line lengths UNEVEN —
 * a few long lines among lines that kept the PDF's own break. The maintainer saw it on
 * the rendered page.
 *
 * Its removal was prepared on 23/09/2026 and CALLED OFF by « keep it
 * for now ». The question it hangs on is open, not settled — *does the
 * join earn the uneven lines?* — and it is answered by looking at more real
 * documents, not by reasoning. Flipping this constant IS the experiment.
 */
const JOIN_CELL_LINES = true;

/**
 * AN IMAGE WHOSE CENTRE IS IN A CELL IS PUBLISHED IN THAT CELL (
 * 21/09/2026), among its text lines by height: before the first line whose
 * middle lies below the image's centre — the median rule of the page flow
 * (`pdf-region-order.ts`). The text keeps its own order; images meeting at the
 * same place go top to bottom, then left to right. An unreadable image leaves
 * nothing. Mutates `blocks`, whose paragraphs `lines` describes one to one.
 *
 * AN IMAGE BESIDE A BLOCK OF TEXT IS NOT INSERTED INTO IT (
 * 23/09/2026): it goes before that block, `imageFrontier`. The cell path
 * carries the rule because the booklet is where it bites — every page of
 * fixture 26 is one framed cell, so its images are placed HERE and never by
 * `interleaveRegions`.
 */
function placeCellImages(blocks: IRBlock[], lines: readonly CellParagraphBox[], images: readonly CellImage[]): void {
  const sorted = [...images].sort((a, b) => b.top + b.bottom - (a.top + a.bottom) || a.xMin - b.xMin);
  const texts = blocks.splice(0, blocks.length);
  let next = 0;
  for (const image of sorted) {
    const frontier = imageFrontier(image, lines);
    while (next < texts.length && lines[next]!.middle >= frontier) blocks.push(texts[next++]!);
    blocks.push(...(image.read() ?? []));
  }
  blocks.push(...texts.slice(next));
}

/** The height a cell paragraph occupies on the page: the middle an image is
 *  ordered against (`layout/cell-text.ts#CellLine`), and the extent its text
 *  really covers — its first line's top down to its last line's bottom. */
interface CellParagraphBox {
  middle: number;
  top: number;
  bottom: number;
}

/**
 * AN IMAGE THAT COVERS SEVERAL LINES IS NOT INSERTED BETWEEN THEM: IT PASSES
 * BEFORE THE BLOCK IT OVERLAPS (23/09/2026). Its median then decides
 * nothing.
 *
 * THE CASE: booklet 26 page 3, the CEO's welcome message. The portrait is
 * painted on the LEFT and the message runs down its right side, over the same
 * height, both inside the one cell the Canva page frame makes. The photo's
 * median therefore fell in the MIDDLE of the message — 24 of the cell's 25
 * paragraphs lie inside the photo's vertical extent, 12 above the median and 12
 * below — and the image was published between its twelfth and thirteenth
 * paragraphs, cutting the message in two.
 *
 * THE TEST IS AN OVERLAP, NOT A THRESHOLD, and it adds no constant: of the
 * cell's paragraphs, take those whose height lies inside the image's vertical
 * extent — the ones it COVERS. If the median would put some of them before the
 * image and the others after, the image would be inserted BETWEEN two lines it
 * covers; its frontier then becomes the image's TOP EDGE and the whole covered
 * block follows it. Cover nothing, or cover paragraphs that all fall on the
 * same side, and nothing changes: the median still decides.
 *
 * WHY THE MFA GUIDE CANNOT MOVE, measured: fixture 24 lays its screenshots
 * BETWEEN two instruction lines, in a band where no other text stands, and the
 * only lines they cover are the labels painted on them — "Ecran PC" 27 pt below
 * the top edge of its capture, "Ecran"/"GSM" beside the phone of page 7, all of
 * them above their image's median. One side, nothing to cut, nothing moves.
 *
 * ⚠️ WHAT WAS TRIED AND REFUSED THE SAME DAY: adding a HORIZONTAL condition —
 * "covered AND standing beside the image, without overlapping it". It reads
 * better and it is false on both documents, because the box we measure is the
 * image's DRAWN box, not the visible picture:
 *   · booklet 26 p3, the photo is drawn from x −106.7 to 420.4 and CLIPPED to
 *     the strip 51 → 262 the page shows (538 × 590 px at 73 ppi ≈ 530 × 582 pt
 *     drawn, `pdfimages -list`); the message starts at x 278.6, so against the
 *     drawn box the text "lies on" the photo and the rule never fires — the
 *     defect stays;
 *   · fixture 24 p7, the boxed label "Ecran"/"GSM" stands 11.7 pt to the RIGHT
 *     of the phone (label x 485.0 → 516.8, image x 354.3 → 473.3, label height
 *     679.4 → 693.5 inside the image's 537.1 → 697.1), so the horizontal rule
 *     DOES fire there and moves it after the image — the MFA guide breaks.
 * Reading the clip path would be needed to use the visible extent, and it would
 * move every image box in the app (table detection, figure labels, page
 * furniture). Not done, not decided.
 *
 * WHAT THIS RULE DOES NOT TRY TO DO: reproduce the PDF's layout. The photo is
 * to the LEFT of the text and it does not go back there — that would need a
 * two-column layout section (`ac:layout`), documented for Data Center and NEVER
 * MEASURED ON CLOUD (`docs/PLATFORM-STATUS.md`). A Confluence page is a linear
 * sequence: side by side does not exist, one of the two orders has to be
 * chosen. This rule only stops the text being cut.
 */
function imageFrontier(image: CellImage, lines: readonly CellParagraphBox[]): number {
  const centre = (image.top + image.bottom) / 2;
  const covered = lines.filter((l) => l.bottom >= image.bottom && l.top <= image.top);
  return sharedImageFrontier(centre, image.top, covered);
}

/**
 * A MARK PAINTED k TIMES IS PUBLISHED ONCE: `glyph-positions.ts#collapseOverpaint`
 * keeps one glyph and counts the paintings. The PDF's text layer still reads
 * the k copies — « Moyennes » three times over a colspan of 3 — so the k − 1
 * others are a removal made ON PURPOSE, recorded here for the
 * text-conservation check (lot 2, 21/09/2026).
 *
 * Exactly what is collapsed, nothing broader: only the glyphs whose
 * `paintCount` exceeds 1, recomposed per painting count with the cell's own
 * reading, and each line recorded k − 1 times. A wider record would hide a
 * real loss.
 */
function recordCollapsedPaintings(
  fragments: readonly GlyphFragment[],
  span: { left: number; right: number },
  bodyTextSize: number | undefined,
  recordRemoval: (text: string) => void,
): void {
  const counts = [...new Set(fragments.map((f) => f.paintCount).filter((k) => k > 1))].sort((a, b) => a - b);
  for (const k of counts) {
    for (const line of recomposeCellText(
      fragments.filter((f) => f.paintCount === k),
      span,
      bodyTextSize,
    )) {
      const text = line.text.trim();
      if (text.length === 0) continue;
      for (let copy = 1; copy < k; copy++) recordRemoval(text);
    }
  }
}

/**
 * A TIGHT COMB IS JOINED INTO WORDS, AND A ONE-ROW STRIP OF SINGLE CHARACTERS IS NEVER WITHHELD (15/10/2026). Form cover
 * sheets draw one letter per box: safedocs 0000523 p1 writes « 3RD FLR.DACON BLDG. 2281 » across 21 boxes and
 * « CHINO ROCES AVE.MAKATI CITY » across 28. Read cell by cell that is a row of one-letter cells no search finds, and past
 * the column cap the table was withheld whole: 24 letters lost (render-lint, lost list). The row is published as ONE cell:
 *  - TIGHT COMB, whatever its column count: letters JOINED into words. The boxes are as narrow as the letters (box width
 *    over the glyph height from 1, lower bound, to `COMB_MAX_BOX_EM`), of near-equal width (`COMB_MAX_WIDTH_SPREAD`,
 *    widest over narrowest), at least `COMB_BOX_THRESHOLD` boxes filled, not all digits, no right-to-left character. An
 *    EMPTY box between two letters is a space (several, leading or trailing ones count for one, trimmed); adjacent boxes
 *    are one word — the page draws no space after the full stop of « AVE.MAKATI », so none is published. Measured on
 *    0000523 p1: box width over glyph height 1.59 (15.8 pt boxes, 9.96 pt glyphs), spread 1.11 (15.1 to 16.9 pt), 21 and
 *    28 filled boxes.
 *  - ANY OTHER strip with more than `COMB_MIN_COLUMNS` filled boxes: characters SPACE-SEPARATED, nothing glued, nothing
 *    lost. Any other strip at or under the cap stays an ordinary table (a calendar « 1 2 3 4 5 6 7 », a Y/N row or
 *    « A B C D E F » headers in wide boxes are cells).
 * Abstentions (the table stays cells, and past the cap is withheld as before): more than one row, a merged cell, an image,
 * a link or a repainted glyph (those live in cells), a box holding more than one grapheme (NFC, zero-width characters
 * removed, `Intl.Segmenter`).
 * ⚠️ WRITTEN BIAS, ACCEPTED (15/10/2026, judged by impact): a tight one-row strip of DISTINCT single letters (a
 * weekday legend « S M T W T F S » in narrow boxes) is joined into one token. Single letters carry no search value; the
 * joined form fields do. Pinned by a test. ⚠️ WRITTEN LIMITS: a right-to-left strip is never joined, and is space-separated
 * in column (visual) order, not reading order; a leading label box (« No. ») is read as one more letter of the first word.
 * Starting values to calibrate, one population (0000523).
 */
const COMB_BOX_THRESHOLD = 6;
const COMB_MAX_WIDTH_SPREAD = 1.25;
const COMB_MAX_BOX_EM = 2.5;

const ZERO_WIDTH = /[\u200B-\u200F\u2060\uFEFF]/gu;
const RIGHT_TO_LEFT = /[\u0590-\u08FF\u202A-\u202E\u2066-\u2069\uFB1D-\uFDFF\uFE70-\uFEFE]/u;
const DIGITS = /^\p{Nd}$/u;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The box's one character; undefined when the box is empty; null when it holds more than one grapheme. */
const boxCharacter = (fragments: readonly GlyphFragment[]): string | undefined | null => {
  const text = fragments
    .map((f) => f.text)
    .join("")
    .normalize("NFC")
    .replace(ZERO_WIDTH, "")
    .replace(/\s+/gu, "");
  if (text.length === 0) return undefined;
  const parts = [...graphemes.segment(text)];
  return parts.length === 1 ? text : null;
};

interface Strip {
  filled: { col: number; char: string }[];
  height: number;
}

/** The filled boxes of the row and the median glyph height; undefined when a box holds a link, a repainted glyph or more than one grapheme. */
function readStrip(cells: readonly (readonly GlyphFragment[])[]): Strip | undefined {
  const filled: Strip["filled"] = [];
  const heights: number[] = [];
  for (const [col, fragments] of cells.entries()) {
    if (fragments.some((f) => f.href !== undefined || f.paintCount > 1)) return undefined;
    const char = boxCharacter(fragments);
    if (char === null) return undefined;
    if (char === undefined) continue;
    filled.push({ col, char });
    heights.push(...fragments.filter((f) => f.text.trim().length > 0).map((f) => f.height));
  }
  return { filled, height: [...heights].sort((a, b) => a - b)[heights.length >> 1] ?? 0 };
}

/** Whether the strip is a TIGHT comb — see the comment above for each condition. */
function isTightComb({ filled, height }: Strip, widths: readonly number[]): boolean {
  if (height <= 0 || filled.length < COMB_BOX_THRESHOLD) return false;
  const { low, high } = widths.reduce((acc, w) => ({ low: Math.min(acc.low, w), high: Math.max(acc.high, w) }), {
    low: Infinity,
    high: 0,
  });
  const median = [...widths].sort((a, b) => a - b)[widths.length >> 1]!;
  return (
    low > 0 &&
    high <= low * COMB_MAX_WIDTH_SPREAD &&
    median >= height &&
    median <= height * COMB_MAX_BOX_EM &&
    !filled.every(({ char }) => DIGITS.test(char)) &&
    !filled.some(({ char }) => RIGHT_TO_LEFT.test(char))
  );
}

/** A strip of more filled boxes than this is a COMB — a word written one letter per cell — and its row is published as one
 *  cell of space-separated characters rather than as a table. A GEOMETRY threshold, not a cap: nothing is withheld by it,
 *  so it is not a `ReaderLimits` field and no caller moves it. It held the value of the table column cap until
 *  09/11/2026, when that cap left the library for the app (`core/document-caps.ts#MAX_TABLE_COLS`): same number, 21,
 *  now stated here on its own so that moving the product's cap does not silently change what a comb is. */
const COMB_MIN_COLUMNS = 21;

function combText(
  cells: readonly (readonly GlyphFragment[])[],
  grid: TableGrid,
  merge: MergeMap | undefined,
  hasImages: boolean,
): string | undefined {
  if (hasImages || grid.rowBoundaries.length !== 2) return undefined;
  if (merge?.cells.some((cell) => cell.colspan > 1 || cell.rowspan > 1)) return undefined;
  const strip = readStrip(cells);
  if (strip === undefined) return undefined;
  const { filled } = strip;
  const widths = grid.colBoundaries.slice(1).map((boundary, i) => boundary - grid.colBoundaries[i]!);
  if (isTightComb(strip, widths))
    return filled.reduce(
      (text, { col, char }, i) => text + (i > 0 && col - filled[i - 1]!.col > 1 ? " " : "") + char,
      "",
    );
  return filled.length > COMB_MIN_COLUMNS ? filled.map(({ char }) => char).join(" ") : undefined;
}

/** MIKSUDOC « Spécification technique » §5.4.1, régime 1: attempts to render
 *  the table `grid` describes, using ONLY this page's own items. Prose
 *  strictly above/below the grid's own row bounds is reconstructed via the
 *  EXISTING paragraph logic, completely unchanged
 *  (`linesFromItems`/`paragraphsFromLines`) — a page that's mostly prose
 *  with one table region stays exactly as it was outside that region.
 *  Returns the blocks the region publishes: ONE table block, or — a region of
 *  one content column — its cells' blocks, flat, in row order (see the rule
 *  at the end of this function).
 *  Returns `undefined` — never a partial render — the moment the
 *  conservation invariant doesn't hold cleanly: §8's own rule, "invariant
 *  violation → flat text fallback + flag... never a silent
 *  switch". The CALLER falls back to today's whole-page flat text;
 *  this function never guesses at a partial one. */
export function renderTableRegion(
  grid: TableGrid,
  glyphs: readonly GlyphFragment[],
  merge: MergeMap | undefined,
  /** The page's large images whose centre is inside this grid, NOT read yet —
   *  see `placeCellImages`. Read only once the table is sure to render. */
  images: readonly CellImage[] = [],
  /** Receives each text this table publishes fewer times than the PDF paints
   *  it — see `recordCollapsedPaintings`. Called only once the table is sure
   *  to render. */
  recordRemoval: (text: string) => void = () => {},
): IRBlock[] | undefined {
  const top = grid.rowBoundaries[0]!;
  const bottom = grid.rowBoundaries[grid.rowBoundaries.length - 1]!;
  // THE PAGE'S BODY TEXT, measured once over all its cells
  // (11/09/2026, MIKSUDOC « Spécification technique » §5.4.1). It is what sets the indent threshold
  // at the scale of the source instead of carrying a page size into it.
  const bodyTextSize = dominantTextSize(glyphs);

  // THE TABLE CONTENT COMES FROM THE GLYPHS, NOT FROM THE AGGREGATED ITEMS — and this is
  // what makes the invariant pass (09/09/2026).
  //
  // pdf.js's `getTextContent` glued the glyphs back into text runs that
  // CROSS cell boundaries: measured on a real report card, a
  // single 383.7 pt run carried the content of three cells over a column
  // 18.4 pt wide. Twelve ambiguous fragments out of fifteen came from there, and the
  // fallback below therefore always triggered.
  //
  // At the glyph level the ambiguity disappears by construction — a character
  // crosses no boundary. Measured: 2,348 glyphs, 2,348 placed, zero
  // ambiguous (`docs/INVENTAIRE-PDFJS-UNPDF.md` [purged 27/09/2026, git history]).
  //
  // The prose above and below the grid stays on the aggregated items
  // and on the EXISTING paragraph logic, unchanged: a page of prose
  // with a tabular region does not move outside that region.
  //
  // A PROBLEM THAT DISAPPEARS WITH THE AGGREGATED PATH, and is worth noting
  // because it cost a filter: `unpdf` inserts FILLER items
  // (`str: " "`) to represent the visual space between two runs of the same
  // line, and their width covers the WHOLE gap — they therefore regularly
  // crossed a real column boundary and were flagged ambiguous
  // for nothing (measured on 04/09/2026). They had to be filtered before assigning.
  // At the glyph level the problem does not exist: a space there is a glyph
  // of ordinary width, not a stopgap that spans a column.
  const inRange = gatherRotatedWords(
    glyphs.filter((g) => {
      const center = g.y + g.height / 2;
      return center <= top && center >= bottom;
    }),
  );
  // The grid found real borders/alignment, but no text actually sits
  // inside them (a decorative box, an empty template row) — nothing to
  // build a table FROM, so there's nothing to render as one either.
  if (inRange.length === 0) return undefined;

  // WRITTEN LIMIT (measured 22/09/2026, French and English documents): of the
  // 19 pages that carried a grid and gained their glyphs that day, 7 still
  // render no table, all refused by the two guards around this line: a grid
  // with no glyph in its height (fixture 24 p8, a 6-pt frame) and glyphs
  // ambiguous or outside the grid (24 p7: 9 outside; 29 p1: 12; 29 p4: 1;
  // 0000109 p1 and p2; 0000609 p1: 1 ambiguous). Their text stays published
  // as prose. Guarded as intended, not a defect of the grid reading.
  const { cells, ambiguous, outside } = assignFragmentsToCells(inRange, grid, merge);
  // TRIED AND SET ASIDE (27/10/2026): exempting an AMBIGUOUS glyph declared /Artifact from this refusal (left out of the cells, its
  // text published as a paragraph after the table). Measured on the corpus bench r119: +31 invented words and +3 lost. (a) On pages
  // whose producer declares EVERYTHING artifact it published tables that TORE words apart between cells and the paragraph (167 p2
  // organogram labels « Da » / « y »; 055 p5 « N » / « umber of Tenders », lost), and on 174 p12 and p17 it interleaved the watermark
  // into cell words (« sche DRAd FT ule »). (b) The artifact share of the page does not separate the populations (167 sits at 0.125,
  // under any threshold that keeps the watermark). (c) The one real watermark (174 DRAFT, p13) reaches our glyphs HORIZONTAL and
  // 0.8 pt tall: its VML rotation is lost upstream of `glyph-positions`, so an angle or collinearity rule has nothing to measure until
  // that reading defect is fixed. The exemption may return after it; until then an ambiguous artifact glyph refuses the table.
  // A SPACE PAST THE GRID IS NOT CONTENT (01/10/2026): Word ends a wrapped line with a space whose centre lies a few
  // points beyond the right border; it explains nothing the table must hold. Measured on 07-moj (bordered tables of
  // pages 10, 11, 13, 14): each carried exactly one such glyph and was refused for it. Text outside still refuses.
  if (ambiguous.length > 0 || outside.some((g) => g.text.trim().length > 0)) return undefined;

  // THE CROSS-CHECK — two independent readings of the same merge, which
  // must agree (09/09/2026).
  //
  // The `colspan` is read from the missing SEPARATORS. The generator, for its part,
  // paints the label of a merged cell once per sub-column
  // covered — hence a `paintCount` that equals the same number. Measured on two
  // templates: « Moyennes » painted 4 times for a colspan of 4, 3 times for a
  // colspan of 3.
  //
  // If the two contradict each other, we do not rule: we fall back on flat
  // text. A table built on two signals that contradict each other would be
  // exactly the "plausible and wrong" that this path exists to avoid.
  //
  // The check ONLY FIRES if over-painting exists (`paintCount > 1`):
  // many producers draw a merged cell only once, and
  // the absence of the second signal is not a contradiction. We do not demand
  // proof that we have no reason to expect.
  if (merge !== undefined) {
    for (const cell of merge.cells) {
      if (cell.colspan <= 1) continue;
      const painted = (cells[cell.row] ?? [])
        .slice(cell.col, cell.col + cell.colspan)
        .flat()
        .filter((f) => f.text.trim().length > 0 && f.paintCount > 1);
      if (painted.length > 0 && painted.some((f) => f.paintCount !== cell.colspan)) return undefined;
    }
  }

  // Placed before `recordCollapsedPaintings`: a comb abstains on a repainted glyph, so it has no collapsed painting to record.
  const comb = combText(cells[0] ?? [], grid, merge, images.length > 0);
  if (comb !== undefined) {
    const width = grid.colBoundaries[grid.colBoundaries.length - 1]! - grid.colBoundaries[0]!;
    return [
      {
        kind: "table",
        columnWidths: [width],
        rows: [{ cells: [{ blocks: [{ kind: "paragraph", inlines: [{ text: comb }] }] }] }],
      },
    ];
  }

  // THE DOCUMENT'S PROPORTIONS, PASSED ON AS THEY ARE (10/09/2026).
  //
  // The grid already carries the right widths: they are the gaps between its
  // column boundaries. Not passing them on left Confluence to distribute
  // the columns equally, so an assessments column 364 pt wide
  // got the same room as an empty « Pos. » column 18 pt wide.
  // Nothing is guessed here, nothing is interpreted: it is a copied measurement.
  const columnWidths = grid.colBoundaries.slice(1).map((boundary, i) => boundary - grid.colBoundaries[i]!);

  // THE HEADER HEIGHT IS READ FROM THE MERGE, it is not guessed.
  //
  // A first-row cell that SPANS the next one describes a two-level header:
  // « Matières », « Pos. » and « Appréciations » cover both
  // rows, while « Moyennes » heads its sub-columns. The header
  // block therefore has the height of the largest of these merges, and its two
  // rows come out as `<th>`.
  //
  // Without a vertical merge, the value is 1: it is exactly the earlier rule
  // — the first row is the header, a sound default rather than a guess
  // dressed up as a decision (§8 milestone 2, AI labelling is not part of this lot).
  const headerRows = headerRowCount(merge);

  const imagesByCell = imagesPerCell(images, grid, merge);
  // The glyphs a link is tied to (`pdf-links.ts#linkTieOfPage`), by identity: the cell's lines keep the same objects.
  const hrefOf = new Map<Fragment, string>();
  for (const g of inRange) if (g.href !== undefined) hrefOf.set(g, g.href);

  // WHERE THE CONTENT LIES, column by column of the grid — what
  // `dropEmptyColumns` reads. A glyph marks the case it was assigned to; an
  // image marks the column of its centre, the same centre that placed it in its
  // cell.
  const columnOf = (x: number): number => {
    let col = 0;
    while (col < grid.colBoundaries.length - 2 && x > grid.colBoundaries[col + 1]!) col++;
    return col;
  };
  const contentColumns = new Set<number>();
  for (const row of cells) {
    row.forEach((caseFragments, col) => {
      if (caseFragments.some((f) => f.text.trim().length > 0)) contentColumns.add(col);
    });
  }
  for (const image of images) contentColumns.add(columnOf((image.xMin + image.xMax) / 2));

  // A REGION OF ONE COLUMN: THE CONDITION UNDER WHICH A CELL JOINS ITS LINES
  // (23/09/2026 — the whole reasoning is at `pdf-cell-paragraphs.ts`)
  // AND, SINCE 26/10/2026, THE CONDITION UNDER WHICH THE REGION IS PUBLISHED
  // FLAT (`flatOneColumnRegion`, at the end of this function). Read on the
  // columns that actually CARRY something, the same set `dropEmptyColumns`
  // publishes: on safedocs 0000713 p3, p4 and p6 the grid draws a 5-pt sliver
  // beside its text column, and that sliver is not a second column any more
  // than a margin is.
  const contentColumnCount = columnWidths.filter((_, col) => contentColumns.has(col)).length;

  // A merged row renders FEWER cells than the grid has columns: the
  // fragments of the covered columns are joined, and the cell carries its
  // `colspan`. `renderer/storage.ts` already emits it on `<th>`/`<td>`.
  const built = cells.map((_, rowIndex) =>
    cellsOfRow(cells, rowIndex, merge).map(({ fragments: cellFragments, cell }) => {
      // No AI column/header labeling in this jalon (§8 jalon 2's own
      // staging — 2b, may never be built at all, cost-permitting): the
      // first row as the header is a plain, sane default, not a guess
      // dressed up as a decision — matches the shape of a real school
      // report ("Matière | Note" as row 1) and every other real-world
      // table this convention is common for.
      //
      // A LOGICAL LINE IS NEVER MERGED WITH ITS NEIGHBOUR HERE.
      // `recomposeCellText` tells a wrap (it joins) from a real break (it
      // separates) — without that, « FRANCAIS » and « Mme FINELLE » become
      // « FRANCAIS Mme FINELLE », the family of findings the rendering review
      // called « plausible, invisible, false ». What the two rules below
      // decide is only how a break that STAYS is published: a line break
      // inside one paragraph, or two paragraphs.
      //
      // `depth` is available and DELIBERATELY UNUSED here: that is the first
      // step of gap 17. Keeping the separation claims nothing; deciding that
      // « indented » means « subordinate » is a claim of another class, for
      // the second step.
      const span = { left: grid.colBoundaries[cell.col]!, right: grid.colBoundaries[cell.col + cell.colspan]! };
      const recomposed = recomposeCellText(cellFragments, span, bodyTextSize);
      const lines = JOIN_CELL_LINES && contentColumnCount === 1 ? joinCellLines(recomposed, span.right) : recomposed;
      recordCollapsedPaintings(cellFragments, span, bodyTextSize, recordRemoval);
      const texts = cellParagraphs(lines);
      // WRITTEN LIMIT (R3, measured 22/09/2026): a cell carries no bold.
      // A `CellLine` carries no emphasis, and a cell paragraph is one
      // plain inline. On the tables that the glyph repair of that day brought
      // out, 440 bold characters over 10 pages publish as plain text — 609 p8:
      // 158, 713 p5: 105, p6: 54, p3: 37, p4: 23, 25 p2: 22, 669 p2 and p3: 15
      // each, 523 p1: 7, 27 p2: 4. The text itself is kept.
      //
      // IN A CELL, A LINE THE JOIN LEFT ALONE IS A LINE BREAK, NOT A NEW
      // PARAGRAPH (lot « 44 », 23/09/2026 — `cellParagraphs`). Two lines
      // separated by an ordinary line spacing come out as one `<p>` with a
      // `<br/>` between them; only a real paragraph blank, measured by the
      // vertical gap, opens a second `<p>`. The claim is exact where the
      // paragraph break was a guess, and nothing is merged.
      //
      // THE JOIN RUNS FIRST AND IS UNCHANGED — a table of ONE COLUMN joins
      // the lines of its cells into continuous prose (lot « 42 »,
      // 23/09/2026). The condition and why it is the right one live at
      // `pdf-cell-paragraphs.ts`; the measurements that led to it are the ones
      // below, and they stay here because they were taken here.
      //
      // MEASURED on the 39 French and English PDFs: of the cell paragraph
      // PAIRS, 121 end with no final punctuation and are followed by a
      // lowercase letter — 121 line breaks too many (the count of 23/09 read
      // 122 on a slightly different basis). Booklet 26 carries 97 of them on
      // its pages 1, 9, 10, 13, 14 and 15; then 0000754 (9), 0000713 (8),
      // bulletin T1 (4), bulletin T2 (2), fixture 24 (1).
      //
      // THE TWO ATTEMPTS THAT CAME BEFORE, AND WHY NEITHER IS RETRIED.
      //
      // 1. LOT « 35 », shape + contiguity in the PDF flow: 64 right joins and
      //    ONE wrong, on booklet 26 page 13, cell « Moyens de Communication
      //    Interne ». Its two items open with DRAWN bullets, absent from the
      //    text layer: « Le chat via Google drive » and « ordinateur portable
      //    pour chaque collaborateur. » would have become one sentence the
      //    document does not write — false and invisible.
      //
      // 2. LOT « 41 » (23/09/2026), the ORDINARY paragraph rules applied to
      //    the logical lines of `recomposeCellText` — same predicates as
      //    outside a cell, the cell's own width as the centred container, the
      //    cell's widest line as the right margin, joins only (no boundary
      //    ever added), `roomReadable` closing the rule on a degenerate cell.
      //    Measured on the 39 French and English PDFs: 126 joins, 86 RIGHT and
      //    40 WRONG, each looked at on the page image (`pdftoppm -r 110`).
      //      right: booklet 26 (64 — the p1 welcome word comes out whole, and
      //        the title « LIVRET D'ACCUEIL STAGIAIRE » rejoins), 0000754 (9),
      //        0000713 p6 (8), the wrapped headers « Maîtrise / insuffisante »
      //        of both school reports (5);
      //      wrong: bulletin T1 (19) and T2 (10) — « FRANCAIS » + « Mme
      //        FINELLE », « Écrit » + « Oral », the two grades « 7,00 » +
      //        « 6,00 »; 0000713 p3–p5 (10) — « Présentation de
      //        l'organisation sur site » + « Organigramme opérationnel », two
      //        distinct entries of one cell; 0000754 p2 (1) — the callout
      //        bubbles « 7 » and « 5 » of a screenshot.
      //    WHY GEOMETRY CANNOT DECIDE HERE: « did the next word fit » is asked
      //    against a MARGIN, and a cell of two lines has none — the margin is
      //    set by the OTHER line of the pair, so the shorter of the two never
      //    has room and everything rejoins.
      //    Second reading measured the same day, the CELL's right edge as the
      //    margin: 53 joins, the 10 wrong ones of 0000713 and the one of
      //    0000754 disappear, but the school reports keep 12 (their narrow
      //    « Matières » column) and the booklet only gains 29 joins instead of
      //    64 — Canva lays its text far inside its page frame. Neither reading
      //    reaches zero wrong, and one wrong is enough to give up (
      //    23/09: fidelity before comfort).
      //    WHAT THIS REFUTES: the blocking case is NOT booklet 26 p13. Neither
      //    geometric reading joins its two drawn-bullet items — « Le chat via
      //    Google drive » ends far from the margin, so its line end is read as
      //    deliberate. That page blocked the rule of lot « 35 », not this one.
      //
      // WHAT LOT « 42 » CHANGED: reading 1 is kept AS IT IS, and applied only
      // where its own precondition holds — a table of ONE column, whose cell
      // spans the whole width, so the margin it asks against is real. That
      // removes the wrong joins of both school reports and of 0000754, which
      // are grids of several columns. A piece that is only a NUMBER never
      // joins either, whatever the table: that is the « 7,00 » + « 6,00 »
      // defect, named and guarded on its own.
      // 🔴 IT DOES NOT REMOVE THE WRONG JOINS OF 0000713, whose tables publish
      // ONE column and still glue two entries of a list together: the cause
      // and the numbers are at `pdf-cell-paragraphs.ts`, and two red tests say
      // so.
      const blocks: IRBlock[] = texts.map(({ text, fragments, raised }) => ({
        kind: "paragraph" as const,
        inlines: cellInlines(text, fragments, hrefOf, raised),
      }));
      const boxes: CellParagraphBox[] = [...texts];

      placeCellImages(blocks, boxes, imagesByCell.get(`${cell.row},${cell.col}`) ?? []);

      return { cell, blocks, header: rowIndex < headerRows };
    }),
  );

  if (contentColumnCount === 1 && images.length === 0) return [...flatOneColumnRegion(built)];
  const { rows, columnWidths: kept } = dropEmptyColumns(built, columnWidths, contentColumns);
  // A ONE-cell row that merely continues a URL goes back into the cell above
  // (`pdf-row-url-join.ts`, measured on 30/10/2026: 1 case out of 67 PDFs, 0 false).
  return [{ kind: "table", rows: joinCutUrlRows(rows), ...(kept === undefined ? {} : { columnWidths: kept }) }];
}

type TableBlock = Extract<IRBlock, { kind: "table" }>;

/**
 * A REGION OF ONE CONTENT COLUMN IS PUBLISHED AS ITS CELLS' BLOCKS, FLAT, IN ROW
 * ORDER — NOT AS A TABLE (26/10/2026, on measurement). No exception of
 * form. It supersedes « one-column tables stay tables » of 22/09/2026, below.
 *
 * WHY. A grid of one column offers no second reading that confirms a table:
 * nothing aligns across columns. The borders say « table », the content says
 * « a stack of paragraphs », the two readings diverge — so the table abstains
 * and the prose is published. The count is the CONTENT column count, the one
 * `dropEmptyColumns` publishes: an empty sliver beside the text column is not a
 * second column (safedocs 0000713 p3, p4, p6).
 *
 * MEASURED on the corpus before the decision (26/10/2026): `table_false`
 * 797 → 92, `table_missed` +185, 0 word moved, lists unchanged.
 *
 * WHAT STAYS. The cells are still read glyph by glyph (`recomposeCellText`, the
 * one-column join included): the page is NOT re-read as prose — the 22/09
 * attempt did, and cut 38 paragraphs on corpus doc 29 p3. A row the grid cut
 * through a box's fill band stays its own paragraph(s) (02-jvmalin p13 splits
 * « schedu » / « les » that way: a written limit, not this rule's). An empty
 * cell yields nothing.
 *
 * ABSTENTION (the table stays): a cell carrying an image the grid claims —
 * flat, the image would have no cell to live in (`placeCellImages`).
 *
 * THE COMB IS NOT AN EXCEPTION, IT NEVER REACHES HERE: `combText` returns far
 * above, and the one-cell table it emits comes from a region whose boxes carry
 * one character EACH, in as many columns — the count this rule reads is not 1.
 * So a one-column table block can still be published, by that path only.
 *
 * NOT CODED, WRITTEN: lists and nested tables do not exist inside a PDF cell —
 * 0 out of 2 605 cells of the corpus — so a cell's blocks are paragraphs and
 * nothing is lost by publishing them bare.
 *
 * ⚠️ VARIANT WEIGHED AND REJECTED THE SAME DAY: keep a one-column table when
 * EVERY cell holds exactly one paragraph (−426 false / +77 missed). Refused
 * because its real discriminant is « no empty cell », an accident of form: it
 * kept 109 of 133 true tables and left 285 of 389 false ones.
 *
 * SUPERSEDED — tried then rejected (22/09/2026, lot « 33 »): « a table of ONE
 * content column and several filled cells is not a table » — the grid dropped
 * before the page was read, its cells published as prose. Measured on 39
 * French/English PDFs: 27 → 18 tables (Canva page frames, 29 p3, 0000713
 * p3-6). Its costs, seen on the page images: 29 p3, a page of prose cut into
 * 38 one-line cells, came out as 38 paragraphs with 31 mid-sentence breaks as
 * soon as a cell boundary had to stay a paragraph boundary; without that
 * boundary, 0000713 p5 joined lines of different cells. the decision
 * then: ONE-COLUMN TABLES STAY TABLES, in every case. A borderless table does
 * not exist in Confluence Cloud (the editor offers no border option), so
 * making the grid "transparent" would mean "no table" — and the table was
 * preferred. What differs today: the cells are kept as read (no re-reading of
 * the page, so no mid-sentence cut), and the measure is on the whole corpus.
 */
function flatOneColumnRegion(built: readonly (readonly { blocks: IRBlock[] }[])[]): IRBlock[] {
  return built.flatMap((row) => row.flatMap(({ blocks }) => blocks));
}

/**
 * A GRID COLUMN WITH NOTHING IN IT, IN ANY ROW, IS NOT PUBLISHED (
 * 22/09/2026). Nothing means no text, no image, no disc and no data fill
 * located in that column (`contentColumns`). A merged cell that crosses the
 * column keeps it only if part of its content lies IN it; otherwise the cell
 * just loses one unit of `colspan`. Nothing can be lost by construction: every
 * piece of content marks the column it lies in, so a cell whose columns are
 * all dropped is empty.
 *
 * WHY THE GEOMETRY AND NOT THE CELLS. A cell that merely crosses an empty
 * column says nothing about that column. On safedocs 0000713 p3, p4 and p6,
 * every row is one cell spanning a 5-pt sliver and the text column: read on the
 * IR cells alone, where a merged cell's content has no position, the sliver
 * stays; read on the geometry it goes.
 *
 * WHY HERE. This is the last place where content still has a position; the IR
 * table only knows cells. It applies to every PDF table and only to PDF tables:
 * docx, xlsx and pptx declare their columns and never pass through here.
 *
 * Measured 22/09/2026 on 38 French and English PDFs, pages looked at before
 * choosing, then again once image frames and footer tables were set aside the
 * same day: 7 of the 27 published tables lose columns, 27 in all, on 6 pages; no
 * word lost and no table count changed. None is a form field left blank: gaps
 * between boxes (0000523 p1, 21 → 11 and 5 → 4), margins and slivers left by
 * borders that do not align (26 p9, 3 → 1; 0000713 p3, p4, 2 → 1, p6, 3 → 1)
 * and layout columns (0000523 p5, 12 → 2). Before those two rules, 0000754 p1
 * (4 → 2, its screenshot frames) and the 0000669 footer (3 → 2, a spacer) were
 * dropped here too.
 *
 * A HEADING IS CONTENT (22/09/2026): an entirely empty column has no
 * heading either, so a column headed and empty below is kept. Measured the same
 * day, in tables with a body: 9 columns carry text in their heading only, all
 * kept. 5 have painted data below (bars, discs). 4 hold no text and no painted
 * centre below: the four mastery levels of the real bulletin's "socle" table (trimester 1).
 *
 * ABSTENTIONS, the table staying as it was: no content column at all, a row
 * that would lose all its cells (an empty `<tr>`), and a cell that would vanish
 * while holding a block (the construction above says it cannot; it is checked).
 *
 * WRITTEN LIMIT: this runs page by page, so a column empty on one page and
 * filled on the next gives two tables of different widths. Tables are never
 * joined across pages, so this costs nothing.
 */
function dropEmptyColumns(
  built: readonly (readonly { cell: MergedCell; blocks: IRBlock[]; header: boolean }[])[],
  columnWidths: readonly number[],
  contentColumns: ReadonlySet<number>,
): Pick<TableBlock, "rows" | "columnWidths"> {
  const kept = columnWidths.map((_, col) => contentColumns.has(col));
  const spanOf = (cell: MergedCell): number => kept.slice(cell.col, cell.col + cell.colspan).filter(Boolean).length;
  const abstain =
    !kept.some(Boolean) ||
    built.some((row) => row.length > 0 && row.every(({ cell }) => spanOf(cell) === 0)) ||
    built.some((row) => row.some(({ cell, blocks }) => spanOf(cell) === 0 && blocks.length > 0));
  const span = abstain ? (cell: MergedCell): number => cell.colspan : spanOf;
  return {
    columnWidths: abstain ? [...columnWidths] : columnWidths.filter((_, col) => kept[col]),
    rows: built.map((row) => ({
      cells: row
        .filter(({ cell }) => span(cell) > 0)
        .map(({ cell, blocks, header }) => ({
          blocks,
          ...(span(cell) > 1 ? { colspan: span(cell) } : {}),
          ...(cell.rowspan > 1 ? { rowspan: cell.rowspan } : {}),
          ...(header ? { header: true as const } : {}),
        })),
    })),
  };
}
