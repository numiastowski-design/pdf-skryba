/**
 * A control character a font DECLARES never reaches the published text, nor the text the conservation check reads.
 * Decision of 24/11/2026, found by the PDF fuzz (lot 4): a `/ToUnicode` CMap (ISO 32000-1 §9.10.3) mapping a code to
 * « A » + U+0007 published the U+0007, because only a glyph whose WHOLE text is control characters was dropped.
 * Both readings come from the same glyph text (`glyph-positions.ts#placedTextOf`): the published runs and the second
 * reading (`textSource.reference`) must hold the same letters, so the check reports no false loss.
 */
import { PDFDict, PDFDocument, PDFName, StandardFonts } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";

import { extractPdf } from "./pdf";

/** Code 01 paints U+0007 alone; code 02 paints « A » + U+0007. */
const CMAP =
  "/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 begincodespacerange <00> <FF> endcodespacerange " +
  "2 beginbfchar <01> <0007> <02> <00410007> endbfchar endcmap end end";

async function pdfWithControls(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  const font = doc.context.register(
    doc.context.obj({
      Type: "Font",
      Subtype: "Type1",
      BaseFont: "Helvetica",
      Encoding: "WinAnsiEncoding",
      ToUnicode: doc.context.register(doc.context.flateStream(CMAP)),
    }),
  );
  const page = doc.addPage([612, 792]);
  page.drawText("Plain words", { x: 40, y: 740, size: 12, font: helvetica });
  const resources = page.node.Resources() ?? doc.context.obj({});
  page.node.set(PDFName.of("Resources"), resources);
  const fonts = resources.lookupMaybe(PDFName.of("Font"), PDFDict) ?? doc.context.obj({});
  resources.set(PDFName.of("Font"), fonts);
  fonts.set(PDFName.of("FX"), font);
  page.node.addContentStream(doc.context.register(doc.context.stream("BT /FX 24 Tf 40 600 Td <0102> Tj ET")));
  return doc.save();
}

const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/u;

describe("a control character declared by a font (decision of 24/11/2026)", () => {
  it("publishes « A », without U+0007, and the conservation source holds the same letters", async () => {
    const result = await extractPdf(await pdfWithControls());
    const published = JSON.stringify(result.pages);
    expect(published).toContain('{"text":"A"}');
    const runs = result.textSource.runs.flatMap((page) => page.map((run) => run.text)).join("");
    const cycles = result.textSource.reference?.pages ?? [];
    const reference = cycles.flatMap((page) => page.map((cycle) => cycle.text)).join("");
    expect(runs).not.toMatch(CONTROL);
    expect(reference).not.toMatch(CONTROL);
    expect(reference).toContain("A");
  });
});
