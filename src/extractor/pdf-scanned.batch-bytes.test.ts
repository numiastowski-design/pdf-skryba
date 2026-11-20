/**
 * OCR batches are cut by BYTES as well as by page count: the app's own cap (OCR_BATCH_MAX_BYTES) keeps a
 * request small, base64 adding a third, so ten heavy scanned pages must not travel in one request.
 */

import { PDFDocument, PDFName } from "@cantoo/pdf-lib";
import { describe, expect, it, vi } from "vitest";

import { FakeVisionPort } from "./pdf-fake-vision.test.support";
import { OCR_BATCH_MAX_BYTES, ocrScannedPages } from "./pdf-scanned";

/** Deterministic incompressible filler (LCG, no Math.random): the saved size tracks the byte count. */
const filler = (n: number, seed: number): Uint8Array => {
  const out = new Uint8Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
};

/** Page i has MediaBox width 100 + i (its identity) and `weights[i]` bytes of raw, uncompressed payload. */
const documentOf = async (weights: number[]): Promise<Uint8Array> => {
  const pdf = await PDFDocument.create();
  weights.forEach((bytes, i) => {
    const page = pdf.addPage([100 + i, 100]);
    if (bytes > 0)
      page.node.set(PDFName.of("Contents"), pdf.context.register(pdf.context.stream(filler(bytes, i + 1))));
  });
  return pdf.save();
};

/** Records every batch the vision port receives: its saved size and the identities of its pages, in order. */
const recordingVision = () => {
  const batches: { size: number; pages: number[] }[] = [];
  const vision = new FakeVisionPort();
  vision.analyzeDocument = async (doc) => {
    const loaded = await PDFDocument.load(doc.bytes);
    const pages = loaded.getPages().map((p) => p.getWidth() - 100);
    batches.push({ size: doc.bytes.length, pages });
    return pages.map((p) => ({ text: `page ${p}`, confidence: 0.9 }));
  };
  return { vision, batches };
};

describe("ocrScannedPages — batches cut by bytes", () => {
  it("exports OCR_BATCH_MAX_BYTES (valeur de départ à calibrer: 12 000 000), the app's own cap", () => {
    expect(OCR_BATCH_MAX_BYTES).toBe(12_000_000);
  });

  it("ten pages of 1.5 MB (15 MB in all) are split into several batches, each page read once and in order, no batch above the cap", async () => {
    const weights = Array.from({ length: 10 }, () => 1_500_000);
    const indices = Array.from({ length: 10 }, (_, i) => i);
    const { vision, batches } = recordingVision();
    const result = await ocrScannedPages(await documentOf(weights), indices, vision);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flatMap((b) => b.pages)).toEqual(indices);
    for (const b of batches) expect(b.size).toBeLessThanOrEqual(OCR_BATCH_MAX_BYTES);
    expect([...result.keys()]).toEqual(indices);
  });

  it("a single page above the cap goes alone, the pages around it are still read once, in order", async () => {
    const weights = [100_000, 13_000_000, 100_000];
    const { vision, batches } = recordingVision();
    const result = await ocrScannedPages(await documentOf(weights), [0, 1, 2], vision);
    expect(batches.flatMap((b) => b.pages)).toEqual([0, 1, 2]);
    expect(batches.some((b) => b.pages.length === 1 && b.pages[0] === 1)).toBe(true);
    expect(batches.filter((b) => b.size > OCR_BATCH_MAX_BYTES).every((b) => b.pages.length === 1)).toBe(true);
    expect([...result.keys()]).toEqual([0, 1, 2]);
  });

  it("small pages still travel ten to a batch: twelve small pages make batches of 10 and 2", async () => {
    const weights = Array.from({ length: 12 }, () => 1_000);
    const indices = Array.from({ length: 12 }, (_, i) => i);
    const { vision, batches } = recordingVision();
    await ocrScannedPages(await documentOf(weights), indices, vision);
    expect(batches.map((b) => b.pages.length)).toEqual([10, 2]);
    expect(batches.flatMap((b) => b.pages)).toEqual(indices);
  });

  it("the source PDF is parsed once, however many batches it yields: twelve small pages (two batches) load it one time", async () => {
    const weights = Array.from({ length: 12 }, () => 1_000);
    const indices = Array.from({ length: 12 }, (_, i) => i);
    const bytes = await documentOf(weights);
    // The fake port parses each batch with the real `load`, captured before the spy so only the module under test is counted.
    const realLoad = PDFDocument.load.bind(PDFDocument);
    const vision = new FakeVisionPort();
    vision.analyzeDocument = async (doc) => {
      const pages = (await realLoad(doc.bytes)).getPages().map((p) => p.getWidth() - 100);
      return pages.map((p) => ({ text: `page ${p}`, confidence: 0.9 }));
    };
    const load = vi.spyOn(PDFDocument, "load");
    try {
      const result = await ocrScannedPages(bytes, indices, vision);
      expect([...result.keys()]).toEqual(indices);
      expect(load).toHaveBeenCalledTimes(1);
    } finally {
      load.mockRestore();
    }
  });
});
