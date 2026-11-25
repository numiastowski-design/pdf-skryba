/**
 * THE DECLARED READING ORDER, ON THE CORPUS (23/09/2026) — what the READER hands over.
 *
 * The witness here: `11-Brochure-Deux-Colonnes`, braided and NOT tagged: nothing here touches it.
 * Then the second reading the letters control is given: the bands of the rendered tables, the notes of the tree.
 *
 * The decisive counter-example — fixture 22, tagged `PASS ua1` with WRONG headers, still read by the geometry — lives
 * in `pdf-matterhorn.test.ts`, with the other Matterhorn conditions.
 * NOT here: the coverage guard on tagged documents this package may not carry, and the order of the PUBLISHED page:
 * the application's tests hold them.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { extractPdf } from "./pdf";
import { declaredRanks } from "./pdf-reading-order";
import { readPdfSource } from "./pdf-source";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/pdf");
const bytesOf = (relative: string): Uint8Array => new Uint8Array(readFileSync(join(fixturesDir, relative)));

describe("11-Brochure-Deux-Colonnes — NON balisée, donc rien ne la déplace", () => {
  it("aucune de ses pages n'a d'arbre, donc aucune n'a d'ordre déclaré", async () => {
    const source = await readPdfSource(bytesOf("11-Brochure-Deux-Colonnes.pdf"));
    expect(source.pages.map((page) => page.declaredOrder)).toEqual([undefined, undefined]);
    expect(source.pages.map(declaredRanks)).toEqual([undefined, undefined]);
  });
});

describe("the letters control is told the bands of the tables the table stage rendered", () => {
  // CHANGED from commit 7a7976ef: `reference.tableStagePages` (a set of pages) became `reference.tableBandsByPage` (page -> the top/bottom bands of
  // the rendered tables, 0-based pages); a page listed there is a table-stage page, so the set is redundant and gone.
  type Reference = { tableStagePages?: unknown; tableBandsByPage?: Map<number, { top: number; bottom: number }[]> };

  it("fixture 30 (a made-up school report): a table that RENDERS records its band — one table, one band, its top above its bottom", async () => {
    // 26/10/2026: the assertion that goes red if bands stop being recorded.
    // Measured on 19/11/2026: one page, 1 table, 1 band. The page with TWO tables and two bands is a real school report, which
    // stays in the publisher's private repository: the application's tests hold it there.
    const { textSource, pages } = await extractPdf(bytesOf("30-Bulletin-Fusion-Et-Couleur.pdf"));
    const reference = textSource.reference as typeof textSource.reference & Reference;
    expect(pages.map((page) => page.filter((b) => b.kind === "table").length)).toEqual([1]);
    expect([...(reference.tableBandsByPage?.keys() ?? [])]).toEqual([0]);
    expect([...(reference.tableBandsByPage?.values() ?? [])].map((bands) => bands.length)).toEqual([1]);
    for (const band of [...(reference.tableBandsByPage?.values() ?? [])].flat())
      expect(band.top).toBeGreaterThan(band.bottom);
  });

  it("control: 11-Brochure-Deux-Colonnes, no table page, no bands", async () => {
    // FAILS WITH: a page listed although no table stage laid it out (green today: tableBandsByPage does not exist either).
    const { textSource } = await extractPdf(bytesOf("11-Brochure-Deux-Colonnes.pdf"));
    expect((textSource.reference as { tableBandsByPage?: unknown }).tableBandsByPage).toBeUndefined();
  });
});

describe("the reference cycles carry the structure tree's notes", () => {
  it("fixture 40 (Word 365, tagged): page 1 holds cycles under a Note node, flagged note", async () => {
    // FAILS WITH: 0 (no cycle carries `note`).
    const { textSource } = await extractPdf(bytesOf("40-School-Improvement-Planning-Word365.pdf"));
    expect(textSource.reference?.pages[0]?.filter((c) => c.note === true).length).toBeGreaterThan(0);
  });

  it("control: 11-Brochure-Deux-Colonnes, untagged, no note", async () => {
    // FAILS WITH: a cycle flagged note on a PDF with no structure tree.
    const { textSource } = await extractPdf(bytesOf("11-Brochure-Deux-Colonnes.pdf"));
    expect(textSource.reference?.pages.flat().some((c) => c.note === true)).toBe(false);
  });
});
