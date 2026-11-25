/**
 * The regression detector on the extraction, in work done, never in seconds: a stopwatch measures the machine as
 * much as the code, and the counters are identical from run to run.
 *
 * The fixtures. `05d` has three pages, two of them without text: the only one where the pages with glyphs differ
 * from the pages, without which a wrong cost model passed all the others. Written limit: `05d` is the only one that
 * reads images (2, its scanned pages); the documents that paint large images are documents this package may not carry.
 *
 * How the numbers are revised. They are goldens: a counter that rises is a regression until proven otherwise, and
 * it is updated in the golden file, in a commit that says why, never in the test. The failure message says what
 * the number means, not only that it changed.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { extractPdf } from "../extractor/pdf";
import { COUNTERS, emptyExtractionCost, type ExtractionCost } from "../extractor/extraction-cost";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");

const FIXTURES = [
  "05a-Rapport-Annuel-Digital",
  "05d-Dossier-Mixte",
  "11-Brochure-Deux-Colonnes",
  "16-Brochure-Dense",
  "18-Composition-Reelle",
] as const;

const KEYS = Object.keys(emptyExtractionCost()) as (keyof ExtractionCost)[];

/** The golden's keys are the `ExtractionCost` field names, so the failure
 *  message names the very key one would edit in the file. */
const readGolden = (name: string): Record<string, number> =>
  JSON.parse(readFileSync(join(repoRoot, `golden/extraction-cost/${name}.json`), "utf8")) as Record<string, number>;

describe("coût d'extraction — golden", () => {
  it.each(FIXTURES)("%s ne coûte pas plus de travail qu'avant", async (name) => {
    const expected = readGolden(name);
    const { cost } = await extractPdf(new Uint8Array(readFileSync(join(repoRoot, `fixtures/pdf/${name}.pdf`))));

    const drift = KEYS.filter((key) => cost[key] !== expected[key]).map(
      (key) => `  ${key} ${expected[key]} → ${cost[key]} : ${COUNTERS[key].rise}`,
    );
    if (drift.length > 0) {
      throw new Error(
        `Le coût d'extraction de ${name} a changé :\n${drift.join("\n")}\n\n` +
          `Un compteur qui monte est une régression jusqu'à preuve du contraire. S'il s'agit d'une\n` +
          `amélioration délibérée, mettre à jour golden/extraction-cost/${name}.json dans un commit\n` +
          `qui dit POURQUOI le nombre bouge — jamais dans celui qui le fait bouger sans le dire.`,
      );
    }
    expect(drift).toEqual([]);
  });

  /**
   * THE KEY SET IS CHECKED BOTH WAYS, or it would drift in silence. A counter
   * missing from a golden already fails the test above (the value read is
   * `undefined`); a key IN EXCESS in a golden would show nowhere — a counter
   * removed from the code would leave its number behind, and the golden would
   * lie about what it watches.
   */
  it.each(FIXTURES)("%s : le golden porte exactement les clés des compteurs, ni plus ni moins", (name) => {
    expect(Object.keys(readGolden(name)).sort()).toEqual([...KEYS].sort());
  });

  it("le compteur est DÉTERMINISTE : deux extractions du même document donnent le même travail", async () => {
    const bytes = new Uint8Array(readFileSync(join(repoRoot, "fixtures/pdf/05a-Rapport-Annuel-Digital.pdf")));
    const a = await extractPdf(bytes);
    const b = await extractPdf(bytes);
    expect(a.cost).toEqual(b.cost);
  });
});
