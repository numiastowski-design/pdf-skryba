/** A raised, smaller run belongs to the line below it, a lowered, smaller one to the line above it: the one rule the page
 *  flow (`extractor/pdf-lines.ts`) and the table cells (`layout/cell-text.ts`) share, so a footnote call or a chemical
 *  subscript is read the same way in both.
 *  NOT here: the line grouping itself (`./fragment-cells.ts`, `extractor/pdf-lines.ts#groupItemsIntoLines`), nor the `sup` mark
 *  of the page flow (`extractor/pdf-lines.ts#isRaisedCall`, 19/10/2026; a table cell says it through `layout/cell-text.ts#CellLine.raised`).
 *  Called by: `extractor/pdf-lines.ts`, `layout/cell-text.ts`. */
import { BULLET } from "./list";
import { modeOf } from "./mode";

/**
 * A SUPERSCRIPT BELONGS TO ITS LINE (defect H, 22/09/2026).
 *
 * A superscript sits on its own baseline, a third of a body above the line it
 * belongs to — further than `SAME_LINE_TOLERANCE` — so it became a line of its
 * own, published somewhere else. Measured before the fix: « Release: 18 » +
 * « September 2020 » on one line and « th » as the paragraph ABOVE it, first
 * block of safedocs 0000609; same shape for « 81 saison » (fixture 27),
 * « 3 Tuesday of May » (0000523), « XXI siècle » (0000713). Worse on fixture 25
 * p2, where the raised « es » landed within 0.45 pt of an unrelated LEFT-COLUMN
 * line and was published as « Pour tester l'alarme es ». One character torn off
 * its word, and a word nobody can search.
 *
 * TWO READINGS, AND BOTH SEPARATE ON THEIR OWN — every item of every French or
 * English corpus PDF that sits above the line below it, inside that line's
 * horizontal span (225 items, 22/09/2026):
 *  - superscripts (6 items, 5 documents): size 0.630–0.727 of the host line's,
 *    baseline raised 0.272–0.370 of it;
 *  - everything else (219): size 0.909 of the host's and above, raised 0.500
 *    and above.
 * Empty intervals: 0.727–0.909 on the size, 0.370–0.500 on the rise. Starting
 * values to calibrate, both required — two independent readings must agree.
 *
 * A LENGTH CAP WAS NOT WRITTEN, although all six are one or two characters:
 * there is no second population for it here, and the size alone already sorts
 * the 225. `it.x > hLeft` is not a threshold but the definition — a superscript
 * FOLLOWS something on its line, and this also keeps the host line's `y`, read
 * from its leftmost item.
 *
 * WHAT ELSE MOVES, measured on the whole French and English corpus: five
 * documents, six places, nothing else. Two of the six also close a cut the lost
 * character was making — 0000713 p1 becomes one paragraph instead of three, and
 * fixture 25's « Pour tester l'alarme » becomes the heading it is drawn as. The
 * sixth pays for it: on fixture 25 p2, a left-column sentence and a right-column
 * spec line are now consecutive lines and join into one paragraph, because the
 * raised « e » no longer sits between them. That page is the two-column
 * interleaving already written down for this fixture; no letter is lost.
 *
 * THE MARK (19/10/2026, corrected: the IR has a `sup` mark since 24/09): in the page flow the raised item is a `sup` inline
 * (`extractor/pdf-lines.ts#isRaisedCall`), « 18<sup>th</sup> », so that « Money2. » reads « Money 2. » for a search. In a table
 * cell the text keeps the call on the baseline, « 18th », and `CellLine.raised` tells the renderer which glyphs are calls.
 */
