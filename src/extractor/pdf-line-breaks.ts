/** Whether the break between two lines is DELIBERATE — the question a vertical
 *  gap cannot answer, decided on the width of the next first word, on centring,
 *  and on markers.
 *  NOT here: the assembly of the lines it separates
 *  (`extractor/pdf-paragraphs.ts`), nor the glyph advances it measures on
 *  (`extractor/glyph-positions.ts`).
 *  Called by: `extractor/pdf-paragraphs.ts`, `extractor/pdf.ts`. */

import type { GlyphFragment } from "./glyph-positions";
import { firstWordWidthOf } from "../layout/cell-text";
import { markerOf } from "../layout/list";
import type { Line } from "./pdf-model";
import { SAME_LINE_TOLERANCE } from "./pdf-lines";
import { SAME_LINE_PT } from "../layout/tolerances";

/**
 * The exact width of a line's first word: the sum of its glyph advances, up to the first space.
 * Tried then dropped: estimating it pro rata of the characters, which failed on short words.
 */
export const firstWordWidthReader =
  (glyphs: readonly GlyphFragment[]) =>
  /** `left`: the line's own left edge. On a page of several columns, the glyphs at an ordinate belong to every column
   *  that has a line there; without it the word measured was the LEFTMOST column's (Alouette bulletin p3, 06/11/2026:
   *  « Comme » of column 1, 27.7 pt, read for « parlementaire » of column 2, 70.3 pt — and the two-line subheading
   *  « Un rôle de vigie / parlementaire » split, the spare room being judged on the wrong word). */
  (y: number, left?: number): number => {
    const sameLine = glyphs
      .filter(
        (f) => Math.abs(f.y - y) <= SAME_LINE_TOLERANCE && (left === undefined || f.x >= left - SAME_LINE_TOLERANCE),
      )
      .sort((a, b) => a.x - b.x);
    // A glyph flagged `isSpace` (code 32) can carry a non-blank text; it still ends the word.
    return firstWordWidthOf(sameLine.map((g) => (g.isSpace ? { text: " ", width: g.width } : g)));
  };

/**
 * Is this line break forced or deliberate: would the next word have fitted.
 *
 * A vertical-gap threshold cannot answer: lines of different nature sit at the same size, less than two body sizes
 * apart. The typographer's question does: did the first word of the next line fit in the room left? No, the break is
 * forced and the text continues; yes, it is deliberate.
 * Chosen bias: no wrong split, some joins remain (a last line that happens to end near the margin stays joined).
 *
 * Without glyphs, abstain: a word width of zero means "unknown", never "everything fits"; otherwise every line of a
 * page whose operators could not be read would become a paragraph.
 *
 * THE WORD MUST FIT WITH 0.45 EM TO SPARE (lot 32, 22/09/2026). "Fit"
 * used to mean room ≥ word, which forgets the space before the word and the
 * overshoot of the widest line that sets `marginRight` (justified text, a
 * hanging punctuation mark). Once glyphs were read on more documents, that
 * split 15 real sentences in the middle (group G1: fixture 29 ×8, 28 ×2,
 * safedocs 0000609 ×2, 27, 0000154, 0000547). Measured as
 * e = (room − word) / body size, over the 1,322 pairs this rule decides in
 * the 39 French/English PDFs (real documents, fixture 25 set apart):
 *
 *     mid-sentence splits (false)   28 pairs, median 0.17 em;
 *                                   max 0.4206 em (0000609 p1, group G1)
 *     paragraph ends (true)         91 pairs, min 0.4727 em (0000109 p1,
 *                                   « …payers. » / « Bill History: »), then
 *                                   1.97 em; 0.55 em on fixture 18, whose
 *                                   truth is written down
 *
 * The gap is 0.05 em. `DELIBERATE_BREAK_SPARE_EM` sits in its middle (owner's
 * decision) and is a VALEUR DE DÉPART À CALIBRER. Half an em was decided
 * first, on a diagnostic that saw 0.42 to 0.55 (its 0.62 end of 0000754 p1 is
 * table-cell lines since the same day, not decided here); it joined the 0.47
 * end. A thin gap is accepted because the later check on the rendered text
 * (remedy B) is the safety net for what geometry misses on either side.
 * Tried and set aside:
 *  - the margin of the same-size lines only (fixes the 16 pt bubbles of
 *    0000754 p2): splits 3 real headers wrongly — both school reports and the
 *    address of booklet 26;
 *  - the margin of the local column: the 39 mid-sentence cuts measured fall
 *    only to 33 (0.45 em: to 24).
 * ⚠️ LOT « 39 » (22/09/2026) — THE MEASURE ABOVE HOLDS, THE COUNT BELOW DOES
 * NOT. Removing the gutter cut of `0000109`, `0000713` and `0000523` changed
 * which lines share a segment, so it changed their `marginRight`. Re-measured:
 * the two values this rule is calibrated on are IDENTICAL (0000109 p1 still
 * 0.4727 em and 2.0812 em — the widest line of the page is the same either
 * way). But `0000523` p6 gained 13 mid-sentence splits, for a reason that is
 * NOT this threshold: an unrecognised browser footer sets a right margin 30 pt
 * too wide there (written down on `pdf-paragraphs.ts#marginRight`).
 *
 * 6 false splits this rule decides sit ABOVE 0.45 em (0000713 ×2, 0000523
 * ×2, 0000609 p2 « OR, », 26) and no threshold separates them from real ends:
 * geometry cannot decide them, so they are left to a later check on the
 * rendered text (the two of 0000754 p2 are table-cell lines, not decided here).
 * The fabricated fixture 19 draws one sentence per line without composing, so
 * one of its real ends (0.14 em) now joins: it says nothing of a real engine.
 */
