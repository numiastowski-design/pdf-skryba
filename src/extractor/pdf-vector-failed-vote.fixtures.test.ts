/** The vector-grid search goes on past a failed vote (the two ends of one underline) once a real table is accepted
 *  (`layout/vector-grid.ts#judgeRegion`): the page it must now publish. The pages whose extra regions must stay
 *  refused downstream are a document of the measurement corpus the package may not carry: their case lives with the
 *  app (`src/readers/pdf-vector-failed-vote.fixtures.given.test.ts`, 20/11/2026). */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { IRBlock } from "doc-ir";
import { extractPdf } from "./pdf";

const textOf = (block: IRBlock): string =>
  "inlines" in block
    ? block.inlines.map((i) => i.text).join("")
    : block.kind === "table"
      ? block.rows.flatMap((r) => r.cells.flatMap((c) => c.blocks.map(textOf))).join(" ")
      : "";

describe("failed vote then a real table", () => {
  it("docx-reel/07 page 18: the Cohorts table is published as a table, after the long table", async () => {
    const bytes = new Uint8Array(readFileSync("fixtures/docx-reel/07-moj-data-sharing-guidance-Word.pdf"));
    const { pages } = await extractPdf(bytes, "en", { firstPages: 25 });
    const tables = pages[17]!.filter((b) => b.kind === "table");
    expect(tables).toHaveLength(2);
    expect(textOf(tables[1]!)).toContain("Cohorts");
    expect(textOf(tables[1]!)).toContain("how are you defining the cohort");
  }, 120_000);
});
