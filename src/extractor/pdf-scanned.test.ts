import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PDFDocument, PDFName } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";

import { ReaderError } from "doc-ir";
import type { IRBlock } from "doc-ir";
import { extractPdf } from "./pdf";
import { FakeVisionPort } from "./pdf-fake-vision.test.support";
import { PAGE_SIZED_LIMITS } from "./pdf-page-caps.test.support";
import { extractPdfWithVision, ocrScannedPages } from "./pdf-scanned";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => new Uint8Array(readFileSync(join(here, "../../fixtures/pdf", name)));
/** The blocks of the page tabs, in page order (the tab layout wraps every page in `tabs`). */
const flatBlocks = (blocks: readonly IRBlock[]): IRBlock[] =>
  blocks.flatMap((b) => (b.kind === "tabs" ? b.tabs.flatMap((t) => t.blocks) : [b]));
const blocksOf = (read: { doc: { blocks: readonly IRBlock[] } }): IRBlock[] => flatBlocks(read.doc.blocks);

describe("ocrScannedPages (real corpus fixtures, mocked vision)", () => {
  /**
   * ⚠️ THIS TEST USED TO RUN ON FORTY PAGES AND FOUR BATCHES (until
   * 14/09/2026). The product now REFUSES a document of more than fifteen
   * pages (`orchestrator/page-cap.ts`): `extractPdf` throws
   * `DOCUMENT_TOO_MANY_PAGES` on `05b`, and the split into four batches has
   * become a path that production can no longer reach.
   *
   * It now exercises the LARGEST reachable case — fifteen pages, hence
   * two batches of 10 and 5. The batch boundary is still crossed, which is all
   * this test had to prove.
   *
   * **The bytes remain those of a real scan**: we take the first fifteen
   * pages of `05b` rather than fabricate a PDF. A fabricated scan only measures
   * our habits; here we want the split of a real document.
   */
  it("un scan de 15 pages (le plafond) est découpé en 2 lots de 10 et 5, toutes pages OCRisées", async () => {
    const bytes = fixture("05b-Archive-Scannee-40p.pdf");
    // `extractPdf` would refuse the whole document — it is the ceiling that speaks,
    // and that is tested elsewhere (`pdf.test.ts`). Here we aim at `ocrScannedPages`,
    // which receives its page indices as a parameter.
    const scannedPageIndices = Array.from({ length: 15 }, (_, i) => i);

    const vision = new FakeVisionPort();
    // Configure a result for whatever batch bytes get built — since batch
    // content depends on pdf-lib's exact output, assert call SHAPE (count,
    // mime type) via a local counter rather than pre-computing expected
    // bytes. Overriding the method wholesale bypasses FakeVisionPort's own
    // call tracking, hence the local `calls`/`mimeTypes` bookkeeping here.
    const mimeTypes: string[] = [];
    vision.analyzeDocument = async (doc) => {
      mimeTypes.push(doc.mimeType);
      const pageCount = (await PDFDocument.load(doc.bytes)).getPageCount();
      return Array.from({ length: pageCount }, (_, i) => ({ text: `page ${i}`, confidence: 0.9 }));
    };

    const result = await ocrScannedPages(bytes, scannedPageIndices, vision);
    expect(mimeTypes).toHaveLength(2); // 15 pages, batches of 10 → 10 + 5
    expect(mimeTypes.every((m) => m === "application/pdf")).toBe(true);
    expect(result.size).toBe(15);
    for (const idx of scannedPageIndices) expect(result.get(idx)?.[0]?.kind).toBe("paragraph");
    // A LARGE TIME BUDGET, AND IT IS A GUARD AGAINST A HANG, NOT A
    // SLOWNESS DETECTOR. The repository has a regression detector on
    // extraction, and it counts WORK, not seconds
    // (`pipeline/extraction-cost.test.ts`). This stopwatch only measures the
    // machine: it is there so that a test that hangs fails instead of hanging.
    //
    // It was 30 seconds when this test extracted forty pages; the
    // work melted away with the ceiling — no more full extraction, two batches
    // instead of four — but the bound stays wide rather than tightened on
    // a measure of today, for the reason above.
  }, 30_000);

  it("05c-Scan-Illisible.pdf: low-confidence result throws OCR_LOW_CONFIDENCE, aborting the whole call", async () => {
    const bytes = fixture("05c-Scan-Illisible.pdf");
    const { scannedPageIndices } = await extractPdf(bytes);
    expect(scannedPageIndices).toEqual([0]);

    const vision = new FakeVisionPort();
    vision.analyzeDocument = async () => [{ text: "", confidence: 0.1 }];

    await expect(ocrScannedPages(bytes, scannedPageIndices, vision)).rejects.toSatisfy(
      (error) => error instanceof ReaderError && error.code === "OCR_LOW_CONFIDENCE",
    );
  });

  it("05d-Dossier-Mixte.pdf: only the scanned pages (1, 2) are batched, digital page 0 untouched", async () => {
    const bytes = fixture("05d-Dossier-Mixte.pdf");
    const { pages, scannedPageIndices } = await extractPdf(bytes);
    expect(scannedPageIndices).toEqual([1, 2]);
    expect(pages[0]?.length).toBeGreaterThan(0); // page 0 is digital, already has blocks

    const vision = new FakeVisionPort();
    vision.analyzeDocument = async (doc) => {
      const pageCount = (await PDFDocument.load(doc.bytes)).getPageCount();
      expect(pageCount).toBe(2); // only pages 1 and 2 went into the batch
      return Array.from({ length: pageCount }, () => ({ text: "ocr text", confidence: 0.9 }));
    };

    const result = await ocrScannedPages(bytes, scannedPageIndices, vision);
    expect([...result.keys()].sort()).toEqual([1, 2]);
  });
});

