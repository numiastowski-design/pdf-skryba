/** Which items form one visual line, and what that line measures: its text,
 *  its runs, its edges, its widest inner gap.
 *  NOT here: what a SUITE of lines means — paragraphs, headings, lists
 *  (`extractor/pdf-paragraphs.ts`) — nor the order a two-band page is read in
 *  (`extractor/pdf-bands.ts`).
 *  Called by: `extractor/pdf.ts`, `extractor/pdf-source.ts` (`hasReadableText`, `linesFromItems`),
 *  `extractor/pdf-page-stages.ts`, `extractor/pdf-bands.ts`, `extractor/pdf-page-tables.ts`,
 *  `extractor/pdf-rotated-lines.ts` (`separatorBefore`), and the PDF
 *  stages that measure lines (`pdf-line-breaks.ts`, `pdf-image-anchors.ts`,
 *  `pdf-document-scale.ts`). */

import { maxOf, minOf } from "doc-ir/lib/extent";
import type { ImageRef } from "doc-ir/lib/ir";
import { groupIntoReseatedLines, SAME_LINE_TOLERANCE } from "doc-ir/layout/baseline-lines";
import {
  dominantSizeByChars,
  LEADING_CALL_GAP_EM,
  SUPERSCRIPT_MAX_RISE_EM,
  SUPERSCRIPT_MAX_SIZE_RATIO,
  SUPERSCRIPT_MIN_RISE_EM,
} from "doc-ir/layout/superscript";
import type { Line, PositionedItem, TextRun } from "./pdf-model";

export { SAME_LINE_TOLERANCE };

/** See `Line.maxInnerGap`. The items are sorted by x coordinate — the order of the
 *  file says nothing about the layout. Also returns where the text resumes
 *  after that gap (`Line.valueStart`). */
const innerGapOf = (items: readonly PositionedItem[]): { gap: number; end?: number } => {
  const size = items[0]?.fontSize ?? 0;
  if (items.length < 2 || !(size > 0)) return { gap: 0 };
  const sorted = [...items].sort((a, b) => a.x - b.x);
  let worst = 0;
  let end: number | undefined;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i]!.x - (sorted[i - 1]!.x + sorted[i - 1]!.width);
    if (gap > worst) {
      worst = gap;
      end = sorted[i]!.x;
    }
  }
  return end === undefined ? { gap: worst / size } : { gap: worst / size, end };
};

/** The text of a run that carries ONLY a bitmap marker: nothing. The picture is the run; it survives its empty text through
 *  the filter of `pdf-paragraphs.ts#inlinesFromRuns`, which keeps every run that carries a marker. */
const emptyMarkerText = "";

/**
 * A GAP WIDER THAN THIS, between two items that carry no whitespace at their
 * junction, IS A WORD BREAK: the line gets a space there. In units of font size
 * (the larger of the two items'); the font's own space width is not available
 * on a run. Starting value to calibrate (21/09/2026).
 *
 * The two populations, measured on every fixture PDF (45 documents, 05b
 * excluded) as the code DECIDES on them — adjacent non-blank items of one
 * `groupItemsIntoLines` line, no whitespace between them:
 *  - inside a word (kerning, a font switch mid-word, a run split): 263 pairs
 *    from −0.05 to +0.034 em, plus 25 overlaps below −0.2 em;
 *  - between words: 172 pairs from 0.278 em up, up to 232 pt between two
 *    columns.
 * Three pairs lie between the two and stay joined, as before: an emoji then
 * its word (0.068) and a list number then its text, "1." | "Confirmer" (0.101
 * ×2) — less than half the smallest word gap. Glyph by glyph (pages whose
 * glyphs could be rebuilt), gaps inside a word reach 0.080 em in this corpus
 * (a decomposed "fi" ligature, fixture 26): 0.15 sits in the empty interval
 * 0.080–0.278, clear of both.
 */
const WORD_GAP_EM = 0.15;

