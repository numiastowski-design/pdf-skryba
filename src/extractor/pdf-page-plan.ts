/** The single entry point to a page's geometry, and the record of what that geometry gave: the column cuts the page
 *  is read on, and the SLICES it is read in — one per call of the reader, in reading order, each with the segments
 *  it produced. At this step of the page-plan work it decides NOTHING of its own and delegates everything to
 *  `extractor/pdf-bands.ts` and `extractor/pdf-reading-order.ts`, so the published render stays byte-identical.
 *
 *  It is a RECORDER, not a precomputation: a page is not read whole, so the plan is filled BY the one reading that
 *  already happens, slice by slice (the measurements that impose it are at `pagePlanReader`). It also carries the
 *  page's large pictures, and reads none of them (step 1).
 *  ⚠️ WRITTEN LIMIT (measured 13/11/2026): the plan only knows the pictures the DETECTOR kept. Alouette's two
 *  masked images never become candidates, so no plan can carry them — lifting that means going up to
 *  `pdf-signals.ts`, which step 1 does not do.
 *  NOT here: which cut a page takes (`extractor/pdf-column-cut.ts`), where a cut comes from (`layout/gutter.ts`,
 *  `extractor/pdf-table-detector.ts`), the band reading itself (`extractor/pdf-bands.ts`), the declared-order rewrite
 *  (`extractor/pdf-reading-order.ts`), nor who carves the slices (`extractor/pdf-region-order.ts`).
 *  Called by: `extractor/pdf.ts` (one plan per page), `extractor/pdf-image-anchors.ts` (every reading). */

import { maxOf, minOf } from "../lib/extent";

import { readingBands, readingSegments, type ReadSegment } from "./pdf-bands";
import type { ColumnCut } from "./pdf-column-cut";
import { inkOfLine, isDropCap, isOverhungBy, MIN_DROP_CAP_RATIO, type LineInk } from "./pdf-lines";
import type { ImageCandidate } from "./pdf-model";
import { segmentsInDeclaredOrder } from "./pdf-reading-order";
import type { PdfTextRun } from "./pdf-source";

/** Where one reading segment stands on the page, on BOTH axes. All four absent when it carries no inked item. */
export interface SegmentExtent {
  readonly top: number | undefined;
  readonly bottom: number | undefined;
  readonly left: number | undefined;
  readonly right: number | undefined;
}

/** One stretch of a page read on its own. A page no image crosses has exactly ONE, which covers it. */
export interface PageSlice {
  /** The items the reader handed over, in the order it handed them. */
  readonly items: readonly PdfTextRun[];
  /** The slice's extent, OBSERVED on its items; both absent when it carries none. */
  readonly top: number | undefined;
  readonly bottom: number | undefined;
  /** ⚠️ EXACTLY ONE of the two is set — a slice is read either on the geometry or in the order the document
   *  declares, never both (`pdf-page-plan.test.ts`). The bands of a slice read geometrically. */
  readonly bands?: readonly ReadSegment<PdfTextRun>[];
  /** The segments of a slice of a TAGGED page, put back in the declared order. No column flag: the rewrite cuts and
   *  merges segments, so none of the geometric ones survives whole. */
  readonly declared?: readonly PdfTextRun[][][];
  /** Where each segment of this slice stands, in reading order — same length as `bands` or `declared`. The plan
   *  said where a slice begins and ends VERTICALLY and nothing horizontally; without x one cannot say « this line
   *  is within the picture's width », which is the test that tells a caption from a line of prose. */
  readonly extents: readonly SegmentExtent[];
  /** ⚠️ WRITTEN LIMIT — this slice is the WHOLE page, read again. A tagged page whose chunks break its declared
   *  order is re-read in one piece, and the reader then keeps ONE of the two readings
   *  (`pdf-image-anchors.ts#readPageWithImages`, one-segment guard). The plan records both, in the order they
   *  happened, and does not yet say which one published: that is step 2. */
  readonly wholePage?: true;
}

/** A large picture of the page: the room it takes, and whether its pixels were obtained. */
export interface PicturePlace {
  readonly top: number;
  readonly bottom: number;
  readonly xMin: number;
  readonly xMax: number;
  /** The column band it stands in, by its x range; `undefined` when it crosses a cut, or when the page has none.
   *  ⚠️ NOT the read segment it belongs to — that is a decision, and it belongs to step 2. */
  readonly band: number | undefined;
  /** `true` when `ImageCandidate.read()` gave blocks, `false` when it gave nothing — the place is taken and the
   *  pixels are missing — and `undefined` when nobody read it: its image went into a rendered cell, unscanned
   *  (`pdf-table-render.ts#renderTableRegion`). */
  readonly readable: boolean | undefined;
}

