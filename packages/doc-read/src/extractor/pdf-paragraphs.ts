/** Where one paragraph ends and the next begins, which of them is a heading,
 *  and which consecutive ones form a list.
 *  Assembles the lists here (`groupLists`, `stripMarker`, `candidateOf`) from the run
 *  detection of `layout/list.ts`. NOT here: the predicates that separate two lines
 *  (`extractor/pdf-line-breaks.ts`), nor the heading scale itself
 *  (`layout/heading-sizes.ts`, `extractor/pdf-document-scale.ts`).
 *  Called by: `extractor/pdf-page-stages.ts`, `extractor/pdf-page-tables.ts`,
 *  `extractor/pdf-cell-paragraphs.ts`. */

/**
 * PDF has no semantic paragraph markers — unlike docx/pptx's real `<a:p>`/
 * `<w:p>` boundaries, "where does one paragraph end and the next begin" has
 * to be inferred from layout. Reconstructed here from `extractTextItems`'
 * per-line geometry using two signals, both read off
 * `fixtures/pdf/05a-Rapport-Annuel-Digital.pdf`'s real numbers rather than
 * guessed (MIKSUDOC « Spécification technique » T10: thresholds calibrated in C1):
 *  1. A **font-size change** from the previous line always starts a new
 *     paragraph. In the fixture this alone accounts for every real
 *     paragraph/heading break — headings and body text differ in size, and a
 *     caption/footer in a smaller size after body text does too.
 *  2. Within the SAME font size, a vertical gap large relative to that size
 *     also starts a new paragraph (catches same-style paragraph breaks a
 *     font-size change alone wouldn't). The line-wrap gap for continuing
 *     text in the fixture is ~1.45–1.8× the font size depending on the
 *     paragraph's own line spacing; 2.2 sits safely above the highest of
 *     those with room to spare, without relying on a fragile fixture-only
 *     margin the way a single global ratio without signal 1 would have.
 *
 * A heading IS promoted from SIZE ALONE (document and page scales,
 * `extractor/pdf-document-scale.ts`). The criteria path, the numbered-bold rule,
 * the series pass, the grey bands and the figure demotion were removed on
 * 05/11/2026: « on se base sur la taille des textes et on essaye de
 * rester fidèle aux proportions, quitte à inventer des titres ».
 */

import { maxOf, minOf } from "doc-ir/lib/extent";
import type { ImageRef, Inline, InlineMark, IRBlock } from "doc-ir/lib/ir";
import { CUT_MARK, cutAcrossLines } from "doc-ir/layout/cut-word";
import type { HeadingLevel } from "doc-ir/layout/heading-sizes";
import { modeOf } from "doc-ir/layout/mode";
import { SAME_LINE_PT } from "doc-ir/layout/tolerances";
import { inducedMarkers, leadingMarkerToken } from "doc-ir/layout/induced-markers";
import {
  blockReading,
  bulletRuns,
  itemTextLeft,
  listRuns,
  markerOf,
  orderedPieces,
  quantiseIndent,
  type ListCandidate,
  type Marker,
} from "doc-ir/layout/list";
import { linesFromGroups } from "./pdf-lines";
import type { ImageCandidate, Line, PositionedItem, TextRun } from "./pdf-model";
import {
  continuesCentredLine,
  endsWithPageLeader,
  hangsFromMarker,
  isCentredPair,
  isDeliberateBreak,
  startsNewItem,
} from "./pdf-line-breaks";

// See module doc: empirically calibrated against fixtures/pdf/05a, not guessed.
// Exported for `pdf-cell-paragraphs.ts`, which asks the same question of the
// lines of a one-column table's cell: one value, read in both places.
export const PARAGRAPH_BREAK_GAP_RATIO = 2.2;

/** Les morceaux accumulés deviennent des `Inline`, en fusionnant les voisins de
 *  même emphase : « ABSENCES » en gras suivi de « : 6 demi-journées » en maigre
 *  fait deux inlines, pas quinze. Un morceau de texte vide ne produit rien —
 *  SAUF s'il porte un marqueur bitmap (son image seule doit survivre). */
const marksOf = (r: TextRun): InlineMark[] => [
  ...(r.bold ? ["strong" as const] : []),
  ...(r.italic === true ? ["em" as const] : []),
  ...(r.sup === true ? ["sup" as const] : []),
];