export const SUPERSCRIPT_MAX_SIZE_RATIO = 0.8;
export const SUPERSCRIPT_MAX_RISE_EM = 0.6;
/** A raised item is a superscript from this rise (× the host's size). Starting value to calibrate: the six measured superscripts rise 0.272 to 0.370; an item that rises less shares the line's baseline (`SAME_LINE_TOLERANCE`, 1 pt). */
export const SUPERSCRIPT_MIN_RISE_EM = 0.2;
/** CELLS ONLY (`layout/cell-text.ts` passes it to `reseatSuperscripts`): a call that ENDS its host line (« m² », « 4² » alone in
 *  a cell) starts at or just after the host's right edge, not inside it, so it is reseated when it starts within this many em
 *  (x the host's size) past that edge. The page flow keeps 0: there, a small raised value of the next column of a tight grid not
 *  rebuilt would join the line (review 23/10/2026). Starting value to calibrate: the population of calls ending their line (gap
 *  past the edge) and the population of unrelated raised small items just past a line's end are not measured yet. */
export const TRAILING_CALL_GAP_EM = 0.3;
/** THE OTHER SIDE (04/11/2026, Mikolaj on the published Federal Register: « corriges »): a note NUMBER opens its note at
 *  the foot of a column — a small raised digit that ENDS just before the line's left edge. Measured on `sd-4133285`,
 *  25 numbers: the white between the number's right edge and its note is 0.13 to 0.16 em of the note's size. Such a
 *  number is reseated onto the line it opens, in every flow: it is then the line's first item, so `isRaisedCall`
 *  does not mark it `sup`, and the page reads « 1 The Commission notes… ». The nearest foreign raised item before a
 *  line's start is the previous column's end, a gutter away (`layout/gutter.ts#MIN_GUTTER_PT`, 8 pt: 0.9 em at a 9 pt
 *  body, 1.1 em at 7 pt). THE TWO POPULATIONS THE VALUE SITS BETWEEN: the 25 measured note numbers, 0.13 to 0.16 em;
 *  and the guard of `pdf-superscript.fixtures.test.ts` — a raised smaller letter 0.30 em before a line « follows
 *  nothing » and stays alone (synthetic, no document behind it; a first value of 0.3 took it and the test said so).
 *  Starting value to calibrate. */
export const LEADING_CALL_GAP_EM = 0.2;

/**
 * A SUBSCRIPT BELONGS TO ITS LINE TOO (issue defaut-file n° 33, fixture 48, 13/10/2026) — the mirror of the rule above.
 *
 * Fixture 48 page 5 (a two-column table): the « 2 » of « CO2 », « N2 », « H2O » is a run at 6.96 pt on a body of
 * 11.04 pt, its baseline 1.6 pt BELOW the line's — more than `SAME_LINE_TOLERANCE` (1 pt) — so it became a line of its
 * own, published elsewhere (« composée de N, CO et HO … 222 »): letters torn off their formula, a word nobody can find.
 *
 * TWO READINGS, measured as for the superscripts: every non-blank item of every French or English corpus PDF
 * (fixtures/pdf, the safedocs ones minus 0000441, 0000661, 0000944, 0000986, 0000877, 0000340, fixtures/docx-reel;
 * 8 774 items) that sits BELOW the line above it, inside that line's horizontal span, after the baseline grouping:
 *  - subscripts (22 items, ONE document, fixture 48 pages 5, 7, 8, 9): size 0.630 of the host line's, baseline lowered
 *    0.141 of it (the « 2 » of CO2, N2, H2O, and a « 3 », two « 4 »);
 *  - everything else (8 752): lowered 0.192 em and more. Between 0.192 and 0.2: sizes 0.909 and 1.000 (fixture 25 p2
 *    « 100 », table values of 10). Past 0.2: small items too, 0.651 at 0.229–0.265 (the table footnote calls « 3 » and
 *    « (1) » of fixture 49 pages 7, 8, 16), 0.830 at 0.240 (the « OFFICIAL » banner of 06), then 0.389 and more.
 * Empty intervals: 0.141–0.192 on the drop; 0.630–0.909 on the size among the items lowered 0.2 em or less. The size
 * alone does not separate (the small items of 49 and 06 are 0.23–0.27 em lower): the drop does, so both are required.
 * Starting values to calibrate; ONE document is a thin population, reopen the day another one shows another depth.
 *
 * `it.x > hLeft` and `it.x < hRight + trailingGapEm * hSize` as for the superscript: a subscript FOLLOWS something of its line. A subscript at
 * the start of its line is not moved (nothing to hang it on).
 *
 * WHAT ELSE MOVES, measured on the published text of the whole French and English corpus before and after: fixture 48
 * pages 5, 7, 8, 9, nothing else. A blank run is never moved: without that guard a space glyph of fixture 47 (pages 30
 * to 40) joined the heading above and added a trailing space.
 *
 * WHAT IS NOT DONE: no `sub` mark in the IR; « CO2 » is published on the baseline, like « 18th » for the superscript.
 */
