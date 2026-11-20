/** The lists a PDF never declares, found in the markers and the hanging indent
 *  of its lines.
 *  NOT here: how a list becomes IR blocks, nor paragraph grouping — both in
 *  `extractor/pdf-paragraphs.ts`.
 *  Called by: `extractor/pdf-paragraphs.ts`, `extractor/pdf-line-breaks.ts`. */
import { maxOf } from "../lib/extent";
import { SAME_LINE_PT } from "./tolerances";

/**
 * list — the lists of a PDF, without a model.
 *
 * The rule: an item is a line indented against the body; a list is a run of at least two items, at least half of
 * which carry a readable marker.
 * A marker alone is not enough: a dash opening a sentence, a reference number or a date carry one. The indent alone
 * is not enough either: it finds far too many runs.
 * Chosen bias: the rule under-detects. A missed list loses no text; an invented list lies about the structure.
 * Not kept: the nesting level, drawn from successive quantised indents.
 *
 * 🔴 **BULLETS: A LIST ONLY IN THE SIMPLE CASE (14/10/2026).**
 *
 * History. On 23/09/2026 no bulleted list was published at all: a run of bullets
 * or dashes stayed paragraphs, **the marker kept in the text** (nothing removed,
 * nothing lost). Why: a bullet is what our documents read worst (a symbol-font
 * letter, a dash glued to its word, a vector disc, a wrapped line taken for an
 * item), and the list tag is what let us REMOVE the marker, so a misread marker
 * made a false list. That rule still holds for `listRuns` (indented runs of
 * dashes, mixed runs, anything outside the simple case).
 *
 * Revision. A run is published as a bulleted list again, but only through
 * `bulletRuns` (see there for the conditions). Measured on 51 French and English
 * PDFs: 84 lists, 318 items, 0 invented list. Numbered and lettered lists are
 * unchanged.
 */

/**
 * The markers. The bullet character is often absent from the text layer (drawn beside it), so the pattern never
 * decides alone: the indent carries the signal and the marker confirms.
 *
 * ⚠️ And when the character IS there, it can be a LIE — see the written limits
 * below: a symbol font writes its bullet as « x » or as a private codepoint,
 * and only the font would tell. We do not read the font.
 */
/** The bullet characters the list reader knows, once. */
const BULLET_CHARS = "•▪◦‣·●⁃";
/** A line opening on a bullet. Its behaviour, with the four other marker patterns below, is frozen as a matrix in
 *  `layout/list.markers.test.ts` — one line per example, one column per rule, so a drift shows as a cell. */
export const BULLET = new RegExp(`^\\s*[${BULLET_CHARS}]\\s*`, "u");
/**
 * THE BLANK AFTER THE DASH IS REQUIRED, AND THAT IS A DECISION (
 * 22/09/2026). Word 2007 glues its dash to its word — « -Ensures Safety of the
 * patient » — so fixture 28 page 2 publishes 7 items as 7 paragraphs.
 *
 * Accepting a glued dash was built and measured, then dropped. The two
 * populations, over the 39 French and English PDFs — 22 lines open on a dash
 * with NO blank after it, in 3 documents:
 *   · 7 REAL items, fixture 28 p2, where the dash IS the bullet (read on the
 *     page image);
 *   · 15 that are not, and the two conditions already hold every one of them
 *     out of any list on their own: 0000312 p1 « –positive advanced
 *     nonsquamous… » (two wrapped lines continuing « ALK–positive », not
 *     indented, 45.4 pt is the body's own margin), 27 p2 « -30- » (the end mark
 *     of a press release, not indented), and the timeline of 28 p3-p4
 *     (« -Jan 2014--CAAS approves… », 11 lines, never two indented in a row).
 * So the rule produced no false list at all — and it was still dropped. On
 * 28 p2 the text ALREADY comes out one item per line: the `<ul>` was a comfort,
 * and its only effect on the text was to REMOVE the leading dash from 7 items.
 * A character of the document less, for nothing findable more. Reopen it the
 * day a document really loses something here.
 */
export const DASH = /^\s*[-–—]\s+/u;
export const NUMBERED = /^\s*(\d{1,2})[.)]\s+/u;
export const LETTERED = /^\s*[a-zA-Z][.)]\s+/u;
export const ROMAN = /^\s*[IVXivx]{1,4}[.)]\s+/u;

