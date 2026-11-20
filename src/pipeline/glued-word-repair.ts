/** Re-splits a glued page word where the PDF's own reading proves the boundaries, by adding spaces to the storage XHTML's text nodes — and undoes the whole repair if the re-check comes out worse in any way.
 *  NOT here: finding the glued words (`pipeline/text-conservation.ts`), what the document record keeps (`pipeline/publish-conservation.ts`), nor joining a word published split — this lot repairs glued words only.
 *  Called by: `pipeline/publish-conservation.ts`, once per checked PDF render. */

/**
 * THE RULE (21/09/2026, lot 4). A page token is re-split ONLY when
 * its letters, as the check normalises them, are EXACTLY the concatenation of
 * the 2+ consecutive source words the word reading proved; a space goes at
 * each boundary the source gives, and nothing else changes. Anything less
 * certain is left alone and stays counted as glued, visible on the dashboard.
 *
 * WHY THE XHTML AND NOT THE DOCUMENT MODEL. The finding locates a word by
 * block and word index in the storage XHTML the check read; the same reader
 * hands back the text nodes those indices came from, so the edit lands on the
 * exact characters, with no second mapping to get wrong. A space added inside
 * a text node leaves every tag where it was: bold runs, links and images keep
 * their markup, and an image is never inside a word (it ends the
 * block for the reader). A boundary at a formatting edge gets its space at
 * the end of the first word's text node, inside that run.
 *
 * WHERE PUNCTUATION GOES. Between the last letter of one source word and the
 * first of the next, the page may carry non-letters (« IV.1.1)Vrsta »). They
 * are split as the source words carry them — the first word's trailing
 * characters, then the next word's leading ones; if the page's characters
 * there are not exactly those, the token is left alone rather than guessed.
 *
 * THE UNDO. The repaired page is checked again. It must lose no letter, keep
 * every page letter in the same order, create no word the PDF lacks, and
 * leave at most the glued words it did not repair; otherwise the original
 * page and its verdict are kept, whole — never a partial repair.
 *
 * ⚠️ CLIENT TEXT, in memory only, like the verdict it reads.
 */

import { conservationKey, type ConservationVerdict, type PageEdit, type PublishedPage, type Respacing } from "doc-ir";

/** One character of a published block: its text, its letters, and where it ends IN THAT BLOCK'S TEXT.
 *  Until 09/11/2026 `end` was an offset in the storage XHTML and a unit could be an entity (`&amp;`): the decision
 *  then only worked on one markup. It is now an index in the text the caller published, which every destination has. */
interface Unit {
  text: string;
  key: string;
  end: number;
}

/** One code point (the `u` flag makes `[\s\S]` match a whole one), so `end` is a UTF-16 index usable for `slice`. */
const UNIT = /[\s\S]/gu;

/** The units of one published block. */
const unitsOf = (text: string): Unit[] =>
  [...text.matchAll(UNIT)].map((m) => ({ text: m[0], key: conservationKey(m[0]), end: m.index + m[0].length }));

/** The block's words, as the check splits them: runs of non-space units with at least one letter.
 *  Same split as `text-conservation.ts#wordKeysOf`, kept by unit to locate offsets. */
const wordsOf = (units: readonly Unit[]): Unit[][] => {
  const words: Unit[][] = [];
  let current: Unit[] = [];
  const close = (): void => {
    if (conservationKey(current.map((u) => u.text).join("")).length > 0) words.push(current);
    current = [];
  };
  for (const u of units) {
    if (/^\s+$/u.test(u.text)) close();
    else current.push(u);
  }
  close();
  return words;
};

/** Leading or trailing characters of a source word that carry no letter. */
const edge = (raw: string, side: "lead" | "trail"): string => {
  const chars = [...raw];
  const order = side === "lead" ? chars : [...chars].reverse();
  const out: string[] = [];
  for (const c of order) {
    if (conservationKey(c).length > 0) break;
    out.push(c);
  }
  return (side === "lead" ? out : [...out].reverse()).join("");
};

