/**
 * A word pdf.js used to split into two runs is published whole once the text comes from our glyphs
 * (docs/CONCEPTION-TEXTE-PDF-GLYPHES.md; issue defaut-file n° 33, fixture 48).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { extractPdf } from "./pdf";

const here = dirname(fileURLToPath(import.meta.url));
const bytesOf = (name: string): Uint8Array => new Uint8Array(readFileSync(join(here, "../../fixtures/pdf", name)));

describe("a word pdf.js used to cut in two is published whole (fixture 48)", () => {
  it("page 11 reads « jouer », never « jo uer »", async () => {
    const page11 = (
      await extractPdf(bytesOf("48-Programme-Terminale-Spe-Word2010.pdf"), "fr", { pageLimit: Infinity })
    ).pages[10]!.map((b) => JSON.stringify(b)).join("\n");
    expect(page11).toContain("amenée à jouer à l’avenir");
    expect(page11).not.toContain("jo uer");
  }, 120_000);
});

// Bench of 14/10/2026: the three recoils of the first glyph-built version, all from a blank dropped where a run closes.
describe("a blank where a run closes is kept (fixtures 38 and 49)", () => {
  // 16/10/2026: the tab layout keeps running footers, so the test asserts the footer's blanks instead of its removal.
  it("doc 38: the footer « Version 4 Page N of 9 » keeps its blanks on every page", async () => {
    const all = (await extractPdf(bytesOf("38-SOP-Video-Appraisals-Word365.pdf"), "en", { pageLimit: Infinity })).pages
      .flat()
      .map((b) => JSON.stringify(b))
      .join("|");
    for (const n of [2, 3, 4, 5, 6, 7]) expect(all).toContain(`Version 4 Page ${n} of 9`);
  }, 120_000);

  it("doc 49: « 3. Indicateurs de performance », never « 3.Indicateurs »", async () => {
    const all = (
      await extractPdf(bytesOf("49-GrandSoissons-RPQS-Eau-2021-PDFium.pdf"), "fr", { pageLimit: Infinity })
    ).pages
      .flat()
      .map((b) => JSON.stringify(b))
      .join("|");
    expect(all).toContain("3. Indicateurs");
    expect(all).not.toContain("3.Indicateurs");
  }, 300_000);
});
