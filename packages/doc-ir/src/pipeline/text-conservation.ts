/** Whether the storage XHTML about to be published still carries every letter of the PDF's own text: a typed verdict — ok, lost, glued or abstain — with its rule, its margin and the pages concerned, from two readings that must agree.
 *  NOT here: what the publish path keeps of a verdict (`pipeline/publish-conservation.ts`), the repairs of glued words, lost passages and cut paragraphs (`pipeline/glued-word-repair.ts`, `pipeline/lost-text-repair.ts`, `pipeline/cut-paragraph-repair.ts`), the furniture decision (`extractor/pdf-document-scale.ts`), nor the comparison for a format that declares its text (`pipeline/declared-format-conservation.ts`) — only a PDF has no declared text to trust, so only its verdict is computed here.
 *  Also hosts the page reading shared with the declared formats (`TAG`, `INLINE_TAGS`, `dropScaffolding`, `readPage`, `decodePageEntities`).
 *  Called by: `pipeline/publish-conservation.ts`, `pipeline/glued-word-repair.ts`, `pipeline/lost-text-repair.ts` and `pipeline/cut-paragraph-repair.ts` for where a page word sits in the XHTML, `pipeline/adf-conservation.ts` for the page letters, and `pipeline/declared-format-conservation.ts` for the shared page reading. */

/**
 * WHY TWO READINGS (design validated by 21/09/2026).
 *
 * The WORD reading tiles the source words against the page words, order
 * ignored, then explains what is left by re-spacing: a page token that is
 * exactly 2+ consecutive source words (glued), a source word that is exactly
 * 2+ consecutive page words (split). The LETTER reading does not look at word
 * boundaries at all: a leftover source word is covered when the page's
 * leftover letters, document-wide, still hold all of its letters. A word is
 * LOST only when neither reading finds it. A word the word reading explains
 * but the letters can no longer cover — an earlier leftover already took them
 * — means the two readings tell different stories: we abstain.
 *
 * NO THRESHOLD: a real render loses exactly 0 letters (fixture 24 in
 * `text-conservation.fixtures.test.ts`), so the margin is simply the number of
 * letters beyond 0.
 *
 * ⚠️ CLIENT TEXT. `respacings` and `lostPassages` carry the document's own
 * words, because a repair needs them. They live in memory only: never stored
 * in an entity. What may travel into a RECORD is the counts and the page
 * numbers. The ONE exception (lot C addendum, 29/09/2026): `lostWords`
 * below, which `pipeline/publish-conservation.ts` hands on to the
 * DEVELOPMENT-only log line of `adapters/conservation-log.ts` — never
 * production, never a page, never an entity.
 */

/** What this check needs from a text run — a subset of `PdfTextRun`. */

export interface ConservationRun {
  text: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  hasEOL: boolean;
}

type ConservationDecision = "ok" | "lost" | "glued" | "abstain";

/** Every rule a verdict can name — a closed list, so the output vocabulary stays enumerable. */
export type ConservationRule =
  "all-words-found" | "respaced-words" | "letters-cover-unmatched-words" | "letters-missing" | "readings-disagree";

/** Where a page word sits: the index of its text block in the page (macros
 *  not counted), and its index among that block's words. */
export interface PageWordAt {
  block: number;
  word: number;
}

/**
 * One re-spacing the word reading proved: in memory only (see the module
 * note). `glued`: one page word (`pageWords` has one entry) spells the
 * `sourceWords` run. `split`: the `pageWords` run spells one source word.
 */
export interface Respacing {
  kind: "glued" | "split";
  /** 1-based PDF page of the first source word. */
  page: number;
  pageWords: PageWordAt[];
  /** The source words as read, boundaries included — what a repair re-inserts. */
  sourceWords: string[];
}

/**
 * The source word right beside a lost passage, as a repair needs it: where
 * its matched page word sits, the edge of the document when there is no
 * source word on that side, or `unanchored` when that word was found some
 * other way (an image's alt text, a list number, a deliberate removal, a
 * re-spacing, the letter reading) — it has no single place in the page.
 */
type LostPassageAnchor = PageWordAt | "document-edge" | "unanchored";

/** A run of consecutive lost source words, in memory only (see the module note). */
export interface LostPassage {
  /** 1-based PDF page of the first word. */
  page: number;
  /** The tokens as read — what a repair re-inserts: the lost words and the
   *  letterless tokens between them. Those around the passage belong to no
   *  one for sure and are left out. */
  sourceWords: string[];
  before: LostPassageAnchor;
  after: LostPassageAnchor;
}