describe("extractPdfWithVision (merge, real fixture)", () => {
  it("05d-Dossier-Mixte.pdf: merges digital page 0 with OCR'd pages 1-2, in page order", async () => {
    const bytes = fixture("05d-Dossier-Mixte.pdf");
    const vision = new FakeVisionPort();
    vision.analyzeDocument = async (doc) => {
      const pageCount = (await PDFDocument.load(doc.bytes)).getPageCount();
      return Array.from({ length: pageCount }, (_, i) => ({ text: `ocr page ${i}`, confidence: 0.95 }));
    };

    const { doc } = await extractPdfWithVision(bytes, vision);
    // Digital page 0's blocks come first (real extracted text, non-trivial
    // length), followed by the two OCR'd paragraphs — never reordered.
    expect(flatBlocks(doc.blocks).length).toBeGreaterThan(2);
    const blocks = flatBlocks(doc.blocks);
    const last = blocks[blocks.length - 1];
    expect(last?.kind).toBe("paragraph");
    if (last?.kind === "paragraph") expect(last.inlines[0]?.text).toContain("ocr page");
  });

  // OCR on request (01/10/2026): without `ocr`, the pages with no text layer are
  // counted, never sent to vision, and keep what the file gives (nothing, here).
  it("ocr:false — 05d: vision never called, the digital page kept, the 2 scanned pages counted", async () => {
    const vision = new FakeVisionPort();
    const { doc, scannedPages } = await extractPdfWithVision(fixture("05d-Dossier-Mixte.pdf"), vision, { ocr: false });
    expect(vision.documentCallCount).toBe(0);
    expect(scannedPages).toBe(2);
    expect(doc.blocks.length).toBeGreaterThan(0);
  });

  it("ocr:false — a scan of 12 pages (no page limit of its own any more) is refused for needing the AI", async () => {
    const source = await PDFDocument.load(fixture("05b-Archive-Scannee-40p.pdf"));
    const twelve = await PDFDocument.create();
    for (const page of await twelve.copyPages(source, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])) twelve.addPage(page);
    await expect(extractPdfWithVision(await twelve.save(), new FakeVisionPort(), { ocr: false })).rejects.toMatchObject(
      { code: "SCANNED_PDF_NEEDS_AI_OCR" },
    );
  });

  // Fully scanned PDFs need AI OCR to be published (03/10/2026, features/scanned-pdf-publication.feature).
  it("ocr:false — a PDF of several pages, every one scanned, is REFUSED with the page counts (nothing is read)", async () => {
    const source = await PDFDocument.load(fixture("05b-Archive-Scannee-40p.pdf"));
    const three = await PDFDocument.create();
    for (const page of await three.copyPages(source, [0, 1, 2])) three.addPage(page);
    const vision = new FakeVisionPort();
    await expect(extractPdfWithVision(await three.save(), vision, { ocr: false })).rejects.toMatchObject({
      code: "SCANNED_PDF_NEEDS_AI_OCR",
      pageCount: 3,
      scannedPageCount: 3,
    });
    expect(vision.documentCallCount).toBe(0);
  });

  it("ocr:false — one page with no text is a scan too: refused, nothing read", async () => {
    const vision = new FakeVisionPort();
    await expect(extractPdfWithVision(fixture("05c-Scan-Illisible.pdf"), vision, { ocr: false })).rejects.toMatchObject(
      { code: "SCANNED_PDF_NEEDS_AI_OCR", pageCount: 1, scannedPageCount: 1 },
    );
    expect(vision.documentCallCount).toBe(0);
  });

  it("ocr read — the same 3 scanned pages are read, not refused", async () => {
    const source = await PDFDocument.load(fixture("05b-Archive-Scannee-40p.pdf"));
    const three = await PDFDocument.create();
    for (const page of await three.copyPages(source, [0, 1, 2])) three.addPage(page);
    const vision = new FakeVisionPort();
    vision.analyzeDocument = async () => [0, 1, 2].map((i) => ({ text: `read ${i}`, confidence: 0.95 }));
    const { scannedPages } = await extractPdfWithVision(await three.save(), vision);
    expect(scannedPages).toBe(3);
  });

  it("ocr read: the scanned pages are still counted (a scan stays a scan once read)", async () => {
    const vision = new FakeVisionPort();
    vision.analyzeDocument = async () => [{ text: "read", confidence: 0.95 }];
    const { scannedPages } = await extractPdfWithVision(fixture("05c-Scan-Illisible.pdf"), vision);
    expect(scannedPages).toBe(1);
  });

  it("a digital PDF reports no scanned page", async () => {
    const { scannedPages } = await extractPdfWithVision(
      fixture("05a-Rapport-Annuel-Digital.pdf"),
      new FakeVisionPort(),
    );
    expect(scannedPages).toBeUndefined();
  });

  it("returns the plain digital IRDoc unchanged when nothing is scanned (05a)", async () => {
    const bytes = fixture("05a-Rapport-Annuel-Digital.pdf");
    const vision = new FakeVisionPort();
    const { doc } = await extractPdfWithVision(bytes, vision);
    expect(vision.documentCallCount).toBe(0); // vision never called — nothing to OCR
    expect(doc.blocks.length).toBeGreaterThan(0);
  });
});

