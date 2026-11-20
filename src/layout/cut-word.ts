/** A word the PAPER cut across two lines: the predicate that says so, and what becomes of its hyphen.
 *  Decides: that two lines join with NO separator because the upper one ends on a word the layout broke — a LETTER
 *  before the hyphen, a LETTER after it, and no blank at the end of the upper line; that two published paragraphs split
 *  inside such a word are one (`joinCutParagraphs`); whether the hyphen of a cut word stays (`resolveCutHyphens`), and in
 *  which language's table (`hyphenationLanguageOf`: the document's, 10/11/2026).
 *  NOT here: the wrap junction INSIDE a table cell, which is a different and wider rule
 *  (`layout/cell-text.ts#endsOnJoiningHyphen`, J2: anything ending on `-` or `_` joins, safe only because its caller
 *  is reached for a line whose last word did not fit the cell's drawn edge); nor what a junction without a cut word
 *  writes (a space in the page flow, a `\n` in a cell paragraph).
 *  Called by: `extractor/pdf-cell-paragraphs.ts`, `extractor/pdf-paragraphs.ts`, `extractor/pdf.ts`.
 *
 * 🔴 WHY THIS IS NARROW, AND IT WAS PAID FOR. The cell wrap rule was read for one night by the logical-line junction
 * and glued « Total - » to « 12,00 » — a NUMBER nowhere in the document, on a page that looks perfectly normal. That
 * is the gravest defect this product can produce. The letter-before-hyphen condition alone refuses the three known
 * counter-examples: « Signature ______ » + « Date », « Chapitre 1 - » + « Introduction », « Total - » + « 12,00 ».
 * MEASURED (29/10/2026, three-way manual test — Acrobat, Chrome, us): the 57 cut words of 13 corpus
 * documents all pass it (« sous-utilisés », « Net-Zero », « CLARENCE-ROCKLAND », « Gender-Based », « mots-clés. »).
 * ABSTAINED ON, DELIBERATELY: a lower line starting with a DIGIT (« AG- » + « 002. » is a real cut word on paper). No
 * discriminant separates it from a fabricated number, so the word stays cut rather than risk the figure.
 *
 * 🔴 05/11/2026: the visible hyphenation is removed where typography rules let us recognise it. The hyphen of a cut
 * word goes when a SECOND reading concords with the junction (`resolveCutHyphens`): the document writes the whole word
 * elsewhere, OR the cut sits on a legal hyphenation point of the page's language (`./hyphenation.ts`, the hyph-utf8
 * tables of TeX). The newspaper `sd-2479793` cuts 202 words with a plain U+002D, never the soft hyphen U+00AD.
 *
 * 🔴 THE TABLE READING HAS THREE REFUSALS, AND A WRITTEN BIAS. Refused: a capital starting either piece
 * (« TWO-WAY », « Net-Zero », « De-identification », « V-twin », « Gender-Based » — probe of 05/11/2026 over the
 * 18 joins measured on 03/11 against PDFium), the hyphenated form written elsewhere in the document
 * (« ministry-funded » twice: the hyphen is the word's own), and a language without a table (the hyphen stays, as
 * before). THE BIAS, written: a NATIVE lowercase compound
 * written ONCE and cut at its own hyphen joins wrongly — French typesetting cuts a compound AT its existing hyphen by
 * rule (OQLF; Lexique de l'Imprimerie nationale), so the position cannot discriminate. MEASURED on the bench of
 * 05/11/2026: « ministry-funded » of 08-ontario publishes « ministryfunded », one invented word; to be looked at with
 * the maintainer before any rule. 🔴 10/11/2026, THE FOURTH REFUSAL, MEASURED: BOTH HALVES ARE WORDS OF THE DOCUMENT. Over 155 real PDFs, 175 cut words
 * had no whole witness and two halves the document writes on their own; about 165 are compounds (« above-average »,
 * « elle-même », « time-consuming », « self-addressed »), which the tables find legal and joined into words nowhere
 * written. THE BIAS, written: about ten are true cut words (« every-body », « else-where », « under-took ») and keep a
 * hyphen too many — ugly and visible, and a whole witness elsewhere in the document still joins them first.
 * Before any reading, one refusal: an address is never touched (« note-de- » + « methode.md » of
 * dgf-b5189db8e606). A whole witness wins over every other refusal
 * (« Dis-plays » + « displays » joins).
 *
 * WRITTEN LIMIT OF THE WHOLE-WITNESS READING (bench of 05/11/2026): `08-ontario` writes « interministerial » whole once
 * and cuts « Inter-ministerial » at a line's end, where its Word source keeps the hyphen; the witness joins it, and the
 * bench counts one invented word (10 -> 11). The author spells the word both ways; the document's other spelling decides.
 *
 * 🔴 WHY IT LIVES HERE SINCE 03/11/2026, in `layout/` and no longer inside a cell module: the page flow needed the
 * same decision, and this repository had just been bitten by the opposite habit — `WORD_GAP_EM` is written twice,
 * 0.1 in `extractor/glyph-runs.ts` and 0.15 in `extractor/pdf-lines.ts`, two values for one question. One decision,
 * one place.
 */

