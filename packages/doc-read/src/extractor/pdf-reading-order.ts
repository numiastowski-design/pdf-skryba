/** The reading order a TAGGED PDF declares for itself, and how a page's
 *  reading segments are put back in that order — or nothing at all when the
 *  page's structure tree does not account for all of its CONTENT text, what the
 *  document declares an `/Artifact` excepted.
 *  NOT here: the read of the tree (`extractor/pdf-source.ts`), where
 *  the geometric segments come from (`extractor/pdf-bands.ts`), nor any use of
 *  the tree's ROLES, which never cross the boundary — one exception, made
 *  `Note` content drawn below the rest of the page is ranked at the end
 *  (`declaredRanks`, through `extractor/pdf-source.ts#notesAfterText`).
 *  Called by: `extractor/pdf.ts`, `extractor/pdf-image-anchors.ts`. */

/**
 * pdf-reading-order — ON PREND LES BALISES POUR L'ORDRE, JAMAIS POUR LE TYPE
 * (décision de 23/09/2026).
 *
 * A tagged PDF carries a structure tree, and that tree states the order its
 * author meant the page to be read in. That order — and only that order —
 * becomes the model's order. Heading, table, column header, list, page
 * furniture: every one of those stays decided by our geometry.
 *
 * 🔴 **THE PROOF THAT THE TYPE MUST NOT BE TAKEN FROM THE TREE IS IN THE
 * REPO.** `fixtures/pdf/22-Tableau-Balise-En-Tetes-Faux.pdf` passes the
 * official PDF/UA validator (veraPDF, `PASS ua1`, counter-check in
 * `fixtures/pdf/22-…verapdf.md`) and its column headers are WRONG all the
 * same; our geometry reads them right. A valid tagging is not a truthful
 * tagging. `pdf-matterhorn.test.ts` keeps that fixture reading its headers
 * from the geometry.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE GUARDRAIL: ALL OF THE PAGE'S TEXT, OR NONE OF THE PAGE
 * ═══════════════════════════════════════════════════════════════════════════
 * A partial tree would leave fragments with no place in the order, and there
 * is no honest place to put them. So a page whose tree does not account for
 * EVERY text cycle carrying a character keeps its geometric order whole.
 *
 * ⚠️ **AN `/Artifact` COUNTS AS KNOWN, NOT AS MISSING — CORRECTED 23/09/2026.**
 * The first version asked for the impossible. A marked-content section tagged
 * `/Artifact` is BY DEFINITION outside the structure tree: ISO 32000-1
 * §14.8.1 excludes artifacts from the logical structure, so no conforming
 * producer will ever put one in the tree. Requiring the tree to name it means
 * requiring something the standard forbids.
 *
 * What that mistake cost, measured on the corpus the day before: of the 84
 * tagged pages, 31 passed and **53 fell — every one of them for `/Artifact`
 * text alone**, a page number ("2/9", "- 1 -", "1 | P a g e"), a running head
 * ("COVID-19 · International Aircraft and Crew"), or safedocs 0000713's cover
 * block. **Not one fell for ordinary prose the tree forgot.** Fixtures 24
 * (8 pages of 9) and 26 (15 of 15), the best-tagged documents of the corpus,
 * were dropped for a page number.
 *
 * So coverage is judged on CONTENT text: a cycle is accounted for when the
 * tree ranks it, when it carries no character, **or when the document itself
 * declares it an artifact** (`PdfTextRun.artifact`). Prose the tree really
 * forgets still costs the page its declared order — that half of the guardrail
 * is untouched, and `pdf-declared-order.fixtures.test.ts` holds both halves.
 *
 * **WHERE THE ARTIFACTS THEN GO IN THE ORDER.** Nowhere new: they have no rank,
 * so `segmentsInDeclaredOrder` leaves them with the group they geometrically
 * follow. A page number stays at the foot of the page, a running head at its
 * top. That is page furniture, not prose, and its place is its geometry.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHERE THE ORDER IS APPLIED, AND WHERE IT IS NOT
 * ═══════════════════════════════════════════════════════════════════════════
 * At the one place a page WITHOUT a rendered table decides its reading order:
 * the segments of `pdf-bands.ts#readingSegments`, through
 * `pdf-image-anchors.ts#readPageWithImages`. A page the table stage claims
 * keeps `renderPageTables`'s own region interleaving, which is NOT covered by
 * this lot — fixture 22 is such a page, and it does not move.
 */

import type { PositionedItem } from "./pdf-model";
import { notesAfterText, type PdfSourcePage } from "./pdf-source";