const inlinesFromRuns = (runs: readonly TextRun[]): Inline[] =>
  runs
    .filter((r) => r.text.length > 0 || r.marker !== undefined)
    .map((r) => ({
      text: r.text,
      // A marker is never bold nor a link: it is a picture, not text.
      ...(r.marker === undefined && marksOf(r).length > 0 ? { marks: marksOf(r) } : {}),
      ...(r.marker !== undefined ? { image: r.marker } : {}),
      ...(r.marker === undefined && r.href !== undefined ? { href: r.href } : {}),
    }));

/** What a segment of lines is measured against: its margins, its usual line gap and its body indent. */
interface SegmentMeasures {
  marginLeft: number;
  marginRight: number;
  blockWidth: number;
  /** The median gap between two consecutive baselines. */
  medianGap: number;
  bodyIndent: number;
}

/** What the caller decides about headings (see the parameters of `paragraphsFromLines`). */
interface HeadingPolicy {
  headingLevelOf: ((size: number) => HeadingLevel | undefined) | undefined;
  /** Smaller than the body of the page (`pdf-document-scale.ts#scaleOfPage`): the paragraph comes out as « Small text ». */
  isSmallSize: ((size: number) => boolean) | undefined;
}

/** The paragraph being gathered. */
interface PendingParagraph {
  runs: TextRun[];
  /** The size of the paragraph being gathered. A change of size already opens a
   *  paragraph (see `startsParagraph`), so all its lines share it. */
  size: number | undefined;
  /** The index of the FIRST line of the paragraph being gathered, and their count. */
  first: number;
  count: number;
}

/** The fewest gaps (so three lines) a segment needs for its median gap to be a yardstick. With ONE gap the median is that
 *  gap itself, so every gap feature of both lines reads 1.0 (« stuck to the next line »): 4 real headings of
 *  docx-heading-reel/17 (« Note 4. Prêts ») were lost on 14/10/2026 once page furniture left a body segment of two lines.
 *  Measured on docx-heading-reel and docx-reel (14/10/2026): 0 false headings added, +1 found. */
const MIN_GAPS_FOR_MEDIAN = 2;

/** The median gap between two consecutive baselines, or 0 (unknown) for fewer than `MIN_GAPS_FOR_MEDIAN` gaps. */
const medianGapOf = (lines: readonly Line[]): number => {
  const gaps: number[] = [];
  for (let i = 0; i < lines.length - 1; i++) gaps.push(lines[i]!.y - lines[i + 1]!.y);
  if (gaps.length < MIN_GAPS_FOR_MEDIAN) return 0;
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  return sortedGaps.length > 0 ? sortedGaps[Math.floor(sortedGaps.length / 2)]! : 0;
};

/**
 * THE BODY INDENT: the most frequent left margin of the segment. It is the
 * reference against which "indented" means something — an indent in absolute
 * points means nothing. Measured on the SEGMENT and not on the document: on a
 * page in columns, it is the column's margin.
 *
 * ⚠️ **WRITTEN LIMIT, MEASURED AND LEFT ALONE (22/09/2026): a page that is
 * MOSTLY a list elects the list's own margin as the body's**, and then no
 * item is indented against it. Safedocs 0000609 publishes 35 items as plain
 * paragraphs for that reason alone — p4 (13 marked lines at x=90 against 10
 * body lines at x=72) and p8 (22 at x=96 against 7). No text is lost.
 *
 * Tried and set aside the same day: leaving MARKED lines out of the vote. It
 * gives 0000609 p4 its 15 items, but over the 39 French and English PDFs it
 * also elects a continuation indent as the body on 0000713 p8 (126 pt, the
 * hanging indent of « a) », instead of 108) and breaks the ordered list that
 * lot « 30 » fixed there, and it invents two lists on the form 0000523 (p2
 * and p5, 6 items of address boxes). +4 true lists, +2 false, −1 regression:
 * the vote is the wrong place. What is missing is a reading of « the body
 * margin » that a list-heavy page cannot outvote, and that is its own lot.
 */
const bodyIndentOf = (lines: readonly Line[]): number => {
  const indentCounts = new Map<number, number>();
  for (const line of lines) {
    const q = quantiseIndent(line.left);
    indentCounts.set(q, (indentCounts.get(q) ?? 0) + 1);
  }
  // On a tie the first indent inserted wins.
  return modeOf(indentCounts, "first") ?? 0;
};