/** The separator a line puts BEFORE `group[i]`: a space when the document
 *  leaves a word-sized gap and no whitespace of its own (see `WORD_GAP_EM`).
 *
 *  WRITTEN LIMIT (R2, measured 22/09/2026): a form with ONE LETTER PER BOX is
 *  published letter-spaced. Safedocs 0000523 p1 gives « D M C I H O L D I N G S »
 *  and « 3 R D F L R . D A C O N B L D G »: our runs put a space item
 *  between two boxes (pdf.js did too), and the line keeps the document's whitespace. No letter is
 *  lost, but the words cannot be found as words. Present before the glyph
 *  repair of 22/09/2026, not caused by it.
 *
 *  WRITTEN LIMIT (R5, measured 22/09/2026): « paintingWhy » on safedocs 0000393
 *  p1 stays glued. The document itself paints « …walk around after painting »
 *  and « Why I Love the Yamaha Virago » at a gap of 0.01 pt, same 12 pt size,
 *  on one baseline — a page of scraped result titles run together. There is no
 *  space and no gap to restore, so a repair would INVENT a character the
 *  document does not have, and the publish-time check cannot report it either:
 *  its own independent reading (`pipeline/text-conservation.ts#joinRuns`) uses
 *  the same 0.15 em rule and reads one word too. Two readings agree, so we
 *  abstain.
 *  THE WEIGHT CHANGE WAS MEASURED AS THE SECOND READING AND REFUTED: of the 169
 *  pairs this function joins with no space across the French and English corpus,
 *  41 change weight, and exactly ONE of the 41 is a word boundary. The other 40
 *  are inside a word or against punctuation — « L' | intégrité », « l'e |
 *  xcellence », « Richter | , fut animé », « Sofitel | . ». Forty invented
 *  spaces to recover one. Narrowing to a lowercase-then-uppercase junction
 *  leaves that single case, in a single document: a rule calibrated on its own
 *  example, which is what the repository refuses to write. */
export const separatorBefore = (group: readonly PositionedItem[], i: number): string => {
  const prev = group[i - 1];
  const it = group[i]!;
  if (prev === undefined || prev.text.length === 0 || /\s$/u.test(prev.text) || /^\s/u.test(it.text)) return "";
  const gap = it.x - (prev.x + prev.width);
  const em = Math.max(prev.fontSize, it.fontSize);
  // Two texts drawn ON TOP of each other on one baseline (an item starting more than an em inside the one before) are two words: a kerning
  // overlap is a fraction of an em, never this (safedocs 47: « page 2/21 » under « Contrat de prêt… », published « …2/21Contrat »).
  return gap > WORD_GAP_EM * em || gap < -em ? " " : "";
};

/** An item's text cut at its link spans, in order: the parts without a link carry no `href`. */
const linkPieces = (item: PositionedItem): { text: string; href?: string }[] => {
  const spans = item.links ?? [];
  if (spans.length === 0) return [{ text: item.text }];
  const pieces: { text: string; href?: string }[] = [];
  let at = 0;
  for (const span of spans) {
    if (span.start > at) pieces.push({ text: item.text.slice(at, span.start) });
    pieces.push({ text: item.text.slice(span.start, span.end), href: span.href });
    at = span.end;
  }
  if (at < item.text.length) pieces.push({ text: item.text.slice(at) });
  return pieces;
};