/** The source word a page word was tiled to, one to one: its index in the
 *  PDF's reading order (every checked page, furniture left out), and the font
 *  size its first and last characters were set in. No text: it travels
 *  nowhere, but it names no word either. */
export interface SourceWordLink {
  index: number;
  firstSize: number;
  lastSize: number;
}

export interface ConservationVerdict {
  decision: ConservationDecision;
  rule: ConservationRule;
  /** Letters beyond zero: `lostLetters` for a loss, 0 otherwise. */
  margin: number;
  /** Letters and digits of the source words neither reading found. */
  lostLetters: number;
  /** Re-spacings proved by the word reading, plus leftover words the letters
   *  covered. Line-end hyphenation, letter-spaced titles and ideographic text
   *  rejoined are correct joins and are not counted. */
  gluedWords: number;
  /** 1-based pages of the words the decision is about, ascending. */
  pages: number[];
  /** Page words no source word matched and no re-spacing explains — words
   *  the page has and the PDF never had. A repair may not add any. */
  unmatchedPageWords: number;
  respacings: Respacing[];
  /** Letters and digits of every checked source word: a repaired page may not carry more. */
  sourceLetters: number;
  lostPassages: LostPassage[];
  /** Per page block, per word (the indices of `PageWordAt`): the source word
   *  the word reading tiled it to, or `null` — an extra, a re-spacing, a word
   *  the PDF lacks. Two page words whose links follow each other are two
   *  words the PDF reads in a row. */
  sourceOfPageWords: (SourceWordLink | null)[][];
}

/** The lost source words themselves, normalised like every other word this
 *  check compares (`conservationKey`) — for the dashboard's cause groups and
 *  the DEVELOPMENT-only log line only (lot C addendum,
 *  `pipeline/publish-conservation.ts`, `adapters/conservation-log.ts`): in
 *  memory, built from `lostPassages`, never stored in an entity and never on
 *  a page (module note above still holds — this reads the SAME in-memory
 *  verdict a repair already reads). */
export const lostWords = (verdict: Pick<ConservationVerdict, "lostPassages">): string[] =>
  verdict.lostPassages
    .flatMap((p) => p.sourceWords)
    .map(conservationKey)
    .filter((w) => w.length > 0);

export interface ConservationOptions {
  /** 0-based pages whose runs are not document text we can check: scanned
   *  pages and pages under an invisible OCR layer. */
  excludedPages?: ReadonlySet<number>;
  /** Texts the render drops ON PURPOSE (a merged header painted several
   *  times, the repeated header row of a continued table). Their words absorb
   *  leftover source words, after body text and extras, each at most as many
   *  times as it is listed: `extractPdf` hands them on as
   *  `textSource.deliberateRemovals`. */
  deliberateRemovals?: readonly string[];
}

// ───────────────────────────── normalisation ─────────────────────────────

/** Letters and digits only, NFKC (ligatures), lower case. Dropping every other
 *  character is what gives apostrophes a single form: none. */
export const conservationKey = (token: string): string =>
  token
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");

/** The keys of the words of `text`, as every check here splits them: on white
 *  space, a word with no letter or digit dropped. */
export const wordKeysOf = (text: string): string[] =>
  text
    .split(/\s+/)
    .map(conservationKey)
    .filter((k) => k.length > 0);

const HYPHEN_END = /[-‐­]$/u;
const IDEOGRAPHIC = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

// ───────────────────────────── source side ─────────────────────────────

interface SourceWord {
  raw: string;
  key: string;
  /** 1-based. */
  page: number;
  /** The letterless tokens read between the previous word and this one
   *  (« : », « « »), which a lost passage carries back between its words. */
  gap: string[];
  /** The font size of the run the word's first character came from, and its last. */
  firstSize: number;
  lastSize: number;
}

/**
 * Runs in content-stream order → text, by geometry alone and independently of
 * the render: two runs are glued only when they share a baseline and the gap
 * between them is under 0.15 em. Same reading as `tools/render-lint.ts`,
 * rewritten here because `src/` never imports `tools/`. `owner[k]` is the run
 * character `k` of the text came from, -1 for a space this reading added.
 */
