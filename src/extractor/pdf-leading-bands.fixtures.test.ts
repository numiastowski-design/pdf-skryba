/** 16/10/2026 (render 96): the PDF reader drops the leading BANDS of a table and lets the header cells « fall »; 24/10/2026 (B replaces A): the whole
 *  header cut into lines folds into ONE row (`lib/table-leading-bands.ts`).
 *  Real page: fixtures/pdf/49-GrandSoissons-RPQS-Eau-2021-PDFium.pdf, page 9. Before the change the first table had 13 rows (header cut into 8 rows of one
 *  line each); the second, whose header has no spanning cell (it looks like a cross table), 10 and stays.
 *  Run: npx vitest run --project=main src/extractor/pdf-leading-bands.fixtures.test.ts */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { IRBlock } from "doc-ir";
import { extractPdf } from "./pdf";

type TableBlock = Extract<IRBlock, { kind: "table" }>;
const paragraphs = (cell: TableBlock["rows"][number]["cells"][number]): string[] =>
  cell.blocks.map((b) => ("inlines" in b ? b.inlines.map((i) => i.text).join("") : ""));

describe("49-GrandSoissons page 9: the header cut into lines falls into shape", () => {
  it("1.6.3 (B, 24/10/2026; re-pinned 27/10/2026): the header cut into lines is ONE row, « Fournisseur » in the corner, each column's pieces in reading order; 1.6.4 is untouched", async () => {
    // 27/10/2026, hidden repaints: [5, 10] -> [4, 7]. The old shape held a spurious sliver row (table 1) and a header cut
    // into three rows plus an empty row (table 2) — the band edges that made them are invisible repaints of the header
    // cell shadings (#cccccc, 3 to 6 bands per cell). The physical reading is header + 2 empty + Total, and header + 6
    // data bands of 20 pt. The header pieces now arrive as ONE paragraph with line breaks, not four paragraphs.
    const bytes = new Uint8Array(readFileSync("fixtures/pdf/49-GrandSoissons-RPQS-Eau-2021-PDFium.pdf"));
    const { pages } = await extractPdf(bytes, "en", { firstPages: 9 });
    const big = pages[8]!.filter((b): b is TableBlock => b.kind === "table" && b.rows.length > 1);
    expect(big.map((t) => t.rows.length)).toEqual([4, 7]);
    const header = big[0]!.rows[0]!.cells;
    expect(paragraphs(header[0]!)).toEqual(["Fournisseur"]);
    expect(paragraphs(header[1]!).map((s) => s.trim())).toEqual(["Volume acheté\ndurant\nl’exercice\n2020 en m3"]);
    // the row under the header is a data row, not a piece of the header
    expect(big[0]!.rows[1]!.cells.map((c) => paragraphs(c).join(" ")).join(" ")).not.toContain("2020 en m3");
    // the second table keeps its own header rows
    expect(paragraphs(big[1]!.rows[0]!.cells[1]!).join(" ")).toContain("Volumes vendus");
  }, 120_000);
});