const DELIBERATE_BREAK_SPARE_EM = 0.45;

export const isDeliberateBreak = (line: Line, next: Line, marginRight: number): boolean =>
  next.firstWordWidth > 0 &&
  marginRight - line.right - next.firstWordWidth >= DELIBERATE_BREAK_SPARE_EM * line.fontSize;

/**
 * Two lines centred on each other do not continue a paragraph.
 *
 * `isDeliberateBreak` assumes left-aligned text against a margin, where a line's right edge says the text stopped for
 * lack of room. In a centred block that edge only says where centring put the line, so the answer would always be
 * "it did not fit" and everything would join.
 *
 * The discriminant is a comparison, not a threshold: the centres agree better than the left edges and better than
 * the right edges. Left-aligned prose fails it at once, justified prose too.
 * Trap: a hanging indent passes it (the item's first line and its continuation can share a centre);
 * `hangsFromMarker` covers that case.
 */
export const isCentredPair = (line: Line, next: Line): boolean => {
  const centre = Math.abs((line.left + line.right) / 2 - (next.left + next.right) / 2);
  return centre < Math.abs(line.left - next.left) && centre < Math.abs(line.right - next.right);
};

/**
 * A CENTRED LINE WRAPPED BY THE LAYOUT ENGINE IS NOT A DELIBERATE BREAK
 * (defect 4 of the MFA guide review, 21/09/2026).
 *
 * `isCentredPair` split every centred pair, so a title Word wrapped over two
 * lines came out as two headings. The typographer's question comes back, asked
 * of the CONTAINER instead of the line: a centred line is re-centred when a word
 * is added, so the room it had is everything its container leaves free —
 *
 *     ratio = (containerWidth − lineWidth) / nextFirstWordWidth
 *
 * — and the break was forced only if the next word did not fit. The word width
 * is `Line.firstWordEstimate` (character-count estimate, see `pdf-lines.ts`).
 *
 * "Fit" must mean LARGELY: a centred line's container is known less exactly
 * than a margin. `CENTRED_WRAP_RATIO` is a VALEUR DE DÉPART À CALIBRER, set in
 * the gap between the two populations measured on every fixture PDF, with the
 * container found:
 *
 *     wraps (join)            0 – 0.96 exact advances, 0 – 1.26 estimated (20)
 *     deliberate (split)      4.1 – 141 exact, 4.09 – 141 estimated       (35)
 *
 * e.g. the MFA title « …Microsoft via » / « MS Authenticator » 0.82 (exact),
 * the bulletin header box « 1 rue Constant Pilate » / « 92331 SCEAUX » 7.62.
 *
 * ⚠️ WHEN THE REAL CONTAINER IS NOT DETECTED, the fallback is wider, the ratio
 * grows, and the pair SPLITS — exactly as before this rule. Ten measured wraps
 * stayed split that way; the value columns (`valueColumnStarts`) now join five
 * of them (safedocs 0000109 p2, fixture 25 p2). Table cells whose padding
 * counts as room in 0000661 still split. No word estimate or no container:
 * split, as before.
 */