const measureSegment = (lines: readonly Line[]): SegmentMeasures => {
  // The reference margin is the SEGMENT's: on a page in two bands,
  // `readingSegments` has already separated the columns, so it is the column's
  // margin. Taking it on the block would amount to asking the widest line
  // whether it reaches its own end, which is always true.
  //
  // ⚠️ WRITTEN LIMIT (22/09/2026): A SINGLE LINE WIDER THAN THE OTHERS SETS THE
  // MARGIN OF THE WHOLE SEGMENT, and it may be nobody's margin.
  //
  // Measured on `0000523` p6: the browser's footer
  // ("https://edge.pse.com.ph/… 2/3", placed 26.5 pt from the edge like the header,
  // where the 28 lines of the press release start at 45.5) extends to 585.5
  // when they stop between 549 and 555. Thirty points of invented margin
  // against 0.45 em (≈ 4.5 pt) of slack in `isDeliberateBreak`: every line end
  // becomes deliberate, and the release comes out as 28 one-line paragraphs cut
  // mid-sentence. Until lot "39" the gutter cut of this document — drawn from a
  // right band that held only "1/3" — put this footer in another segment and
  // hid the defect by accident.
  //
  // TRIED THEN SET ASIDE, the same day: "the margin is the edge that at least TWO
  // lines reach to within 1 pt" (the form of `pdf-bands.ts#columnEdge`).
  // It repairs `0000523` p6 and p5, but it collapses on ragged-right text
  // where no pair of lines shares its right edge: on `0000609` p7 it
  // returns 195.7 instead of 534.9 — the width of two neighbouring list items — and
  // glues the item "6. Ground transport arrangements" to the next paragraph. One
  // false gluing against two repaired pages: the discriminant is not
  // defined, so we do not decide. The real cause is elsewhere — this footer
  // is furniture that `layout/page-furniture.ts` does not recognise.
  const marginRight = lines.length > 0 ? maxOf(lines, (l) => l.right) : 0;
  const marginLeft = lines.length > 0 ? minOf(lines, (l) => l.left) : 0;
  return {
    marginLeft,
    marginRight,
    blockWidth: marginRight - marginLeft,
    medianGap: medianGapOf(lines),
    bodyIndent: bodyIndentOf(lines),
  };
};

/** Le marqueur qu'un document s'est donné (`layout/induced-markers.ts`), quand la liste FIXE n'en voit aucun : le
 *  premier jeton de la ligne en fait partie. La sûreté vient de l'induction elle-même — un jeton n'est induit que s'il
 *  ouvre trois lignes au même retrait dans ce document — pas de ce test, qui ne fait que relire sa conclusion. */
const inducedMarkerOf = (text: string, induced: readonly string[]): Marker | undefined => {
  const found = leadingMarkerToken(text);
  return found !== undefined && induced.includes(found.token) ? { kind: "bullet", length: found.length } : undefined;
};

/** What a block brings to the list decision: its indent against the body, its
 *  marker, its left edge, and for a numbered block where its text starts —
 *  read after the marker and on the second line (`itemTextLeft`). */
const candidateOf = (blockLines: readonly Line[], bodyIndent: number, induced: readonly string[]): ListCandidate => {
  const first = blockLines[0];
  if (first === undefined) return { indented: false, marker: undefined };
  const marker = markerOf(first.text) ?? inducedMarkerOf(first.text, induced);
  const afterMarker =
    marker !== undefined &&
    first.lead !== undefined &&
    first.lead.text.trim() === first.text.slice(0, marker.length).trim()
      ? first.lead.nextLeft
      : undefined;
  const textLeft =
    marker?.kind === "ordered" ? itemTextLeft({ afterMarker, secondLine: blockLines[1]?.left }) : undefined;
  return {
    indented: quantiseIndent(first.left) !== bodyIndent,
    marker,
    left: minOf(blockLines, (l) => l.left),
    ...(textLeft !== undefined ? { textLeft } : {}),
    ...blockReading(blockLines),
  };
};

/** The heading level of the gathered paragraph: its SIZE names one, or nothing does (05/11/2026 — the only path). */
const headingOf = (pending: PendingParagraph, policy: HeadingPolicy): HeadingLevel | undefined =>
  pending.size === undefined ? undefined : policy.headingLevelOf?.(pending.size);