const joinRuns = (runs: readonly ConservationRun[]): { text: string; owner: number[] } => {
  let text = "";
  const owner: number[] = [];
  const separate = (): void => {
    text += " ";
    owner.push(-1);
  };
  runs.forEach((run, i) => {
    text += run.text;
    for (let k = 0; k < run.text.length; k++) owner.push(i);
    const next = runs[i + 1];
    if (next === undefined) return;
    if (run.hasEOL) {
      separate();
      return;
    }
    const em = Math.max(run.fontSize, 1);
    const sameLine = Math.abs(next.y - run.y) < 0.5 * em;
    const gap = next.x - (run.x + run.width);
    if (!(sameLine && gap < 0.15 * em && gap > -0.5 * em)) separate();
  });
  return { text, owner };
};

const sourceWords = <R extends ConservationRun>(
  pages: readonly (readonly R[])[],
  excluded: ReadonlySet<number>,
): SourceWord[] =>
  pages.flatMap((pageRuns, index) => {
    if (excluded.has(index)) return [];
    const runs = pageRuns;
    const { text, owner } = joinRuns(runs);
    const sizeAt = (k: number): number => runs[owner[k]!]?.fontSize ?? 0;
    const words: SourceWord[] = [];
    let gap: string[] = [];
    for (const m of text.matchAll(/\S+/g)) {
      const raw = m[0];
      const key = conservationKey(raw);
      if (key.length > 0) {
        words.push({
          raw,
          key,
          page: index + 1,
          gap,
          firstSize: sizeAt(m.index),
          lastSize: sizeAt(m.index + raw.length - 1),
        });
        gap = [];
      } else gap.push(raw);
    }
    return words;
  });

// ───────────────────────────── page side ─────────────────────────────

interface PageWord {
  key: string;
  at: PageWordAt;
}

export interface PublishedPage {
  readonly blocks: readonly string[];
  readonly extras?: readonly string[];
  /** What the caller can say about each published block WITHOUT the library knowing its markup, and which two of the
   *  three repairs need (09/11/2026). Index by index with `blocks`; absent means « I cannot say », and a repair that
   *  needs a fact it does not have abstains rather than guesses.
   *  `paragraph`: the block is a plain paragraph of prose — not a cell, not a list item, not a heading. Joining two
   *  blocks is only ever proposed for two of those.
   *  `joinableWithNext`: nothing of the page sits between this block and the next one, so joining them would move no
   *  other content. In Confluence's storage format that means two `<p>` elements side by side with only blank text
   *  between them; in another destination it means whatever that destination's « side by side » is. */
  readonly blockFacts?: readonly { readonly paragraph: boolean; readonly joinableWithNext: boolean }[];
  /**
   * THE PAGE'S UNITS, as the caller cuts them: what its destination treats as one block-level element — a paragraph, a
   * heading, a table. Two of the three repairs reason on units, not on blocks, because a unit may hold several blocks
   * (a line break inside a paragraph ends a block, not the paragraph).
   *
   * Three facts per unit, each one the caller's to state and none of them naming a format:
   * `blocks` — the `blocks` indices it holds, in order. Only blocks that carry a word, numbered as this check numbers
   *   them, so an empty cell shifts nothing.
   * `paragraphOrHeading` — the destination treats it as prose or a title. A lost passage may only be anchored at the
   *   edge of such a unit: put back inside a table or a list it would land in a cell nobody asked for.
   * `joinable` — it can be merged with the next unit WITHOUT LOSING ANYTHING IT CARRIES. A paragraph with its own
   *   styling is not joinable, because merging it would drop that styling silently.
   * `adjacentToNext` — nothing of the page sits between this unit and the next, so merging them, or putting a passage
   *   between them, moves no other content.
   *
   * Absent means « I cannot say »: a repair that needs a unit fact it does not have abstains rather than guesses.
   */
  readonly units?: readonly {
    readonly blocks: readonly number[];
    readonly paragraphOrHeading: boolean;
    readonly joinable: boolean;
    readonly adjacentToNext: boolean;
  }[];
}