// « Convert with AI » (docs/CONCEPTION-TROIS-MODES.md §3, 19/10/2026): `readAll` sends EVERY page of a PDF with text to the AI,
// whose text replaces our reading. Failure value: the AI never called (a digital PDF has no page without text).
describe("extractPdfWithVision — readAll (« Convert with AI »)", () => {
  it("a digital PDF: every page goes to the AI, and the AI's words are published", async () => {
    const bytes = fixture("05a-Rapport-Annuel-Digital.pdf");
    const { pages } = await extractPdf(bytes);
    const vision = new FakeVisionPort();
    const sent: number[] = [];
    vision.analyzeDocument = async (doc) => {
      const count = (await PDFDocument.load(doc.bytes)).getPageCount();
      sent.push(count);
      return Array.from({ length: count }, (_, i) => ({ text: `aireadword${i}`, confidence: 0.95 }));
    };
    const read = await extractPdfWithVision(bytes, vision, { readAll: true });
    expect(sent.reduce((a, b) => a + b, 0)).toBe(pages.length);
    expect(JSON.stringify(blocksOf(read))).toContain("aireadword0");
  });

  it("readAll with the AI turned off (ocr: false): the AI is never called", async () => {
    const vision = new FakeVisionPort();
    await extractPdfWithVision(fixture("05a-Rapport-Annuel-Digital.pdf"), vision, { readAll: true, ocr: false });
    expect(vision.documentCallCount).toBe(0);
  });
});

