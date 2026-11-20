import { PDFDocument, StandardFonts, rgb } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";

import { MAX_TABLE_ROWS as CAP_EXPORT, PAGE_SIZED_LIMITS } from "./pdf-page-caps.test.support";
import { extractPdf } from "./pdf";
// Until MAX_TABLE_ROWS is exported the fixtures would be built with NaN rows; fall back to the decided value so the red is behavioural.
const MAX_TABLE_ROWS: number = Number.isInteger(CAP_EXPORT) ? CAP_EXPORT : 200;

// 08/10/2026: ONE cap of 200 rows for every table; a PDF table detected longer is not published and the
// document says so (notice table-withheld, one entry per document). The PDF is a real vector grid (one stroked line per
// border): 2 columns of `rows` rows on ONE tall page, one distinct word per cell.
// Run: npx vitest run --project=pdf src/extractor/pdf.long-table.test.ts   (the file must be added to PDF_HEAVY_TESTS in vitest.config.ts; until then --project=main)

const gridPdf = async (rows: number, tag: string): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const rh = 14;
  const cw = 90;
  const top = rows * rh + 40;
  const page = doc.addPage([400, top + 40]);
  const ys = Array.from({ length: rows + 1 }, (_, r) => top - r * rh);
  const xs = [40, 40 + cw, 40 + 2 * cw];
  for (const y of ys)
    page.drawLine({ start: { x: xs[0]!, y }, end: { x: xs[2]!, y }, thickness: 1, color: rgb(0, 0, 0) });
  for (const x of xs)
    page.drawLine({ start: { x, y: ys[0]! }, end: { x, y: ys[rows]! }, thickness: 1, color: rgb(0, 0, 0) });
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < 2; c++)
      page.drawText(`${tag}r${r + 1}c${c + 1}`, { x: xs[c]! + 4, y: ys[r]! - 10, size: 7, font });
  }
  return doc.save();
};

const tablesOf = (pages: Awaited<ReturnType<typeof extractPdf>>["pages"]): number =>
  pages.flat().filter((b) => b.kind === "table").length;

describe("pdf — a detected table longer than MAX_TABLE_ROWS is not published and the document says so", () => {
  it("non-regression: a grid of MAX_TABLE_ROWS rows is published as a table, no remark", async () => {
    const { pages, notices } = await extractPdf(await gridPdf(MAX_TABLE_ROWS, "a"), undefined, {
      limits: PAGE_SIZED_LIMITS,
    });
    expect(tablesOf(pages)).toBe(1);
    expect((notices ?? []).filter((n) => n.kind === "table-withheld")).toEqual([]);
  });

  it("a grid of MAX_TABLE_ROWS + 1 rows gives no table block and one remark with count 1", async () => {
    const { pages, notices } = await extractPdf(await gridPdf(MAX_TABLE_ROWS + 1, "b"), undefined, {
      limits: PAGE_SIZED_LIMITS,
    });
    // Failure value (before): one table block.
    expect(tablesOf(pages)).toBe(0);
    expect((notices ?? []).filter((n) => n.kind === "table-withheld")).toEqual([{ kind: "table-withheld", count: 1 }]);
  });
});

describe("pdf — the row cap constant", () => {
  it("MAX_TABLE_ROWS is exported and is 200", () => {
    expect(CAP_EXPORT).toBe(200);
  });
});