const SUBSCRIPT_MAX_SIZE_RATIO = 0.8;
const SUBSCRIPT_MAX_DROP_EM = 0.2;

/**
 * A LONE LIST MARKER BELONGS TO THE TEXT BESIDE IT (fixture 50, ReportLab, 14/10/2026).
 *
 * ReportLab draws the bullet « • » at 12 pt, 2 pt LOWER than its item text at 10 pt (marker baseline 659.89, text 661.89).
 * That is more than `SAME_LINE_TOLERANCE`, so the marker became a line of its own, sorted after the text: each item was
 * published as a paragraph followed by a lone « • ».
 *
 * TWO POPULATIONS, the only ones measured so far (starting value to calibrate, thin: ONE document):
 *  - the marker of fixture 50: baseline 2 pt off on a 12 pt marker = 0.167 em, text starting 18 pt (1.5 em) to its right;
 *  - the next text line under a marker: a whole line pitch away, 1 em and more.
 * `MARKER_MAX_BASELINE_EM` sits between them. `MARKER_MAX_GAP_EM` (the text must START within 4 em to its right) is a
 * guard with no second population measured: it only keeps a marker from reaching across a column.
 *
 * Only a run that is ONLY a bullet character moves, onto the adjacent line whose leftmost item lies to the marker's
 * right and is not itself a marker. A line to its left, another marker, or text farther away: nothing moves.
 */
const MARKER_MAX_BASELINE_EM = 0.3;
const MARKER_MAX_GAP_EM = 4;

const isLoneMarker = (text: string | undefined): boolean => text !== undefined && text.trim() !== "" && text.replace(BULLET, "") === "";

/** Moves each lone list marker onto the adjacent line whose first item starts to its right at nearly its baseline. */
export const reseatListMarkers = <T extends SuperscriptReading>(groups: T[][], sizeOf: (item: T) => number): T[][] => {
  const moves: { from: number; to: number; item: T }[] = [];
  for (const [gi, group] of groups.entries()) {
    for (const it of group) {
      if (!isLoneMarker(it.text)) continue;
      const size = sizeOf(it);
      for (const hi of [gi - 1, gi + 1]) {
        const host = groups[hi];
        if (host === undefined || hi === gi) continue;
        const first = host.reduce((a, b) => (b.x < a.x ? b : a));
        if (isLoneMarker(first.text) || (first.text !== undefined && first.text.trim() === "")) continue;
        const gap = first.x - (it.x + it.width);
        if (!(first.x > it.x && gap <= MARKER_MAX_GAP_EM * size)) continue;
        if (!(Math.abs(first.y - it.y) <= MARKER_MAX_BASELINE_EM * size)) continue;
        moves.push({ from: gi, to: hi, item: it });
        break;
      }
    }
  }
  if (moves.length === 0) return groups;
  const moved = new Set(moves.map((m) => m.item));
  const next = groups.map((group) => group.filter((it) => !moved.has(it)));
  for (const move of moves) next[move.to]!.push(move.item);
  return next.filter((group) => group.length > 0);
};

/** The DOMINANT size of a line's items: the size carrying the most characters, a tie going to the LARGER size (between two halves,
 *  the one that carries the title). The ONE reading of a line's host size, shared by the page flow (`extractor/pdf-lines.ts`) and
 *  the table cells (`layout/cell-text.ts#raisedCallsOf`). */
