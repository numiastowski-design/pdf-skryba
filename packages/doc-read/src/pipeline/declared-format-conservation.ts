/** The text-conservation check for a format that DECLARES its own text (Word,
 *  Google Doc — lot A; pptx — lot D; xlsx, Google Sheet — lot E,
 *  MIKSUDOC « Spécification technique » T11): source words against the
 *  words the published page actually carries, MISSING words only, plus xlsx numeric/date cells missing at their published position;
 *  the misses grouped by cause, and the record's bounded preview of them
 *  (count always exact, words capped in number and length). No repair:
 *  a lost word in a declared format is our own reader's
 *  defect, not a render accident to paper over. Publishes exactly as
 *  rendered either way (never a reason not to publish).
 *  NOT here: reading a format into a `DeclaredFormatConservationSource`
 *  (`pipeline/source-reading-*.ts`), locating a cell in the published table
 *  (`pipeline/xlsx-page-cells.ts`), the PDF check and its repairs
 *  (`pipeline/text-conservation.ts`, `pipeline/*-repair.ts`), the dev-only
 *  log line (`adapters/conservation-log.ts`).
 *  Called by: `pipeline/publish-conservation.ts#conservationOfRender`, for
 *  every non-PDF `ConservationSource`. */

import type { DocumentConservation, MissingWordCause } from "doc-ir/lib/reader-types";
import type { DeclaredFormatConservationSource, MissingWordCauseGroup } from "./conservation-source";
import type { PublishedPage } from "doc-ir/pipeline/text-conservation";
import { diagramParagraphs, type IRBlock } from "doc-ir/lib/ir";
import { walkBlocks } from "doc-ir/lib/ir-walk";
import { wordsOf } from "../lib/words";

/** How many characters of ONE missing word the development log line keeps
 *  (`adapters/conservation-log.ts`; the record keeps no word since the owner decision of 09/10/2026): a
 *  « word » is whatever `wordsOf` cuts between spaces, so a base64 blob or a
 *  long URL is one word of any length — unbounded, it would flood the log.
 *  A cut word ends with « … ». A VALUE TO CALIBRATE, set against the two
 *  populations it separates: the longest real words of the two languages we
 *  test (FR « anticonstitutionnellement », 25 characters; EN
 *  « pneumonoultramicroscopicsilicovolcanoconiosis », 45) stay whole with
 *  margin for joined tokens (« c'est-à-dire », an e-mail, a reference);
 *  only blobs and long URLs are cut (Mikolaj, 29/09/2026). */
export const MISSING_WORD_SHOWN_MAX_CHARS = 64;

/** The published page's own words, tokenised by the SAME rule as the source side (`lib/words.ts#wordsOf`).
 *  Takes the page as TEXT, block by block (09/11/2026): no tag, no entity and no scaffolding reaches here any more. The
 *  caller dropped them when it converted its own render — for Confluence,
 *  `pipeline/confluence-page-reading.ts#confluencePageOf` drops macro parameters and ADF-node attributes, tab titles
 *  included, because the source side never counts a sheet or slide name and neither must this one.
 *  The blocks are joined by a line break: a block boundary ends a word, which is what the dropped block tags used to do. */
export const pageWords = (page: PublishedPage): string[] => wordsOf(page.blocks.join("\n"));

const multiset = (words: readonly string[]): Map<string, number> => {
  const m = new Map<string, number>();
  for (const w of words) m.set(w, (m.get(w) ?? 0) + 1);
  return m;
};

/** The words of a SmartArt's model that its picture does not show, as the IR's `diagramText` sections list them (`DiagramTextSection#undrawn`):
 *  counted `smartart-not-drawn`, AHEAD of the diagram text that excuses the drawn words. A SmartArt with no drawing lists all its words here. */
export function undrawnDiagramWords(blocks: readonly IRBlock[]): string[] {
  const words: string[] = [];
  walkBlocks(blocks, (block) => {
    // A section the page PUBLISHES (a SmartArt outline, `levels`) loses nothing to a drawing that leaves a shape out:
    // its words are on the page as a list, drawn or not (29/10/2026). Only a section that stays off the page can.
    if (block.kind === "diagramText") for (const section of block.sections) if (section.levels === undefined) words.push(...(section.undrawn ?? []));
  });
  return words;
}

/** The words of the `diagramText` blocks of an IR, read from the IR (the page no longer carries them, 19/10/2026): the sections' PARAGRAPHS
 *  only, joined as they were published. The relations add nothing: every shape a relation names is already a paragraph of the diagram,
 *  and excusing a name a second time silenced a real loss of the same word elsewhere (« crs » drawn once, excused twice:
 *  fixtures/pptx-reel/High_level_IT_Landscape_overview_4.pptx slide 2; review of 1f45b6ef, 22/10/2026). Bias, written: a name a relation
 *  cites that no paragraph holds counts lost (visible), never excused. Labels and our own wording are not the document's words. */