// Precise numbers on the file's row (02/10/2026, decision C): the page count and the count of pages WITHOUT text
// are recorded when the PDF is opened — also on a refusal, where the error carries them as structured fields (its message
// stays ours).
describe("page counts recorded at opening", () => {
  it("a digital PDF: its page count, no scanned page", async () => {
    const read = await extractPdfWithVision(fixture("05a-Rapport-Annuel-Digital.pdf"), new FakeVisionPort());
    expect(read.pageCount).toBeGreaterThan(0);
    expect(read.pageCount).toBe((await PDFDocument.load(fixture("05a-Rapport-Annuel-Digital.pdf"))).getPageCount());
    expect(read.scannedPages).toBeUndefined();
  });

  it("a mixed PDF counts only its pages WITHOUT text (05d: 3 pages, 2 of them scanned)", async () => {
    const read = await extractPdfWithVision(fixture("05d-Dossier-Mixte.pdf"), new FakeVisionPort(), { ocr: false });
    expect({ pages: read.pageCount, scanned: read.scannedPages }).toEqual({ pages: 3, scanned: 2 });
  });

  it("the scan refusal carries both numbers (12 pages, 12 scanned)", async () => {
    const source = await PDFDocument.load(fixture("05b-Archive-Scannee-40p.pdf"));
    const twelve = await PDFDocument.create();
    for (const page of await twelve.copyPages(source, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])) twelve.addPage(page);
    await expect(extractPdfWithVision(await twelve.save(), new FakeVisionPort(), { ocr: false })).rejects.toMatchObject(
      {
        code: "SCANNED_PDF_NEEDS_AI_OCR",
        pageCount: 12,
        scannedPageCount: 12,
      },
    );
  });

  it("a mixed PDF (2 pages with text, 11 without) is no scan: published with the AI off, 11 pages counted", async () => {
    const scan = await PDFDocument.load(fixture("05b-Archive-Scannee-40p.pdf"));
    const digital = await PDFDocument.load(fixture("05a-Rapport-Annuel-Digital.pdf"));
    const mixed = await PDFDocument.create();
    for (const page of await mixed.copyPages(digital, [0, 1])) mixed.addPage(page);
    for (const page of await mixed.copyPages(scan, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])) mixed.addPage(page);
    const vision = new FakeVisionPort();
    const read = await extractPdfWithVision(await mixed.save(), vision, { ocr: false });
    expect({ pages: read.pageCount, scanned: read.scannedPages }).toEqual({ pages: 13, scanned: 11 });
    expect(vision.documentCallCount).toBe(0);
  });

  it("the page-count refusal carries the page count (the scanned count is not known: nothing was read)", async () => {
    // A 15-page ceiling is the CALLER's and is asked for (09/11/2026): the reader holds none of its own.
    const error = await extractPdfWithVision(fixture("05b-Archive-Scannee-40p.pdf"), new FakeVisionPort(), {
      ocr: false,
      limits: PAGE_SIZED_LIMITS,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "DOCUMENT_TOO_MANY_PAGES", pageCount: 40 });
    expect((error as { scannedPageCount?: number }).scannedPageCount).toBeUndefined();
  });
});

