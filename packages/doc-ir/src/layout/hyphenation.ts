/** WHERE A CUT IS LEGAL INSIDE A WORD OF A LANGUAGE — the Knuth-Liang algorithm over the hyph-utf8 tables of TeX
 *  (05/11/2026 : « les règles de typographie doivent nous aider à repérer une césure, et donc la supprimer
 *  quand on n'est plus en fin de ligne »). The tables are the de-facto international standard: Unicode UAX #14 only
 *  says where a LINE may break and leaves hyphenation to the language, and these patterns are what Firefox and
 *  LibreOffice hyphenate with. Deterministic, frozen in the repository, no service called — the embedded-model rule.
 *  Decides: whether « left-right » at a junction is a legal hyphenation point of the joined word; the minima are the
 *  OFFICIAL ones of each table's header (fr 2/2, en-us 2/3), not calibrated here.
 *  NOT here: whether a hyphen IS a layout cut — that needs the junction and the document, `./cut-word.ts`.
 *  Called by: `./cut-word.ts`. */

import type { PageLanguage } from "doc-ir/lib/reader-types";
import { EXCEPTIONS as EN_EXCEPTIONS, PATTERNS as EN_PATTERNS } from "./hyphenation-en";
import { EXCEPTIONS as FR_EXCEPTIONS, PATTERNS as FR_PATTERNS } from "./hyphenation-fr";

interface Table {
  /** Pattern letters → inter-letter values (length letters+1), Liang's digits. */
  readonly patterns: ReadonlyMap<string, readonly number[]>;
  readonly maxPattern: number;
  /** Exception word (hyphens removed, lower case) → the set of its legal cut offsets; EMPTY SET = never cut. */
  readonly exceptions: ReadonlyMap<string, ReadonlySet<number>>;
  readonly leftMin: number;
  readonly rightMin: number;
}

/** One pattern token (« ab4c ») → its letters and Liang digits (length letters + 1). */
const patternEntry = (token: string): [string, number[]] => {
  const letters = token.replace(/\d/gu, "");
  const values = new Array<number>(letters.length + 1).fill(0);
  let at = 0;
  for (const ch of token) {
    if (ch >= "0" && ch <= "9") values[at] = Number(ch);
    else at += 1;
  }
  return [letters, values];
};

/** One exception token (« as-so-ciate », or « present » with no cut) → the word and its legal cut offsets. */
const exceptionEntry = (token: string): [string, Set<number>] => {
  const cuts = new Set<number>();
  let offset = 0;
  for (const piece of token.toLowerCase().split("-").slice(0, -1)) {
    offset += piece.length;
    cuts.add(offset);
  }
  return [token.toLowerCase().replaceAll("-", ""), cuts];
};

const tokensOf = (joined: string): string[] => joined.split(" ").filter((token) => token !== "");

const parsed = (tokens: string, exceptionTokens: string, leftMin: number, rightMin: number): Table => {
  const patterns = new Map<string, readonly number[]>(tokensOf(tokens).map(patternEntry));
  let maxPattern = 1;
  for (const letters of patterns.keys()) if (letters.length > maxPattern) maxPattern = letters.length;
  const exceptions = new Map<string, ReadonlySet<number>>(tokensOf(exceptionTokens).map(exceptionEntry));
  return { patterns, maxPattern, exceptions, leftMin, rightMin };
};

/** The official typesetting minima are each table's own (their file headers), never tuned here. */
const TABLES: Record<PageLanguage, () => Table> = {
  fr: () => parsed(FR_PATTERNS, FR_EXCEPTIONS, 2, 2),
  en: () => parsed(EN_PATTERNS, EN_EXCEPTIONS, 2, 3),
};
const cache = new Map<PageLanguage, Table>();
const tableOf = (lang: PageLanguage): Table => {
  const held = cache.get(lang);
  if (held !== undefined) return held;
  const table = TABLES[lang]();
  cache.set(lang, table);
  return table;
};

/** The legal cut offsets of a word: Liang — dot the word, overlay every matching pattern, keep the ODD maxima. */
/** Liang's overlay: every pattern matching a substring of the dotted word raises its digits; maxima win. */
const liangValues = (table: Table, dotted: string): number[] => {
  const values = new Array<number>(dotted.length + 1).fill(0);
  for (let start = 0; start < dotted.length; start++) {
    const stop = Math.min(start + table.maxPattern, dotted.length);
    for (let end = start + 1; end <= stop; end++) {
      const found = table.patterns.get(dotted.slice(start, end));
      if (found === undefined) continue;
      for (const [i, v] of found.entries()) if (v > values[start + i]!) values[start + i] = v;
    }
  }
  return values;
};

const cutsOf = (table: Table, word: string): Set<number> => {
  const exception = table.exceptions.get(word);
  if (exception !== undefined) return new Set(exception);
  const values = liangValues(table, `.${word}.`);
  const cuts = new Set<number>();
  // Value index p of the dotted word sits BEFORE its p-th character; the cut after `offset` letters is p = offset + 1.
  for (let offset = 1; offset < word.length; offset++) if (values[offset + 1]! % 2 === 1) cuts.add(offset);
  return cuts;
};

/** Whether « left-right » is a legal hyphenation point of the joined word, under the language's official minima.
 *  Case is the sentence's, not the word's: the pieces are lowered before the table is read. */
export const legalCutOf = (lang: PageLanguage): ((left: string, right: string) => boolean) => {
  const table = tableOf(lang);
  return (left, right) =>
    left.length >= table.leftMin && right.length >= table.rightMin && cutsOf(table, `${left}${right}`.toLowerCase()).has(left.length);
};