/** Emits the paragraph being gathered — as a HEADING when its size names one. */
const flushParagraph = (
  pending: PendingParagraph,
  lines: readonly Line[],
  m: SegmentMeasures,
  policy: HeadingPolicy,
  blocks: IRBlock[],
  candidates: ListCandidate[],
  /** Les marqueurs que CE document s'est donnés (`layout/induced-markers.ts`) ; vide quand il n'en a aucun. Sans
   *  valeur par défaut : les deux appelants le passent, et un défaut silencieux ferait lire un document sans ses
   *  propres marqueurs sans que rien ne le dise (revue du 30/10/2026). */
  induced: readonly string[],
): void => {
  if (pending.runs.length === 0) return;
  const level = headingOf(pending, policy);
  const inlines = inlinesFromRuns(pending.runs);
  candidates.push(candidateOf(lines.slice(pending.first, pending.first + pending.count), m.bodyIndent, induced));
  const small = level === undefined && policy.isSmallSize?.(lines[pending.first]!.fontSize) === true;
  const block: IRBlock =
    level === undefined
      ? { kind: "paragraph", inlines, ...(small ? { size: "small" as const } : {}) }
      : { kind: "heading", level, inlines };
  blocks.push(block);
  pending.runs = [];
  pending.count = 0;
};

/** The junction of two lines adds a space to the PREVIOUS piece, never to the
 *  next one: put in front of a bold piece, it would produce
 *  `<strong> Absences</strong>`, an emphasis that starts with a blank. */
/** Two text runs of one style (emphasis, link, raised call) merge into one piece. */
const sameStyle = (a: TextRun, b: TextRun): boolean =>
  a.bold === b.bold && (a.italic === true) === (b.italic === true) && a.href === b.href && a.sup === b.sup;

/** Whether the junction between two visual lines of a paragraph writes a space.
 *  🔴 A WORD THE PAPER CUT TAKES NO JUNCTION SPACE (03/11/2026). Measured on 100 wild PDFs: 11 documents, 75 words,
 *  8 producer families publish « data manage- ment » — the hyphen AND the space, so neither « management » nor
 *  « manage-ment » is findable, and the promise of this product is that a word stays findable. The rule is
 *  `layout/cut-word.ts`, already measured on 13 documents and 57 cut words, and NARROW on purpose: a digit after the
 *  hyphen keeps its space, because gluing « Total - » to « 12,00 » fabricates a figure the document never held.
 *  Written as its own function because the branch inside `appendRuns` cost a `sonarjs/cognitive-complexity` finding,
 *  and a quality ratchet is never refrozen upward — the same reason `continuedWith` exists below. */
const junctionWritesSpace = (previous: TextRun | undefined, next: TextRun | undefined, separator: boolean): boolean =>
  separator && previous !== undefined && !cutAcrossLines(previous.text, next?.text ?? "");

/** A piece copied into the paragraph being gathered, with its marks and nothing undefined. Its own function: the
 *  spreads cost `appendRuns` a complexity finding when the italic joined them (05/11/2026). */
const copyOfRun = (run: TextRun): TextRun => ({
  text: run.text,
  bold: run.bold,
  ...(run.italic === true ? { italic: true } : {}),
  ...(run.marker !== undefined ? { marker: run.marker } : {}),
  ...(run.href !== undefined ? { href: run.href } : {}),
  ...(run.sup === true ? { sup: true } : {}),
});

/** A WORD THE PAPER CUT: the junction replaces its hyphen by the cut mark, resolved once the whole document is read
 *  (`layout/cut-word.ts#resolveCutHyphens`). Its own function for the complexity ratchet, like its two neighbours. */
const markCutJunction = (previous: TextRun | undefined, next: TextRun | undefined, separator: boolean): void => {
  if (separator && previous !== undefined && cutAcrossLines(previous.text, next?.text ?? ""))
    previous.text = `${previous.text.slice(0, -1)}${CUT_MARK}`;
};

const appendRuns = (current: TextRun[], runs: readonly TextRun[], separator: boolean): void => {
  // A MARKER TAKES NO JUNCTION SPACE AND NO NEIGHBOUR: the space becomes a run of its own.
  const previous = current[current.length - 1];
  const writesSpace = junctionWritesSpace(previous, runs[0], separator);
  markCutJunction(previous, runs[0], separator);
  if (writesSpace && previous !== undefined) {
    // A link takes the junction's space only when the next line goes on with the same link (`pdf-links.ts`).
    if (previous.marker === undefined && (previous.href === undefined || previous.href === runs[0]?.href))
      previous.text += " ";
    else current.push({ text: " ", bold: false });
  }
  for (const run of runs) {
    const last = current[current.length - 1];
    if (last !== undefined && last.marker === undefined && run.marker === undefined && sameStyle(last, run))
      last.text += run.text;
    else current.push(copyOfRun(run));
  }
};