/** The indent is quantised: two lines at 53.8 and 54.1 are at the same level. */
const INDENT_QUANTUM_PT = 3;
/** A lone item is not a list: it is an indented paragraph. */
const MIN_ITEMS = 2;

/*
 * WRITTEN LIMIT, NOT A DEFECT TO FIX (22/09/2026). The Jev re-read
 * (`docs/ESSAI-JEV-ETIQUETAGE.md` [purged 27/09/2026, git history], French and English documents) found 35
 * items published as plain paragraphs, in 8 documents, in three shapes: marked
 * items that are NOT indented (20), several items fused into one block (8), and
 * word markers such as « Pas 1 : » (7). No text is lost; it stays searchable.
 * Tried and set aside: a run of CONSECUTIVE numbers (n, n+1…) standing in for
 * the indent. Measured over 34 French/English PDFs: 7 runs, 17 items, no false
 * list — and roughly half of the 20 unindented items, since any block slipped
 * between two items breaks the run. Too much mechanism for that gain. Reopen
 * only if a real document loses something because of a missed list.
 *
 * THREE MORE FAMILIES OF BULLET, MEASURED ON 22/09/2026 AND LEFT ALONE
 * (the text already
 * comes out line by line in all three, so the drawn bullet is a comfort, and a
 * marker we do not read is a marker we cannot remove by mistake). The glued
 * dash is a fourth, written at `DASH` above.
 *
 * 1. **A BULLET PAINTED IN A SYMBOL FONT.** The same glyph comes out three
 *    different ways, because a symbol font's glyphs have no character
 *    identity and what pdf.js wrote for them (measured before its removal) was an accident of the font's
 *    cmap (a symbolic TrueType (3,0) cmap maps to 0xF000+code):
 *      SymbolMT 0xB7   → « • » U+2022,  68 runs, 6 documents — read today
 *      Wingdings 0xFC  → U+F0FC,        17 runs, safedocs 0000609 — a private
 *                        codepoint, published as a tofu box
 *      SymbolMT 0x78   → « x » U+0078,  24 runs, fixture 25 — a LETTER
 *    The character cannot be the test, so the FONT would have to be: measured
 *    over the 39 French and English PDFs, every run painted in a font named
 *    for a symbol family is 116 runs, 9 fonts, 8 documents, ALL of ONE
 *    character and ALL bullets — 0 run of prose, 0 run longer than one
 *    character. The discriminant is clean; its price is not. It needs the
 *    boundary to resolve the font name (`pdf-source.ts`), a new field on every
 *    text run, and a new field on every line. Built and measured that way, it
 *    gave ONE list — safedocs 0000609 p5, 6 items — whose 6 lines already come
 *    out one per line today. Reopen it only if a document loses text for it.
 *    Also tried: the private-use range U+E000–U+F8FF as the test, which
 *    PyMuPDF4LLM does with U+F0B7 and U+F0A7 hard-coded. No new reading, 17
 *    lines on the corpus, all bullets, 0 false — but it catches only the
 *    Wingdings shape, not the « x », and it publishes a `<ul>` in place of
 *    lines that are already right.
 *
 * 2. **A DISC DRAWN IN VECTOR, not written.** Fixture 26 (Canva) marks 37 lines
 *    with a filled circle of 3.7 to 3.8 pt; all 37 sit 8.2 to 8.4 pt to the
 *    left of their line, on its baseline band (dy 2.1 to 2.6 pt) — geometry
 *    clean enough to attach. What stops it is elsewhere and it is bigger: every
 *    page of that document publishes as ONE TABLE, and a table cell's blocks
 *    are built without `paragraphsFromLines` (`pdf-table-render.ts`), so no
 *    list is ever looked for inside a cell. The marker would change nothing.
 *    And the size is no discriminant on its own: fixture 25 draws a watch with
 *    484 small paths of 26 different sizes, 1.2 to 6.3 pt, 15 of which sit just
 *    left of a line.
 * 3. **A WRAPPED LINE TAKEN FOR AN ITEM.** Safedocs 0000602 p2 publishes
 *    « April 6, 2020 » as an item of its own: it is the end of the line above,
 *    indented like the items around it and carrying no marker, which the « half
 *    of them marked » rule lets in. Counted over every item the 39 French and
 *    English PDFs publish — 78 of them — it is the ONLY one. One case is not a
 *    family, and no text is lost.
 */

