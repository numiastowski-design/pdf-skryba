/** Which characters of a PDF page carry a hyperlink: the page's link annotations tied to the words their rectangle
 *  covers (decision of 07/10/2026, option B).
 *  NOT here: reading the annotations (`extractor/pdf-source.ts`), turning a Drive URL into `drive:<id>`
 *  (`pipeline/normalize-links.ts`), nor writing the link into the text (`extractor/pdf-lines.ts`,
 *  `extractor/pdf-paragraphs.ts`).
 *  Called by: `extractor/pdf.ts`, once per page; `extractor/pdf-table-render.ts` (`fillBetween`). */

/**
 * WHAT THE DOCUMENT DECLARES. A `/Link` annotation (ISO 32000-1 §12.5.6.5) is a rectangle (`/Rect`, §12.5.2) with
 * an action; a URI action (§12.6.4.7) names the target. Nothing in the file says WHICH WORDS the link is on: the
 * rectangle is laid over the painted text, and the words are found by geometry. A producer draws it a little
 * larger or smaller than the text (measured 07/10/2026: Word overhangs the next character by 1 to 3 pt and adds
 * 1-pt rectangles over the spaces; PowerPoint starts 1.4 pt inside the first glyph).
 *
 * THE TIE RULE, and why it has no threshold:
 *  1. A glyph belongs to a rectangle when its CENTRE lies inside it. The overhangs measured are smaller than half
 *     a glyph, so a centre reads them right without a tolerance to calibrate.
 *  2. A WORD (letters, digits and their marks) is covered when all its glyphs are, untouched when none is. Some
 *     but not all: the rectangle cuts a word, and that link ABSTAINS everywhere — text unchanged.
 *  3. A word covered by two links with different targets: both abstain. The same target twice is one link.
 *  4. Punctuation glued to a linked word (« / » ending a URL, « . » inside one) carries the link while its own
 *     glyph centre is inside the rectangle, so « (example.com) » keeps its parentheses outside. Spaces and
 *     punctuation BETWEEN two characters of the same link carry it too: « Data Protection Act » is one link.
 *  5. A run whose glyphs do not read as its text (the two readings of `pdf-letter-spacing.ts`) or a rotated run
 *     cannot be placed: every link touching it abstains.
 * Only the targets the page may publish are kept (`lib/link-schemes.ts#PUBLISHED_SCHEME`: http, https, mailto); another
 * target — `javascript:`, `file:`, `tel:`, `ftp:`, our own internal forms — leaves the text plain.
 *
 * MEASURED 07/10/2026 over the 127 PDFs of fixtures/ (46 carry links): 792 kept annotations, 578 tied to words,
 * 200 over no word (the 1-pt space rectangles, links on pictures), 14 abstain (10 rectangles cutting a word —
 * mostly Word's space rectangles touching the next word's first glyph, while the link's main rectangle is tied —
 * and 4 under a page-sized Canva link disagreeing with the links inside it, fixture 26 pages 8 and 9).
 *
 * A TABLE CELL is built from glyphs, not runs (`pdf-table-render.ts`): it reads the same tie, per glyph
 * (`linkTieOfPage`), never a second geometry (07/10/2026).
 *
 * KNOWN LIMITS, written: a word painted as two runs is judged as two words; the pages whose text the AI reads (a
 * scan) have no position, so no link.
 */

import type { GlyphFragment } from "./glyph-positions";
import { CENTRE_WINDOW, glyphsOfRun, sortedByBaseline } from "./glyph-window";
import type { PdfLinkSpan } from "./pdf-model";
import { PUBLISHED_SCHEME } from "doc-ir/lib/link-schemes";
import type { PdfLinkAnnotation, PdfTextRun } from "./pdf-source";

/** The most kept links one page may carry; beyond it the page gets none (its text is unchanged). Starting value to
 *  calibrate: the real maximum is 59 on one page (07/10/2026, 127 fixture PDFs); a hostile page can declare tens of
 *  thousands, and each costs a pass over the runs it touches. */
export const PDF_MAX_LINKS_PER_PAGE = 500;

const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;
const WORDS = /[\p{L}\p{N}\p{M}]+/gu;
const SPACE = /\s/u;

type Rect = PdfLinkAnnotation["rect"];

const centreIn = (rect: Rect, g: GlyphFragment): boolean => {
  const x = g.x + g.width / 2;
  const y = g.y + g.height / 2;
  return x >= rect[0] && x <= rect[2] && y >= rect[1] && y <= rect[3];
};

const touches = (rect: Rect, run: PdfTextRun): boolean =>
  run.x <= rect[2] && run.x + run.width >= rect[0] && run.y <= rect[3] && run.y + run.fontSize >= rect[1];

