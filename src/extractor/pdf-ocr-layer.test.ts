/**
 * A page that carries an invisible text layer (the OCR text a scanner or an archive hides under the picture of the
 * page) makes its PDF a SCAN (05/10/2026; until then, since 02/10/2026, it was a normal digital page).
 *
 * WHY. The scanner's own OCR is often wrong: the fixture `12-Archive-OCR-Ancien.pdf` carries "TOTAL 12 OOO EUROS" under a
 * scan that shows "TOTAL 42 000 EUROS". With the AI off the document is refused (SCANNED_PDF_NEEDS_AI_OCR); with it on,
 * the WHOLE document goes to the AI and the layer is never published. `extractPdf` still names these pages, for that rule
 * and for the « Fun facts ».
 *
 * The file belongs to the `pdf` batch of `vitest.config.ts`: it reads PDFs with our reader.
 * NOT here: the rendered page (that it carries the AI's reading and never the layer is held where the page is rendered);
 * only what the reader hands over.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PDFDocument } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";

import type { IRBlock } from "doc-ir";
import { extractPdf } from "./pdf";
import { FakeVisionPort } from "./pdf-fake-vision.test.support";
import { extractPdfWithVision } from "./pdf-scanned";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => new Uint8Array(readFileSync(join(here, "../../fixtures", name)));
const archive = () => fixture("pdf/12-Archive-OCR-Ancien.pdf");
/** A real public scan (archive.org, public domain) whose 11 pages all carry an invisible OCR layer. */
const publicScan = () => fixture("pdf/scans-publics/Dominion-Saw-Works-1886.pdf");

/** What the scan shows, and what its hidden layer claims (4 read as 1, 0 as O). */
const TRUTH = "TOTAL 42 000 EUROS";
const LAYER = "TOTAL 12 OOO EUROS";

/** A vision port that answers every page of the batch with the same result and records each batch's page count. */
const answering = (text: string) => {
  const batchSizes: number[] = [];
  const port = new FakeVisionPort();
  port.analyzeDocument = async (doc) => {
    const pages = (await PDFDocument.load(doc.bytes)).getPageCount();
    batchSizes.push(pages);
    return Array.from({ length: pages }, () => ({ text, confidence: 0.95 }));
  };
  return { port, batchSizes };
};

/** The blocks of the page tabs, in page order (the tab layout wraps every page in `tabs`). */
const flatBlocks = (blocks: readonly IRBlock[]): IRBlock[] =>
  blocks.flatMap((b) => (b.kind === "tabs" ? b.tabs.flatMap((t) => t.blocks) : [b]));

const textOf = (blocks: readonly { kind: string }[]): string =>
  blocks
    .map((b) => ("inlines" in b ? (b as { inlines: { text: string }[] }).inlines.map((i) => i.text).join("") : ""))
    .join(" ");

describe("a page with an invisible text layer makes its PDF a scan", () => {
  it("is NOT counted among the pages without text by extractPdf: it is named apart", async () => {
    const { scannedPageIndices, ocrLayerPageIndices } = await extractPdf(archive());
    expect(scannedPageIndices).toEqual([]);
    expect(ocrLayerPageIndices).toEqual([0]);
  });

  it("is still named, for the « Fun facts » (which pages hold invisible text)", async () => {
    const { ocrLayerPageIndices } = await extractPdf(archive());
    expect(ocrLayerPageIndices).toEqual([0]);
  });

  it("AI off: refused, nothing sent; AI on: the whole document is sent and the page holds the reading, never the layer", async () => {
    const off = answering(TRUTH);
    await expect(extractPdfWithVision(archive(), off.port, { ocr: false })).rejects.toMatchObject({
      code: "SCANNED_PDF_NEEDS_AI_OCR",
    });
    expect(off.batchSizes, "no vision call").toEqual([]);
    const { port, batchSizes } = answering(TRUTH);
    const read = await extractPdfWithVision(archive(), port);
    expect(batchSizes).toEqual([1]);
    expect(read.scannedPages).toBe(1);
    const text = textOf(flatBlocks(read.doc.blocks));
    expect(text, "the AI's reading is in the document").toContain(TRUTH);
    expect(text, "never the scanner's layer").not.toContain(LAYER);
  });

  it("a real public scan with an OCR layer on all its 11 pages: refused with the AI off; read whole with it on", async () => {
    const bytes = publicScan();
    const { scannedPageIndices, ocrLayerPageIndices, pages } = await extractPdf(bytes);
    expect(scannedPageIndices).toEqual([]);
    expect(ocrLayerPageIndices).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(textOf(pages.flat()).length, "the layer's words are there").toBeGreaterThan(1000);

    await expect(extractPdfWithVision(bytes, new FakeVisionPort(), { ocr: false })).rejects.toMatchObject({
      code: "SCANNED_PDF_NEEDS_AI_OCR",
      pageCount: 11,
      scannedPageCount: 11,
    });
    const { port, batchSizes } = answering("read by the AI");
    const read = await extractPdfWithVision(bytes, port);
    expect(batchSizes, "11 pages: a batch of 10 and a batch of 1").toEqual([10, 1]);
    expect(read.scannedPages).toBe(11);
    expect(read.pageCount).toBe(11);
  });

  it("a document mixing an invisible-layer page and a page with NO text is a scan: both pages are read, the layer is not kept", async () => {
    const mixed = await PDFDocument.create();
    const layered = await PDFDocument.load(archive());
    const blank = await PDFDocument.load(fixture("pdf/05c-Scan-Illisible.pdf"));
    for (const page of await mixed.copyPages(layered, [0])) mixed.addPage(page);
    for (const page of await mixed.copyPages(blank, [0])) mixed.addPage(page);

    const { port, batchSizes } = answering("the page read by the model");
    const read = await extractPdfWithVision(await mixed.save(), port);
    expect(batchSizes, "one batch of TWO pages").toEqual([2]);
    expect(read.scannedPages).toBe(2);
    expect(read.pageCount).toBe(2);
    const text = textOf(flatBlocks(read.doc.blocks));
    expect(text, "the invisible layer is not kept").not.toContain(LAYER);
    expect(text).toContain("the page read by the model");
  });

  it("a scan whose reading fails still fails loudly (no fallback, not even on a layer)", async () => {
    const unreadable = fixture("pdf/05c-Scan-Illisible.pdf");
    const port = new FakeVisionPort();
    port.analyzeDocument = async () => [{ text: "x", confidence: 0.1 }];
    await expect(extractPdfWithVision(unreadable, port)).rejects.toMatchObject({ code: "OCR_LOW_CONFIDENCE" });
  });
});

describe("non-regression: nothing else carries an invisible layer", () => {
  it.each([
    ["05a-Rapport-Annuel-Digital.pdf", "ordinary digital prose"],
    ["05d-Dossier-Mixte.pdf", "digital + scanned"],
    ["13-Police-Sans-CMap.pdf", "font without a mapping table"],
    ["14-Ligatures-ToUnicode.pdf", "ligatures through ToUnicode"],
    ["11-Brochure-Deux-Colonnes.pdf", "two columns"],
  ])("%s (%s): no page named as invisible text", async (name) => {
    const { ocrLayerPageIndices } = await extractPdf(fixture(`pdf/${name}`));
    expect(ocrLayerPageIndices).toBeUndefined();
  });
});