/** A drop cap of the page, and the line it should open INSIDE its own column. */
export interface DropCapPlace {
  readonly letter: string;
  readonly x: number;
  readonly y: number;
  readonly fontSize: number;
  /** Where it stands: the slice, then the read segment inside that slice. */
  readonly slice: number;
  readonly segment: number;
  /** The index, in that segment, of the highest line it overhangs — the line it should open. `undefined` when it
   *  overhangs none of its column's lines. ⚠️ NOBODY READS THIS YET: `pdf-lines.ts#liftDropCaps` still decides on
   *  the WHOLE page, which is the defect step 2 corrects. */
  readonly opensLine: number | undefined;
}

export interface PagePlan {
  readonly cuts: readonly number[];
  /** The ordinate above which the cuts hold (`ColumnCut.above`); absent when they hold on the whole page. */
  readonly bound: number | undefined;
  readonly slices: readonly PageSlice[];
  /** The page's large pictures, in the order the page offered them. Step 1 carries them and reads none of them:
   *  deciding the columns with an image is step 2 (conception, decision 3). */
  readonly pictures: readonly PicturePlace[];
  /** The drop caps found in the slices, in reading order. Carried, never read (step 1). */
  readonly dropCaps: readonly DropCapPlace[];
}

export interface PagePlanReader {
  /** The plan as it stands: it grows by one slice at each reading call below. */
  readonly plan: PagePlan;
  /** The page's cuts and bound, for the decisions that need them without reading anything (which band an x falls
   *  in, where a column is centred). The plan is their one holder, so they cannot drift from what it read on. */
  readonly cuts: readonly number[];
  readonly bound: number | undefined;
  /** Puts the page's large pictures on the plan and returns the SAME candidates, each wrapped so that the plan
   *  learns whether its pixels came out. Called once per page, before any stage reads them. */
  watchPictures: (candidates: readonly ImageCandidate[]) => ImageCandidate[];
  bands: (items: readonly PdfTextRun[]) => ReadSegment<PdfTextRun>[];
  declared: (items: readonly PdfTextRun[], rankOf: (item: PdfTextRun) => number | undefined) => PdfTextRun[][][];
  /** The whole page read again, in the declared order (see `PageSlice.wholePage`). */
  declaredWholePage: (
    items: readonly PdfTextRun[],
    rankOf: (item: PdfTextRun) => number | undefined,
  ) => PdfTextRun[][][];
}

/**
 * 🔴 EACH DROP CAP OPENS THE LINE IT OVERHANGS INSIDE ITS OWN COLUMN — and the plan MOVES it there (step 2,
 * correction 1, 13/11/2026: « lettrine puis image, go »).
 *
 * It is the rule of `pdf-lines.ts#liftDropCaps`, imported and not copied, applied to a narrower set of lines: that
 * module searches the WHOLE page, before the columns are split, and gives the « L » of Alouette page 2 to the
 * « Vaud » line of the THIRD column, 1.6 pt higher (799.8 against 798.2). The page-wide line then reads « LVaud »,
 * and once the columns are cut the « L » stays alone in column 1 — a paragraph of one letter. Searching inside the
 * column finds « a chasse continue », which is the line a reader sees it open.
 *
 * This runs AFTER the page-wide lift, on lines already grouped, so it costs no new line grouping — the measured
 * reason not to regroup each column's items instead, which gives the same answer (« La chasse continue, une
 * chasse ») at the price of one grouping per column.
 */
/** A drop cap of one segment, and the index of the line it must open — before any line is removed. */
interface CapInColumn {
  cap: PdfTextRun;
  from: number;
  to: number | undefined;
}

/** Shape is not enough, size decides too: `isDropCap` only tests the shape (one or two letters), because
 *  `liftDropCaps` then rules out on position. Without the size condition the plan lists one-letter words of body
 *  text as drop caps. */
const isCapOfColumn = (cap: PdfTextRun, line: readonly PdfTextRun[], inks: readonly (LineInk | undefined)[]): boolean =>
  isDropCap(cap, line) && inks.some((ink) => ink !== undefined && ink.size * MIN_DROP_CAP_RATIO <= cap.fontSize);

/**
 * A drop cap already seated opens its own line: it heads its line with the body text. The overhang test cannot say
 * so, because `inkOfLine` takes the line's first inked item, the drop cap itself, and because the cap shares its
 * line's baseline where the overhang asks for a strictly higher one. Naming the next line would move a correct cap.
 *
 * Otherwise the search covers the whole column, not only the lines before as in `liftDropCaps`: when the plan sees
 * these lines the cap was already moved, and it may overlap a line above its target. Lines run top to bottom, so the
 * first that matches is the highest.
 */