/** One glyph per non-space code unit of `text`, or `undefined` when the glyphs do not read as the text. */
const glyphPerChar = (text: string, glyphs: readonly GlyphFragment[]): (GlyphFragment | undefined)[] | undefined => {
  if (glyphs.map((g) => g.text).join("") !== text.replace(/\s+/gu, "")) return undefined;
  const at: (GlyphFragment | undefined)[] = [];
  let g = 0;
  let used = 0;
  for (let c = 0; c < text.length; c++) {
    if (SPACE.test(text[c]!)) {
      at.push(undefined);
      continue;
    }
    const glyph = glyphs[g]!;
    at.push(glyph);
    if (++used >= glyph.text.length) {
      g++;
      used = 0;
    }
  }
  return at;
};

/** Rule 4, between: the spaces and punctuation flanked by two characters of the same target take it. `linkAt` holds
 *  an index per code unit of `text`, filled in place; `targetOf` names an index's target. */
export const fillBetween = (text: string, linkAt: (number | undefined)[], targetOf: (link: number) => string): void => {
  // Two passes, never a scan per character: a dot leader of n dots would cost n² (review of 07/10/2026).
  // `left[c]`: the link of the nearest character before c that is linked or a word character, read across spaces and
  // punctuation; `undefined` when that character is an unlinked word, or none.
  const left: (number | undefined)[] = new Array<number | undefined>(text.length).fill(undefined);
  let last: number | undefined;
  for (let c = 0; c < text.length; c++) {
    left[c] = last;
    const link = linkAt[c];
    if (link !== undefined) last = link;
    else if (WORD_CHAR.test(text[c]!)) last = undefined;
  }
  let next: number | undefined;
  for (let c = text.length - 1; c >= 0; c--) {
    const link = linkAt[c];
    const isWord = WORD_CHAR.test(text[c]!);
    const before = left[c];
    if (link === undefined && !isWord && before !== undefined && next !== undefined && targetOf(before) === targetOf(next)) linkAt[c] = before;
    // `next` is read from the ORIGINAL marks: a character filled here was unlinked punctuation, transparent either way.
    if (link !== undefined) next = link;
    else if (isWord) next = undefined;
  }
};

/**
 * The link spans of each run of one page — only runs that carry one are in the map. Pure: same inputs, same spans.
 */
export const linkSpansOfPage = <T extends PdfTextRun>(
  runs: readonly T[],
  glyphs: readonly GlyphFragment[],
  annotations: readonly PdfLinkAnnotation[],
): Map<T, PdfLinkSpan[]> => linkTieOfPage(runs, glyphs, annotations).spansByRun;

/** A run whose words some link covers: its glyph per code unit, and each covered word with the links that cover it. */
type PlacedRun<T> = { run: T; at: (GlyphFragment | undefined)[]; words: { start: number; end: number; links: number[] }[] };

/** Rules 1 to 3: ties each word of each run to the links whose rectangle holds the centre of all its glyphs. A link
 *  that is only partly on a word, that covers one word with another target, or that sits on a run the glyphs do not
 *  read (rotated, or glyphs that do not spell the text) is added to `abstained`: it ties nothing anywhere. */
function tieWordsToLinks<T extends PdfTextRun>(
  runs: readonly T[],
  links: readonly PdfLinkAnnotation[],
  byY: readonly GlyphFragment[],
  abstained: Set<number>,
): PlacedRun<T>[] {
  const placed: PlacedRun<T>[] = [];
  for (const run of runs) {
    if (run.text.trim().length === 0) continue;
    const touching = links.flatMap((link, i) => (touches(link.rect, run) ? [i] : []));
    if (touching.length === 0) continue;
    const at = run.rotated ? undefined : glyphPerChar(run.text, glyphsOfRun(run, byY, CENTRE_WINDOW));
    if (at === undefined) {
      for (const i of touching) abstained.add(i);
      continue;
    }
    const words: PlacedRun<T>["words"] = [];
    for (const match of run.text.matchAll(WORDS)) {
      const start = match.index;
      const end = start + match[0].length;
      const own = [...new Set(at.slice(start, end))].filter((g): g is GlyphFragment => g !== undefined);
      const covering: number[] = [];
      for (const i of touching) {
        const inside = own.filter((g) => centreIn(links[i]!.rect, g)).length;
        if (inside === own.length) covering.push(i);
        else if (inside > 0) abstained.add(i);
      }
      if (new Set(covering.map((i) => links[i]!.url)).size > 1) for (const i of covering) abstained.add(i);
      if (covering.length > 0) words.push({ start, end, links: covering });
    }
    if (words.length > 0) placed.push({ run, at, words });
  }
  return placed;
}

/** Rule 4, glued punctuation: outward from a linked word character, in both directions, while the glyph centre stays
 *  in the link's rectangle. Fills `linkAt` in place. */