// A SCAN is a PDF whose every page has no text, or that carries an invisible OCR layer on any page (05/10/2026,
// features/scanned-pdf-publication.feature). Read, the WHOLE document goes to the AI and the scanner's layer is never published.
describe("a scan carrying an invisible OCR layer", () => {
  const ocrArchive = () => new Uint8Array(readFileSync(join(here, "../../fixtures/pdf/12-Archive-OCR-Ancien.pdf")));
  const visionReading = () => {
    const vision = new FakeVisionPort();
    const sent: number[] = [];
    vision.analyzeDocument = async (doc) => {
      const n = (await PDFDocument.load(doc.bytes)).getPageCount();
      sent.push(n);
      return Array.from({ length: n }, (_, i) => ({ text: `ai page ${i}`, confidence: 0.95 }));
    };
    return { vision, sent };
  };
  const mixedOcr = async () => {
    const ocr = await PDFDocument.load(ocrArchive());
    const scan = await PDFDocument.load(fixture("05b-Archive-Scannee-40p.pdf"));
    const out = await PDFDocument.create();
    out.addPage((await out.copyPages(ocr, [0]))[0]);
    for (const page of await out.copyPages(scan, [0, 1])) out.addPage(page);
    return out.save();
  };
  const textOf = (blocks: { kind: string; inlines?: { text: string }[] }[]) =>
    blocks.flatMap((b) => (b.inlines ?? []).map((i) => i.text)).join(" ");

  it("AI off: refused, nothing read", async () => {
    const vision = new FakeVisionPort();
    await expect(extractPdfWithVision(ocrArchive(), vision, { ocr: false })).rejects.toMatchObject({
      code: "SCANNED_PDF_NEEDS_AI_OCR",
      pageCount: 1,
      scannedPageCount: 1,
    });
    expect(vision.documentCallCount).toBe(0);
  });

  it("AI on: every page goes to the AI and the page holds the AI's text, not the scanner's layer", async () => {
    const { vision, sent } = visionReading();
    const read = await extractPdfWithVision(ocrArchive(), vision);
    expect(sent).toEqual([1]);
    expect(textOf(blocksOf(read))).toContain("ai page 0");
    expect(textOf(blocksOf(read))).not.toContain("OOO");
    const source = read.conservationSource;
    expect(
      "excludedPages" in source && source.excludedPages.has(0),
      "the scanner's layer is not text we can check",
    ).toBe(true);
  });

  it("an OCR layer on one page of three, the others with no text: a scan (AI off refuses, AI on sends all 3 pages)", async () => {
    const bytes = await mixedOcr();
    await expect(extractPdfWithVision(bytes, new FakeVisionPort(), { ocr: false })).rejects.toMatchObject({
      code: "SCANNED_PDF_NEEDS_AI_OCR",
      pageCount: 3,
    });
    const { vision, sent } = visionReading();
    const read = await extractPdfWithVision(bytes, vision);
    expect(sent).toEqual([3]);
    expect(read.scannedPages).toBe(3);
    expect(textOf(blocksOf(read))).not.toContain("OOO");
  });
});