export function diagramTextWords(blocks: readonly IRBlock[]): string[] {
  const words: string[] = [];
  walkBlocks(blocks, (block) => {
    if (block.kind !== "diagramText") return;
    for (const section of block.sections) {
      // A SECTION THE PAGE PUBLISHES EXCUSES NOTHING (29/10/2026): its words are counted by the ordinary reading of the
      // page, and adding them here a second time would let a real loss of the same word pass unseen.
      if (section.levels !== undefined) continue;
      for (const paragraph of diagramParagraphs(section)) words.push(...wordsOf(paragraph.map((i) => i.text).join("")));
    }
  });
  return words;
}

interface MissingToken {
  text: string;
  cause: MissingWordCause;
}

/** The word cut in two by the page: every split point is tried, and BOTH halves must be on the page for it to count — one
 *  half alone leaves the word lost, which bounds the bias. Two pieces only: three would make a bag of common words excuse
 *  almost anything, and the one case measured on the corpus (29/10/2026) needs two.
 *  ⚠️ The bias, chosen and written: a source word whose letters happen to decompose into two words the page has elsewhere
 *  would be excused — « nowhere » against « now » and « here ». It is reported under its own cause rather than silently
 *  swallowed, exactly so that case can be seen. */
const spendAsPieces = (bag: Map<string, number>, word: string): boolean => {
  for (let cut = 1; cut < word.length; cut += 1) {
    const left = word.slice(0, cut);
    const right = word.slice(cut);
    if ((bag.get(left) ?? 0) === 0 || (bag.get(right) ?? 0) === 0) continue;
    spend(bag, left);
    spend(bag, right);
    return true;
  }
  return false;
};

/** One occurrence taken out of a bag of words; says whether there was one. */
const spend = (bag: Map<string, number>, word: string): boolean => {
  const left = bag.get(word) ?? 0;
  if (left > 0) bag.set(word, left - 1);
  return left > 0;
};

/** The cause of a source word the page lacks, or `undefined` when the word is EXCUSED. Only a plain « text » word is relabelled: first
 *  `smartart-not-drawn` (a SmartArt word its picture does not show, or every word of a SmartArt with no drawing), then excused when the
 *  diagram text holds it (a diagram is published as a drawing only, Mikolaj 22/10/2026: its drawn words are not lost). One occurrence per
 *  occurrence of that word in each list. */
const causeOf = (token: { text: string; cause?: MissingWordCause }, undrawn: Map<string, number>, drawn: Map<string, number>): MissingWordCause | undefined => {
  const cause = token.cause ?? "text";
  if (cause !== "text") return cause;
  if (spend(undrawn, token.text)) return "smartart-not-drawn";
  return spend(drawn, token.text) ? undefined : cause;
};

/** Every source-word OCCURRENCE not found on the page, in source reading
 *  order — a DECLARED removal absorbs a leftover first (empty for Word/
 *  Google Doc today, pptx/xlsx will use it): same arithmetic as the
 *  count-only check this replaces (`n - published(w) - removals(w)`, floored
 *  at 0 — a combined FIFO budget per word gives the identical total), now
 *  keeping the occurrences themselves so each can carry its own cause. Which
 *  SPECIFIC occurrence of a repeated word is "the" missing one is arbitrary
 *  (the page has no correspondence to offer) — first-seen-first-matched,
 *  applied consistently, same discipline as `text-conservation.ts#absorb`. */
const missingTokens = (
  source: DeclaredFormatConservationSource,
  published: readonly string[],
  deliberateRemovals: readonly string[],
  diagramWords: readonly string[] = [],
  undrawnWords: readonly string[] = [],
): MissingToken[] => {
  const budget = multiset(published);
  for (const [word, n] of multiset(deliberateRemovals.flatMap(wordsOf))) budget.set(word, (budget.get(word) ?? 0) + n);
  // A diagram is published as a drawing only (Mikolaj 22/10/2026, a product decision): a source word that lives in its text, which the page
  // does not carry, is not lost. Only a plain « text » word is excused, one occurrence per occurrence of that word in the diagram text.
  const drawn = multiset(diagramWords);
  // A SmartArt word its picture does not show (or every word of a SmartArt with no drawing) is nowhere on the page: its own cause, taken
  // BEFORE the excuse (the IR's diagram text still holds every word of the model, for the control and the language).
  const undrawn = multiset(undrawnWords);
  const missing: MissingToken[] = [];
  source.units.forEach((unit, i) => {
    if (source.excludedUnits.has(i)) return;
    for (const token of unit.tokens) {
      if (spend(budget, token.text)) continue;
      // THE PAGE SPLIT IT, IT DID NOT LOSE IT — AND A HUMAN IS ASKED (Mikolaj, 29/10/2026). The source can hold one word
      // where the page holds its pieces side by side: a document that puts a heading and the next paragraph in ONE `w:p`
      // with nothing between the two runs reads « competitionthere », and we publish « …Competition » then « There are
      // no… ». Not a letter is missing, so calling it a LOSS lies to the owner of the page and lowers its fidelity for
      // nothing; saying nothing would hide the day a real loss takes the same shape. So it is spent, and reported apart.
      // L'ORDRE COMPTE, ET LE CONTRÔLE COMPLET L'A DIT (29/10/2026) : les excuses d'abord, l'explication ensuite. Mis avant
      // `causeOf`, ce test expliquait par une coupure de page des mots qu'un DIAGRAMME dessine — 158 d'un coup sur
      // 07-fr-trouver-une-image. Un mot qu'on sait publié autrement n'est pas coupé, il n'est rien du tout.
      const cause = causeOf(token, undrawn, drawn);
      if (cause === undefined) continue;
      if (spendAsPieces(budget, token.text)) {
        missing.push({ text: token.text, cause: "split-by-page" });
        continue;
      }
      missing.push({ text: token.text, cause });
    }
  });
  return missing;
};