/**
 * GEOMETRIC READING ORDER, top to bottom then left to right: the grouping alone, without the text; the column
 * discriminant needs a line's items, not its string.
 *
 * Grouping used to take the items IN FILE ORDER and group only CONSECUTIVE items of close ordinate, so it depended on
 * the generating software, not on the layout (measured 08/09/2026 on `11-Brochure-Deux-Colonnes.pdf`: two pages of the
 * SAME geometry gave 8 lines and 6).
 *
 * WHAT THE SORT CLOSES: the gap in `paragraphsFromLines` is SIGNED (`prev.y - line.y`), so any emission that does not
 * descend the page gave a NEGATIVE gap, hence no paragraph break and a silent merge. Two measured forms: a COLUMN change
 * (jump back to the top) glued the last left line to the first right one; two chart LABELS emitted out of order
 * (« 2023 » at y=320 then « Volume archive » at y=440) merged into one paragraph. After the sort the gap is always >= 0.
 *
 * WHAT IT DOES NOT CLOSE: INTERLEAVING. Two columns at the same ordinates stay one visual line, hence one mixed
 * paragraph; that needs a partition by band (`pdf-bands.ts`).
 *
 * A total, deterministic sort in two steps rather than one tolerant comparator: a comparator that called two items 0.5 pt
 * apart "equal" is NOT transitive (a~b, b~c, a!~c), and `Array.sort` then has no guaranteed result. So: strict order,
 * group, then order inside each group.
 */
export const groupItemsIntoLines = <T extends PositionedItem>(pageItems: readonly T[]): T[][] => {
  // A TURNED RUN IS A LINE OF ITS OWN (06/11/2026, Alouette bulletin p2): written upwards beside a masthead, the postal mark
  // « 1000 LAUSANNE 12 » (12.5 pt) laid its length flat over the start of the 7.5 pt line « CCP 10-3056-2 Lausanne. » 6.6 pt
  // above it, and the reseating took that whole line for its superscript. A run written in a turned direction shares no
  // baseline with horizontal text. Turned runs are grouped into lines AMONG THEMSELVES, by the same baseline rule (the
  // three turned axis labels of `11-Brochure-Deux-Colonnes` stay one line, « 2023 2024 2025 », as `pdf-columns.test.ts`
  // pins), and each of their lines is placed at its own height among the horizontal ones, after the line it falls under.
  const turned = groupIntoReseatedLines(
    pageItems.filter((it) => it.rotated === true),
    (it) => it.fontSize,
  );
  const lines = liftDropCaps(
    groupIntoReseatedLines(
      pageItems.filter((it) => it.rotated !== true),
      (it) => it.fontSize,
    ),
  );
  for (const line of turned) {
    const y = line[0]!.y;
    const before = lines.findIndex((other) => other[0]!.y < y);
    lines.splice(before < 0 ? lines.length : before, 0, line);
  }
  return lines;
};

/**
 * A DROP CAP OPENS THE FIRST LINE IT OVERHANGS (05/11/2026, front page of the newspaper `sd-2479793`). The glyph sits on
 * the baseline of the LAST line it spans — « C' » of 36 pt on the third line of « C'est devenu un rituel » — and the lines
 * above it, indented to its right, came out before it: « est devenu un ri-tuel. Une semaine / C'du mois de mars ». A drop
 * cap is a glyph of one or two letters at least `MIN_DROP_CAP_RATIO` times the body of the lines it overhangs; it moves
 * to the head of the highest of those lines. A large glyph with no indented line above it (a section number beside its
 * title) and a whole word in a large size are not drop caps.
 */
export const MIN_DROP_CAP_RATIO = 2;

const dropCapShape = /^\p{L}\p{P}?$|^\p{L}{2}$/u;
const twoLettersShape = /^\p{L}{2}$/u;

/** A TWO-LETTER « cap » IS A WORD OF A TITLE when another ink item of its line is not body text, that is less than
 *  `MIN_DROP_CAP_RATIO` smaller than it: « Le » of « Le Monde » in 30 pt under a 12 pt kicker (review 06/11/2026). A real
 *  drop cap shares its baseline with body lines only. The pieces of one letter (« C’ ») keep the old rule. */
const isTitleWord = (cap: PositionedItem, line: readonly PositionedItem[]): boolean =>
  twoLettersShape.test(cap.text.trim()) &&
  line.some((it) => it !== cap && it.text.trim() !== "" && it.fontSize * MIN_DROP_CAP_RATIO > cap.fontSize);