/** The line's first ink run is a raised note NUMBER (`pdf-lines.ts#isRaisedCall`, leading digits): the line opens a
 *  note, whatever the line above it looked like. Federal Register `sd-4133285` p1 (05/11/2026): « 6 See id. … » fills
 *  its line to the margin, so « 7 Id. » below it passed for a wrap, and the two notes came out as one paragraph. A
 *  call INSIDE a line decides nothing. */
const opensWithNoteNumber = (line: Line): boolean => {
  const first = line.runs.find((run) => run.text.trim() !== "");
  return first?.sup === true && /^\d+$/.test(first.text.trim());
};

/** Does `line` open a new paragraph after `prev`? A font-size change, a large vertical gap, a new list item, a note
 *  number opening the line, a centred pair or a deliberate break (see the predicates of `pdf-line-breaks.ts`). */
/**
 * A COLUMN RUNNING ALONGSIDE A PICTURE IS MEASURED AGAINST ITS OWN LINES (12/11/2026 : « on repère les lignes
 * qui sont collées à la photo, de celles qui finissent avant […] si une ligne est significativement plus courte que
 * celles qui étaient à côté de l'image », « le nb à fixer c'est 4 caractères »). A picture narrows the column it stands
 * beside: those lines stop at the picture, far short of the SEGMENT's margin, so `isDeliberateBreak` called every one
 * of them deliberate and published the column as one paragraph per line — the staircase of the newspaper `sd-2479793`.
 * The reference for such a line is the right edge of the lines sharing its picture, and nothing else moves.
 *
 * WHY NOT THE PICTURE'S OWN EDGE: the lines' own edge needs no gutter constant and says what the text actually did.
 * WHY NOT A MARGIN SHARED BY N LINES anywhere on the page: tried on 22/09/2026 and set aside — it collapses on
 * ragged-right text where no pair of lines shares an edge (`measureSegment`). Beside a picture the group is given by
 * the geometry, not by a count.
 *
 * WRITTEN LIMIT: this heals only a column that runs beside a picture. A ragged-right column with no picture keeps its
 * staircase.
 */
const SLACK_CHARS_BESIDE_A_PICTURE = 4;

/** `line` stops more than `SLACK_CHARS_BESIDE_A_PICTURE` characters short of `limit`, the right edge of the lines that
 *  share its picture. The character width is the line's OWN mean advance — its width over its character count — so no
 *  font metric is read and the measure follows the size of the text it judges. */
const fallsShortBesideAPicture = (line: Line, limit: number): boolean => {
  const chars = line.text.length;
  if (chars === 0) return false;
  const advance = (line.right - line.left) / chars;
  return advance > 0 && limit - line.right > SLACK_CHARS_BESIDE_A_PICTURE * advance;
};

/** The right edge each line is judged against when it runs beside a picture: the furthest right reached by the lines
 *  sharing that same picture. Read once per segment, so the question costs nothing per line. */
const asideLimitsOf = (
  lines: readonly Line[],
  asidePicture: ((line: Line) => number | undefined) | undefined,
  marginRight: number,
): ((line: Line) => number | undefined) => {
  if (asidePicture === undefined) return () => undefined;
  // A PICTURE THAT STANDS BEYOND THE SEGMENT'S OWN MARGIN NARROWS NOTHING: it belongs to another column of the page,
  // and the lines here already reach their end. Without this the photo of a third column would take over the reading
  // of the first one.
  const narrows = (line: Line): number | undefined => {
    const picture = asidePicture(line);
    return picture !== undefined && picture < marginRight ? picture : undefined;
  };
  const edges = new Map<number, number>();
  for (const line of lines) {
    const picture = narrows(line);
    if (picture !== undefined) edges.set(picture, Math.max(edges.get(picture) ?? line.right, line.right));
  }
  return (line) => {
    const picture = narrows(line);
    return picture === undefined ? undefined : edges.get(picture);
  };
};

/** `line` opens a marker of its OWN at the same left as `prev`, or further left: a sibling item, never the wrap of
 *  `prev`, however full `prev` looked against its picture. `pdf-line-breaks.ts#startsNewItem` cannot see this one — it
 *  asks for an outdent, and these items are flush with each other. Scoped to the picture rule on purpose: everywhere
 *  else `isDeliberateBreak` already separates them. Booklet `26-Livret-Accueil-Canva.pdf` p9, published 12/11/2026:
 *  « 2) sélectionner → groupe IT service desk » butts against the picture and swallowed « 3) sélectionner la raison
 *  du signalement… ». */
