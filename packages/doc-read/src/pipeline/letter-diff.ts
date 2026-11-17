/** The ORDER half of the letters control: a bounded diff (Myers) of two letter sequences and the pairing of a deleted run with an inserted
 *  twin ("a passage moved").
 *  NOT here: where the two sequences come from, the letter counts, nor what a moved passage means for the decision
 *  (`pipeline/letter-conservation.ts`).
 *  Called by: `pipeline/letter-conservation.ts`. */

/** A maximal run of letters present on one side only: `start`..`end` (exclusive) in that side's sequence, in UTF-16 code units (the
 *  sequences are compared unit by unit, so a run indexes the string it was read from). */
export interface EditRun {
  start: number;
  end: number;
}

export interface Alignment {
  /** Runs of the reference with no counterpart on the page. */
  deletions: EditRun[];
  /** Runs of the page with no counterpart in the reference. */
  insertions: EditRun[];
}

/** Myers' O(ND) diff, stopped when the edit distance passes `maxEdits`, its short equal stretches (under `keepMin` letters) then folded into the edits around them (`foldShortEqualities`): `undefined` then (the caller names it "too different").
 *  Common prefix and suffix are cut first. Memory: one slice of the frontier per edit step, 2d + 1 values each (about 16 MB at 2 000).
 *  Deterministic: no clock, no randomness. */
export function align(a: Uint32Array, b: Uint32Array, maxEdits: number, keepMin: number): Alignment | undefined {
  return alignWithRaw(a, b, maxEdits, keepMin)?.alignment;
}

/** `align`, plus `rawOutOfOrderLetters`: the letters Myers itself both deleted somewhere AND inserted elsewhere (per letter, the smaller of
 *  its deleted and inserted counts, summed), taken BEFORE the fold of short equalities (the fold lengthens the edits with equal letters, which
 *  are not out of order: a swap of two 11-letter passages folds into 22 deleted letters, Myers deleted 11). A letter only deleted (lost) or only
 *  inserted (invented) is not counted. O(letters). */
export function alignWithRaw(
  a: Uint32Array,
  b: Uint32Array,
  maxEdits: number,
  keepMin: number,
): { alignment: Alignment; rawOutOfOrderLetters: number } | undefined {
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let hiA = a.length;
  let hiB = b.length;
  while (hiA > lo && hiB > lo && a[hiA - 1] === b[hiB - 1]) {
    hiA--;
    hiB--;
  }
  const n = hiA - lo;
  const m = hiB - lo;
  if (n === 0 && m === 0) return { alignment: { deletions: [], insertions: [] }, rawOutOfOrderLetters: 0 };
  const limit = Math.min(n + m, maxEdits);
  const trace = frontiers({ a, b, lo, n, m, limit });
  if (trace === undefined) return undefined;
  const { deleted, inserted } = backtrack(lo, trace, n, m);
  return {
    alignment: foldShortEqualities(segmentsOf(a.length, b.length, deleted, inserted), keepMin, a, b),
    rawOutOfOrderLetters: sharedLetters(a, b, deleted, inserted),
  };
}

/** Sum, over each letter, of the smaller of its count among the deleted positions of `a` and among the inserted positions of `b`. */
function sharedLetters(
  a: Uint32Array,
  b: Uint32Array,
  deleted: readonly number[],
  inserted: readonly number[],
): number {
  const pending = new Map<number, number>();
  for (const i of deleted) pending.set(a[i]!, (pending.get(a[i]!) ?? 0) + 1);
  let shared = 0;
  for (const i of inserted) {
    const left = pending.get(b[i]!) ?? 0;
    if (left === 0) continue;
    pending.set(b[i]!, left - 1);
    // A letter outside the basic plane is two units: its second half adds no letter (counted in code points, like the rest of this file).
    if (b[i]! < 0xdc00 || b[i]! > 0xdfff) shared++;
  }
  return shared;
}

/** The furthest x reached on each diagonal k = x - y, for every edit count d up to the first that reaches the corner. `trace[d][k + d]`. */
function frontiers({
  a,
  b,
  lo,
  n,
  m,
  limit,
}: {
  a: Uint32Array;
  b: Uint32Array;
  lo: number;
  n: number;
  m: number;
  limit: number;
}): Int32Array[] | undefined {
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= limit; d++) {
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!);
      let x = down ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[lo + x] === b[lo + y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        trace.push(v.slice(offset - d, offset + d + 1));
        return trace;
      }
    }
    trace.push(v.slice(offset - d, offset + d + 1));
  }
  return undefined;
}