export const quantiseIndent = (x: number): number => Math.round(x / INDENT_QUANTUM_PT) * INDENT_QUANTUM_PT;

/**
 * `letter` is a letter or a Roman numeral: « a. », « iv) ». It counts as a
 * marker for the list rule, but it never leaves the text (22/09/2026).
 * The IR list has no marker type, so the only ordered rendering is `<ol>`
 * counting 1, 2, 3: stripping « a. » replaced every letter with a number, and
 * the letters were lost — 16 on safedocs 0000609 p7. A run of letters is
 * therefore a BULLET list whose items keep « a. » in their text: the simplest
 * form that loses nothing and still says "these are items". Set aside: no list
 * at all (the items would then read as loose paragraphs), and a marker type in
 * the IR (a change to every renderer for one document).
 */
type MarkerKind = "bullet" | "ordered" | "letter";

export interface Marker {
  kind: MarkerKind;
  /** What the marker occupies at the head of the text — removed from the
   *  rendering only when the list's own marker replaces it (see
   *  `pdf-paragraphs.ts#groupLists`). */
  length: number;
  /** The number read, on an ordered marker that carries one. */
  value?: number;
}

/**
 * The marker at the head of a line, if any. A marker is read, not interpreted: "ordered" is what a number says, not
 * an inference on intent.
 *
 * ⚠️ IT READS THE TEXT AND NOTHING ELSE. A marker the text cannot name is a
 * written limit here, not a parameter — see below.
 */
export function markerOf(text: string): Marker | undefined {
  const numbered = NUMBERED.exec(text);
  if (numbered !== null) return { kind: "ordered", length: numbered[0].length, value: Number(numbered[1]) };
  for (const [pattern, kind] of [
    [BULLET, "bullet"],
    [DASH, "bullet"],
    [ROMAN, "letter"],
    [LETTERED, "letter"],
  ] as const) {
    const m = pattern.exec(text);
    if (m !== null) return { kind, length: m[0].length };
  }
  return undefined;
}

export interface ListCandidate {
  /** Indented against the document's body: the necessary condition. */
  indented: boolean;
  marker: Marker | undefined;
  /** The block's left edge, its marker INCLUDED: the lowest left of its lines. */
  left?: number;
  /** Where a numbered block's text starts (`itemTextLeft`). Absent: no reading,
   *  or two readings that disagree. */
  textLeft?: number;
  /** Present on a paragraph block: where it sits on the page (`blockReading`). */
  geometry?: BlockGeometry;
  /** Present when the block opens on a real bullet character of its own (`blockReading`). */
  bullet?: BulletLead;
}

interface ListRun {
  /** Inclusive. */
  start: number;
  /** Inclusive. */
  end: number;
  ordered: boolean;
}

/**
 * The runs of items in a sequence of consecutive blocks.
 *
 * A block joins the current run when it is indented; the run closes at the first block that is not. It is kept only
 * with at least `MIN_ITEMS` blocks, at least half of them marked. `ordered` follows the majority of the markers read.
 *
 * Tried and set aside (22/09/2026): requiring the run's MARKED blocks to share
 * one quantised indent — signal 3 of the literature is « bullet partner
 * detection AT THE SAME LEVEL » and we only kept the partner. Written while the
 * symbol-font marker above was being measured, to hold back the one false list
 * it produced on fixture 25 (eight booklet pages imposed on one sheet, columns
 * not cut, markers then at 138, 144, 312 and 318 pt). With the markers we
 * actually read, the level changes NOTHING over the 39 French and English PDFs.
 * A guard that guards nothing is mechanism, so it is not here — reopen it with
 * the page that needs it.
 */
