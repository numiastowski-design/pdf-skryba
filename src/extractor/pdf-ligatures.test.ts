/**
 * Point 11 of the former ideas log (git history) v0.6 — typographic ligatures (08/09/2026).
 *
 * THE FINDING, CORRECTED A SECOND TIME ON 29/09/2026 — THE MECHANISM WAS WRONG
 * =============================================================================
 * The entry feared that merged glyphs would come out as non-printable
 * Unicode characters (U+FB00-FB06). This file measures `getTextContent()`
 * only (`extractPdf` → PARAGRAPH text): on this path, **the returned
 * text never carries a precomposed ligature** — true, and always
 * true, but NOT because pdf.js `would read the /ToUnicode CMap here and not
 * elsewhere`: an independent cross-check (29/09/2026) measured that
 * `showText` (read by `glyph-positions.ts` for a table cell) AND
 * `getTextContent()` resolve a glyph's unicode in the SAME way
 * (`_charToGlyph`'s `toUnicode.get(charcode)`, pdf.worker.mjs ~l.28767,
 * shared by both paths), and that on THIS fixture as on the real
 * document the `/ToUnicode` CMap maps TO the precomposed form, not
 * to its letters. What decomposes the text of `getTextContent()` is a
 * POST-PROCESSING that only this path runs: `normalizeUnicode()`
 * (pdf.worker.mjs ~l.720, NFKC on a closed list of code points),
 * called from `runBidiTransform()` (~l.35856-35859). `showText` never goes
 * through it — that is why `glyph-positions.ts` must decompose by itself.
 * Found on a real document (`37-Circulaire-Rentree-2023-Pages.pdf`, Apple
 * Pages) where the ligatured word WAS in a cell: 73 precomposed
 * occurrences published, 0 outside a table. Fixed in `glyph-positions.ts`
 * (`LIGATURE_PRESENTATION_FORMS`).
 *
 * Consequence: **NFKC normalisation was NOT a no-op** on the glyph
 * path — it was needed there, and has been applied there since. It remains a
 * no-op on the `getTextContent()` path that this file measures: nothing here
 * changes.
 *
 * pdf.js, and `getTextContent()` with it, was removed on 01/11/2026: the finding above is of its date. The tests below
 * now read the paragraphs of our reader.
 *
 * WHAT THIS TEST DOES NOT PROVE
 * ============================
 * The fixture is synthetic: its `/ToUnicode` DECLARES ligatures, as a
 * typesetting engine does, but no font is actually embedded in it
 * (the generator says why). The test therefore establishes that **our
 * chain never returns a ligature character when the CMap announces
 * one, on the `getTextContent()` path** — not on the glyph path (measured by
 * `glyph-positions.test.ts` and by `pdf-source.oracle.test.ts` (deleted, see git history) since
 * 29/09/2026), and not how often real producers
 * announce one. That last question stays open beyond the two documents
 * measured to date (14, 37).
 *
 * This file belongs to the `pdf` batch of `vitest.config.ts` — it reads PDFs with our reader.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { extractPdf } from "./pdf";

const here = dirname(fileURLToPath(import.meta.url));
const bytes = new Uint8Array(readFileSync(join(here, "../../fixtures/pdf/14-Ligatures-ToUnicode.pdf")));

/** U+FB00 ff, FB01 fi, FB02 fl, FB03 ffi, FB04 ffl, FB05/FB06 st. */
const LIGATURES = new Set([0xfb00, 0xfb01, 0xfb02, 0xfb03, 0xfb04, 0xfb05, 0xfb06]);

const flatText = async (): Promise<string> => {
  const { pages } = await extractPdf(bytes);
  return pages
    .flat()
    .map((block) => (block.kind === "paragraph" ? block.inlines.map((i) => i.text).join("") : ""))
    .join(" ");
};

describe("ligatures — what our reader actually returns", () => {
  it("no U+FB00-FB06 character reaches the IRDoc, on the five Latin ligatures", async () => {
    const text = await flatText();
    const found = [...text].filter((c) => LIGATURES.has(c.codePointAt(0) ?? 0));
    expect(found).toEqual([]);
  });

  it("each isolated ligature decomposes into its letters", async () => {
    const text = await flatText();
    // Line 1 of the fixture: the ligature alone, between brackets, without word
    // context — the decomposition reads without ambiguity.
    expect(text).toContain("ff[ff]");
    expect(text).toContain("fi[fi]");
    expect(text).toContain("fl[fl]");
    expect(text).toContain("ffi[ffi]");
    expect(text).toContain("ffl[ffl]");
  });

  it("in context, the words stay whole and correctly spelt", async () => {
    const text = await flatText();
    for (const word of ["chiffre", "affaires", "financier", "flux", "efficace", "souffle"]) {
      expect(text).toContain(word);
    }
  });

  it("no stray space is inserted inside a ligatured word", async () => {
    // The symptom feared by point 11 ("of ice" for "office"). It was
    // indeed REPRODUCED while building the fixture — but its cause
    // was the absence of `/Widths` in the PDF, which deprived pdf.js of any
    // advance and triggered its space "fillers" (`pdf.ts:112-115`).
    // With declared widths, it disappears. This test locks both halves:
    // the symptom is not our doing, and a PDF with wrong widths will
    // reproduce it without our pipeline being able to tell it from a real space.
    const text = await flatText();
    for (const split of ["fi nancier", "fl ux", "e fficace", "chi ffre"]) {
      expect(text).not.toContain(split);
    }
  });
});