import type { IRBlock } from "doc-ir";
import { mapBlockChildren, mapInlines, walkInlines } from "doc-ir/internal";
import type { PageLanguage } from "doc-ir";
import { detectLanguage } from "doc-ir/language";
import { legalCutOf } from "./hyphenation";

/** The upper line ends on a letter followed by a hyphen. */
const CUT_WORD_END = /\p{L}-$/u;
/** The lower line starts on a letter — never a digit, see the abstention above. */
const CUT_WORD_START = /^\p{L}/u;

export const cutAcrossLines = (previous: string, line: string): boolean =>
  previous === previous.trimEnd() && CUT_WORD_END.test(previous) && CUT_WORD_START.test(line);

/** The character a page-flow join writes IN PLACE of the hyphen of a cut word, until the document is read whole
 *  (`resolveCutHyphens`). U+00AD, the soft hyphen, is what Unicode calls a hyphen at a layout break; no mark survives
 *  extraction. */
export const CUT_MARK = "\u00AD";

const WORD = /[\p{L}\p{M}]+/gu;
const LETTER_OR_MARK = /^[\p{L}\p{M}]$/u;

/** Where a run of letters (marks included) ENDS, scanning right from `from`. */
const runEnd = (text: string, from: number): number => {
  let end = from;
  while (end < text.length) {
    const char = String.fromCodePoint(text.codePointAt(end)!);
    if (!LETTER_OR_MARK.test(char)) break;
    end += char.length;
  }
  return end;
};

/** Where a run of letters (marks included) STARTS, scanning left from `from`, never before `floor`. */
const runStart = (text: string, from: number, floor: number): number => {
  let start = from;
  while (start > floor) {
    let step = start - 1;
    if (
      step > floor &&
      text.charCodeAt(step) >= 0xdc00 &&
      text.charCodeAt(step) <= 0xdfff &&
      text.charCodeAt(step - 1) >= 0xd800 &&
      text.charCodeAt(step - 1) <= 0xdbff
    )
      step--;
    if (!LETTER_OR_MARK.test(text.slice(step, start))) break;
    start = step;
  }
  return start;
};

/** Every « letters, mark, letters » of a text, left to right, matches not overlapping: a LINEAR scan around each mark.
 *  It replaces the regex `([\p{L}\p{M}]+)<mark>([\p{L}\p{M}]+)`, which tried every start of a long run of letters and
 *  backtracked from its end each time (quadratic: 3 s on 60 000 letters, review 06/11/2026). `visit` gives the two halves
 *  and the index of the match; `true` removes the mark, anything else turns it into a hyphen. */
const replaceCutWords = (
  text: string,
  visit: (left: string, right: string, at: number, length: number) => boolean,
): string => {
  let out = "";
  let done = 0;
  for (let mark = text.indexOf(CUT_MARK); mark >= 0; mark = text.indexOf(CUT_MARK, mark + 1)) {
    // Each mark is judged on its own two pieces: a word cut twice (three lines) has a middle piece that is the right
    // half of the first mark and the left half of the second. A mark with no letter on a side is just a hyphen.
    const start = runStart(text, mark, 0);
    const stop = runEnd(text, mark + 1);
    const joined =
      start < mark &&
      stop > mark + 1 &&
      visit(text.slice(start, mark), text.slice(mark + 1, stop), start, stop - start);
    out += text.slice(done, mark) + (joined ? "" : "-");
    done = mark + 1;
  }
  return out + text.slice(done);
};

const CAPITAL = /^\p{Lu}/u;
/** THE FRENCH CONTRACTED RELATIVES, a CLOSED set of the grammar, always written as one word (10/11/2026): the two-words
 *  refusal below turned « auxquelles » into « aux-quelles » in two documents, « aux » and « quelles » being words of their
 *  own. A rule of the language, exhaustive, not a dictionary. */
const FRENCH_CONTRACTED_RELATIVES = new Set([
  "auquel",
  "auxquels",
  "auxquelles",
  "duquel",
  "desquels",
  "desquelles",
  "lesquels",
  "lesquelles",
  "laquelle",
]);
/** AN ADDRESS IS NEVER TOUCHED (05/11/2026 : « on ne coupe jamais une URL ») : a scheme, a « www. », a domain
 *  followed by a slash, or a mail address, anywhere in the word run that holds the cut. */