const groupByCause = (tokens: readonly MissingToken[]): MissingWordCauseGroup[] => {
  const order: MissingWordCause[] = [];
  const byCause = new Map<MissingWordCause, string[]>();
  for (const { text, cause } of tokens) {
    if (!byCause.has(cause)) {
      byCause.set(cause, []);
      order.push(cause);
    }
    byCause.get(cause)!.push(text);
  }
  return order.map((cause) => ({ cause, words: byCause.get(cause)! }));
};

/** The numeric/date source cells (xlsx only, lot E addendum) whose
 *  published position is empty or missing, as `MissingToken`s so they merge
 *  into the same cause groups as the word-bag misses above — the « word »
 *  each carries is its cell reference, never a value
 *  (`conservation-source.ts#ConservationNumericCell`). Checked by POSITION
 *  (`pipeline/xlsx-page-cells.ts`), never by matching text on the page: a
 *  number's page text is our own formatter's output, not the source's. */
/** The numeric cells the page lost, as tokens. Their reading is the CALLER's: finding a sheet's cells in a render means
 *  knowing that render's markup (`pipeline/xlsx-page-cells.ts`, app code since 09/11/2026), and this check does not. */
const missingNumericTokens = (missingNumericCells: readonly { ref: string; cause: MissingWordCause }[]): MissingToken[] =>
  missingNumericCells.map(({ ref, cause }) => ({ text: ref, cause }));

/** The missing words themselves, grouped by cause, in first-seen order —
 *  read by the dev-only log line (`adapters/conservation-log.ts`,
 *  `orchestrator/doc-processor.ts`), UNBOUNDED, and by
 *  `conservationFromMissingWordGroups` below, which keeps only their counts
 *  per cause (owner decision, 09/10/2026: the record keeps no word) — this
 *  function itself never bounds or persists anything on its own. */
export function missingWordGroups(
  source: DeclaredFormatConservationSource,
  /** The page as TEXT, block by block: this check reads no markup (09/11/2026). */
  page: PublishedPage,
  diagramWords: readonly string[] = [],
  undrawnDiagramWords: readonly string[] = [],
  /** The numeric cells the CALLER found missing in its own render, or none: finding a worksheet's cells in a page means
   *  knowing that page's markup (`pipeline/xlsx-page-cells.ts`), which this check no longer does. Last and named, so
   *  adding it could not silently shift the two word lists above — it did, for one commit of 09/11/2026. */
  missingCells: readonly { ref: string; cause: MissingWordCause }[] = [],
): MissingWordCauseGroup[] {
  const wordTokens = missingTokens(source, pageWords(page), source.deliberateRemovals, diagramWords, undrawnDiagramWords);
  return groupByCause([...wordTokens, ...missingNumericTokens(missingCells)]);
}

/** The shape kept in `SyncedDocument.conservation`, from groups already
 *  computed: `count` per cause, the true total; never a word (owner
 *  decision, 09/10/2026: the app keeps no content of a document). Split from
 *  `conservationOfDeclaredFormat` so a caller that already has the groups
 *  (the dev-only log, the record — `pipeline/publish-conservation.ts`)
 *  does not read the page twice. */
export function conservationFromMissingWordGroups(groups: readonly MissingWordCauseGroup[]): DocumentConservation {
  // `split-by-page` is NOT a loss and never enters the count the owner reads; it stays in `causeCounts`, where it asks for
  // the human look it deserves (Mikolaj, 29/10/2026: « le compteur peut nous demander une vérif humaine si nécessaire »).
  const missing = groups.reduce((n, g) => n + (g.cause === "split-by-page" ? 0 : g.words.length), 0);
  const causeCounts = groups.map((g) => ({ cause: g.cause, count: g.words.length }));
  return {
    decision: missing > 0 ? "missing-words" : "ok",
    lostLetters: 0,
    gluedWords: 0,
    missingWords: missing,
    units: [],
    ...(causeCounts.length > 0 ? { causeCounts } : {}),
  };
}

// RETIRÉ LE 10/11/2026 (revue du découpage) : `conservationOfDeclaredFormat(source, page)`. Elle n'était appelée que
// par son propre fichier de tests, et le découpage du 09/11 l'a laissée appeler `missingWordGroups` avec DEUX
// arguments quand la production lui en passe CINQ — les mots des diagrammes et les cellules numériques manquantes
// (`conservation/publish-conservation.ts`). Elle sous-déclarait donc, et ses tests validaient une fonction que le
// produit n'exécute pas. La composition est désormais écrite dans le test, où son manque se voit.