/** 🔴 THE DROP-CAP RULE, IN ONE PLACE (13/11/2026). `extractor/pdf-page-plan.ts` applies the same one to say which
 *  line a drop cap SHOULD open inside its own column; a rule written twice diverges, so the three pieces below are
 *  exported rather than copied. Nothing here decides anything: `liftDropCaps` keeps deciding as it always did. */
export const isDropCap = (cap: PositionedItem, line: readonly PositionedItem[]): boolean =>
  dropCapShape.test(cap.text.trim()) && !isTitleWord(cap, line);

export interface LineInk {
  /** The baseline of the line's first inked item. */
  y: number;
  left: number;
  /** The largest size of its inked items. */
  size: number;
}

export const inkOfLine = (line: readonly PositionedItem[]): LineInk | undefined => {
  const ink = line.filter((it) => it.text.trim() !== "");
  if (ink.length === 0) return undefined;
  return { y: ink[0]!.y, left: minOf(ink, (it) => it.x), size: maxOf(ink, (it) => it.fontSize) };
};

/** The line is overhung by the cap: baseline between the cap's baseline and its top, starting to the right of its left
 *  edge, in a body at most half its size (tested first: the cheapest refusal). The highest such line receives the cap. */
export const isOverhungBy = (cap: PositionedItem, ink: LineInk | undefined): boolean =>
  ink !== undefined &&
  ink.size * MIN_DROP_CAP_RATIO <= cap.fontSize &&
  ink.y > cap.y &&
  ink.y < cap.y + cap.fontSize &&
  ink.left > cap.x;

const liftDropCaps = <T extends PositionedItem>(lines: T[][]): T[][] => {
  const out = lines.map((line) => [...line]);
  // The ink of each line, read ONCE and again only for the two lines a lift changes: the search then costs O(1) per
  // line, not a pass over its items.
  const inks = out.map(inkOfLine);
  for (const [li, line] of out.entries()) {
    for (const cap of [...line]) {
      if (!isDropCap(cap, out[li]!)) continue;
      const target = inks.slice(0, li).findIndex((ink) => isOverhungBy(cap, ink));
      if (target < 0) continue;
      out[li] = out[li]!.filter((it) => it !== cap);
      out[target]!.unshift(cap);
      inks[li] = inkOfLine(out[li]);
      inks[target] = inkOfLine(out[target]!);
    }
  }
  return out.filter((line) => line.length > 0);
};

/** The items of a line without the whitespace-only ones at its start and its end (all of them when none holds a letter). */
const trimBlankEnds = (group: readonly PositionedItem[]): readonly PositionedItem[] => {
  const isInk = (it: PositionedItem): boolean => it.text.trim().length > 0;
  const first = group.findIndex(isInk);
  if (first < 0) return group;
  let last = group.length - 1;
  while (!isInk(group[last]!)) last--;
  return group.slice(first, last + 1);
};

/** The item of a line that stands on the line's baseline: the first ink item of the dominant size. */
const hostOf = (measured: readonly PositionedItem[], size: number): PositionedItem | undefined =>
  measured.find((it) => it.fontSize === size && it.text.trim() !== "");

/**
 * A NOTE CALL OR AN ORDINAL SUFFIX IS A TOKEN OF ITS OWN (19/10/2026, corpus 008 p5 « Money2. », 261 p4-5 « supraterane3. »,
 * « Brigade6. », 057 p4 « 0.5th »). An item that FOLLOWS the host's first item, is smaller than 0.8 of the host's size and raised
 * between `SUPERSCRIPT_MIN_RISE_EM` and `SUPERSCRIPT_MAX_RISE_EM` of it (the rule that hung it back on its line,
 * `layout/superscript.ts`) is published as a `sup` inline: a reader or a search index sees « Money 2. », not « Money2. »,
 * while the text stays the document's (« 18th »: `<sup>` never ends a word for the conservation check). A space in the
 * text was refused: it would write « 18 th », a letter-spaced ordinal the document does not have.
 */