const ADDRESS = /:\/\/|^\W*www\.|@/iu;
/** A domain followed by a slash (« fonciris.fr/donnees »): the part before the first slash ends on a dot and two letters.
 *  Anchored and split on the slash, so the check stays linear (`sonarjs/super-linear-regex`). */
const isAddress = (run: string): boolean => {
  if (ADDRESS.test(run)) return true;
  const slash = run.indexOf("/");
  return slash > 0 && /\.\p{L}{2,}$/u.test(run.slice(0, slash));
};

type Prose = Extract<IRBlock, { kind: "paragraph" | "heading" }>;
const isProse = (block: IRBlock | undefined): block is Prose =>
  block?.kind === "paragraph" || block?.kind === "heading";
/** Two paragraphs of one size, or two headings of one level: a heading never swallows a paragraph. */
const sameProse = (a: Prose, b: Prose): boolean =>
  a.kind === "paragraph" ? b.kind === "paragraph" && a.size === b.size : b.kind === "heading" && a.level === b.level;
const proseText = (block: Prose): string => block.inlines.map((inline) => inline.text).join("");
const LOWERCASE_START = /^\p{Ll}/u;

type ProseInline = Prose["inlines"][number];
/** Two pieces that differ by their text only (same marks, same link). */
const sameStyle = (a: ProseInline, b: ProseInline): boolean =>
  JSON.stringify({ ...a, text: "" }) === JSON.stringify({ ...b, text: "" });

/** Whether `lower` goes on with the word cut at the end of `upper` — pairwise on the ORIGINAL blocks: the end of a merged
 *  block is the end of the last block merged into it, so a chain is decided pair by pair. */
const continuesCut = (upper: IRBlock, upperText: string, lower: IRBlock, lowerText: string): boolean =>
  isProse(upper) &&
  isProse(lower) &&
  sameProse(upper, lower) &&
  LOWERCASE_START.test(lowerText) &&
  cutAcrossLines(upperText, lowerText);

/** The inlines of a chain of blocks, in ONE pass (review 10/11/2026: rebuilding the growing block at each merge was
 *  quadratic on a hostile page of thousands of « a- » paragraphs). Every block but the last has its final hyphen turned
 *  into the cut mark; the two pieces meeting at a cut become one when they share a style, because `resolveCutHyphens`
 *  reads a cut word inside one piece. Texts are gathered as parts and joined once. */
const chainInlines = (chain: readonly Prose[]): ProseInline[] => {
  const gathered: { inline: ProseInline; parts: string[] }[] = [];
  chain.forEach((block, k) => {
    let last = block.inlines.length - 1;
    if (k < chain.length - 1) while (last >= 0 && block.inlines[last]!.text === "") last--;
    for (let at = 0; at <= last; at++) {
      const original = block.inlines[at]!;
      const inline =
        k < chain.length - 1 && at === last
          ? { ...original, text: `${original.text.slice(0, -1)}${CUT_MARK}` }
          : original;
      const tail = gathered[gathered.length - 1];
      if (at === 0 && k > 0 && tail !== undefined && sameStyle(tail.inline, inline)) tail.parts.push(inline.text);
      else gathered.push({ inline, parts: [inline.text] });
    }
  });
  return gathered.map(({ inline, parts }) => (parts.length === 1 ? inline : { ...inline, text: parts.join("") }));
};

/** 🔴 A WORD THE PAPER CUT NEVER ENDS A PARAGRAPH (10/11/2026 : « corriger les coupures par espace et les
 *  moitiés égarées »). MEASURED on 09/11 over 155 real PDFs: 393 published blocks ended on « letter- », and 300 had their
 *  continuation in the VERY NEXT block — « non- monetised », « régu- lièrement », two non-words the search cannot find.
 *  The upper block ends on a cut word (`cutAcrossLines`) and the next one starts LOWERCASE: they become one block, joined
 *  by the cut mark, and `resolveCutHyphens` then decides the hyphen as for any line of a paragraph. A capital or a digit
 *  after the hyphen stays apart: a new sentence or a figure is as likely as a continuation.
 *  WRITTEN LIMITS: the other 79 blocks find their continuation two to seven blocks further, in a newsletter whose columns
 *  are interleaved (`sd-7343223`): that is reading order, not hyphenation, and nothing moves here. Of the 300 adjacent
 *  ones, 12 are themselves such a wrong neighbour (« Bank- » + « pearances »): the join makes one non-word of two.
 *  Across pages nothing joins (6 cases): a tab is a page. */