const opensASiblingItem = (prev: Line, line: Line): boolean =>
  markerOf(line.text) !== undefined && line.left <= prev.left + SAME_LINE_PT;

/** What the segment lends to the paragraph decision: its other lines, its right margin, and the two readers that
 *  answer a question about a PAIR of lines. Gathered in one place since 13/11/2026 — `startsParagraph` had grown to
 *  six arguments, one over the ratchet, and five of them were the same for every line of the segment. */
interface SegmentContext {
  lines: readonly Line[];
  marginRight: number;
  centredContainerWidth: ((line: Line, next: Line, segment: readonly Line[]) => number | undefined) | undefined;
  asideLimitOf: (line: Line) => number | undefined;
}

/**
 * THE GEOMETRIC HALF of the paragraph decision: `prev` is short, and the question is whether it is short BECAUSE the
 * author ended there.
 *
 * THE LINE ABOVE IS JUDGED ON THE OBSTACLE *IT* HAD (12/11/2026). The question asked here is « does `prev`
 * stop short? », so only `prev`'s own geometry can answer it. Until 12/11 both lines had to share the picture, and
 * the pair crossing the picture's BOTTOM edge fell back on the segment's margin — a width `prev` could never reach,
 * the picture was in the way, so it was declared deliberately short and cut. Measured on
 * `fixtures/pdf/26-Livret-Accueil-Canva.pdf` p5: « Efficience Intelligente: aller à l'essentiel pour » stops at
 * 362.3, the picture starts at 363.9, the segment's margin is 551.4.
 */
const breaksOnGeometry = (prev: Line, line: Line, ctx: SegmentContext): boolean => {
  if (hangsFromMarker(prev, line)) return false;
  if (
    isCentredPair(prev, line) &&
    !continuesCentredLine(prev, line, ctx.centredContainerWidth?.(prev, line, ctx.lines))
  )
    return true;
  const asideLimit = ctx.asideLimitOf(prev);
  return asideLimit === undefined
    ? isDeliberateBreak(prev, line, ctx.marginRight)
    : fallsShortBesideAPicture(prev, asideLimit) || opensASiblingItem(prev, line);
};

const startsParagraph = (prev: Line | undefined, line: Line, ctx: SegmentContext): boolean =>
  prev === undefined ||
  endsWithPageLeader(prev.text) ||
  line.fontSize !== prev.fontSize ||
  (prev.y - line.y) / line.fontSize > PARAGRAPH_BREAK_GAP_RATIO ||
  startsNewItem(prev, line) ||
  opensWithNoteNumber(line) ||
  breaksOnGeometry(prev, line, ctx);

export const paragraphsFromLines = (
  lines: Line[],
  /** The heading level of a font size, or nothing. Absent, the function returns exactly what it returned before
   *  headings were detected. */
  headingLevelOf?: (size: number) => HeadingLevel | undefined,
  /** The width of the container two lines share — see
   *  `pdf-line-breaks.ts#centredContainerReader`. Absent, every centred pair
   *  splits, as before 21/09/2026. */
  centredContainerWidth?: (line: Line, next: Line, segment: readonly Line[]) => number | undefined,
  /** Is a size smaller than the page's body (« Small text »)? Absent, no paragraph is small. */
  isSmallSize?: (size: number) => boolean,
  /** The left edge of the picture this line runs beside, or nothing (`fallsShortBesideAPicture`). Lines returning the
   *  same edge are measured against each other. Absent, the segment's margin decides for every line, as before. */
  asidePicture?: (line: Line) => number | undefined,
): IRBlock[] => {
  const measures = measureSegment(lines);
  const asideLimitOf = asideLimitsOf(lines, asidePicture, measures.marginRight);
  const policy: HeadingPolicy = { headingLevelOf, isSmallSize };
  const blocks: IRBlock[] = [];
  /** One list candidate per emitted block, in the same order — see `listRuns`. */
  const candidates: ListCandidate[] = [];
  // Les marqueurs que CE segment se donne, induits une fois puis relus pour chaque bloc : un jeton court qui ouvre
  // trois lignes au MÊME retrait est une puce de ce document (`layout/induced-markers.ts`, 30/10/2026).
  // La liste fixe de `markerOf` passe d'abord ; l'induction ne sert que là où elle ne voit rien.
  const induced = inducedMarkers(lines.map((line) => ({ text: line.text, left: line.left })));
  const pending: PendingParagraph = { runs: [], size: undefined, first: 0, count: 0 };
  let prev: Line | undefined;
  const segment: SegmentContext = { lines, marginRight: measures.marginRight, centredContainerWidth, asideLimitOf };

  for (const [index, line] of lines.entries()) {
    if (startsParagraph(prev, line, segment)) {
      flushParagraph(pending, lines, measures, policy, blocks, candidates, induced);
      pending.size = line.fontSize;
      pending.first = index;
      pending.count = 1;
      appendRuns(pending.runs, line.runs, false);
    } else {
      pending.count += 1;
      appendRuns(pending.runs, line.runs, true);
    }
    prev = line;
  }
  flushParagraph(pending, lines, measures, policy, blocks, candidates, induced);
  return groupLists(blocks, candidates);
};