/**
 * ONE REPAIR THE LIBRARY DECIDED, FOR THE CALLER TO APPLY TO ITS OWN PAGE (09/11/2026: « on le fait auj' »).
 *
 * The check proves what is wrong and WHERE, in the coordinates of the page it was given — a block index, and a
 * character index inside that block's text. It never writes the page: composing markup is the caller's job, because
 * only the caller knows its markup. So a repair comes back as a list of these, and the caller applies them (for
 * Confluence, `pipeline/confluence-page-edits.ts#applyPageEdits`), re-checks, and keeps or undoes the lot.
 *
 * `insert-space`: put one space inside block `block`, before the character at `atChar` — the re-split of a glued word.
 * `insert-block-after`: publish `text` as a NEW block of its own, right after block `block` (`-1` means before the
 *   first block) — a lost passage put back where the source says it belongs. The caller writes it in its own markup,
 *   escaping as its format requires.
 * `join-with-next`: make block `block` and the next one ONE block, separated by `separator` — two paragraphs the
 *   source proves were cut in mid-sentence.
 *
 * Every index is one in the `PublishedPage` as given: a caller that applies several edits applies them so that they do
 * not shift one another (back to front, as the Confluence applier does).
 */
export type PageEdit =
  | { readonly kind: "insert-space"; readonly block: number; readonly atChar: number }
  /** Publish `text` as a new UNIT of its own, right after unit `unit`; `-1` means before the first unit. */
  | { readonly kind: "insert-unit-after"; readonly unit: number; readonly text: string }
  /** Make unit `unit` and the next one ONE unit, their texts separated by one space. */
  | { readonly kind: "join-units"; readonly unit: number };

/** A published page's located words: the TEXT of each block, numbered exactly as `readPage` numbers the storage XHTML's
 *  (`PageWordAt` = block, then word inside it), so the two paths give the same verdict on the same content. */
export const pageWordsOfPublished = (page: PublishedPage): { body: PageWord[]; extras: string[] } => {
  const body: PageWord[] = [];
  let block = 0;
  for (const text of page.blocks) {
    const keys = wordKeysOf(text);
    if (keys.length === 0) continue;
    keys.forEach((key, word) => body.push({ key, at: { block, word } }));
    block += 1;
  }
  return { body, extras: [...(page.extras ?? [])] };
};

// ───────────────────────────── word reading ─────────────────────────────

/**
 * Greedy string tiling, order ignored: the longest shared run of words first,
 * then the next longest among what remains, down to one word. Every tile is
 * kept — order is not this check's question. Returns, per source word, the
 * page word it was matched to, or -1.
 */
const tile = (src: readonly string[], ren: readonly string[]): { srcTo: Int32Array; renUsed: Uint8Array } => {
  const where = new Map<string, number[]>();
  src.forEach((k, i) => {
    const list = where.get(k);
    if (list === undefined) where.set(k, [i]);
    else list.push(i);
  });
  const buckets: [number, number][][] = [];
  let top = 0;
  ren.forEach((k, j) => {
    for (const i of where.get(k) ?? []) {
      if (i > 0 && j > 0 && src[i - 1] === ren[j - 1]) continue; // not a maximal start
      let len = 1;
      while (i + len < src.length && j + len < ren.length && src[i + len] === ren[j + len]) len++;
      (buckets[len] ??= []).push([i, j]);
      top = Math.max(top, len);
    }
  });
  const srcTo = new Int32Array(src.length).fill(-1);
  const renUsed = new Uint8Array(ren.length);
  for (let len = top; len >= 1; len--) {
    const bucket = buckets[len];
    // Pieces re-queued while this bucket is read go to strictly shorter buckets.
    for (let q = 0; bucket !== undefined && q < bucket.length; q++) {
      const [i, j] = bucket[q]!;
      let free = true;
      for (let k = 0; k < len && free; k++) free = srcTo[i + k] === -1 && renUsed[j + k] === 0;
      if (free) {
        for (let k = 0; k < len; k++) {
          srcTo[i + k] = j + k;
          renUsed[j + k] = 1;
        }
        continue;
      }
      let start = -1;
      for (let k = 0; k <= len; k++) {
        const ok = k < len && srcTo[i + k] === -1 && renUsed[j + k] === 0;
        if (ok && start < 0) start = k;
        if (!ok && start >= 0) {
          (buckets[k - start] ??= []).push([i + start, j + start]);
          start = -1;
        }
      }
    }
  }
  return { srcTo, renUsed };
};

/** A multiset of keys that absorbs leftover source words, in source order.
 *  Known limit: it is unpositioned, so a dropped standalone number equal to a number the page draws for an ordered list is not seen by this guard. */