const capTarget = (
  cap: PdfTextRun,
  line: readonly PdfTextRun[],
  lineIndex: number,
  inks: readonly (LineInk | undefined)[],
): number | undefined => {
  const seated = line.some(
    (it) => it !== cap && it.text.trim() !== "" && it.fontSize * MIN_DROP_CAP_RATIO <= cap.fontSize,
  );
  if (seated) return lineIndex;
  const found = inks.findIndex((ink) => isOverhungBy(cap, ink));
  return found < 0 ? undefined : found;
};

/** The drop caps of ONE segment, decided on the lines as they stand — moving as we go would shift the indices. */
const capsOfColumn = (
  lines: readonly (readonly PdfTextRun[])[],
  inks: readonly (LineInk | undefined)[],
): CapInColumn[] => {
  const found: CapInColumn[] = [];
  for (const [lineIndex, line] of lines.entries()) {
    for (const cap of line) {
      if (isCapOfColumn(cap, line, inks))
        found.push({ cap, from: lineIndex, to: capTarget(cap, line, lineIndex, inks) });
    }
  }
  return found;
};

/**
 * 🔴 EACH DROP CAP OPENS THE LINE IT OVERHANGS INSIDE ITS OWN COLUMN — and the plan MOVES it there (step 2,
 * correction 1, 13/11/2026: « lettrine puis image, go »).
 *
 * It is the rule of `pdf-lines.ts#liftDropCaps`, imported and not copied, applied to a narrower set of lines: that
 * module searches the WHOLE page, before the columns are split, and gives the « L » of Alouette page 2 to the
 * « Vaud » line of the THIRD column, 1.6 pt higher (799.8 against 798.2). The page-wide line then reads « LVaud »,
 * and once the columns are cut the « L » stays alone in column 1 — a paragraph of one letter. Searching inside the
 * column finds « a chasse continue », which is the line a reader sees it open.
 *
 * This runs AFTER the page-wide lift, on lines already grouped, so it costs no new line grouping — the measured
 * reason not to regroup each column's items instead, which gives the same answer (« La chasse continue, une
 * chasse ») at the price of one grouping per column.
 *
 * A line emptied by a move disappears, exactly as `liftDropCaps` drops it: a paragraph of one letter is what we
 * are removing. The reported `opensLine` is the line's index AFTER that removal.
 */
const seatDropCaps = (
  segments: readonly (readonly PdfTextRun[][])[],
  slice: number,
): { segments: PdfTextRun[][][]; dropCaps: DropCapPlace[] } => {
  const dropCaps: DropCapPlace[] = [];
  const out: PdfTextRun[][][] = [];
  segments.forEach((original, segment) => {
    const lines = original.map((line) => [...line]);
    const caps = capsOfColumn(lines, lines.map(inkOfLine));
    for (const { cap, from, to } of caps) {
      if (to === undefined || to === from) continue;
      lines[from] = lines[from]!.filter((it) => it !== cap);
      lines[to]!.unshift(cap);
    }
    const kept = lines.filter((line) => line.length > 0);
    for (const { cap, to } of caps) {
      dropCaps.push({
        letter: cap.text.trim(),
        x: cap.x,
        y: cap.y,
        fontSize: cap.fontSize,
        slice,
        segment,
        opensLine: to === undefined ? undefined : kept.indexOf(lines[to]!),
      });
    }
    out.push(kept);
  });
  return { segments: out, dropCaps };
};

const extentOf = (items: readonly PdfTextRun[]): { top: number | undefined; bottom: number | undefined } =>
  items.length === 0
    ? { top: undefined, bottom: undefined }
    : { top: maxOf(items, (it) => it.y + it.height), bottom: minOf(items, (it) => it.y) };

/** The extent is measured on inked text, never on filler blanks: a filler item (`str: " "`) runs from the end of one
 *  column to the start of the next and, counted, would make every column look full width. */
const segmentExtent = (lines: readonly (readonly PdfTextRun[])[]): SegmentExtent => {
  const ink = lines.flat().filter((it) => it.text.trim() !== "");
  if (ink.length === 0) return { top: undefined, bottom: undefined, left: undefined, right: undefined };
  return {
    top: maxOf(ink, (it) => it.y + it.height),
    bottom: minOf(ink, (it) => it.y),
    left: minOf(ink, (it) => it.x),
    right: maxOf(ink, (it) => it.x + it.width),
  };
};