export const dominantSizeByChars = <T>(items: readonly T[], textOf: (item: T) => string, sizeOf: (item: T) => number): number => {
  const weights = new Map<number, number>();
  for (const it of items) weights.set(sizeOf(it), (weights.get(sizeOf(it)) ?? 0) + textOf(it).length);
  return modeOf(weights, "largest") ?? 0;
};

/** What the rule reads of a run: its box and its text size (the page flow carries `fontSize`, a table glyph its
 *  `height`). */
export interface SuperscriptReading {
  x: number;
  y: number;
  width: number;
  /** When known: a blank run is never moved by the subscript rule (a small space glyph under a heading carries no
   *  subscript; moving it only added a trailing space to the heading, fixture 47). */
  text?: string;
}

/** A host line's largest size and horizontal span, by loops (a hostile line of 100k items would overflow a spread). */
const hostExtent = <T extends SuperscriptReading>(host: readonly T[]): { hLeft: number; hRight: number } => {
  let hLeft = Infinity;
  let hRight = -Infinity;
  for (const it of host) {
    hLeft = Math.min(hLeft, it.x);
    hRight = Math.max(hRight, it.x + it.width);
  }
  return { hLeft, hRight };
};

/** 🔴 THE HOST SIZE UNDER A CANDIDATE IS THAT OF THE TEXT BENEATH IT, not the tallest glyph of the line (05/11/2026,
 *  front page of the newspaper `sd-2479793`). A drop cap « C' » of 36 pt made its whole visual line — column 3 included,
 *  a visual line crosses the page — a host of 36 pt, and the two body lines above its baseline (9 pt, 19 and 10 pt
 *  higher) passed for its superscripts: « C'duest devenu un ri- tuel. Une semaine mois de mars », and column 3 opening
 *  on its third line. The items of the host that overlap the candidate horizontally decide; a call that opens its line,
 *  before the first item, takes the nearest item's size. */
const sizeUnder = <T extends SuperscriptReading>(it: T, host: readonly T[], sizeOf: (item: T) => number): number => {
  const right = it.x + it.width;
  // The item that covers the most of the candidate decides: a drop cap's box touches the word that follows it by a point.
  const overlap = (h: T): number => Math.min(right, h.x + h.width) - Math.max(it.x, h.x);
  const beneath = host.filter((h) => overlap(h) > 0);
  if (beneath.length > 0) return sizeOf(beneath.reduce((best, h) => (overlap(h) > overlap(best) ? h : best)));
  const gap = (h: T): number => (h.x >= right ? h.x - right : it.x - (h.x + h.width));
  return sizeOf(host.reduce((best, h) => (gap(h) < gap(best) ? h : best)));
};

/** Moves each raised, smaller item onto the line below and each lowered, smaller item onto the line above it. Decided
 *  against the ORIGINAL grouping, applied afterwards: a reseated item never travels twice. `sizeOf` is the item's text size in points. */
