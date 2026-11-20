/**
 * The page furniture of a real document: fixture 47 (GrandSoissons council decisions, 2022, PDFium; issue
 * `defaut-file` n° 32, 13/10/2026). Its annexed loan contract repeats a four-line footer whose last line carries
 * the page number glued to an address (pages 5 to 25), and its amortisation tables run their band over the footer
 * (pages 29 to 40). 16/10/2026: the tab layout removes no furniture, so these footers are published on their own
 * page and nothing is lost. Each test holds a WITNESS, the page's own body text, next to the footer.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import type { IRBlock } from "doc-ir";
import { extractPdf } from "./pdf";

const here = dirname(fileURLToPath(import.meta.url));
const bytes = new Uint8Array(
  readFileSync(join(here, "../../fixtures/pdf/47-GrandSoissons-Deliberations-2022-PDFium.pdf")),
);

const pageText = (blocks: readonly IRBlock[]): string => JSON.stringify(blocks);

describe("fixture 47: running footers of a real document", () => {
  let pages: IRBlock[][] = [];
  beforeAll(async () => {
    pages = (await extractPdf(bytes, "fr", { pageLimit: Number.POSITIVE_INFINITY })).pages;
  }, 120_000);

  it("pages 5 and 6: the footer whose last line carries a glued page number is published on its own page", () => {
    for (const index of [4, 5]) {
      const text = pageText(pages[index]!);
      expect(text).toContain("caissedesdepots.fr");
      expect(text).toContain("Caisse des dépôts et consignations");
      expect(text).toContain("Amiens cedex");
    }
    // Witness: the body of page 6 is still there.
    expect(pageText(pages[5]!)).toContain("Durant cette phase");
  });

  it("pages 30 and 31: the footer inside the amortisation table's band is published on its own page", () => {
    for (const index of [29, 30]) {
      const text = pageText(pages[index]!);
      expect(text).toContain("CAISSE DES DÉPÔTS ET CONSIGNATIONS");
      expect(text).toContain("Offre Contractuelle");
    }
    // Witness: the table's header row is still there.
    expect(pageText(pages[29]!)).toContain("échéance");
  });
});
