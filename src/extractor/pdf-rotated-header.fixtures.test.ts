/**
 * Rotated table headers on a real Word PDF (corpus 282, page 9, measured 19/10/2026): the six column headers of the risk matrix are
 * printed turned by a quarter, and were published one letter per line AND backwards (« t i e k r a b g ü f r e V » for
 * « Verfügbarkeit »). Poppler reads them right. This file belongs to the `pdf` batch of `vitest.config.ts` (PDF_HEAVY_TESTS).
 * The place to act: where `extractor/pdf.ts` builds the cell text of rotated runs (`extractor/glyph-runs.ts`, `extractor/pdf-cell-paragraphs.ts`).
 */
import { describe, expect, it } from "vitest";

import { publishedPagesOf, textUnitsOf } from "./pdf-corpus-cases.test.support";

const HEADERS = [
  "Verfügbarkeit",
  "Integrität",
  "Vertraulichkeit",
  "Nichtverkettung",
  "Transparenz",
  "Intervenierbarkeit",
];
const reversed = (s: string): string => [...s].reverse().join("");
const squeezed = (s: string): string => s.replace(/\s+/gu, "");

describe("282 p9 — the rotated headers of the risk matrix", () => {
  it("each header is published as its word, letters in reading order", async () => {
    const units = textUnitsOf((await publishedPagesOf("282-dsfa-hos-vorlage-v1-0-Word.pdf", "fr"))[8]!).map(squeezed);
    for (const word of HEADERS) {
      // The failure value (the reversed word) differs from the expected one by construction.
      expect(reversed(word)).not.toBe(word);
      expect({
        word,
        publishedAsWord: units.includes(word),
        publishedReversed: units.includes(reversed(word)),
      }).toEqual({ word, publishedAsWord: true, publishedReversed: false });
    }
  }, 120_000);
});