const CENTRED_WRAP_RATIO = 2;

export const continuesCentredLine = (line: Line, next: Line, containerWidth: number | undefined): boolean => {
  const word = next.firstWordEstimate;
  if (containerWidth === undefined || word === undefined || word <= 0) return false;
  return (containerWidth - (line.right - line.left)) / word < CENTRED_WRAP_RATIO;
};

/** A closed rectangle on the page: a stroked box (coloured fills no longer count, lot « 34 »). */
export interface ContainerBox {
  left: number;
  right: number;
  bottom: number;
  top: number;
}

/**
 * The width of the container two lines share, innermost first:
 *  1. the smallest closed rectangle holding both lines;
 *  2. else the VALUE COLUMN the first line's value starts in (see
 *     `valueColumnStarts`), up to the right edge of 3 or 4;
 *  3. else the side of the page's column cut the WHOLE segment is on (the
 *     lines read together with this pair), bounded by the document's body
 *     text area. Judged on the segment, not the pair, because that is how it
 *     was measured: a pair can sit left of a cut its paragraph does not respect
 *     (safedocs 0000944 p2, a signature block: 0.88 per pair, 4.66 per segment);
 *  4. else the document's body text area (see `DocumentScale.bodyTextArea`).
 * Undefined when not even the text area is known, or when the first line's
 * value is in a column the next line does not start in.
 */
export const centredContainerReader =
  (
    boxes: readonly ContainerBox[],
    cut: { cut: number; above?: number } | undefined,
    area: { left: number; right: number } | undefined,
    valueColumns: readonly number[] = [],
  ) =>
  (line: Line, next: Line, segment: readonly Line[]): number | undefined => {
    const pair = [line, next];
    let innermost: ContainerBox | undefined;
    for (const box of boxes) {
      if (!pair.every((l) => l.left >= box.left && l.right <= box.right && l.y >= box.bottom && l.y <= box.top))
        continue;
      if (
        innermost === undefined ||
        (box.right - box.left) * (box.top - box.bottom) <
          (innermost.right - innermost.left) * (innermost.top - innermost.bottom)
      )
        innermost = box;
    }
    if (innermost !== undefined) return innermost.right - innermost.left;
    if (area === undefined) return undefined;
    let left = area.left;
    let right = area.right;
    if (cut !== undefined && segment.every((l) => cut.above === undefined || l.y >= cut.above)) {
      if (segment.every((l) => l.right <= cut.cut)) right = cut.cut;
      else if (segment.every((l) => l.left >= cut.cut)) left = cut.cut;
    }
    // A LABEL/VALUE LINE IS NOT CENTRED, IT IS LEFT-ALIGNED AT A TAB STOP
    // (safedocs 0000109 p1, owner decision of 21/09/2026). « DeLuca… self-referral. »
    // then « Bill History: » looked centred by accident: label and value read as
    // one line, the text area as their container, ratio 1.35 → a new label
    // glued to the previous value. Inside a value column the question changes:
    //  - the next line starts LEFT of the column: it opens a new label, the pair
    //    shares no container — split, as a centred pair always did before;
    //  - it starts in the column: a wrapped value, whose room is all on the
    //    right, so the container runs from the line's own left edge to the
    //    column's right one (Ecker… 0.87, joined).
    // Measured on every fixture PDF: 30 of the 69 pairs this rule decides meet
    // a column, 6 verdicts change, all toward the document — DeLuca splits,
    // three wrapped « Bill History » values of 0000109 p2 and two wrapped lines
    // of fixture 25 p2 join.
    const column = valueColumns.find(
      (x) => x > left && [line.valueStart, line.left].some((v) => v !== undefined && Math.abs(v - x) <= ALIGNED),
    );
    if (column !== undefined) return next.left < column - ALIGNED ? undefined : right - line.left;
    return right - left;
  };