export function listRuns(candidates: readonly ListCandidate[]): ListRun[] {
  const runs: ListRun[] = [];
  let start: number | undefined;

  const close = (end: number): void => {
    if (start === undefined) return;
    const slice = candidates.slice(start, end + 1);
    const marked = slice.filter((c) => c.marker !== undefined);
    const ofKind = (kind: MarkerKind): number => marked.filter((c) => c.marker?.kind === kind).length;
    // A run of bullets or dashes is no list here (23/09/2026, see the header; the
    // simple bulleted case goes through `bulletRuns`). The majority decides, as for
    // `ordered`, and a tie falls on the side of ABSTENTION.
    const bulleted = ofKind("bullet") * 2 >= marked.length;
    if (slice.length >= MIN_ITEMS && marked.length * 2 >= slice.length && !bulleted) {
      const ordered = ofKind("ordered") * 2 > marked.length;
      runs.push({ start, end, ordered });
    }
    start = undefined;
  };

  for (const [index, candidate] of candidates.entries()) {
    if (candidate.indented) {
      start ??= index;
      continue;
    }
    close(index - 1);
  }
  close(candidates.length - 1);
  return runs;
}

/**
 * THE SIMPLE BULLETED RUN (14/10/2026). A run of consecutive paragraph
 * blocks is a bulleted list when ALL of these hold:
 *   - at least `MIN_ITEMS` items, each opening on a real bullet character
 *     (• ▪ ◦ ‣ ●) that is a run of its own: not a dash, not a symbol-font letter
 *     (« x »), not glued to its text (`blockReading`);
 *   - the markers are at one x, the item texts at one x right of the marker, and
 *     every wrapped line of an item is at the item-text x, never back at the
 *     marker x (each within `BULLET_RUN_MAX_DRIFT_PT`);
 *   - GUARD 1: no item carries a second bullet character (bullets laid out in two
 *     columns, fixture 33 p5: « ▪ Safe Operations ▪ Delivery of high-quality… »);
 *   - indentation is NOT required.
 * Anything else stays paragraphs, marker kept in the text.
 *
 * GUARD 2, THE TAIL: an unmarked block at exactly the item-text x directly under
 * the last item, no further below than the list's own line spacing, is that
 * item's continuation (docx-reel/10 p38: the last item is cut in two blocks) and
 * is returned as `tail`. The list's line spacing is the largest line pitch inside
 * its own wrapped items; with none to measure it from, the whole list is REJECTED
 * (bias: abstain). Beyond that spacing the block is a paragraph of its own and the
 * list stays.
 *
 * BULLET_RUN_MAX_DRIFT_PT = 1 pt, starting value to calibrate (the coordinate
 * noise of `SAME_LINE_PT`). Measured over 51 French and English PDFs: 84 runs
 * (318 items) kept, every marker, text and wrapped line within 1 pt; the 14 runs
 * rejected fail on wrapped lines that are not at the text x (12), on item texts
 * at 86.2 against 89.5 pt (1) and on a bullet glued to its text (1); two of them
 * also hold a bullet line inside an item.
 */
const BULLET_RUN_MAX_DRIFT_PT = SAME_LINE_PT;
/** How much farther than the list's own line pitch a tail may start, in points: the same noise. Starting value to calibrate. */
const BULLET_TAIL_MAX_GAP_SLACK_PT = 1;

const BULLET_LEAD_CHARS = new Set(["•", "▪", "◦", "‣", "●"]);
const ANY_BULLET_LEAD = /[•▪◦‣●]/u;

/** The pieces of a line `blockReading` needs: its text, left edge, baseline (decreasing down the page) and its first two items. */
export interface BlockLine {
  text: string;
  left: number;
  y: number;
  lead?: { text: string; nextLeft: number };
}

export interface BlockGeometry {
  firstLeft: number;
  /** Baseline of the first line, and of the last. */
  firstY: number;
  lastY: number;
  /** The largest distance between two consecutive lines of the block; absent for a one-line block. */
  pitch?: number;
}

export interface BulletLead {
  markerLeft: number;
  textLeft: number;
  /** The left edge of every line after the first. */
  continuationLefts: number[];
  /** Another bullet character after the first one, anywhere in the block. */
  secondBullet: boolean;
}