export const joinCutParagraphs = (blocks: readonly IRBlock[]): IRBlock[] => {
  const mapped = blocks.map((raw) => mapBlockChildren(raw, joinCutParagraphs));
  const textOf = mapped.map((block) => (isProse(block) ? proseText(block) : ""));
  const out: IRBlock[] = [];
  for (let i = 0; i < mapped.length;) {
    const first = mapped[i]!;
    if (!isProse(first)) {
      out.push(first);
      i += 1;
      continue;
    }
    const chain: Prose[] = [first];
    for (let j = i + 1; j < mapped.length; j++) {
      const next = mapped[j];
      if (!isProse(next) || !continuesCut(mapped[j - 1]!, textOf[j - 1]!, next, textOf[j]!)) break;
      chain.push(next);
    }
    out.push(chain.length > 1 ? { ...first, inlines: chainInlines(chain) } : first);
    i += chain.length;
  }
  return out;
};

/** THE LANGUAGE WHOSE TABLE JUDGES THE CUT WORDS: THE DOCUMENT'S, NOT THE PAGE'S (10/11/2026). The page's
 *  language is the reader's interface, not the text's: measured on 09/11 over 322 real PDFs, 137 cut words changed with
 *  it, and a French document on an English page kept 123 hyphens wrongly against 36 on a French page. The detector is
 *  the product's own (`doc-ir/pipeline/detect-language.ts`, local and deterministic). A language without a table gets
 *  NONE — the hyphen stays unless the document writes the whole word, ugly and visible rather than a wrong table
 *  deciding. A document too short or too mixed to tell keeps the page's language, the behaviour before this rule. */
export const hyphenationLanguageOf = (
  pages: readonly IRBlock[][],
  pageLanguage: PageLanguage | undefined,
): PageLanguage | undefined => {
  const detected = detectLanguage({ blocks: pages.flat() });
  if (detected === undefined) return pageLanguage;
  return detected === "fr" || detected === "en" ? detected : undefined;
};

/** EVERY CUT MARK OF A DOCUMENT, RESOLVED: the hyphen goes when the document writes the joined word elsewhere (any
 *  case), or when the cut is a legal hyphenation point of the page's language and nothing refuses it (see the header);
 *  else it comes back. The vocabularies are read from every inline of every page, marked words left out. */
export const resolveCutHyphens = (pages: readonly IRBlock[][], lang?: PageLanguage): IRBlock[][] => {
  const words = new Set<string>();
  const hyphenated = new Set<string>();
  for (const page of pages)
    walkInlines(page, (inline) => {
      // The two halves of a marked word stay out of the vocabulary: a word whose edge touches a mark is skipped.
      const { text } = inline;
      // One walk of the word runs serves both vocabularies; a dedicated `A+-A+` regex would be super-linear again.
      let prevEnd = -2;
      let prevWord = "";
      for (const m of text.matchAll(WORD)) {
        // The document's own mid-line hyphens: a junction that reads as one of them keeps its hyphen (the word's own).
        if (m.index === prevEnd + 1 && text[prevEnd] === "-") hyphenated.add(`${prevWord}-${m[0]}`.toLowerCase());
        prevEnd = m.index + m[0].length;
        prevWord = m[0];
        if (text[m.index - 1] === CUT_MARK || text[prevEnd] === CUT_MARK) continue;
        words.add(m[0].toLowerCase());
      }
    });
  const legal = lang === undefined ? undefined : legalCutOf(lang);
  const joins = (left: string, right: string): boolean => {
    if (words.has(`${left}${right}`.toLowerCase())) return true;
    if (lang === "fr" && FRENCH_CONTRACTED_RELATIVES.has(`${left}${right}`.toLowerCase())) return true;
    if (hyphenated.has(`${left}-${right}`.toLowerCase())) return false;
    // Both halves are words of the document: a compound cut at its own hyphen (10/11/2026, see the header).
    if (words.has(left.toLowerCase()) && words.has(right.toLowerCase())) return false;
    if (CAPITAL.test(left) || CAPITAL.test(right)) return false;
    return legal !== undefined && legal(left, right);
  };
  // One refusal before any reading: the word run holding the cut is an address, never touched.
  const inChain = (text: string, at: number, length: number): boolean => {
    const start = text.lastIndexOf(" ", at) + 1;
    const stop = text.indexOf(" ", at + length);
    return isAddress(text.slice(start, stop < 0 ? text.length : stop));
  };
  const resolve = (text: string): string =>
    text.includes(CUT_MARK)
      ? replaceCutWords(text, (left, right, at, length) => !inChain(text, at, length) && joins(left, right))
      : text;
  return pages.map((page) =>
    mapInlines([...page], (inlines) =>
      inlines.map((inline) => (inline.text.includes(CUT_MARK) ? { ...inline, text: resolve(inline.text) } : inline)),
    ),
  );
};