const isRaisedCall = (it: PositionedItem, host: PositionedItem | undefined, size: number): boolean => {
  if (
    host === undefined ||
    it === host ||
    it.text.trim() === "" ||
    !(it.x > host.x || opensAsNoteNumber(it, host, size))
  )
    return false;
  const rise = it.y - host.y;
  return (
    it.fontSize <= SUPERSCRIPT_MAX_SIZE_RATIO * size &&
    rise > SUPERSCRIPT_MIN_RISE_EM * size &&
    rise <= SUPERSCRIPT_MAX_RISE_EM * size
  );
};

/**
 * A NOTE NUMBER OPENS ITS NOTE (05/11/2026 on the published Federal Register `sd-4133285`: « 6 See id. … 7 Id. »
 * came out as one paragraph). Since 04/11 the small raised digit at the foot of a column is reseated onto the line it
 * opens (`layout/superscript.ts#LEADING_CALL_GAP_EM`); it is then the line's FIRST item, and « follows nothing », so it
 * was published as a plain « 7 » that no paragraph rule could tell from a first word. A leading DIGIT run that ends
 * within that same gap before the host is the note's number, and is marked like a call. Digits only: a leading raised
 * letter still follows nothing (`pdf-lines.sup.test.ts`).
 */
const opensAsNoteNumber = (it: PositionedItem, host: PositionedItem, size: number): boolean =>
  /^\d+$/.test(it.text.trim()) && it.x + it.width <= host.x && host.x - (it.x + it.width) <= LEADING_CALL_GAP_EM * size;

/** `isBold` is INJECTED rather than read here: emphasis cannot be seen on an
 *  `unpdf` item, it comes from a second reading of the document
 *  (`pdf-table-detector.ts#textPositionSignals`). Without a predicate, everything is
 *  light — that is, exactly the earlier behaviour. */
/** ONE letter, with the punctuation its own item carries: « C », « C’ », never « Le ». The newspaper draws « C’ » as
 *  ONE run, so a shape of exactly one letter would miss the very case this is written for. */
const oneLetterShape = /^\p{L}\p{P}?$/u;

/**
 * A DROP CAP IS PUBLISHED IN BOLD, AND NOTHING ELSE IS DONE TO IT (12/11/2026, evening: « pour lettrines on
 * revert en effet. on met juste en gras […] basta »). It keeps its size, its width and its place.
 *
 * WHY NOTHING MORE. Confluence serves no text size above Normal that is not a heading — its editor offers « Small
 * text » and nothing else (`docs/PLATFORM-STATUS.md` §92) — and the only other face it can give is the monospace of
 * `<code>`, which would read as code. Bold is what is left.
 *
 * WHAT WAS REVERTED THE SAME DAY. The morning's rule brought the glyph back to the body size and moved it flush
 * against the word it opens. A VISUAL LINE SPANS EVERY COLUMN OF THE PAGE: the « L » of `sd-2479793` p2 had « Vaud »
 * (third column, 363.9) as its only line mate, so the letter was reseated 300 pt away, in that column, and the page's
 * column reading braided from there (« a chasse continue, une chasse fédérales et en constatant que, sur gnement et
 * de l'éducation… »). A second defect of the same rule was never explained: « eaucoup … à Ge-Bnève ».
 *
 * A letter SMALLER than the body is left alone: it is a note call, and its size is how `isRaisedCall` knows it.
 */
const dropCapOf = <T extends PositionedItem>(group: readonly T[], body: number): T | undefined => {
  const cap = group.find((it) => it.text.trim() !== "");
  return cap !== undefined && cap.fontSize > body && oneLetterShape.test(cap.text.trim()) ? cap : undefined;
};