/** Walks the frontiers back from the corner, collecting the index of each single deletion (in `a`) and insertion (in `b`), ascending. */
function backtrack(lo: number, trace: Int32Array[], n: number, m: number): { deleted: number[]; inserted: number[] } {
  const deleted: number[] = [];
  const inserted: number[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d - 1]!;
    const at = (k: number): number => prev[k + d - 1]!;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    if (down) inserted.push(lo + prevY);
    else deleted.push(lo + prevX);
    x = prevX;
    y = prevY;
  }
  return { deleted: [...deleted].reverse(), inserted: [...inserted].reverse() };
}

/** A stretch of the two sequences: kept as is (`equal`), or edited (`a0..a1` deleted, `b0..b1` inserted in its place). Both ranges are
 *  end-exclusive; the segments tile both sequences in order. */
interface Segment {
  equal: boolean;
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

/** The two sequences cut into equal stretches and edit groups, from the single-letter edits Myers found. */
function segmentsOf(
  aLength: number,
  bLength: number,
  deleted: readonly number[],
  inserted: readonly number[],
): Segment[] {
  const segments: Segment[] = [];
  let i = 0;
  let j = 0;
  let d = 0;
  let k = 0;
  const push = (equal: boolean, a1: number, b1: number): void => {
    const last = segments[segments.length - 1];
    if (last?.equal === equal) {
      last.a1 = a1;
      last.b1 = b1;
    } else segments.push({ equal, a0: i, a1, b0: j, b1 });
  };
  while (i < aLength || j < bLength) {
    if (deleted[d] === i) {
      push(false, i + 1, j);
      i++;
      d++;
    } else if (inserted[k] === j) {
      push(false, i, j + 1);
      j++;
      k++;
    } else {
      push(true, i + 1, j + 1);
      i++;
      j++;
    }
  }
  return segments;
}

/** Myers pairs the letters two unrelated passages happen to share, which chops a moved passage into stretches too short to recognise.
 *  After the cleanup of diff-match-patch (`diff_cleanupSemantic`): an equal stretch SHORTER THAN `keepMin` (too short to be a passage kept
 *  in place) and no longer than the edit groups on BOTH its sides is folded into them (deleted and inserted whole). One pass, each stretch
 *  judged against the groups Myers made: judged against the groups already grown by folding, the folds cascade over a long equal stretch
 *  and the whole page becomes one deletion and one insertion, which no longer pairs (tried, 20/10/2026: two swapped 180-letter paragraphs
 *  gave movedLetters 0). Without the `keepMin` limit, an equal stretch of exactly the size of its neighbours is folded away, and a real
 *  swap of two 12-letter passages loses the one that stayed. The leading and trailing equal stretches have an edit on one side only and
 *  stay. Deterministic. Returns the deletions and insertions as runs. */
function foldShortEqualities(segments: readonly Segment[], keepMin: number, a: Uint32Array, b: Uint32Array): Alignment {
  // Measured in LETTERS (code points), like `movedPassages`: a letter outside the basic plane is two UTF-16 units of the sequences.
  const size = (seg: Segment): number => Math.max(lettersIn(a, seg.a0, seg.a1), lettersIn(b, seg.b0, seg.b1));
  const list: Segment[] = [];
  segments.forEach((seg, at) => {
    const before = segments[at - 1];
    const after = segments[at + 1];
    const length = lettersIn(a, seg.a0, seg.a1);
    const folds =
      seg.equal &&
      before !== undefined &&
      after !== undefined &&
      length < keepMin &&
      length <= size(before) &&
      length <= size(after);
    const last = list[list.length - 1];
    if ((folds || !seg.equal) && last !== undefined && !last.equal) {
      last.a1 = seg.a1;
      last.b1 = seg.b1;
    } else list.push({ ...seg, equal: seg.equal && !folds });
  });
  const deletions: EditRun[] = [];
  const insertions: EditRun[] = [];
  for (const seg of list) {
    if (seg.equal) continue;
    if (seg.a1 > seg.a0) deletions.push({ start: seg.a0, end: seg.a1 });
    if (seg.b1 > seg.b0) insertions.push({ start: seg.b0, end: seg.b1 });
  }
  return { deletions, insertions };
}

/** The letters (code points) of `units[from..to)`: every unit but the second half of a surrogate pair. */
function lettersIn(units: Uint32Array, from: number, to: number): number {
  let letters = 0;
  for (let i = from; i < to; i++) if (units[i]! < 0xdc00 || units[i]! > 0xdfff) letters++;
  return letters;
}

/** The smallest passage `movedPassages` pairs: at least one letter, a whole number. A minimum of 0 would pick empty stretches forever; a
 *  minimum that is not a finite number (NaN, Infinity) is read as 1 too. */
export const effectiveMinLetters = (minLetters: number): number =>
  Number.isFinite(minLetters) && minLetters >= 1 ? Math.floor(minLetters) : 1;

export interface MovedPassages {
  passages: number;
  letters: number;
}

/** A run as letters (code points), with the ones already given to a pair. */
interface Candidate {
  letters: string[];
  taken: Uint8Array;
}

/** The longest common segment of two runs, over the letters nobody took yet: the first one found in the scan order when several tie. */
interface CommonSegment {
  length: number;
  inDeleted: number;
  inInserted: number;
}

function longestCommon(del: Candidate, ins: Candidate): CommonSegment {
  let best: CommonSegment = { length: 0, inDeleted: 0, inInserted: 0 };
  let previous = new Uint32Array(ins.letters.length + 1);
  let current = new Uint32Array(ins.letters.length + 1);
  for (let i = 1; i <= del.letters.length; i++) {
    for (let j = 1; j <= ins.letters.length; j++) {
      const same = del.letters[i - 1] === ins.letters[j - 1] && del.taken[i - 1] === 0 && ins.taken[j - 1] === 0;
      current[j] = same ? previous[j - 1]! + 1 : 0;
      if (current[j]! > best.length)
        best = { length: current[j]!, inDeleted: i - current[j]!, inInserted: j - current[j]! };
    }
    [previous, current] = [current, previous];
  }
  return best;
}

const candidatesOf = (runs: readonly EditRun[], text: string, minLetters: number): Candidate[] =>
  runs
    .map((r) => Array.from(text.slice(r.start, r.end)))
    .filter((letters) => letters.length >= minLetters)
    .map((letters) => ({ letters, taken: new Uint8Array(letters.length) }));

/** A passage moved is a stretch of at least `minLetters` letters common to a deleted run and an inserted run of the page. The longest such
 *  stretch is paired first and its letters are taken on both sides; the search repeats while one of `minLetters` remains. Myers shifts a
 *  match by a letter when the last letter of one passage is the first of the next, so a run is never required to lie whole in the other.
 *  The letters of the runs have already been counted as lost / extra by the multiset (`letter-conservation.ts`): this only names them.
 *  Cost: every pair of runs costs deleted x inserted steps, so a sweep costs the product of the deletion and insertion lengths (folded stretches
 *  lengthen the runs, so no fixed figure is claimed); after a pairing only the row and the column of its two runs are searched
 *  again. `deleted` and `inserted` are the two sequences as strings, the ones the runs index. */
export function movedPassages(
  alignment: Alignment,
  deleted: string,
  inserted: string,
  requestedMin: number,
): MovedPassages {
  const minLetters = effectiveMinLetters(requestedMin);
  const dels = candidatesOf(alignment.deletions, deleted, minLetters);
  const inss = candidatesOf(alignment.insertions, inserted, minLetters);
  const best = dels.map((d) => inss.map((i) => longestCommon(d, i)));
  let passages = 0;
  let letters = 0;
  for (;;) {
    let pick: { d: number; i: number } | undefined;
    let longest = minLetters - 1;
    best.forEach((row, d) =>
      row.forEach((segment, i) => {
        if (segment.length > longest) {
          longest = segment.length;
          pick = { d, i };
        }
      }),
    );
    if (pick === undefined) return { passages, letters };
    const { d, i } = pick;
    const segment = best[d]![i]!;
    dels[d]!.taken.fill(1, segment.inDeleted, segment.inDeleted + segment.length);
    inss[i]!.taken.fill(1, segment.inInserted, segment.inInserted + segment.length);
    passages++;
    letters += segment.length;
    inss.forEach((other, j) => (best[d]![j] = longestCommon(dels[d]!, other)));
    dels.forEach((other, k) => (best[k]![i] = longestCommon(other, inss[i]!)));
  }
}