/**
 * The declared rank of each of a page's text cycles, by cycle index — or
 * `undefined` for the WHOLE page when there is no exploitable tree. Never a
 * guessed fallback: a page either has a declared order or has none.
 *
 * A cycle carrying no character (the document's own spacing) may be unranked
 * without costing the page its order: it says nothing about where to read. So
 * may a cycle the document declares an `/Artifact` — see the header: the
 * standard keeps artifacts OUT of the tree, so demanding one there demands the
 * impossible.
 */
export const declaredRanks = (page: PdfSourcePage): readonly (number | undefined)[] | undefined => {
  const tree = page.declaredOrder;
  if (tree === undefined || tree.length === 0) return undefined;
  const declared = page.noteIds === undefined ? tree : notesAfterText(tree, page.runs, page.noteIds);
  // FIRST OCCURRENCE WINS. A marked-content identifier named twice in one tree
  // is read at the first place it is named; taking the last would move the
  // text forward for no stated reason.
  const rankOfId = new Map<string, number>();
  declared.forEach((id, rank) => {
    if (!rankOfId.has(id)) rankOfId.set(id, rank);
  });
  const ranks = page.runs.map((run) => (run.markedContentId === undefined ? undefined : rankOfId.get(run.markedContentId)));
  const covered = page.runs.every((run, index) => run.text.trim().length === 0 || run.artifact || ranks[index] !== undefined);
  return covered ? ranks : undefined;
};

/** The lines of a page in order (segment by segment, line by line): which lines hold each rank, each line's index, and the first and last
 *  line that holds each rank. */
const indexLines = <T extends PositionedItem>(segments: readonly T[][][], rankOf: (item: T) => number | undefined) => {
  const owners = new Map<number, Set<T[]>>();
  const lineIndex = new Map<T[], number>();
  const firstLine = new Map<number, number>();
  const lastLine = new Map<number, number>();
  for (const line of segments.flat()) {
    const index = lineIndex.size;
    lineIndex.set(line, index);
    for (const item of line) {
      const rank = rankOf(item);
      if (rank === undefined) continue;
      const set = owners.get(rank) ?? new Set<T[]>();
      set.add(line);
      owners.set(rank, set);
      if (!firstLine.has(rank)) firstLine.set(rank, index);
      lastLine.set(rank, index);
    }
  }
  return { owners, lineIndex, firstLine, lastLine };
};

/**
 * A visual line the geometry built across two blocks the document declares one after the other (two columns of an author block, the
 * cells of a table the table stage did not rebuild: docs 287, 290 of the corpus, 22/10/2026) is cut where its declared order passes
 * through ANOTHER line: between two of its ranked pieces lies a rank no piece of this line holds. A line whose pieces follow each other
 * (a bold word, a link: ranks only its own between them) is returned as the same object. An unranked piece stays with the piece before
 * it on its line. Then each piece is read at its own rank, so the column or the cell comes out whole, one line after the other.
 * A line is also cut between ranked pieces a → b (a ≠ b) when b's block already appears on an EARLIER line or a's block still appears
 * on a LATER line: cells centred vertically in a grid not rebuilt, where a cell begun above (or going on below) is not read mid-line
 * (doc 151 p10, 23/10/2026). O(items log items).
 */
const splitCrossingLines = <T extends PositionedItem>(segments: readonly T[][][], rankOf: (item: T) => number | undefined): T[][][] => {
  const { owners, lineIndex, firstLine, lastLine } = indexLines(segments, rankOf);
  const ranks = [...owners.keys()].sort((a, b) => a - b);
  const position = new Map(ranks.map((rank, index) => [rank, index]));
  // Each line's own rank positions, sorted: whether a FOREIGN rank lies between two of its ranks is a count, by two binary searches (review of
  // d33a7c2f, 23/10/2026: scanning the interval was O(N²) on a hostile line of alternating ranks).
  const ownPositions = new Map<T[], number[]>();
  for (const [rank, lines] of owners)
    for (const line of lines) {
      const list = ownPositions.get(line) ?? [];
      list.push(position.get(rank)!);
      ownPositions.set(line, list);
    }
  for (const list of ownPositions.values()) list.sort((a, b) => a - b);
  const foreignBetween = (line: T[], a: number, b: number): boolean => {
    const [low, high] = a < b ? [position.get(a)!, position.get(b)!] : [position.get(b)!, position.get(a)!];
    const own = ownPositions.get(line)!;
    return high - low - 1 > lowerBound(own, high) - lowerBound(own, low) - 1;
  };
  /** Does the line `here` break between a piece ranked `last` and the next one ranked `rank`? */
  const cutsBetween = (line: T[], here: number, last: number, rank: number): boolean =>
    foreignBetween(line, last, rank) || (last !== rank && (firstLine.get(rank)! < here || lastLine.get(last)! > here));
  const piecesOf = (line: T[]): T[][] => {
    const pieces: T[][] = [];
    let current: T[] = [];
    let last: number | undefined;
    const here = lineIndex.get(line)!;
    for (const item of line) {
      const rank = rankOf(item);
      if (rank !== undefined && last !== undefined && cutsBetween(line, here, last, rank)) {
        pieces.push(current);
        current = [];
      }
      current.push(item);
      if (rank !== undefined) last = rank;
    }
    if (current.length > 0) pieces.push(current);
    return pieces.length <= 1 ? [line] : pieces;
  };
  return segments.map((segment) => segment.flatMap(piecesOf));
};