/** What the simple-bullet rule reads of a block's lines: where the block sits, and its bullet if it opens on a real one of its own. */
export function blockReading(lines: readonly BlockLine[]): { geometry?: BlockGeometry; bullet?: BulletLead } {
  const first = lines[0];
  if (first === undefined) return {};
  const last = lines[lines.length - 1]!;
  const pitches = lines.slice(1).map((line, k) => lines[k]!.y - line.y);
  const geometry: BlockGeometry = {
    firstLeft: first.left,
    firstY: first.y,
    lastY: last.y,
    ...(pitches.length > 0 ? { pitch: maxOf(pitches, (p) => p) } : {}),
  };
  const opener = first.lead?.text.trim();
  if (
    first.lead === undefined ||
    opener === undefined ||
    !BULLET_LEAD_CHARS.has(opener) ||
    !first.text.trimStart().startsWith(opener)
  )
    return { geometry };
  const afterOpener = lines
    .map((line) => line.text)
    .join(" ")
    .trimStart()
    .slice(opener.length);
  return {
    geometry,
    bullet: {
      markerLeft: first.left,
      textLeft: first.lead.nextLeft,
      continuationLefts: lines.slice(1).map((line) => line.left),
      secondBullet: ANY_BULLET_LEAD.test(afterOpener),
    },
  };
}

export interface BulletRun {
  /** First and last item, inclusive. */
  start: number;
  end: number;
  /** The index of the unmarked block that goes on with the last item, when there is one. */
  tail?: number;
}

const near = (a: number, b: number): boolean => Math.abs(a - b) <= BULLET_RUN_MAX_DRIFT_PT;

/** The simple bulleted runs among consecutive blocks — see the rule above. */
export function bulletRuns(candidates: readonly ListCandidate[]): BulletRun[] {
  const runs: BulletRun[] = [];
  let index = 0;
  while (index < candidates.length) {
    if (candidates[index]!.bullet === undefined) {
      index++;
      continue;
    }
    let end = index;
    while (candidates[end + 1]?.bullet !== undefined) end++;
    const run = checkBulletRun(candidates, index, end);
    if (run !== undefined) runs.push(run);
    index = end + 1;
  }
  return runs;
}

const checkBulletRun = (candidates: readonly ListCandidate[], start: number, end: number): BulletRun | undefined => {
  if (end - start + 1 < MIN_ITEMS) return undefined;
  const items = candidates.slice(start, end + 1).map((c) => c.bullet!);
  const { markerLeft, textLeft } = items[0]!;
  const simple =
    textLeft - markerLeft > BULLET_RUN_MAX_DRIFT_PT &&
    items.every(
      (item) =>
        near(item.markerLeft, markerLeft) &&
        near(item.textLeft, textLeft) &&
        !item.secondBullet &&
        item.continuationLefts.every((left) => near(left, textLeft)),
    );
  if (!simple) return undefined;

  const next = candidates[end + 1];
  if (
    next?.geometry === undefined ||
    next.marker !== undefined ||
    next.bullet !== undefined ||
    !near(next.geometry.firstLeft, textLeft)
  )
    return { start, end };
  const pitches = candidates.slice(start, end + 1).flatMap((c) => c.geometry?.pitch ?? []);
  // ITEMS WITHOUT A WRAPPED LINE STILL HAVE A LINE SPACING: the pitch between two consecutive one-line items
  // (five one-line questions followed by a block at the text's x must stay a list).
  const itemPitches = candidates.slice(start, end).flatMap((c, k) => {
    const below = candidates[start + k + 1]!.geometry;
    const own = c.geometry;
    return own === undefined || below === undefined ? [] : [own.lastY - below.firstY].filter((d) => d > 0);
  });
  const spacing =
    pitches.length > 0 ? maxOf(pitches, (p) => p) : itemPitches.length > 0 ? maxOf(itemPitches, (p) => p) : undefined;
  if (spacing === undefined) return undefined;
  const gap = candidates[end]!.geometry!.lastY - next.geometry.firstY;
  // The tail lies BELOW the last item: a block read after a jump up the page (another column) is never one (review of 14/10/2026).
  return gap > 0 && gap <= spacing + BULLET_TAIL_MAX_GAP_SLACK_PT ? { start, end, tail: end + 1 } : { start, end };
};

/**
 * HOW FAR A BLOCK MAY SIT FROM AN ITEM'S TEXT AND STILL BE ALIGNED ON IT.
 * Starting value to calibrate: 1 pt, the coordinate-noise tolerance of
 * `hangsFromMarker`. Measured on the French and English PDFs (22/09/2026):
 *   - aligned: an item's text start read twice (after its marker, on its second
 *     line) agrees to 0.05 pt on 53 of 64 items; the one unnumbered block that
 *     belongs to an item (0000609 p1, « and crew across borders », the last line
 *     of item 1 split off) is 0.0 pt from its item's text;
 *   - not aligned: the nearest disagreement is 1.3 pt, on a form (0000523), and
 *     the nearest block after an item that does not continue it is 6.7 pt away.
 * Gap between the two populations: 0.05 to 1.3 pt.
 */