/** Two abscissas are the same tab stop when they are this close, in points —
 *  coordinate noise only: the aligned values measured are 0 to 0.25 pt apart
 *  (safedocs 0000441, 0000986), and every verdict above is the same from 0.05
 *  to 2 pt. */
const ALIGNED = SAME_LINE_PT;

/**
 * THE VALUE COLUMNS OF A PAGE — the tab stops a label/value layout puts its
 * values at (owner decision of 21/09/2026: fix the cause, detect the column).
 *
 * TWO INDEPENDENT READINGS MUST AGREE, else no column and nothing changes:
 *  1. the VALUES of at least two lines start at the same abscissa — a value
 *     being the text after the line's widest inner gap (`Line.valueStart`).
 *     One line aligns with nothing; two is the least an alignment means;
 *  2. at least one line STARTS there with no label: a wrapped value.
 * Labels are NOT read: their ends, colons or alignment are ragged or absent
 * in real forms. Neither count is tuned: over every fixture PDF the
 * centred-pair verdicts are identical with 2 to 4 aligned values and 0 to 2
 * wrapped lines. Reading 2 still guards the case it can: a two-column page
 * reads as one line per ordinate, so its right column aligns (16-Brochure-
 * Dense, 44 lines at 320) — but no line starts there, and nothing is inferred.
 *
 * What it finds is wider than forms, and that is measured, not hidden: 47 of
 * 165 fixture pages, among them marker lists (a bullet is a label, its text
 * a value), borderless tables and the undetected columns of fixture 25. A
 * column only changes a CENTRED pair whose first line's value is in it.
 * Forms whose values never wrap are missed (safedocs 0000523 p2, 0000441 p1
 * right half): no reading 2, so today's behaviour.
 */
export const valueColumnStarts = (lines: readonly { left: number; valueStart?: number }[]): number[] => {
  const values = lines.flatMap((l) => (l.valueStart === undefined ? [] : [l.valueStart])).sort((a, b) => a - b);
  const columns: number[] = [];
  for (let i = 0; i < values.length;) {
    let j = i;
    while (j + 1 < values.length && values[j + 1]! - values[i]! <= ALIGNED) j++;
    const x = values[i]!;
    if (j > i && lines.some((l) => l.left >= x - ALIGNED && l.left <= values[j]! + ALIGNED)) columns.push(x);
    i = j + 1;
  }
  return columns;
};

/**
 * A marker on an outdented line opens an item. It separates consecutive items when no glyph advance is known and
 * `isDeliberateBreak` abstains.
 *
 * Both conditions are needed together. The outdent alone is the classic indented paragraph, whose following lines
 * come back to the margin; the marker alone is a dash inside a sentence. Without an indent, it is not a bullet.
 * The tolerance only absorbs coordinate noise.
 */
export const startsNewItem = (line: Line, next: Line): boolean =>
  line.left - next.left > SAME_LINE_PT && markerOf(next.text) !== undefined;

