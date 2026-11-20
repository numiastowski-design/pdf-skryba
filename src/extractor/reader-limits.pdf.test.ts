import { PDFDocument, StandardFonts, rgb } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";

import { ReaderError } from "doc-ir";
import { extractPdf } from "./pdf";
import { extractPdfWithVision } from "./pdf-scanned";

// Plan step 5: a PDF is read under the limits it is given (`ReaderLimits`), the product's when it is given none.
// Run: npx vitest run --project=main src/extractor/reader-limits.pdf.test.ts

const pagesPdf = async (count: number): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < count; i++)
    doc.addPage([300, 200]).drawText(`page number ${i + 1}`, { x: 40, y: 100, size: 12, font });
  return doc.save();
};

/** A vector grid (one stroked line per border) of `rows` rows and `cols` columns on one page, one distinct word per cell. */
const gridPdf = async (rows: number, cols: number): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const rh = 14;
  const cw = 70;
  const top = rows * rh + 40;
  const page = doc.addPage([cols * cw + 100, top + 40]);
  const ys = Array.from({ length: rows + 1 }, (_, r) => top - r * rh);
  const xs = Array.from({ length: cols + 1 }, (_, c) => 40 + c * cw);
  for (const y of ys)
    page.drawLine({ start: { x: xs[0]!, y }, end: { x: xs[cols]!, y }, thickness: 1, color: rgb(0, 0, 0) });
  for (const x of xs)
    page.drawLine({ start: { x, y: ys[0]! }, end: { x, y: ys[rows]! }, thickness: 1, color: rgb(0, 0, 0) });
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      page.drawText(`r${r + 1}c${c + 1}`, { x: xs[c]! + 4, y: ys[r]! - 10, size: 7, font });
  return doc.save();
};

const tablesOf = (pages: Awaited<ReturnType<typeof extractPdf>>["pages"]): number =>
  pages.flat().filter((b) => b.kind === "table").length;
const refusal = (run: () => Promise<unknown>): Promise<unknown> =>
  run().then(
    () => "read",
    (error: unknown) => error,
  );

describe("pdf — the page limit is the limit it is given", () => {
  it("a 3-page PDF is read by default and refused past pageLimit: 2, named DOCUMENT_TOO_MANY_PAGES", async () => {
    const bytes = await pagesPdf(3);
    expect((await extractPdf(bytes)).pages).toHaveLength(3);
    // FAILS WITH (limits ignored): expected 'read' to be an instance of ReaderError.
    const refused = await refusal(() => extractPdf(bytes, "en", { limits: { pageLimit: 2 } }));
    expect(refused).toBeInstanceOf(ReaderError);
    expect(refused).toMatchObject({ code: "DOCUMENT_TOO_MANY_PAGES", pageCount: 3 });
    expect((await extractPdf(bytes, "en", { limits: { pageLimit: 3 } })).pages).toHaveLength(3);
  });

  it("an explicit pageLimit option still wins over the limits (the bench lifts the cap that way)", async () => {
    const bytes = await pagesPdf(3);
    expect((await extractPdf(bytes, "en", { pageLimit: Infinity, limits: { pageLimit: 2 } })).pages).toHaveLength(3);
  });

  it("the OCR-capable entry takes the same limits", async () => {
    const bytes = await pagesPdf(3);
    const vision = {
      recognize: async () => {
        throw new Error("no OCR here");
      },
    } as unknown as Parameters<typeof extractPdfWithVision>[1];
    expect(await refusal(() => extractPdfWithVision(bytes, vision, { limits: { pageLimit: 2 } }))).toMatchObject({
      code: "DOCUMENT_TOO_MANY_PAGES",
    });
    expect((await extractPdfWithVision(bytes, vision)).pageCount).toBe(3);
  });
});

describe("pdf — the table caps are the limits it is given", () => {
  it("a 3 × 2 grid is a table by default, and is withheld and said under tableRows: 2", async () => {
    const bytes = await gridPdf(3, 2);
    expect(tablesOf((await extractPdf(bytes)).pages)).toBe(1);
    // FAILS WITH (limits ignored): expected 1 to be +0.
    const limited = await extractPdf(bytes, "en", { limits: { tableRows: 2 } });
    expect(tablesOf(limited.pages)).toBe(0);
    expect(limited.notices).toContainEqual({ kind: "table-withheld", count: 1 });
  });

  it("and under tableCols: 1", async () => {
    const limited = await extractPdf(await gridPdf(3, 2), "en", { limits: { tableCols: 1 } });
    expect(tablesOf(limited.pages)).toBe(0);
    expect(limited.notices).toContainEqual({ kind: "table-withheld", count: 1 });
  });

  it("the words of a withheld table are declared removed on purpose, and none without limits", async () => {
    const bytes = await gridPdf(3, 2);
    expect((await extractPdf(bytes)).textSource.deliberateRemovals).toEqual([]);
    expect((await extractPdf(bytes, "en", { limits: { tableRows: 2 } })).textSource.deliberateRemovals).toContain(
      "r3c2",
    );
  });
});