function extendGluedPunctuation(text: string, at: readonly (GlyphFragment | undefined)[], linkAt: (number | undefined)[], links: readonly PdfLinkAnnotation[]): void {
  for (let c = 0; c < text.length; c++) {
    const link = linkAt[c];
    if (link === undefined || !WORD_CHAR.test(text[c]!)) continue;
    for (const step of [-1, 1]) {
      for (let k = c + step; k >= 0 && k < text.length && linkAt[k] === undefined; k += step) {
        const glyph = at[k];
        if (WORD_CHAR.test(text[k]!) || glyph === undefined || !centreIn(links[link]!.rect, glyph)) break;
        linkAt[k] = link;
      }
    }
  }
}

/** The link of each code unit of a placed run (an index into `links`), or `undefined`: its words that a live link covers,
 *  then rule 4 (glued punctuation, then `fillBetween`). */
function linkIndexPerChar<T extends PdfTextRun>(
  { run, at, words }: PlacedRun<T>,
  links: readonly PdfLinkAnnotation[],
  abstained: ReadonlySet<number>,
): (number | undefined)[] {
  const text = run.text;
  const linkAt: (number | undefined)[] = new Array<number | undefined>(text.length).fill(undefined);
  for (const word of words) {
    const live = word.links.find((i) => !abstained.has(i));
    if (live !== undefined) linkAt.fill(live, word.start, word.end);
  }
  extendGluedPunctuation(text, at, linkAt, links);
  fillBetween(text, linkAt, (i) => links[i]!.url);
  return linkAt;
}

/** Notes each glyph's link in `glyphLink`: its href, or `null` when two characters it paints disagree. */
function noteGlyphLinks(glyphLink: Map<GlyphFragment, string | null>, at: readonly (GlyphFragment | undefined)[], linkAt: readonly (number | undefined)[], links: readonly PdfLinkAnnotation[]): void {
  for (let c = 0; c < linkAt.length; c++) {
    const glyph = at[c];
    if (glyph === undefined) continue;
    const href = linkAt[c] === undefined ? null : links[linkAt[c]!]!.url;
    const seen = glyphLink.get(glyph);
    if (seen === undefined) glyphLink.set(glyph, href);
    else if (seen !== href) glyphLink.set(glyph, null);
  }
}

/** The spans of a run: maximal stretches of code units with the same target. */
function spansOfLinkAt(linkAt: readonly (number | undefined)[], links: readonly PdfLinkAnnotation[]): PdfLinkSpan[] {
  const spans: PdfLinkSpan[] = [];
  for (let c = 0; c < linkAt.length; c++) {
    const link = linkAt[c];
    if (link === undefined) continue;
    const href = links[link]!.url;
    const last = spans[spans.length - 1];
    if (last !== undefined && last.end === c && last.href === href) last.end = c + 1;
    else spans.push({ start: c, end: c + 1, href });
  }
  return spans;
}

/** The tie of one page, read two ways: per run (`spansByRun`, for the page flow) and per glyph (`hrefByGlyph`, for
 *  a table cell, built from glyphs — `pdf-table-render.ts`). One tie, so the two cannot disagree: a glyph takes the
 *  link of the characters it paints, and none when they carry different ones. A space glyph is never in it — no run
 *  character is placed on one — and takes a link in its cell by rule 4 (`fillBetween`). */
export const linkTieOfPage = <T extends PdfTextRun>(
  runs: readonly T[],
  glyphs: readonly GlyphFragment[],
  annotations: readonly PdfLinkAnnotation[],
): { spansByRun: Map<T, PdfLinkSpan[]>; hrefByGlyph: Map<GlyphFragment, string> } => {
  const spansByRun = new Map<T, PdfLinkSpan[]>();
  const hrefByGlyph = new Map<GlyphFragment, string>();
  const links = annotations.filter((link) => PUBLISHED_SCHEME.test(link.url));
  if (links.length === 0 || links.length > PDF_MAX_LINKS_PER_PAGE) return { spansByRun, hrefByGlyph };

  // No space glyph, and the glyph CENTRE decides (same rule as the tie above): `glyph-window.ts` says why letter-spacing differs.
  const byY = sortedByBaseline(glyphs.filter((g) => !g.isSpace && g.text.trim().length > 0));
  const abstained = new Set<number>();
  const placed = tieWordsToLinks(runs, links, byY, abstained);

  // A glyph's link, or `null`: no link, or two characters it paints that disagree.
  const glyphLink = new Map<GlyphFragment, string | null>();
  for (const placedRun of placed) {
    const linkAt = linkIndexPerChar(placedRun, links, abstained);
    noteGlyphLinks(glyphLink, placedRun.at, linkAt, links);
    const spans = spansOfLinkAt(linkAt, links);
    if (spans.length > 0) spansByRun.set(placedRun.run, spans);
  }
  for (const [glyph, href] of glyphLink) if (href !== null) hrefByGlyph.set(glyph, href);
  return { spansByRun, hrefByGlyph };
};