/**
 * CONSECUTIVE ITEMS BECOME A LIST (`layout/list.ts`, 16/09/2026).
 *
 * A marker is REMOVED from the item's text only when the list's own marker
 * replaces it: a bullet in a bullet list (`<ul>`), a number in an ordered list
 * (`<ol>`). Keeping it would print it twice — « •• one ». GROBID keeps every
 * marker, because its TEI renders none; our target does.
 *
 * Every other marker STAYS in the text (22/09/2026): a letter or a Roman
 * numeral always (`layout/list.ts#MarkerKind`), and a bullet inside an ordered
 * list or a number inside a bullet list, which the list's own marker would
 * silently replace.
 *
 * A block that is not a paragraph closes any run in progress: a heading in the
 * middle of a list is not part of it.
 *
 * An ORDERED run goes through `orderedPieces` (22/09/2026): an unnumbered block
 * is an item's next paragraph or closes the list, and a list whose numbers do not
 * follow exactly is published as paragraphs keeping their written numbers.
 */
const groupLists = (blocks: readonly IRBlock[], candidates: readonly ListCandidate[]): IRBlock[] => {
  const none: ListCandidate = { indented: false, marker: undefined };
  const listCandidates = blocks.map((b, i) => (b.kind === "paragraph" ? (candidates[i] ?? none) : none));
  const runs = listRuns(listCandidates);
  const bulletRunList = freeBulletRuns(bulletRuns(listCandidates), runs);
  if (runs.length === 0 && bulletRunList.length === 0) return [...blocks];
  const sequence = [
    ...runs.map((r) => ({ ...r, tail: undefined as number | undefined, simpleBullet: false })),
    ...bulletRunList.map((r) => ({ start: r.start, end: r.end, tail: r.tail, ordered: false, simpleBullet: true })),
  ].sort((a, b) => a.start - b.start);

  const out: IRBlock[] = [];
  let index = 0;
  for (const run of sequence) {
    while (index < run.start) out.push(blocks[index++]!);
    if (run.simpleBullet) {
      out.push(simpleBulletList(blocks, candidates, run));
      index = (run.tail ?? run.end) + 1;
      continue;
    }
    if (run.ordered) out.push(...orderedRunBlocks(blocks, candidates, listCandidates, run));
    else out.push(bulletList(blocks, candidates, run.start, run.end));
    index = run.end + 1;
  }
  while (index < blocks.length) out.push(blocks[index++]!);
  return out;
};

/** The block at `i` without its marker, when that marker is of the list's own `kind` (the list's marker replaces it). */
const withoutMarkerAt = (
  blocks: readonly IRBlock[],
  candidates: readonly ListCandidate[],
  i: number,
  kind: "ordered" | "bullet",
): IRBlock => {
  const block = blocks[i]!;
  const marker = candidates[i]?.marker;
  return marker === undefined || marker.kind !== kind || !("inlines" in block)
    ? block
    : stripMarker(block, marker.length);
};

/** The simple bulleted runs (`layout/list.ts#bulletRuns`), unless a run above already holds one of their blocks. */
const freeBulletRuns = <R extends { start: number; end: number; tail?: number | undefined }>(
  bulletRunList: readonly R[],
  runs: readonly { start: number; end: number }[],
): R[] => {
  const taken = (i: number): boolean => runs.some((r) => i >= r.start && i <= r.end);
  return bulletRunList.filter((r) => {
    for (let i = r.start; i <= (r.tail ?? r.end); i++) if (taken(i)) return false;
    return true;
  });
};

/** A bulleted list of one block per item, from `start` to `end`. */
const bulletList = (
  blocks: readonly IRBlock[],
  candidates: readonly ListCandidate[],
  start: number,
  end: number,
): IRBlock => {
  const items: IRBlock[][] = [];
  for (let i = start; i <= end; i++) items.push([withoutMarkerAt(blocks, candidates, i, "bullet")]);
  return { kind: "list", ordered: false, items };
};

