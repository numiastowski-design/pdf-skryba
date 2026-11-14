/** Whether a PDF font is bold, read from what the font really declares rather
 *  than from the one flag pdf.js exposed (pdf.js is no longer in the product: `pdf-font-objects.ts` now reads the font dictionary).
 *  NOT here: what boldness is then used for — the `strong` mark of the
 *  paragraph pieces (`extractor/pdf-paragraphs.ts`).
 *  Called by: `extractor/pdf-source.ts`. */

/**
 * font-weight — the WEIGHT of a font, and what pdf.js did not say (HISTORICAL: pdf.js has been removed from the product
 * since 01/11/2026; the measurement below predates that, and the name rule remains the product's).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DEFECT THIS MODULE FIXES (measured on 14/09/2026)
 * ═══════════════════════════════════════════════════════════════════════════
 * We read `page.commonObjs.get(fontName).bold`. In the worker source,
 * `this.bold = /bold/i.test(fontName)` is inside
 * `Font.fallbackToSystemFont(properties)` — whose FIRST statement is
 * `this.missingFile = true` (`pdf.worker.mjs`, 6.2.108).
 *
 * So: **pdf.js only filled in `bold` on its SUBSTITUTION path**,
 * when it did not have the font file. An EMBEDDED font returned
 * `bold === undefined`.
 *
 * Measured on the twelve fixtures of the repository — eleven do not embed their fonts
 * (base-14, produced by our generator), and `18-Composition-Reelle` is the
 * ONLY one that embeds them:
 *
 *     05a, 05d, 11, 12, 13, 14, 15, 16, 17   missingFile=true    bold=true/false
 *     18  AAAAAA+Arial-BoldMT                missingFile=false   bold=undefined
 *     18  BAAAAA+ArialMT                     missingFile=false   bold=undefined
 *
 * `boldByPage` was EMPTY on `18` and its page carried no `<strong>` — even
 * for the font literally named `-BoldMT`. Yet every print-ready PDF
 * embeds its fonts: the bold was right on the documents
 * we fabricate, and wrong on the whole class the product will receive.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THREE OUTCOMES, BECAUSE THERE ARE THREE STATES OF KNOWLEDGE
 * ═══════════════════════════════════════════════════════════════════════════
 *  - `bold`    — someone ruled FOR.
 *  - `normal`  — a reading ruled AGAINST, on a font matched
 *                with a standard one (it was pdf.js; today it is `pdf-font-objects.ts#ourWeightOf`).
 *  - `unknown` — **nobody ruled.** This is not "not bold":
 *                it is ignorance, and it is named so that an additional
 *                reading can fill it one day.
 *
 * ⚠️ `unknown` DOES NOT ENTER the set of bold positions, so in
 * output it behaves like `normal` today. This is not a
 * redundancy: the THIRD reading already exists and runs in parallel — the
 * stroke-based fake bold (render modes 2 and 6), which `extractPdf` pairs under
 * `strokedAt`. An `unknown` position can therefore still be declared bold by
 * it. This is the conjunction of independent readings, not an arbitration.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS NOT DECIDED HERE, AND WHEN IT WILL BE
 * ═══════════════════════════════════════════════════════════════════════════
 * The name rule is RELIABLE WHEN IT SAYS YES and mute when it says no:
 * a font can be bold without saying so (`Arial-Black`, `Foo-Heavy`, a
 * subset named `AAAAAA+F1`). Hence the asymmetry — a name that does not match
 * yields `unknown`, never `normal`.
 *
 * **THE CORPUS CANNOT DECIDE BETTER.** The only non-base-14 names it
 * contains are `ABCDEF+SubsetSansCMap`, `LigatureTest+Helvetica`,
 * `AAAAAA+Arial-BoldMT` and `BAAAAA+ArialMT`. No `Semibold`, no `Black`,
 * no font whose name hides its weight. Eleven documents out of twelve measure
 * our own habits.
 *
 * ➜ **MODEL FREEZE CONDITION**: `name`, `bold` and `stroked` must be
 *   measured SIDE BY SIDE on the twenty expected real documents before the
 *   shape of the weight is frozen. Until that measurement has taken place, this
 *   module is a starting value, not an established result.
 *
 * ➜ **TO BE REMEASURED AT THE SAME TIME**: the heading rule delivered in 2.35.0
 *   (`layout/heading-sizes.ts`) was calibrated on this same corpus. It does NOT
 *   read the weight — it classifies by sizes only, so the defect above
 *   never reached it. But its ratio threshold was chosen on eleven
 *   base-14 documents, and it is to be redone on the twenty real ones at the same
 *   time, for the same reason: a corpus that measures our habits.
 */

/** The three states of knowledge about the weight of a font. */
export type FontWeight = "bold" | "normal" | "unknown";

/**
 * The name rule, **the one pdf.js applied** (`/bold/i` on the name of the
 * font), kept rather than inventing a second one: a single definition of
 * "bold by name".
 *
 * It catches `Bold`, `SemiBold`, `DemiBold`, `ExtraBold` — all the
 * weights built on the word. It misses `Black`, `Heavy`, and any mute name.
 */
const NAME_SAYS_BOLD = /bold/i;

/** What this module needs to read about a font object (the one from our reader, `pdf-font-objects.ts`). The shape
 *  is deliberately minimal and everything in it is optional. Describing less means depending on less. */
export interface FontLike {
  name?: unknown;
  bold?: unknown;
  missingFile?: unknown;
}

/**
 * The weight of a font, read in order: what the font object asserts, then what
 * the name says, then abstention.
 */
export function fontWeight(font: FontLike | undefined): FontWeight {
  // 1. The font object has ruled (`bold` filled in). Its answer is authoritative in
  //    BOTH directions: the former pdf.js reader only gave it on its substitution path,
  //    after matching the name with a standard font.
  if (font?.bold === true) return "bold";
  if (font?.bold === false) return "normal";

  // 2. The object asserted nothing (embedded font, formerly with pdf.js). We read the name ourselves.
  const name = font?.name;
  if (typeof name === "string" && NAME_SAYS_BOLD.test(name)) return "bold";

  // 3. Nobody ruled. See the header: this is not "not bold".
  return "unknown";
}