// A document with text and a few pages with none is NOT a scan (05/10/2026): with the AI off, its pages without
// text are published as they are, their images read like on any other page. Defect confirmed by on 07/10/2026: such
// a page came out EMPTY, its images neither read nor counted. With the AI on, the AI's text still replaces the page and its
// images are neither published nor counted (06/10/2026).
describe("a page with no text in a document that is no scan", () => {
  /** Two digital pages of 05a, then the given pages of a real scan (same construction as the mixed PDF above). */
  const digitalThenScan = async (scan: () => Uint8Array, scanPages: number[]): Promise<Uint8Array> => {
    const digital = await PDFDocument.load(fixture("05a-Rapport-Annuel-Digital.pdf"));
    const scanned = await PDFDocument.load(scan());
    const out = await PDFDocument.create();
    for (const page of await out.copyPages(digital, [0, 1])) out.addPage(page);
    for (const page of await out.copyPages(scanned, scanPages)) out.addPage(page);
    return out.save();
  };
  const archive = () => fixture("05b-Archive-Scannee-40p.pdf");
  const imageBlocks = (blocks: readonly { kind: string }[]) =>
    blocks.filter((b): b is { kind: "image"; ref: { sha256: string } } => b.kind === "image");
  const aiReading = () => {
    const vision = new FakeVisionPort();
    vision.analyzeDocument = async (doc) => {
      const n = (await PDFDocument.load(doc.bytes)).getPageCount();
      return Array.from({ length: n }, (_, i) => ({ text: `ai page ${i}`, confidence: 0.95 }));
    };
    return vision;
  };

  it("AI off: the page's picture is published as an image block, after the digital pages, its bytes among the images", async () => {
    const vision = new FakeVisionPort();
    const read = await extractPdfWithVision(await digitalThenScan(archive, [0]), vision, { ocr: false });
    expect(vision.documentCallCount).toBe(0);
    expect({ pages: read.pageCount, scanned: read.scannedPages }).toEqual({ pages: 3, scanned: 1 });
    const pictures = imageBlocks(blocksOf(read));
    expect(pictures).toHaveLength(1);
    expect(blocksOf(read).at(-1)).toBe(pictures[0]);
    expect(read.images?.map((image) => image.sha256)).toEqual([pictures[0]!.ref.sha256]);
    expect(read.notices).toBeUndefined();
  });

  it("AI on: the AI's text replaces the page; its picture is neither published nor among the images", async () => {
    const read = await extractPdfWithVision(await digitalThenScan(archive, [0]), aiReading());
    expect(read.scannedPages).toBe(1);
    expect(imageBlocks(blocksOf(read))).toHaveLength(0);
    expect(read.images ?? []).toEqual([]);
    const last = blocksOf(read).at(-1);
    expect(last?.kind === "paragraph" && last.inlines[0]?.text).toBe("ai page 0");
  });

  it("AI on: a picture also placed on a kept page stays, published once, among the images", async () => {
    // The scan's page twice, from ONE copy (the two pages share the same image object `/Im0`); the second draws it at
    // half size, elsewhere (a picture repeated at the same place is furniture, but furniture is published, so the repeat stays)
    // under a line of text, so it is kept as digital while the AI's text replaces the first.
    const digital = await PDFDocument.load(fixture("05a-Rapport-Annuel-Digital.pdf"));
    const scanned = await PDFDocument.load(archive());
    const out = await PDFDocument.create();
    for (const page of await out.copyPages(digital, [0, 1])) out.addPage(page);
    const [replacedPage, keptPage] = await out.copyPages(scanned, [0, 0]);
    out.addPage(replacedPage);
    keptPage!.node.set(
      PDFName.of("Contents"),
      out.context.register(out.context.stream("q 250 0 0 350 100 200 cm /Im0 Do Q")),
    );
    out
      .addPage(keptPage)
      .drawText("A kept page carries this line of text over the picture.", { x: 50, y: 50, size: 11 });
    const read = await extractPdfWithVision(await out.save(), aiReading());
    expect(read.scannedPages).toBe(1);
    const pictures = imageBlocks(blocksOf(read));
    expect(pictures).toHaveLength(1);
    expect(read.images?.map((image) => image.sha256)).toEqual([pictures[0]!.ref.sha256]);
  });
  // No real fixture has a page with no text whose picture our reader cannot read (Dominion-Saw-Works carries an OCR layer: a
  // scan). That count goes through the detector's own branch, held by `pdf-table-detector.hardening.test.ts`.
});