export const linesFromGroups = (
  groups: readonly PositionedItem[][],
  isBold: (item: PositionedItem) => boolean = () => false,
  firstWordWidthAt: (y: number, left?: number) => number = () => 0,
  /** The bitmap marker placed just before this item (a bulletin's legend badge). Injected like `isBold`: the geometry of
   *  the pictures comes from a second reading of the document, which this module need not know. */
  markerBefore: (item: PositionedItem) => ImageRef | undefined = () => undefined,
): Line[] =>
  groups.map((all) => {
    // A whitespace-only item at either end of a line contributes nothing (a blank run between two columns that share a
    // baseline ended the left line, and the paragraph joiner added its own space: « au format  Pour régler »). Between two
    // letter items it stays. A line made only of blanks keeps them.
    const group = trimBlankEnds(all);
    const runs: TextRun[] = [];
    const separators = group.map((_, i) => separatorBefore(group, i));
    const hostSize = dominantSize(group.filter((it) => it.text.trim() !== ""));
    const host = hostOf(group, hostSize);
    const leadingCap = dropCapOf(group, hostSize);
    for (const [i, it] of group.entries()) {
      const bold = isBold(it) || it === leadingCap;
      const italic = it.italic === true;
      const sup = isRaisedCall(it, host, hostSize);
      const sep = separators[i]!;
      // A bitmap MARKER goes before its label, as a piece of its own; it replaces nothing, the next word stays whole.
      // The space between them is the document's (measured on the bulletin: badge of « Absent » ends at 322.4, label at
      // 323.4); it goes INTO the label's text rather than as a separate piece.
      const before = markerBefore(it);
      if (before !== undefined) runs.push({ text: emptyMarkerText, bold: false, marker: before });
      // The item's pieces, each with the link it carries (`pdf-links.ts`); one piece when it carries none.
      const pieces = linkPieces(it);
      const href = pieces[0]!.href;
      const last = runs[runs.length - 1];
      if (
        last !== undefined &&
        before === undefined &&
        last.marker === undefined &&
        last.bold === bold &&
        (last.italic === true) === italic &&
        last.href === href &&
        (last.sup === true) === sup
      )
        last.text += sep + pieces[0]!.text;
      else {
        // A word-break space never goes inside a link it does not continue.
        const lead = before !== undefined ? " " : sup || !(href === undefined || last?.href === href) ? "" : sep;
        if (sep !== "" && lead === "" && before === undefined) {
          if (last !== undefined && last.marker === undefined && last.href === undefined) last.text += sep;
          else runs.push({ text: sep, bold: false });
        }
        runs.push({
          text: lead + pieces[0]!.text,
          bold,
          ...(italic ? { italic } : {}),
          ...(href !== undefined ? { href } : {}),
          ...(sup ? { sup } : {}),
        });
      }
      for (const piece of pieces.slice(1))
        runs.push({
          text: piece.text,
          bold,
          ...(italic ? { italic } : {}),
          ...(piece.href !== undefined ? { href: piece.href } : {}),
          ...(sup ? { sup } : {}),
        });
    }
    // THE EDGES ARE MEASURED ON THE REAL TEXT, never on `unpdf`'s FILLER
    // items — those `str: " "` whose width covers ALL the visual
    // space up to the next fragment. Measured: a line stopping
    // at 436.8 pt was seen at 548.3, hence "full". The same trap had already
    // cost a filter in the assignment of fragments to cells.
    const real = group.filter((it) => it.text.trim().length > 0);
    const measured = real.length > 0 ? real : group;
    const firstWordEstimate = estimateFirstWord(real[0]);
    const inner = innerGapOf(measured);
    const byX = [...real].sort((a, b) => a.x - b.x);
    return {
      y: all[0]!.y,
      fontSize: dominantSize(measured),
      text: group.map((it, i) => separators[i]! + it.text).join(""),
      runs,
      left: minOf(measured, (it) => it.x),
      right: maxOf(measured, (it) => it.x + it.width),
      // The first word of THIS line: measured from its own left edge, never from the leftmost column at that height.
      firstWordWidth: firstWordWidthAt(
        all[0]!.y,
        minOf(measured, (it) => it.x),
      ),
      ...(firstWordEstimate !== undefined ? { firstWordEstimate } : {}),
      maxInnerGap: inner.gap,
      ...(inner.end !== undefined ? { valueStart: inner.end } : {}),
      ...(byX.length >= 2 ? { lead: { text: byX[0]!.text, nextLeft: byX[1]!.x } } : {}),
    };
  });

