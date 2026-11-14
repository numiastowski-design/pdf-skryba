/** The one word count of the app: a word is a maximal run of letters or digits, NFKC lower case, cut at the boundary between a script
 *  written without spaces and Latin or digits (below). The conservation check, the published page's reading and the "Fun facts" count
 *  all use it (Mikolaj, 07/10/2026).
 *  NOT here: what counts as a missing word or its cause (`pipeline/declared-format-conservation.ts`).
 *  Called by: `pipeline/source-reading-docx.ts` (re-exported), `orchestrator/document-facts.ts`. */

/** A letter or digit of Han, Hiragana, Katakana or Hangul (script extensions, so the long-vowel mark stays in its word). The letter/digit
 *  lookahead keeps out punctuation that shares those extensions (the middle dot U+00B7). */
const LETTER_OR_DIGIT = String.raw`[\p{L}\p{N}]`;
const UNSPACED = String.raw`[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}]`;

/** A script written without spaces never shares a token with Latin letters or digits: "国際会議SC23における" is "国際会議", "sc23",
 *  "における". Word puts the automatic space there in its PDF and the Confluence search splits there too, so both sides of every
 *  comparison cut the same way (CONCEPTION-MESURE-MOTS-PDF [C1], Mikolaj 20/10/2026). */
const WORD = new RegExp(String.raw`(?:(?=${LETTER_OR_DIGIT})${UNSPACED})+|(?:(?!${UNSPACED})${LETTER_OR_DIGIT})+`, "gu");

/** U+200B (zero-width space) is no break, on either side: the renderer writes one before a superscript glued to a word
 *  (`renderer/storage.ts#renderInlines`, PLATFORM-STATUS §81) and the source reading joins the runs (« 4 » + « ème » is « 4ème »);
 *  one already in the source text is dropped the same way. A PDF's reading is the other way round (`render-lint.ts#toWords`). */
export const wordsOf = (text: string): string[] => text.replaceAll("​", "").normalize("NFKC").toLowerCase().match(WORD) ?? [];
