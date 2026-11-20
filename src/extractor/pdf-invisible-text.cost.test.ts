/** 09/10/2026, counter-review of ec5cbf95: the run-to-glyph pairing rescanned every glyph of an origin for every run at that
 *  origin. Measured on a trap page (one rendering-mode-3 run + N one-letter runs at the same origin), extractPdf: N=5 000
 *  4.5 s, 10 000 7.2 s, 20 000 38 s; without the filter 1.0 s at N=20 000.
 *  Run: npx vitest run --project=pdf src/extractor/pdf-invisible-text.cost.test.ts (serial batch: timing bound). */
import {
  PDFDocument,
  StandardFonts,
  TextRenderingMode,
  beginText,
  endText,
  moveText,
  setFontAndSize,
  setTextRenderingMode,
  showText,
} from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";

import { extractPdf } from "./pdf";

describe("PDF hidden-text filter: cost bounded on a trap page", () => {
  it("one invisible run and 10 000 visible one-letter runs at the same origin: under 3 s (7.2 s before)", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const key = page.node.newFontDictionary(font.name, font.ref);
    page.drawText("Visible paragraph alpha", { x: 40, y: 740, size: 12, font });
    page.pushOperators(
      beginText(),
      setFontAndSize(key, 12),
      setTextRenderingMode(TextRenderingMode.Invisible),
      moveText(40, 600),
      showText(font.encodeText("hiddenrun")),
      endText(),
    );
    for (let i = 0; i < 10_000; i++)
      page.pushOperators(
        beginText(),
        setFontAndSize(key, 12),
        moveText(40, 500),
        showText(font.encodeText("a")),
        endText(),
      );
    const bytes = await doc.save();
    const t = performance.now();
    await extractPdf(bytes);
    expect(performance.now() - t).toBeLessThan(3000);
  }, 120_000);
});
