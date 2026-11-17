/** The runs of a rotated text line (a title turned by a quarter or by half a turn, a vertical margin note) gathered into ONE run, read along
 *  the direction they are written in. Decides: which rotated runs share a line (same direction, same baseline across it), their order, the
 *  spaces between them. NOT here: the glyph-level words of a table (`extractor/pdf-rotated-words.ts`), where a run closes (`glyph-runs.ts`).
 *  Called by: `extractor/pdf.ts#enrichRuns`, on the runs of every page, after the links are tied. */

import { groupByBaseline } from "doc-ir/layout/baseline-lines";
import { separatorBefore } from "./pdf-lines";
import type { PositionedItem } from "./pdf-model";
import type { PdfTextRun } from "./pdf-source";
import { writingDirectionTurned } from "./text-writing-direction";

/**
 * THE DEFECT (19/10/2026, probation rule « a rotated text is published straight, its letters in the order it is READ »). The page flow
 * sorts a line by x and its lines by y, whatever the direction of the text: a title turned by half a turn came out « INTERNE DOCUMENT
 * CONFIDENTIEL », and a vertical title read bottom to top came out one word per line, the last word first. A run is already read along its
 * own axis (`glyph-runs.ts` writes the letters in paint order); only the ORDER BETWEEN runs was wrong.
 *
 * THE RULE: each run that is not written left to right (`text-writing-direction.ts`: `b` non zero relative to `a`, or `a < 0`; a shear alone, a synthetic italic, is not a turn) is placed in its own frame (`u` along its
 * writing axis, `v` across it). Runs of one direction are grouped by baseline in that frame with the page's own line rule
 * (`groupByBaseline`), ordered by `u`, and joined with the page's own word-gap rule (`pdf-lines.ts#separatorBefore`). A line of several
 * runs becomes one copy of its first run (origin, matrix, font) with the joined text and the extent along the axis. A run alone, a text
 * written left to right and a line whose runs carry a link (the spans index the run's text) stay as they are. No letter is dropped.
 *
 * Limit written: the copy is placed by its first run, so a rotated line that crosses a column border is read in the column it starts in.
 */

/** Two writing directions closer than this (per unit vector component) are one direction. */
const SAME_DIRECTION = 1e-3;

/** A run in the frame of its writing direction. */
interface Framed extends PositionedItem {
  run: PdfTextRun;
}

const directionKey = (run: PdfTextRun): string | undefined => {
  const n = Math.hypot(run.matrix.a, run.matrix.b);
  if (n === 0) return undefined;
  return `${Math.round(run.matrix.a / n / SAME_DIRECTION)}|${Math.round(run.matrix.b / n / SAME_DIRECTION)}`;
};

const framed = (run: PdfTextRun): Framed => {
  const n = Math.hypot(run.matrix.a, run.matrix.b);
  const ax = run.matrix.a / n;
  const ay = run.matrix.b / n;
  return {
    run,
    text: run.text,
    x: run.x * ax + run.y * ay,
    y: -run.x * ay + run.y * ax,
    width: run.width,
    fontSize: run.fontSize,
  };
};

/** One line of runs, in reading order, as a single copy of its first run. */
const merged = (line: readonly Framed[]): PdfTextRun => {
  const first = line[0]!;
  const last = line[line.length - 1]!;
  const text = line.map((f, i) => (i === 0 ? "" : separatorBefore(line, i)) + f.text).join("");
  return { ...first.run, text, width: Math.max(0, last.x + last.width - first.x), hasEOL: last.run.hasEOL };
};

const pushTo = <V>(map: Map<string, V[]>, key: string, value: V): void => {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
};

/** The runs that can be gathered, framed and bucketed by writing direction. */
const framedByDirection = (runs: readonly PdfTextRun[]): Map<string, Framed[]> => {
  const byDirection = new Map<string, Framed[]>();
  for (const run of runs) {
    const key =
      writingDirectionTurned(run.matrix) && (run as PositionedItem).links === undefined && run.text.trim() !== ""
        ? directionKey(run)
        : undefined;
    if (key !== undefined) pushTo(byDirection, key, framed(run));
  }
  return byDirection;
};

/**
 * `runs` with every line of several rotated runs replaced by one run. `onCopy(copy, source)` is told each copy and the run it stands for
 * (the first of the line), like the other enrichments of `pdf.ts#enrichRuns`. The same array when nothing is merged.
 */
export function gatherRotatedLines(
  runs: readonly PdfTextRun[],
  onCopy: (copy: PdfTextRun, source: PdfTextRun) => void,
): readonly PdfTextRun[] {
  const copyOf = new Map<PdfTextRun, PdfTextRun>();
  const swallowed = new Set<PdfTextRun>();
  const lines = [...framedByDirection(runs).values()].flatMap((items) =>
    groupByBaseline(items).filter((line) => line.length >= 2),
  );
  for (const line of lines) {
    const copy = merged(line);
    copyOf.set(line[0]!.run, copy);
    onCopy(copy, line[0]!.run);
    for (const f of line.slice(1)) swallowed.add(f.run);
  }
  if (copyOf.size === 0) return runs;
  return runs.filter((r) => !swallowed.has(r)).map((r) => copyOf.get(r) ?? r);
}
