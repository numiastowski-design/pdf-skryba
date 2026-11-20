/**
 * Invisible repaints on real pages (chantier tableaux PDF, tranche « repeintures invisibles », 27/10/2026): Word repaints a cell
 * background of the SAME colour in one band per text line; those bands' edges must not become row boundaries, or a word that wraps
 * inside a cell is cut in two paragraphs.
 * This file belongs to the `pdf` batch of `vitest.config.ts`: it reads PDFs with our reader.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { IRBlock } from "doc-ir";
import { extractPdf } from "./pdf";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/docx-reel");
const bytesOf = (name: string): Uint8Array => new Uint8Array(readFileSync(join(fixturesDir, name)));

const textOf = (blocks: readonly IRBlock[]): string =>
  blocks
    .map((b): string => {
      if (b.kind === "table")
        return b.rows.map((row) => row.cells.map((cell) => textOf(cell.blocks)).join(" ")).join(" ");
      if (b.kind === "list") return b.items.map((item) => textOf(item)).join(" ");
      if (b.kind === "paragraph" || b.kind === "heading") return b.inlines.map((i) => i.text).join("");
      return "";
    })
    .join(" ");
const compact = (s: string): string => s.replace(/\s+/g, "");

describe("02 (jvmalin guide API, Word) page 13 — the WebService URLs wrapped in the table cells", () => {
  /**
   * Word's truth (the Word reader on 02-jvmalin-guide-api.docx, held by `docx.wrapped-urls.fixtures.test.ts`): the URLs « .../stopAreas/{stopAreaId}/to/{toStopAreaId}/schedules » and
   * « .../stopPoints/{stopPointId}/to/{toStopPointId}/schedules » are each ONE word. Today (measured 27/10) page 13 publishes
   * « .../{toStopAreaId}/schedu les » and « .../{toStopPointId}/sched ules » (measured 27/10): the cell wrapped the URL and
   * the band repaints cut it. Since 28/10/2026 BOTH are published whole.
   */
  it("publishes « schedules » in one piece in BOTH wrapped URLs of the page", async () => {
    // The stopArea URL wraps with a one-token upper line: junction J1 glues it (layout/cell-text.ts#wrapSeparator).
    // The stopPoint URL's upper line holds several tokens (a bold « GET » then the path), so J1 never fired and its cut was
    // a WRITTEN LIMIT on 27/10, arbitrated against the anti-cascade. The failed-vote SEARCH LICENCE went to 2 on 28/10/2026
    // (`layout/vector-grid.ts`, measured on 247 PDFs of the corpus: 6 tables published more, all true, 0 false), and the
    // cut is gone with it: its box is read whole. Both URLs are now one piece.
    const { pages } = await extractPdf(bytesOf("02-jvmalin-guide-api-Word.pdf"), "en", { pageLimit: Infinity });
    const page = textOf(pages[12]!);
    expect(page).toContain("{toStopAreaId}/schedules");
    expect(page).not.toContain("schedu les");
    expect(page).toContain("{toStopPointId}/schedules");
    expect(page).not.toContain("sched ules");
  });

  it("loses no letter: published letters (spaces ignored) never drop below the 1234 of page 13 and the 12024 of the document", async () => {
    // GREEN today by construction (frozen values measured 27/10): it guards the fix. Spaces are ignored because joining
    // « schedu les » into « schedules » legitimately removes a separator.
    const { pages } = await extractPdf(bytesOf("02-jvmalin-guide-api-Word.pdf"), "en", { pageLimit: Infinity });
    expect(pages.length).toBe(16);
    expect(compact(textOf(pages[12]!)).length).toBeGreaterThanOrEqual(1234);
    expect(compact(pages.map((p) => textOf(p)).join(" ")).length).toBeGreaterThanOrEqual(12024);
  });
});
