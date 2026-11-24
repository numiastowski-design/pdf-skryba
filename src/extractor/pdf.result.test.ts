/**
 * The shape of what `extractPdf` returns (lot 10B characterisation): which keys exist only when there is something to say
 * (images, notices, OCR-layer pages, detected tables), so that a consumer testing `"images" in result` or `result.images
 * !== undefined` reads the same thing as before the function was cut into stages. Documents are small pdf-lib ones.
 */
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";

import { extractPdf } from "./pdf";
import { encodePng } from "doc-ir/internal";

const png = (): Uint8Array => encodePng(8, 8, "rgb-24", new Uint8Array(8 * 8 * 3).fill(180))!;

const textPdf = async (withImage: boolean): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("A plain paragraph of text, long enough to be read as a paragraph.", { x: 40, y: 740, size: 12, font });
  if (withImage) page.drawImage(await doc.embedPng(png()), { x: 40, y: 300, width: 300, height: 300 });
  return doc.save();
};

describe("extractPdf: the keys of the result", () => {
  it("a text-only document carries no images, no notices, no OCR pages and no detected tables", async () => {
    const result = await extractPdf(await textPdf(false));
    expect(Object.keys(result).sort()).toEqual([
      "cost",
      "docFacts",
      "flattenedGridPages",
      "imageLossByPage",
      "pages",
      "scannedPageIndices",
      "textSource",
      "textUnreadByPage",
      "unreadObjectsByPage",
    ]);
    expect(result.scannedPageIndices).toEqual([]);
    // Always present; empty on a document with no one-column grid published flat (20/11/2026).
    expect(result.flattenedGridPages).toEqual([]);
    // Always present, empty when every page was read (16/11/2026).
    expect([...result.textUnreadByPage.entries()]).toEqual([]);
    // Always present, empty when every XObject was read (24/11/2026).
    expect([...result.unreadObjectsByPage.entries()]).toEqual([]);
    expect([...result.imageLossByPage.entries()]).toEqual([[0, { slow: 0, unreadable: 0, places: [] }]]);
    expect(result.textSource.deliberateRemovals).toEqual([]);
    expect(result.textSource.runs.map((page) => page.map((r) => r.text).join(""))).toEqual([
      expect.stringContaining("A plain paragraph"),
    ]);
    expect(Object.keys(result.textSource.runs[0]![0]!).sort()).toEqual([
      "fontSize",
      "hasEOL",
      "text",
      "width",
      "x",
      "y",
    ]);
  }, 60_000);

  it("a document with a large picture publishes it, and says which page placed it", async () => {
    const result = await extractPdf(await textPdf(true));
    expect(result.images).toHaveLength(1);
    expect([...result.pagesOfImage!.values()].map((pages) => [...pages])).toEqual([[0]]);
    expect(result.pages[0]!.some((b) => b.kind === "image")).toBe(true);
    expect(result.imageLossByPage.get(0)).toEqual({ slow: 0, unreadable: 0, places: [] });
  }, 60_000);
});