export const reseatSuperscripts = <T extends SuperscriptReading>(
  groups: T[][],
  sizeOf: (item: T) => number,
  /** How far past the host's right edge (em x host size) an item may start and still follow it; 0 = inside the host's span. */
  trailingGapEm = 0,
): T[][] => {
  // 🔴 L'HÔTE EST LA LIGNE QUE L'ITEM SURPLOMBE, PAS LA SUIVANTE DE LA LISTE (04/11/2026, Mikolaj sur la page
  // publiée : « pourquoi le 6 de registration n'est pas en exposant ? »). Les lignes d'une page à plusieurs colonnes
  // s'entrelacent dans l'ordre des ordonnées : la ligne qui suit un appel de note est souvent celle d'une AUTRE
  // colonne, qui ne le contient pas, et l'appel restait seul — publié comme un paragraphe d'un caractère. Mesuré sur
  // `sd-4133285` p1 : onze appels, neuf dans ce cas, le « 6 » de « registration.⁶ » n'ayant pour seul candidat
  // qu'une ligne de la colonne 3 [399→562]. On parcourt donc les lignes en dessous (en dessus pour un indice) et on
  // prend la PREMIÈRE, à portée, qui le contient. Le seuil de hauteur ne change pas ; seul le choix de l'hôte change.
  //
  // LIMITE ÉCRITE : une ligne large d'une autre colonne, à portée et contenant l'appel, le prendrait — c'est le même
  // risque qu'avant quand elle était la suivante, borné par « la plus proche d'abord ».
  const extents = groups.map((host) => ({ hy: host[0]!.y, ...hostExtent(host) }));
  const over = (it: T, hi: number, gap: number, hSize: number): boolean => {
    const { hLeft, hRight } = extents[hi]!;
    // Un numéro qui OUVRE sa note finit juste avant le bord gauche de la ligne (`LEADING_CALL_GAP_EM`) ; un appel
    // qui la SUIT commence dedans, ou juste après son bord droit pour une cellule (`trailingGapEm`).
    const right = it.x + it.width;
    const opens = right <= hLeft && hLeft - right <= LEADING_CALL_GAP_EM * hSize;
    return opens || (it.x > hLeft && it.x < hRight + gap * hSize);
  };
  // COST (review 06/11/2026): the cheap height test comes first, and the walk stops once no further line can host the
  // item: with the lines top to bottom (checked, not assumed), the distance only grows, and no host is taller than the
  // tallest item of the page.
  let tallest = 0;
  for (const group of groups) for (const it of group) tallest = Math.max(tallest, sizeOf(it));
  const topToBottom = extents.every((e, i) => i === 0 || e.hy <= extents[i - 1]!.hy);
  const hostBelow = (gi: number, it: T): number | undefined => {
    for (let hi = gi + 1; hi < groups.length; hi++) {
      const { hy } = extents[hi]!;
      if (topToBottom && it.y - hy > SUPERSCRIPT_MAX_RISE_EM * tallest) break;
      if (!(it.y > hy)) continue;
      const hSize = sizeUnder(it, groups[hi]!, sizeOf);
      if (!(it.y - hy <= SUPERSCRIPT_MAX_RISE_EM * hSize)) continue;
      if (!(sizeOf(it) <= SUPERSCRIPT_MAX_SIZE_RATIO * hSize)) continue;
      if (over(it, hi, trailingGapEm, hSize)) return hi;
    }
    return undefined;
  };
  const hostAbove = (gi: number, it: T): number | undefined => {
    for (let hi = gi - 1; hi >= 0; hi--) {
      const { hy } = extents[hi]!;
      if (topToBottom && hy - it.y > SUBSCRIPT_MAX_DROP_EM * tallest) break;
      if (!(it.y < hy)) continue;
      const hSize = sizeUnder(it, groups[hi]!, sizeOf);
      if (!(hy - it.y <= SUBSCRIPT_MAX_DROP_EM * hSize)) continue;
      if (!(sizeOf(it) <= SUBSCRIPT_MAX_SIZE_RATIO * hSize)) continue;
      if (over(it, hi, trailingGapEm, hSize)) return hi;
    }
    return undefined;
  };

  const moves: { from: number; to: number; item: T }[] = [];
  const claimed = new Set<T>();
  for (const [gi, group] of groups.entries()) {
    for (const it of group) {
      const to = hostBelow(gi, it);
      if (to === undefined) continue;
      moves.push({ from: gi, to, item: it });
      claimed.add(it);
    }
  }
  for (const [gi, group] of groups.entries()) {
    for (const it of group) {
      if (claimed.has(it) || (it.text !== undefined && it.text.trim() === "")) continue;
      const to = hostAbove(gi, it);
      if (to === undefined) continue;
      moves.push({ from: gi, to, item: it });
    }
  }
  if (moves.length === 0) return groups;
  const moved = new Set(moves.map((m) => m.item));
  const next = groups.map((group) => group.filter((it) => !moved.has(it)));
  for (const move of moves) next[move.to]!.push(move.item);
  return next.filter((group) => group.length > 0);
};