/** A simple bulleted run as a list; its tail goes on with the last item's own text, one paragraph (a space between the two). */
const simpleBulletList = (
  blocks: readonly IRBlock[],
  candidates: readonly ListCandidate[],
  run: { start: number; end: number; tail: number | undefined },
): IRBlock => {
  const list = bulletList(blocks, candidates, run.start, run.end);
  if (list.kind !== "list") return list;
  const { items } = list;
  const tail = run.tail === undefined ? undefined : blocks[run.tail];
  const last = items[items.length - 1]![0]!;
  if (tail !== undefined && "inlines" in tail && "inlines" in last) {
    const joined = last.inlines.map((inline) => ({ ...inline }));
    const end = joined[joined.length - 1];
    if (end?.image === undefined && end !== undefined) end.text += " ";
    else joined.push({ text: " " });
    items[items.length - 1] = [{ ...last, inlines: [...joined, ...tail.inlines] }];
  }
  return list;
};

/** An ordered run as its pieces: lists, and the paragraphs a broken numbering leaves with their written numbers. */
const orderedRunBlocks = (
  blocks: readonly IRBlock[],
  candidates: readonly ListCandidate[],
  listCandidates: readonly ListCandidate[],
  run: { start: number; end: number },
): IRBlock[] =>
  orderedPieces(listCandidates, run.start, run.end).map((piece): IRBlock =>
    piece.kind === "paragraph"
      ? blocks[piece.index]!
      : {
          kind: "list",
          ordered: true,
          items: piece.items.map(([opener, ...rest]) => [
            withoutMarkerAt(blocks, candidates, opener!, "ordered"),
            ...rest.map((i) => blocks[i]!),
          ]),
          ...(piece.first !== 1 ? { start: piece.first } : {}),
        },
  );

/** Removes the first `length` characters of a block's text — the marker.
 *  A piece that is emptied disappears; the others, and a badge's image, do
 *  not move. */
const stripMarker = <T extends Extract<IRBlock, { inlines: Inline[] }>>(block: T, length: number): T => {
  let reste = length;
  const inlines: Inline[] = [];
  for (const inline of block.inlines) {
    if (reste <= 0 || inline.image !== undefined) {
      inlines.push(inline);
      continue;
    }
    const coupe = Math.min(reste, inline.text.length);
    reste -= coupe;
    const text = inline.text.slice(coupe);
    if (text.length > 0) inlines.push({ ...inline, text });
  }
  return { ...block, inlines };
};

/** What a page flow reads a segment of lines with. */
export interface SegmentReading {
  isBold: (item: PositionedItem) => boolean;
  wordWidthAt: (y: number, left?: number) => number;
  markerBefore: ((item: PositionedItem) => ImageRef | undefined) | undefined;
  headingLevelOf: ((size: number) => HeadingLevel | undefined) | undefined;
  /** Smaller than the page's body (`pdf-document-scale.ts#scaleOfPage`): « Small text ». Absent, no paragraph is small. */
  isSmallSize?: ((size: number) => boolean) | undefined;
  centredContainer: ((line: Line, next: Line, segment: readonly Line[]) => number | undefined) | undefined;
  /** The picture a line runs beside (`asidePictureReader`). Absent, the segment's margin decides for every line. */
  asidePicture?: ((line: Line) => number | undefined) | undefined;
}

/** THE PICTURE A LINE RUNS BESIDE, identified by its left edge: one whose box holds the line's baseline and which
 *  starts to the right of where the line stops. The lines it answers for are measured against each other
 *  (`fallsShortBesideAPicture`). */
export const asidePictureReader =
  (pictures: readonly ImageCandidate[]) =>
  (line: Line): number | undefined =>
    pictures.find((p) => line.y <= p.top && line.y >= p.bottom && p.xMin >= line.right)?.xMin;

/** The blocks of one segment of grouped items. `classe` false gives no headings and no rule outside the grid: the content of
 *  a block set beside another. */
export const paragraphsFromSegment = (
  segment: readonly PositionedItem[][],
  reading: SegmentReading,
  classe = true,
): IRBlock[] =>
  paragraphsFromLines(
    linesFromGroups(segment, reading.isBold, reading.wordWidthAt, reading.markerBefore),
    classe ? reading.headingLevelOf : undefined,
    reading.centredContainer,
    classe ? reading.isSmallSize : undefined,
    reading.asidePicture,
  );
