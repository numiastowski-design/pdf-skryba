import { PDFDocument, StandardFonts, rgb } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";

import { MAX_TABLE_COLS, PAGE_SIZED_LIMITS } from "./pdf-page-caps.test.support";
import { extractPdf } from "./pdf";

// 08/10/2026: ONE cap of 12 columns for every table; a PDF table detected wider is not published and the
// document says so (notice table-withheld, one entry per document). The PDF is a real vector grid (one stroked line per
// border, like pdf-table-detector.test.ts): `cols` columns of 3 rows, one distinct word per cell.
// Run: npx vitest run --project=pdf src/extractor/pdf.wide-table.test.ts   (the file must be added to PDF_HEAVY_TESTS in vitest.config.ts; until then --project=main)

const gridPdf = async (cols: number, tag: string, tables = 1): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([900, 800]);
  const cw = 60;
  const rh = 24;
  for (let t = 0; t < tables; t++) {
    const top = 760 - t * 200;
    const ys = [0, 1, 2, 3].map((r) => top - r * rh);
    const xs = Array.from({ length: cols + 1 }, (_, c) => 40 + c * cw);
    for (const y of ys)
      page.drawLine({ start: { x: xs[0]!, y }, end: { x: xs[cols]!, y }, thickness: 1, color: rgb(0, 0, 0) });
    for (const x of xs)
      page.drawLine({ start: { x, y: ys[0]! }, end: { x, y: ys[3]! }, thickness: 1, color: rgb(0, 0, 0) });
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < cols; c++)
        page.drawText(`${tag}${t}r${r}c${c + 1}`, { x: xs[c]! + 4, y: ys[r]! - 16, size: 7, font });
    }
  }
  return doc.save();
};

const tablesOf = (pages: Awaited<ReturnType<typeof extractPdf>>["pages"]): number =>
  pages.flat().filter((b) => b.kind === "table").length;

describe("pdf — a detected table wider than MAX_TABLE_COLS (12) is not published and the document says so", () => {
  it("non-regression: a 12-column grid is published as a table, no remark", async () => {
    const { pages, notices } = await extractPdf(await gridPdf(MAX_TABLE_COLS, "a"), undefined, {
      limits: PAGE_SIZED_LIMITS,
    });
    expect(tablesOf(pages)).toBe(1);
    expect((notices ?? []).filter((n) => n.kind === "table-withheld")).toEqual([]);
  });

  it("a 13-column grid gives no table block and one remark with count 1", async () => {
    const { pages, notices } = await extractPdf(await gridPdf(MAX_TABLE_COLS + 1, "b"), undefined, {
      limits: PAGE_SIZED_LIMITS,
    });
    // Failure value (before): one table block.
    expect(tablesOf(pages)).toBe(0);
    expect((notices ?? []).filter((n) => n.kind === "table-withheld")).toEqual([{ kind: "table-withheld", count: 1 }]);
  });

  it("two 13-column grids on one page: ONE remark with count 2", async () => {
    const { pages, notices } = await extractPdf(await gridPdf(MAX_TABLE_COLS + 1, "c", 2), undefined, {
      limits: PAGE_SIZED_LIMITS,
    });
    expect(tablesOf(pages)).toBe(0);
    expect((notices ?? []).filter((n) => n.kind === "table-withheld")).toEqual([{ kind: "table-withheld", count: 2 }]);
  });
});