/**
 * A marker line and the indented line after it are an item and its continuation, never a centred block: without this
 * guard `isCentredPair` cuts an item with a hanging indent after its first line.
 *
 * 26/10/2026 — A SUB-BULLET UNDER AN ITEM IS NOT ITS CONTINUATION. docx-reel 08
 * p5 « • individuals¹ in: » / « o private schools », and fixture 36 (five bold
 * items glued to their « o » sub-bullet): Word draws the second-level bullet as
 * « o » in Courier New, indented past the item's TEXT, so the pair looked like
 * a hanging indent. The guard is false when ALL of: (i) the marker line has a
 * `lead`; (ii) the next line starts further right than the item's text
 * (`lead.nextLeft`); (iii) the next line itself opens like a bullet (one character, then a blank of at least one body
 * size, i.e. a tab). It decides nothing itself: it hands the pair back to
 * `isDeliberateBreak` / centred pairs. (iii) exists for safedocs 0000602 p2: a
 * date wrapped and indented under its reference (« … Prevention » /
 * « April 3, 2020 ») must stay one paragraph.
 *
 * Written limits: (a) only one-character sub-markers (« o », « - », « ▪ »);
 * « a. », « (i) », « 1. » stay glued. (b) only when the bullet is its own
 * text run (a symbol font); a bullet in the body font gives one item
 * « • text »: `lead.nextLeft` is then past the item's text start and (ii) holds
 * the line. (c) the same glue existed with a KNOWN
 * indented sub-marker (« ▪ »): `startsNewItem` asks for an outdent, not an
 * indent; (iii) covers it as well.
 */
export const hangsFromMarker = (line: Line, next: Line): boolean =>
  next.left - line.left > SAME_LINE_PT && markerOf(line.text) !== undefined && !isSubBulletUnder(line, next);

/** `next` is a one-character bullet indented past the item's text, which starts where the marker line's `lead` ends. */
const isSubBulletUnder = (line: Line, next: Line): boolean => {
  const { lead } = line;
  if (lead === undefined || next.lead === undefined) return false;
  if (next.left - lead.nextLeft <= SAME_LINE_PT) return false;
  return next.lead.text.trim().length === 1 && next.lead.nextLeft - next.left >= next.fontSize;
};

/** Leader dots a contents line needs before its page number (valeur de depart a calibrer). Measured 14/10/2026 on 25 real Word PDFs
 *  (fixtures/docx-heading-reel): 37 merged contents blobs of over 200 characters, 0 left with this rule; no prose paragraph broken
 *  (a prose line ending in three dots and a number is not matched: ellipsis is 3 dots). */
const LEADER_DOTS_THRESHOLD = 4;
// A roman page number is a STRICT roman numeral of at most 6 letters, all lower or all upper case: « civil » is not one.
const ROMAN_LOWER = "(?=[ivxlc]{1,6}\\s*$)c{0,3}(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})";
const ROMAN_UPPER = "(?=[IVXLC]{1,6}\\s*$)C{0,3}(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})";
const PAGE_NUMBER = `(?:\\d{1,4}|${ROMAN_LOWER}|${ROMAN_UPPER})`;
/** The regex is end-anchored: only this many trailing characters can matter, so a hostile 20,000-dot line is never rescanned quadratically. */
const LEADER_TAIL_CHARS = 40;
const LEADER_THEN_PAGE = new RegExp(
  `(?:\\.{${LEADER_DOTS_THRESHOLD},}|…{2,}|(?:\\. ){${LEADER_DOTS_THRESHOLD},})\\s*${PAGE_NUMBER}\\s*$`,
);

/**
 * A CONTENTS LINE ENDS ITS PARAGRAPH. A table of contents line reaches the right margin with its page number, at the body size, at the
 * normal gap: nothing else in the layout says the next entry is a new one, so 13 of 25 real Word documents merged their whole contents
 * into one paragraph (up to 3,602 characters). Only the DOTTED form is read: leader dots, then a page number. The variant with the
 * number after a wide inner gap was measured too and NOT coded: it also splits borderless tables.
 */
export const endsWithPageLeader = (text: string): boolean => LEADER_THEN_PAGE.test(text.slice(-LEADER_TAIL_CHARS));