const absorb = (leftover: number[], words: readonly SourceWord[], texts: readonly string[]): number[] => {
  const bag = new Map<string, number>();
  for (const t of texts) for (const key of wordKeysOf(t)) bag.set(key, (bag.get(key) ?? 0) + 1);
  return leftover.filter((i) => {
    const n = bag.get(words[i]!.key) ?? 0;
    if (n === 0) return true;
    bag.set(words[i]!.key, n - 1);
    return false;
  });
};

/**
 * Runs of 2+ CONSECUTIVE leftover words of the `many` side that spell one
 * leftover word of the `one` side. Consecutive means adjacent in that side's
 * own sequence, both words leftover. Returns [manyRun, oneIndex] pairs.
 */
const spelledRuns = (
  manyLeft: readonly number[],
  manyKey: (i: number) => string,
  manyAdjacent: (a: number, b: number) => boolean,
  oneLeft: readonly number[],
  oneKey: (i: number) => string,
  taken: { many: Set<number>; one: Set<number> },
): [number[], number][] => {
  const byKey = new Map<string, number[]>();
  const prefixes = new Set<string>();
  for (const o of oneLeft) {
    if (taken.one.has(o)) continue;
    const k = oneKey(o);
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(o);
    for (let n = 1; n <= k.length; n++) prefixes.add(k.slice(0, n));
  }
  const found: [number[], number][] = [];
  for (let a = 0; a < manyLeft.length; a++) {
    if (taken.many.has(manyLeft[a]!)) continue;
    let acc = "";
    for (let b = a; b < manyLeft.length; b++) {
      const idx = manyLeft[b]!;
      if (taken.many.has(idx) || (b > a && !manyAdjacent(manyLeft[b - 1]!, idx))) break;
      acc += manyKey(idx);
      if (!prefixes.has(acc)) break;
      const candidates = b > a ? byKey.get(acc)?.filter((o) => !taken.one.has(o)) : undefined;
      if (candidates === undefined || candidates.length === 0) continue;
      const run = manyLeft.slice(a, b + 1);
      run.forEach((i) => taken.many.add(i));
      taken.one.add(candidates[0]!);
      found.push([run, candidates[0]!]);
      // eslint-disable-next-line sonarjs/updated-loop-counter -- the outer scan resumes after the run just claimed (a = b)
      a = b;
      break;
    }
  }
  return found;
};

// ───────────────────────────── the verdict ─────────────────────────────

/** How many times each character of `key` occurs. */
export const letterCounts = (key: string): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const c of key) counts.set(c, (counts.get(c) ?? 0) + 1);
  return counts;
};

/** Takes `key`'s letters from `pool` if all of them are there; leaves the pool untouched otherwise. */
const takeLetters = (key: string, pool: Map<string, number>): boolean => {
  const need = letterCounts(key);
  for (const [c, n] of need) if ((pool.get(c) ?? 0) < n) return false;
  for (const [c, n] of need) pool.set(c, pool.get(c)! - n);
  return true;
};

const pagesOf = (indices: Iterable<number>, words: readonly SourceWord[]): number[] =>
  [...new Set([...indices].map((i) => words[i]!.page))].sort((a, b) => a - b);