/**
 * The first word's width, ESTIMATED by character count on the run that starts
 * the line (see `Line.firstWordEstimate`, which only the centred-pair decision
 * reads):
 *
 *     estimate = run.width × wordChars / runChars
 *
 * The assumption is that every character of the run is equally wide. It is
 * false letter by letter, and good enough for the one question asked: over the
 * 55 centred pairs whose container is detected (20 wraps, 35 deliberate
 * breaks, every fixture PDF, 21/09/2026), the ratio computed with this
 * estimate kept wraps at 0–1.26 and deliberate breaks at 4.09–141, both clear
 * of the threshold 2. With exact glyph advances the same pairs gave 0–0.96
 * and 4.1–141: the estimate moves the wraps up, never across.
 */
const estimateFirstWord = (run: PositionedItem | undefined): number | undefined => {
  if (run === undefined || run.text.length === 0) return undefined;
  const word = run.text.trimStart().split(/\s/)[0] ?? "";
  return word.length === 0 ? undefined : (run.width * word.length) / run.text.length;
};

/**
 * THE SIZE OF A LINE IS THAT OF ITS TEXT, not that of its first glyph
 * (16/09/2026).
 *
 * It used to be read on the FIRST fragment. A Word bullet is drawn at 10 pt
 * in front of a 12 pt text: every bulleted line was therefore declared 10 pt, and
 * as a size change opens a paragraph, each list item was
 * cut IN THE MIDDLE OF A SENTENCE from its next line — "vous prenez différents
 * chemins" on one side, "développez votre propre application" on the other.
 * Exactly the defect the repository calls the worst: wrong and invisible.
 *
 * The same 10 pt also entered the heading rule by size, which compares
 * populations of line sizes.
 *
 * We therefore weigh the sizes by the NUMBER OF CHARACTERS and keep the
 * majority one — same form as `bold`, which is already decided at more than half
 * of the characters. On a tie, the larger: between two halves, it is the one
 * that carries the title.
 */
const dominantSize = <T extends { text: string; fontSize: number }>(items: readonly T[]): number =>
  dominantSizeByChars(
    items,
    (it) => it.text,
    (it) => it.fontSize,
  );

export const linesFromItems = (
  pageItems: readonly PositionedItem[],
  isBold?: (item: PositionedItem) => boolean,
  firstWordWidthAt?: (y: number, left?: number) => number,
): Line[] => linesFromGroups(groupItemsIntoLines(pageItems), isBold, firstWordWidthAt);

/**
 * Does a page carry USABLE text — not just lines?
 *
 * The predicate used to be `lines.length === 0`, which conflated "no text"
 * and "no usable text". Measured on 08/09/2026 on
 * `13-Police-Sans-CMap.pdf`: a PDF whose font is an embedded subset
 * WITHOUT `/ToUnicode` made pdf.js return the raw codes as
 * control characters. The page therefore had lines, was not flagged
 * as scanned, never went to OCR — and published a control-character paragraph,
 * unreadable. The visual rendering of the PDF, for its part, is perfect: OCR is exactly
 * the tool that can recover it.
 *
 * The criterion is a DEFINITION, not a threshold: a page without a single
 * printable character has no text. The partial case — real text MIXED with
 * noise — requires a threshold, hence a product arbitration, and stays open
 * (the former ideas log (git history) v0.6, point 10).
 */
// eslint-disable-next-line sonarjs/duplicates-in-character-class -- the C0 and C1 control ranges are listed whole on purpose; they overlap \s
const READABLE = /[^\s\u0000-\u001F\u007F-\u009F]/;

export const hasReadableText = (lines: readonly Line[]): boolean => lines.some((l) => READABLE.test(l.text));