/** The renderer's zero-width space before a superscript glued to a word (`renderer/storage.ts#renderInlines`, PLATFORM-STATUS §81)
 *  carries nothing the source says: it is passed over between the words, and the space goes before it. */
const visible = (text: string): string => text.replaceAll("\u200B", "");

/** Where in its block one glued token takes its spaces (character indices), or `undefined` to leave it alone. */
const insertionsFor = (blocks: readonly string[], r: Respacing): number[] | undefined => {
  const at = r.pageWords[0];
  if (r.kind !== "glued" || r.pageWords.length !== 1 || at === undefined || r.sourceWords.length < 2) return undefined;
  const text = blocks[at.block];
  const units = text === undefined ? undefined : unitsOf(text);
  const word = units === undefined ? undefined : wordsOf(units)[at.word];
  if (word === undefined) return undefined;
  const keys = r.sourceWords.map(conservationKey);
  const tokenKey = conservationKey(word.map((u) => u.text).join(""));
  // Unit by unit, the letters must add up to the token's own (NFKC can join
  // across characters), and the token must be exactly the source words.
  if (word.map((u) => u.key).join("") !== tokenKey || keys.join("") !== tokenKey) return undefined;

  const offsets: number[] = [];
  let u = 0;
  let letters = 0;
  for (let i = 0; i < keys.length - 1; i++) {
    const boundary = letters + keys[i]!.length;
    // The unit carrying the first word's last letter must end exactly there.
    while (u < word.length && letters + word[u]!.key.length <= boundary && letters < boundary)
      letters += word[u++]!.key.length;
    if (letters !== boundary) return undefined;
    // Non-letters up to the next word's first letter, split as the source says.
    let next = u;
    while (next < word.length && word[next]!.key.length === 0) next++;
    const between = word.slice(u, next);
    const trail = edge(r.sourceWords[i]!, "trail");
    if (visible(between.map((x) => x.text).join("")) !== trail + edge(r.sourceWords[i + 1]!, "lead")) return undefined;
    let taken = "";
    let k = 0;
    while (taken.length < trail.length && k < between.length) taken += visible(between[k++]!.text);
    if (taken !== trail) return undefined;
    offsets.push(word[u + k - 1]!.end);
    u += k;
  }
  return offsets;
};

/** The spaces this check PROVES, as edits for the caller to apply to its own page; `repaired` counts the glued tokens
 *  that got all of theirs. Writes nothing: composing a page is the caller's job (`PageEdit`). */
export function gluedWordEdits(
  page: PublishedPage,
  respacings: readonly Respacing[],
): { edits: PageEdit[]; repaired: number } {
  const glued = respacings.filter((r) => r.kind === "glued");
  if (glued.length === 0) return { edits: [], repaired: 0 };
  const taken = new Set<string>();
  const edits: PageEdit[] = [];
  let repaired = 0;
  for (const r of glued) {
    const block = r.pageWords[0]?.block;
    const at = insertionsFor(page.blocks, r);
    if (at === undefined || block === undefined || at.some((o) => taken.has(`${block}:${o}`))) continue;
    for (const atChar of at) {
      taken.add(`${block}:${atChar}`);
      edits.push({ kind: "insert-space", block, atChar });
    }
    repaired += 1;
  }
  return { edits, repaired };
}

/** Whether the re-checked page is no worse than the original in any way. Exported since 09/11/2026: the loop that
 *  applies the edits and re-checks belongs to the caller (it writes the page), but the RULE for keeping or undoing a
 *  repair is this check's and stays here — a caller that invented its own could keep a page that lost a letter. */
export const noWorse = (before: ConservationVerdict, after: ConservationVerdict, repaired: number): boolean =>
  after.lostLetters <= before.lostLetters &&
  (after.decision !== "lost" || before.decision === "lost") &&
  after.decision !== "abstain" &&
  after.gluedWords <= before.gluedWords - repaired &&
  after.unmatchedPageWords <= before.unmatchedPageWords &&
  after.respacings.filter((r) => r.kind === "split").length <=
    before.respacings.filter((r) => r.kind === "split").length;