export function textConservation<R extends ConservationRun>(
  sourceRuns: readonly (readonly R[])[],
  /** The page: its TEXT block by block. No markup ever reaches this check (09/11/2026) — the caller converts its own
   *  render (`pipeline/confluence-page-reading.ts#confluencePageOf` for Confluence). */
  published: PublishedPage,
  options: ConservationOptions = {},
): ConservationVerdict {
  const src = sourceWords(sourceRuns, options.excludedPages ?? new Set());
  const { body, extras } = pageWordsOfPublished(published);

  // WORD READING — body text first, then extras, then deliberate removals.
  const { srcTo, renUsed } = tile(
    src.map((w) => w.key),
    body.map((w) => w.key),
  );
  let srcLeft: number[] = [];
  srcTo.forEach((j, i) => {
    if (j === -1) srcLeft.push(i);
  });
  srcLeft = absorb(srcLeft, src, extras);
  srcLeft = absorb(srcLeft, src, options.deliberateRemovals ?? []);
  const pageLeft: number[] = [];
  renUsed.forEach((used, j) => {
    if (used === 0) pageLeft.push(j);
  });

  const taken = { many: new Set<number>(), one: new Set<number>() };
  const glued = spelledRuns(
    srcLeft,
    (i) => src[i]!.key,
    (a, b) => b === a + 1,
    pageLeft,
    (j) => body[j]!.key,
    taken,
  );
  const takenSplit = { many: new Set<number>(), one: new Set<number>(taken.many) };
  const split = spelledRuns(
    pageLeft.filter((j) => !taken.one.has(j)),
    (j) => body[j]!.key,
    (a, b) => b === a + 1 && body[a]!.at.block === body[b]!.at.block,
    srcLeft,
    (i) => src[i]!.key,
    takenSplit,
  );

  const respacings: Respacing[] = [];
  const explained = new Set<number>();
  let gluedWords = 0;
  for (const [run, j] of glued) {
    run.forEach((i) => explained.add(i));
    const raws = run.map((i) => src[i]!.raw);
    const correctJoin =
      raws.slice(0, -1).every((r) => HYPHEN_END.test(r)) ||
      run.every((i) => src[i]!.key.length <= 1) ||
      IDEOGRAPHIC.test(raws.join(""));
    if (correctJoin) continue;
    gluedWords += 1;
    respacings.push({ kind: "glued", page: src[run[0]!]!.page, pageWords: [body[j]!.at], sourceWords: raws });
  }
  for (const [run, i] of split) {
    explained.add(i);
    gluedWords += 1;
    respacings.push({
      kind: "split",
      page: src[i]!.page,
      pageWords: run.map((j) => body[j]!.at),
      sourceWords: [src[i]!.raw],
    });
  }

  // LETTER READING — every leftover source word, in source order, against the
  // page's leftover letters, document-wide.
  const pool = letterCounts(pageLeft.map((j) => body[j]!.key).join(""));
  const lost: number[] = [];
  const disagree: number[] = [];
  const covered: number[] = [];
  for (const i of srcLeft) {
    const inLetters = takeLetters(src[i]!.key, pool);
    if (explained.has(i)) {
      if (!inLetters) disagree.push(i);
    } else if (inLetters) covered.push(i);
    else lost.push(i);
  }
  gluedWords += covered.length;
  const lostLetters = lost.reduce((n, i) => n + src[i]!.key.length, 0);

  // Lost words come in source order: each run of consecutive ones is a passage.
  const anchor = (i: number): LostPassageAnchor => {
    if (i < 0 || i >= src.length) return "document-edge";
    const j = srcTo[i]!;
    return j === -1 ? "unanchored" : body[j]!.at;
  };
  const lostPassages: LostPassage[] = [];
  for (let k = 0; k < lost.length;) {
    let end = k;
    while (end + 1 < lost.length && lost[end + 1] === lost[end]! + 1) end++;
    const run = lost.slice(k, end + 1);
    lostPassages.push({
      page: src[run[0]!]!.page,
      sourceWords: run.flatMap((i, k) => (k === 0 ? [src[i]!.raw] : [...src[i]!.gap, src[i]!.raw])),
      before: anchor(run[0]! - 1),
      after: anchor(run[run.length - 1]! + 1),
    });
    k = end + 1;
  }

  const unmatchedPageWords = pageLeft.filter((j) => !taken.one.has(j) && !takenSplit.many.has(j)).length;

  const sourceOfPageWords: (SourceWordLink | null)[][] = [];
  for (const { at } of body) (sourceOfPageWords[at.block] ??= []).push(null);
  srcTo.forEach((j, i) => {
    if (j === -1) return;
    const { at } = body[j]!;
    sourceOfPageWords[at.block]![at.word] = { index: i, firstSize: src[i]!.firstSize, lastSize: src[i]!.lastSize };
  });

  const verdict = (decision: ConservationDecision, rule: ConservationRule, pages: number[]): ConservationVerdict => ({
    decision,
    rule,
    margin: decision === "lost" ? lostLetters : 0,
    lostLetters,
    gluedWords,
    pages,
    unmatchedPageWords,
    respacings,
    sourceLetters: src.reduce((n, w) => n + w.key.length, 0),
    lostPassages,
    sourceOfPageWords,
  });
  if (disagree.length > 0) return verdict("abstain", "readings-disagree", pagesOf(disagree, src));
  if (lost.length > 0) return verdict("lost", "letters-missing", pagesOf(lost, src));
  const gluedPages = [...new Set([...pagesOf(covered, src), ...respacings.map((r) => r.page)])].sort((a, b) => a - b);
  if (covered.length > 0) return verdict("glued", "letters-cover-unmatched-words", gluedPages);
  if (gluedWords > 0) return verdict("glued", "respaced-words", gluedPages);
  return verdict("ok", "all-words-found", []);
}