const ITEM_ALIGN_TOLERANCE_PT = SAME_LINE_PT;

/**
 * WHERE AN ITEM'S TEXT STARTS, from two independent readings: where the text
 * resumes after the marker on the first line, and the left of the second line
 * (a hanging indent). Both present, they must agree, or this abstains; one
 * present, it stands alone. Abstaining means no block can continue the item.
 */
export function itemTextLeft(readings: {
  afterMarker?: number | undefined;
  secondLine?: number | undefined;
}): number | undefined {
  const { afterMarker, secondLine } = readings;
  if (afterMarker !== undefined && secondLine !== undefined)
    return Math.abs(afterMarker - secondLine) <= ITEM_ALIGN_TOLERANCE_PT ? afterMarker : undefined;
  return afterMarker ?? secondLine;
}

/** What an ordered run becomes: blocks left as paragraphs, and lists whose items
 *  are block indices, a numbered block first. */
export type OrderedPiece = { kind: "paragraph"; index: number } | { kind: "list"; first: number; items: number[][] };

/**
 * AN ORDERED RUN PUBLISHES THE DOCUMENT'S OWN NUMBERS (22/09/2026).
 *
 * `<ol>` counts its `<li>`, so an unnumbered block let in as an item shifts every
 * number after it: safedocs 0000713 p8 published « 1. » to « 5. » as 3 to 7. The
 * left edge of a block includes its marker, and an unnumbered block (a letter or
 * a bullet has no number) is never an item of its own:
 *   - aligned on the TEXT of the item before it (the number further left), it is
 *     that item's next paragraph;
 *   - otherwise it closes the list; before the first number it stays a paragraph.
 * GUARD: a list is kept only when its numbers follow exactly (first, first+1…,
 * no gap, no duplicate) over at least `MIN_ITEMS` items. Otherwise every block
 * stays a paragraph, its written number in its text. Every tool read on
 * 22/09/2026 keeps the written number; none checks the sequence
 * (`docs/ETUDE-BIBLIOTHEQUES-PDF.md` [purged 27/09/2026, git history], lesson 21).
 *
 * Set aside (22/09/2026): letting in a NON-indented block aligned on the item's
 * text. It would put the « b) » and « c) » of 0000713 p8 back into item 5, but
 * the same geometry is a body paragraph after a list whose markers hang in the
 * margin (fixture 29: three body paragraphs 0.0 pt from the text of the bullet
 * before them). Nothing tells the two apart, so only blocks already in the run
 * are candidates.
 */
export function orderedPieces(candidates: readonly ListCandidate[], start: number, end: number): OrderedPiece[] {
  const pieces: OrderedPiece[] = [];
  let items: number[][] = [];
  let numbers: number[] = [];
  let opener: ListCandidate | undefined;

  const close = (): void => {
    const exact = numbers.every((n, k) => n === numbers[0]! + k);
    if (items.length >= MIN_ITEMS && exact) pieces.push({ kind: "list", first: numbers[0]!, items });
    else for (const index of items.flat()) pieces.push({ kind: "paragraph", index });
    items = [];
    numbers = [];
    opener = undefined;
  };

  for (let index = start; index <= end; index++) {
    const candidate = candidates[index]!;
    const value = candidate.marker?.kind === "ordered" ? candidate.marker.value : undefined;
    if (value !== undefined) {
      items.push([index]);
      numbers.push(value);
      opener = candidate;
    } else if (opener !== undefined && continuesItem(opener, candidate)) {
      items[items.length - 1]!.push(index);
    } else {
      close();
      pieces.push({ kind: "paragraph", index });
    }
  }
  close();
  return pieces;
}

const continuesItem = (item: ListCandidate, block: ListCandidate): boolean =>
  item.left !== undefined &&
  item.textLeft !== undefined &&
  block.left !== undefined &&
  item.textLeft - item.left > ITEM_ALIGN_TOLERANCE_PT &&
  Math.abs(block.left - item.textLeft) <= ITEM_ALIGN_TOLERANCE_PT;