/** The index of the first element of `sorted` not below `value`. */
const lowerBound = (sorted: readonly number[], value: number): number => {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

/** One line group of the page, with the place it came from. `ranked` is false when it inherited the rank of the group before it. */
interface RankedGroup<T extends PositionedItem> {
  group: T[];
  /** Index of the INPUT segment (the geometric one), not of the output. */
  segment: number;
  index: number;
  rank: number;
  ranked: boolean;
}

/** The horizontal extent and the baseline of a line's NON-blank items (a blank may be spread across a gutter), or `undefined`. */
const inkOf = <T extends PositionedItem>(group: readonly T[]): { left: number; right: number; y: number } | undefined => {
  // By LOOP, never a spread: one argument per item of the group, and a hostile page may draw ~100k on one line (tour 10).
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let y = Number.NEGATIVE_INFINITY;
  let seen = false;
  for (const item of group) {
    if (item.text.trim().length === 0) continue;
    seen = true;
    if (item.x < left) left = item.x;
    if (item.x + item.width > right) right = item.x + item.width;
    if (item.y > y) y = item.y;
  }
  return seen ? { left, right, y } : undefined;
};

/** Start value to calibrate (`core/bounds.ts#TIE_OVERLAP_THRESHOLD_PT`): two lines share a column when their extents overlap by MORE than this. */
const TIE_OVERLAP_THRESHOLD_PT = 1;

/** The place `i` belongs to in a union-find forest (path halving). */
const rootOf = (parent: number[], i: number): number => {
  let node = i;
  while (parent[node] !== node) {
    parent[node] = parent[parent[node]!]!;
    node = parent[node]!;
  }
  return node;
};

/**
 * THE TIE-BREAK OF EQUAL DECLARED RANKS (lot F, 24/10/2026), a pass AFTER the sort, never inside the comparator. In each run of
 * entries of one rank, the RANKED lines (not those that inherited a rank) from different INPUT segments whose horizontal extents
 * overlap by more than 1 pt are joined into connected components; inside a component the lines take back their own places in the
 * order of their height, the highest first. Each ranked line moves AS A BLOCK with the unranked (or blank) entries that follow
 * it: a follower reads with its leader (revue 27/10/2026 — permuting the ranked slots alone stranded a follower between two
 * swapped leaders). Nothing else moves. A single-segment input (`tablePage`) has no pair of different segments, so it is
 * unchanged.
 */
const breakRankTies = <T extends PositionedItem>(ordered: RankedGroup<T>[]): RankedGroup<T>[] => {
  const out = [...ordered];
  let start = 0;
  while (start < out.length) {
    let end = start + 1;
    while (end < out.length && out[end]!.rank === out[start]!.rank) end++;
    if (end - start > 1) reorderTie(out, start, end);
    start = end;
  }
  return out;
};

/** Reorders `out[start..end)`, one run of equal rank, as `breakRankTies` says: BLOCKS of one ranked, inked leader plus its
 *  followers (unranked entries, or ranked ones with no ink) are the unit that moves; a leaderless prefix stays in place. */
/** One INKED, ranked leader and the entries that follow it in its own segment (unranked, or ranked without ink). */
interface TieBlock<T extends PositionedItem> {
  ink?: { left: number; right: number; y: number };
  segment: number;
  entries: RankedGroup<T>[];
}

/** The run cut into blocks: a follower reads with its leader only INSIDE one segment — a group that merely inherited the rank
 *  across a segment boundary is not the leader's text and must not travel with it (revue 27/10/2026, tours 6 and 7). */
const tieBlocksOf = <T extends PositionedItem>(entries: readonly RankedGroup<T>[]): TieBlock<T>[] => {
  const blocks: TieBlock<T>[] = [];
  for (const entry of entries) {
    const ink = entry.ranked ? inkOf(entry.group) : undefined;
    const last = blocks[blocks.length - 1];
    if (ink !== undefined) blocks.push({ ink, segment: entry.segment, entries: [entry] });
    else if (last !== undefined && last.ink !== undefined && last.segment === entry.segment) last.entries.push(entry);
    else blocks.push({ segment: entry.segment, entries: [entry] });
  }
  return blocks;
};

/** The connected components of the inked blocks: two blocks of DIFFERENT input segments whose extents overlap join one. */
const tieComponents = <T extends PositionedItem>(blocks: readonly TieBlock<T>[]): { block: TieBlock<T>; ink: { left: number; right: number; y: number }; place: number }[][] => {
  const members = blocks.flatMap((block, place) => (block.ink === undefined ? [] : [{ block, ink: block.ink, place }]));
  const parent = members.map((_, i) => i);
  for (let i = 0; i < members.length; i++)
    for (let j = i + 1; j < members.length; j++) {
      const a = members[i]!;
      const b = members[j]!;
      const overlap = Math.min(a.ink.right, b.ink.right) - Math.max(a.ink.left, b.ink.left);
      if (a.block.segment !== b.block.segment && overlap > TIE_OVERLAP_THRESHOLD_PT) parent[rootOf(parent, j)] = rootOf(parent, i);
    }
  const byRoot = new Map<number, typeof members>();
  members.forEach((member, i) => {
    const root = rootOf(parent, i);
    byRoot.set(root, [...(byRoot.get(root) ?? []), member]);
  });
  return [...byRoot.values()];
};

const reorderTie = <T extends PositionedItem>(out: RankedGroup<T>[], start: number, end: number): void => {
  const blocks = tieBlocksOf(out.slice(start, end));
  const ordered = [...blocks];
  for (const component of tieComponents(blocks)) {
    if (component.length < 2) continue;
    const places = component.map((m) => m.place);
    const byHeight = [...component].sort((a, b) => b.ink.y - a.ink.y || a.place - b.place);
    byHeight.forEach((member, i) => {
      ordered[places[i]!] = member.block;
    });
  }
  ordered.flatMap((block) => block.entries).forEach((entry, i) => {
    out[start + i] = entry;
  });
};

/**
 * The page's reading segments put back in the order the document declares.
 *
 * ⚠️ **IT IS THE IDENTITY WHEN THE TWO ORDERS AGREE**, and that is the
 * property that keeps this lot from moving text it has no reason to move: a
 * segment is cut only where the declared order LEAVES the geometric one. Two
 * visual lines that the geometry reads one after the other, and that the tree
 * also declares one after the other, stay in the same segment — so paragraph
 * rebuilding, which reads a segment top to bottom, sees exactly what it saw
 * before (`pdf-reading-order.test.ts`).
 *
 * A group of lines with no ranked cycle at all — pure spacing — follows the
 * group before it rather than being sorted on a rank it does not have.
 *
 * Groups of the SAME rank keep their geometric order, except for the tie-break below (`breakRankTies`). Tried and dropped
 * (23/10/2026): breaking that tie by the file's order of the runs puts back the ragged lines of one block that the geometry spread
 * over two segments (doc 200 p82, a right-aligned quote beside a table), but on whole pages it also cost headings and glued entries
 * of a cell (safedocs 0000713, fixture 39): 2 087 pages changed, 10 went back. Tried and dropped (24/10/2026): breaking it by height
 * alone, whatever the columns (6 pages went back: 165 p5 and p7, 177 p1, 271 p2, p4 and p10), and a rule written inside the sort
 * comparator (mixed with the input index it formed a cycle). RETAINED (24/10/2026): a separate pass after the sort, which moves only
 * ranked lines of different input segments whose horizontal extents overlap, and only among themselves (014 p93).
 */
export const segmentsInDeclaredOrder = <T extends PositionedItem>(
  allSegments: readonly T[][][],
  rankOf: (item: T) => number | undefined,
): T[][][] => {
  const segments = splitCrossingLines(allSegments, rankOf);
  const flat: RankedGroup<T>[] = [];
  let previousRank = -1;
  segments.forEach((segment, segmentIndex) =>
    segment.forEach((group) => {
      // Infinity = "no rank yet": never leaks, the check below replaces it with the previous group's rank before use.
      let rank = Infinity;
      for (const item of group) rank = Math.min(rank, rankOf(item) ?? Infinity);
      const ranked = rank !== Infinity;
      if (!ranked) rank = previousRank;
      previousRank = rank;
      flat.push({ group, segment: segmentIndex, index: flat.length, rank, ranked });
    }),
  );

  const ordered = breakRankTies([...flat].sort((a, b) => a.rank - b.rank || a.index - b.index));
  const out: T[][][] = [];
  let current: T[][] = [];
  let previous: (typeof flat)[number] | undefined;
  for (const entry of ordered) {
    // A segment continues only while the declared order walks the geometric
    // one FORWARD, one group at a time, inside one geometric segment.
    const continues = previous !== undefined && entry.index === previous.index + 1 && entry.segment === previous.segment;
    if (!continues && current.length > 0) {
      out.push(current);
      current = [];
    }
    current.push(entry.group);
    previous = entry;
  }
  if (current.length > 0) out.push(current);
  return out;
};