/**
 * 🔴 WHY A RECORDER AND NOT A PRECOMPUTATION (13/11/2026, measured).
 *
 * A page is NOT read whole: an image that crosses it cuts it into chunks, and the bands are read per chunk
 * (`pdf-image-anchors.ts#readColumnsWithImages`, `#readPageWithImages`). Measured on five documents the same day:
 * booklet 26 is read in 5.2 chunks per page, Alouette and brochure 11 in one, and guide 34 asks for no geometry at
 * all on more than half of its pages.
 *
 * Those chunks are not handed out as geometry — `pdf-region-order.ts#interleaveRegions` calls its `prose` callback
 * with item lists as it walks the page, several times per band. So a plan built BEFORE the reading would have to run
 * that whole walk a second time: wired that way on 13/11, the line grouping went 63 → 130 and the band readings
 * 4 → 8, and the ratchet bit within the minute. The reader therefore asks the plan for each slice, and the plan
 * answers and remembers.
 *
 * REFUSED here for now: `cutBy`, the image that carved a slice. `interleaveRegions` hands its callback items, never
 * the region nor the bounds it cut at; making it say so is a change to the page's ordering module, out of an
 * « identical render » step. A slice's extent is OBSERVED on its items instead.
 */
export const pagePlanReader = (cut: ColumnCut | undefined): PagePlanReader => {
  const cuts = cut === undefined ? [] : (cut.all ?? [cut.cut]);
  const bound = cut?.above;
  const slices: PageSlice[] = [];
  const pictures: PicturePlace[] = [];
  const dropCaps: DropCapPlace[] = [];
  /** The band an x range stands in: `undefined` on a page without cuts, and as soon as a cut falls INSIDE the
   *  range — the same test `pdf-image-anchors.ts#placementOf` uses to call a picture « within » one column. */
  const bandOf = (xMin: number, xMax: number): number | undefined =>
    cuts.length === 0 || cuts.some((cut) => xMin < cut && xMax > cut)
      ? undefined
      : cuts.filter((cut) => cut <= xMin).length;
  /** Seats this slice's drop caps, remembers them, and gives back the segments the reader must publish. */
  const seat = (segments: readonly (readonly PdfTextRun[][])[]): PdfTextRun[][][] => {
    const seated = seatDropCaps(segments, slices.length);
    dropCaps.push(...seated.dropCaps);
    return seated.segments;
  };
  const inDeclaredOrder = (
    items: readonly PdfTextRun[],
    rankOf: (item: PdfTextRun) => number | undefined,
    whole: boolean,
  ): PdfTextRun[][][] => {
    const read = seat(segmentsInDeclaredOrder(readingSegments(items, cuts, bound), rankOf));
    slices.push({
      items,
      ...extentOf(items),
      declared: read,
      extents: read.map(segmentExtent),
      ...(whole ? { wholePage: true } : {}),
    });
    return read;
  };
  return {
    get plan(): PagePlan {
      return { cuts, bound, slices, pictures, dropCaps };
    },
    cuts,
    bound,
    // 🔴 THE PLAN LEARNS READABILITY FROM THE READ ITSELF, by wrapping `read()` (13/11/2026). The alternative was to
    // compare the candidates with the anchors `placeImages` kept, and it is worse twice over: it would have to match
    // them by box — two pictures sharing one box become one — and it would have to be called at each of the THREE
    // places that place images, one of which is inside `renderPageTables`, which has no plan. Wrapping is exact and
    // has one call site. A candidate nobody reads stays `readable: undefined`, which is the truth about it.
    watchPictures: (candidates) =>
      candidates.map((candidate) => {
        const place: { -readonly [K in keyof PicturePlace]: PicturePlace[K] } = {
          top: candidate.top,
          bottom: candidate.bottom,
          xMin: candidate.xMin,
          xMax: candidate.xMax,
          band: bandOf(candidate.xMin, candidate.xMax),
          readable: undefined,
        };
        pictures.push(place);
        return {
          ...candidate,
          read: () => {
            const blocks = candidate.read();
            place.readable = blocks !== undefined;
            return blocks;
          },
        };
      }),
    bands: (items) => {
      const banded = readingBands(items, cuts, bound);
      const seated = seat(banded.map((segment) => segment.lines));
      const read = banded.map((segment, i) => ({ ...segment, lines: seated[i]! }));
      slices.push({ items, ...extentOf(items), bands: read, extents: seated.map(segmentExtent) });
      return read;
    },
    declared: (items, rankOf) => inDeclaredOrder(items, rankOf, false),
    declaredWholePage: (items, rankOf) => inDeclaredOrder(items, rankOf, true),
  };
};

/** The plan of a page read in ONE slice — no image crosses it. */
export const pagePlanOf = (items: readonly PdfTextRun[], cut: ColumnCut | undefined): PagePlan => {
  const reader = pagePlanReader(cut);
  reader.bands(items);
  return reader.plan;
};
