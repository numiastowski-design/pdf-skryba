/** The lines that run BESIDE a picture, and the one-row table that publishes the two side by side.
 *  NOT here: where a picture stands among the lines it COVERS (`layout/image-frontier.ts`), which picture a line
 *  is ordered against (`extractor/pdf-region-order.ts`), nor the reading of the picture itself
 *  (`extractor/pdf-image-anchors.ts`).
 *  Called by: `extractor/pdf-image-anchors.ts`. */

import { maxOf, minOf } from "../lib/extent";
import type { IRBlock } from "doc-ir";

import type { ImageAnchor, PageRegion } from "./pdf-model";
import { visualLines } from "./pdf-region-order";
import type { PdfTextRun } from "./pdf-source";

/** A picture, the lines that run beside it, and the table that holds both. */
export interface AsideFigure {
  readonly anchor: ImageAnchor;
  readonly lines: readonly PdfTextRun[][];
  readonly region: PageRegion;
}

const inkOf = (line: readonly PdfTextRun[]): PdfTextRun[] => line.filter((it) => it.text.trim() !== "");

/**
 * The table takes every line the picture shortens. A line runs beside the picture when it ends before its left
 * edge; no threshold.
 *
 * The run extends past the picture's vertical extent, which keeps sentences whole: a line that starts just above
 * the picture's top edge is already shortened, and bounding the run to the extent would leave it out.
 *
 * Shorter is not enough, the line has to butt against the picture: on a page where most lines end left of the
 * picture for another reason, the first version swallowed the whole page. The run goes from the first to the last
 * line that butts, the short lines in between included (the paragraph ends of the block). To butt is to end within
 * one em of the edge, the em being the line's own.
 */
const besideRun = (anchor: ImageAnchor, lines: readonly PdfTextRun[][]): PdfTextRun[][] => {
  if (anchor.bottom === undefined || anchor.xMax === undefined) return [];
  const [top, bottom, left] = [anchor.top, anchor.bottom, anchor.xMin];
  const inks = lines.map(inkOf);
  /** The line ends against the picture: left of it, and within one em of its edge. */
  const butts = (i: number): boolean => {
    const ink = inks[i]!;
    if (ink.length === 0) return false;
    const right = maxOf(ink, (it) => it.x + it.width);
    return right <= left && left - right <= maxOf(ink, (it) => it.fontSize);
  };
  /** The line meets the picture's height: the run has to hold at least one, or it is beside nothing. */
  const meets = (i: number): boolean => {
    const ink = inks[i]!;
    return ink.length > 0 && maxOf(ink, (it) => it.y + it.height) >= bottom && minOf(ink, (it) => it.y) <= top;
  };
  const anchored = lines.map((_, i) => i).filter((i) => butts(i));
  if (!anchored.some((i) => meets(i))) return [];
  return lines.slice(anchored[0], anchored[anchored.length - 1]! + 1);
};

/**
 * THE PICTURE BECOMES A CELL, NOT AN INSERTION POINT.
 *
 * ⚠️ The region does NOT consume its band, although its lines are published inside it. Consuming would drop every
 * line whose centre falls in [bottom, top] — including text standing to the RIGHT of the picture, which belongs to
 * nobody here and would be silently lost. The caller removes the run's own items instead, which loses nothing.
 */
const figureOf = (
  anchor: ImageAnchor,
  lines: readonly PdfTextRun[][],
  toBlocks: (segment: PdfTextRun[][]) => IRBlock[],
): AsideFigure | undefined => {
  const ink = lines.flatMap(inkOf);
  if (ink.length === 0) return undefined;
  const beside = toBlocks(lines.map((line) => [...line]));
  if (beside.length === 0) return undefined;
  const table: IRBlock = { kind: "table", rows: [{ cells: [{ blocks: beside }, { blocks: anchor.blocks }] }] };
  // The table is read where the run STARTS: everything above it comes before, everything below comes after.
  const top = Math.max(
    maxOf(ink, (it) => it.y + it.height),
    anchor.top,
  );
  return {
    anchor,
    lines,
    region: { top, bottom: top, orderAt: top, xMin: minOf(ink, (it) => it.x), blocks: [table], consumesBand: false },
  };
};

/**
 * Every picture of this page that has text running beside it, with the table that publishes the two side by side.
 * A picture with no such text is left alone: it keeps its place in the flow.
 *
 * ⚠️ ONE PICTURE AT MOST PER RUN OF LINES: the runs are taken highest first, and a line already taken by one
 * picture is not offered to the next — two pictures at the same height would otherwise publish the same text
 * twice.
 */
export const asideFigures = (
  items: readonly PdfTextRun[],
  anchors: readonly ImageAnchor[],
  toBlocks: (segment: PdfTextRun[][]) => IRBlock[],
): { figures: AsideFigure[]; taken: Set<PdfTextRun> } => {
  // Most pages have no picture: their lines are not grouped for nothing (review of 14/11/2026).
  if (anchors.length === 0) return { figures: [], taken: new Set() };
  const lines = visualLines(items);
  const taken = new Set<PdfTextRun>();
  const figures: AsideFigure[] = [];
  for (const anchor of [...anchors].sort((p, q) => q.top - p.top)) {
    const free = lines.filter((line) => line.every((it) => !taken.has(it)));
    const run = besideRun(anchor, free);
    if (run.length === 0) continue;
    const figure = figureOf(anchor, run, toBlocks);
    if (figure === undefined) continue;
    for (const it of run.flat()) taken.add(it);
    figures.push(figure);
  }
  return { figures, taken };
};
