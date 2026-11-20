/** The list markers a document gives itself, induced from the document.
 *  Decides: which short tokens, unknown to the fixed list of `list.ts#markerOf`, this document uses as bullets.
 *  Neither the levels nor what is published.
 *
 *  This module is kept on purpose, as the model of a pattern induction with its measure and its written guards.
 *  Limit: a list forms on contiguous candidates, so bullets separated by other blocks stay paragraphs even once
 *  their marker is induced.
 *
 *  What makes the rule safe is its precondition, not a threshold: a token is a marker only if the document uses it
 *  as one, the same token opening at least three lines, all at the same indent. That separates a typed "o" bullet,
 *  which holds its column, from the word "o", which opens sentences at any indent. The rule abstains by itself
 *  where the document is not consistent.
 *
 *  NOT here: the fixed list of markers (`layout/list.ts#markerOf`), the grouping of items into lists
 *  (`layout/list.ts#listRuns`), nor the decision to publish (`extractor/pdf-paragraphs.ts`). Nothing removes the
 *  marker from the text: a PDF keeps its marker visible.
 *  Called by: `extractor/pdf-paragraphs.ts`. */

/** A line as the induction reads it: its text, and the left edge of its block. */
export interface MarkerLine {
  text: string;
  left: number;
}

/** Below three lines, a repeated token is a coincidence. */
const MIN_LINES = 3;
/** The rendering noise on an indent. Starting value to calibrate: real runs of bullets hold within one point, false
 *  ones spread by 20 and more. */
const SAME_INDENT_PT = 1.5;
/** A marker is short: a word is not a marker. */
const MAX_MARKER_CHARS = 2;

/** The first token of a line, when a space then a letter follow it. The pattern does not bound its length on
 *  purpose: `MAX_MARKER_CHARS` alone decides it. */
const LEADING_TOKEN = /^(\S+)\s+\p{L}/u;
/** What the fixed list already recognises. Kept here rather than shared, on purpose: the rule holds only by what
 *  its caller guarantees. */
const ALREADY_KNOWN = /^(?:[-–—•·▪*]|[a-zA-Z0-9][.)]|[IVXivx]{1,4}[.)])$/u;

/** The token that opens a line, when it can be a marker: short, and not already recognised by the fixed list.
 *  Returned with the length of the marker and its space, what a caller needs to cut the text. Both readers of the
 *  pattern go through here: the one that induces the document's markers and the one that reads them back line by
 *  line. */
export const leadingMarkerToken = (text: string): { token: string; length: number } | undefined => {
  const found = LEADING_TOKEN.exec(text.trimStart());
  const token = found?.[1];
  if (found === null || token === undefined || token.length > MAX_MARKER_CHARS || ALREADY_KNOWN.test(token))
    return undefined;
  return { token, length: found[0].length - 1 };
};

/** The order `Array.prototype.sort` gives strings with no comparator (UTF-16 code units), written out; never `localeCompare`. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : Number(a > b));

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

/** The markers this document uses, sorted so that two readings of one document return the same array. */
export function inducedMarkers(lines: readonly MarkerLine[]): string[] {
  const lefts = new Map<string, number[]>();
  for (const line of lines) {
    const token = leadingMarkerToken(line.text)?.token;
    if (token === undefined) continue;
    const list = lefts.get(token) ?? [];
    list.push(line.left);
    lefts.set(token, list);
  }

  const kept: string[] = [];
  for (const [token, xs] of lefts) {
    if (xs.length < MIN_LINES) continue;
    const column = median(xs);
    if (xs.every((x) => Math.abs(x - column) <= SAME_INDENT_PT)) kept.push(token);
  }
  return kept.sort(byCodeUnit);
}
