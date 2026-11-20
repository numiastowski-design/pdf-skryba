/**
 * A REGION OF ONE CONTENT COLUMN IS PUBLISHED AS ITS CELLS' PARAGRAPHS, FLAT, NOT AS A TABLE (26/10/2026, on measurement;
 * rule and unit cases at `pdf-table-render.test.ts`) — on a real document.
 *
 * `fixtures/docx-reel/02-jvmalin-guide-api-Word.pdf` (Word 365, 16 pages; its .docx declares 40 one-cell tables, one per code box).
 * On its first 15 pages the grid stage renders 38 one-column regions TODAY, measured 26/10/2026 before any change (`extractPdf`, no
 * table on pages 1 to 4 nor beyond 15): the API guide's code boxes and the note of page 5. Every region carries a trailing EMPTY row
 * (the box's bottom fill), which yields nothing; five are cut into several rows by their fill bands (the note of page 5 into 5 lines,
 * two boxes of page 13 into « GET » / path / « les » and « ules »), which stay separate paragraphs — the cells are still read glyph by
 * glyph, the page is NOT re-read as prose. So 38 regions become 46 paragraphs carrying today's cell texts, the fill-band cuts included.
 *
 * This file belongs to the `pdf` batch of `vitest.config.ts`: it reads PDFs with our reader.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import type { IRBlock } from "doc-ir";
import { extractPdf } from "./pdf";

const here = dirname(fileURLToPath(import.meta.url));
const JVMALIN = join(here, "../../fixtures/docx-reel/02-jvmalin-guide-api-Word.pdf");

const textOf = (b: IRBlock): string => ("inlines" in b ? b.inlines.map((i) => i.text).join("") : "");

/** The paragraphs of each box, by physical page (1-based), in reading order: today's cell texts, measured 26/10/2026. */
const BOXES: Record<number, string[][]> = {
  5: [
    // 27/10/2026, hidden repaints: the box's same-colour line bands no longer cut it into rows, so its cell is ONE paragraph —
    // \n at the real line ends, a space at the >= 85 % wrap junctions (`layout/cell-text.ts`).
    [
      "Ce guide n’a pas pour rôle de détailler de manière exhaustive les webservices\nexposés. Le swagger reste le document décrivant l’ensemble des attributs, leur format, etc..\nDe plus, les exemples fournis dans le guide d’intégration n’ont pour but que d’aider le lecteur à la compréhension du webservice. Ils ne garantissent pas une réponse valide.",
    ],
    ["POST /journeys/{journeyGroupId}"],
    ["GET v3/networks/{networkId}/journeySchedules"],
  ],
  6: [["GET /v3/networks/{networkId}/reverseGeocode"], ["GET /placesSearch"]],
  7: [["GET /v3/networks/{networkId}/parkAndRides"], ["GET /v3/networks/{networkId}/secureBikeParks"]],
  8: [
    ["GET /v3/networks/{networkId}/bikeSharingStations"],
    ["GET /v3/networks/{networkId}/bikeParks"],
    ["GET /v3/networks/{networkId}/parks"],
  ],
  9: [
    ["GET /v3/networks/{networkId}/lines/{lineId}/directions"],
    ["GET /v3/networks/{networkId}/lines/{lineId}/routes"],
  ],
  10: [
    ["GET /v3/networks/{networkId}/pointsOfInterests"],
    ["GET /v3/networks/{networkId}/pointsOfInterests/{pointOfInterestId}"],
    ["GET /v3/networks/{networkId}/stopAreas"],
    ["GET /v3/networks/{networkId}/stopAreas/{stopAreaId}"],
    ["GET /v3/networks/{networkId}/lines/{lineId}/stopAreas"],
  ],
  11: [
    ["GET /v3/networks/{networkId}/stopPoints"],
    ["GET /v3/networks/{networkId}/stopPoints/{stopPointId}"],
    ["GET /v3/networks/{networkId}/lines/{lineId}/stopPoints"],
    ["GET /v3/networks/{networkId}/stopAreas/{stopAreaId}/stopPoints"],
    ["GET /v3/networks/{networkId}/lines"],
    ["GET /v3/networks/{networkId}/lines/{lineId}"],
    ["GET /v3/networks/{networkId}/stopPoints/{stopPointId}/lines"],
  ],
  12: [
    ["GET /v3/networks/{networkId}/lines/{lineId}/todInformation"],
    ["GET /v3/networks/{networkId}/searchForSchedules"],
  ],
  13: [
    ["GET /v3/networks/{networkId}/lines/{lineId}/directions/{directionId}/timetables"],
    ["GET /v3/networks/{networkId}/lines/{lineId}/stopAreas/{stopAreaId}/schedules"],
    ["GET /v3/networks/{networkId}/lines/{lineId}/stopPoints/{stopPointId}/schedules"],
    // 27/10/2026, hidden repaints + junction J1: the first wrapped URL is whole (one-token upper line). The second kept its
    // cut, and the WRITTEN LIMIT said reading its box whole needed the failed-vote search licence at 2. That licence was
    // taken on 28/10/2026 (`vector-grid.ts`), and the cut is GONE: both URLs are whole, measured on this fixture. The box
    // count does not move (38, the test below).
    ["GET /v3/networks/{networkId}/lines/{lineId}/stopAreas/{stopAreaId}/to/{toStopAreaId}/schedules"],
    ["GET /v3/networks/{networkId}/lines/{lineId}/stopPoints/{stopPointId}/to/{toStopPointId}/schedules"],
    ["GET /v3/networks/{networkId}/stopAreas/{stopAreaId}/schedules"],
    ["GET /v3/networks/{networkId}/stopPoints/{stopPointId}/schedules"],
  ],
  14: [
    ["GET /v3/networks/{networkId}/lines/{lineId}/stopAreas/{stopAreaId}/timesheets"],
    ["GET /v3/networks/{networkId}/lines/{lineId}/stopPoints/{stopPointId}/timesheets"],
    ["GET /v3/networks/{networkId}/proximity"],
  ],
  15: [["GET /v2/disruptions"], ["Rappel webservice perturbations : GET/v2/disruptions"]],
};

/** Blocks per page once the boxes are flat: today's blocks outside tables (measured 26/10/2026) plus the boxes' paragraphs. */
// 27/10/2026, hidden repaints: pages 5 and 13 lose 4 blocks each — their multi-band boxes are one row, so one paragraph per box.
const BLOCKS_PER_PAGE: Record<number, number> = {
  5: 13 + 3,
  6: 14 + 2,
  7: 12 + 2,
  8: 12 + 3,
  9: 12 + 2,
  10: 13 + 5,
  11: 15 + 7,
  12: 15 + 2,
  13: 16 + 7,
  14: 16 + 3,
  15: 15 + 2,
};

/** Where `run` sits in `texts` as a contiguous run, searching from `from`; -1 when it does not. */
const indexOfRun = (texts: readonly string[], run: readonly string[], from: number): number => {
  for (let i = from; i + run.length <= texts.length; i++) if (run.every((text, k) => texts[i + k] === text)) return i;
  return -1;
};

let pages: IRBlock[][] = [];
let flattenedGridPages: readonly number[] = [];

beforeAll(async () => {
  const result = await extractPdf(new Uint8Array(readFileSync(JVMALIN)), "en", { firstPages: 15 });
  pages = result.pages;
  flattenedGridPages = result.flattenedGridPages;
}, 60_000);

describe("02-jvmalin (first 15 pages): the 38 one-column code boxes are published as their paragraphs, not as tables", () => {
  it("the boxes lie on pages 5 to 15 and nowhere else: 38 of them", () => {
    // Green today and tomorrow: the count of boxes this file pins, so that a page out of `BOXES` does not hide a table.
    expect(pages).toHaveLength(15);
    expect(Object.values(BOXES).flat()).toHaveLength(38);
    // 46 -> 38 on 27/10/2026: hidden repaints — pages 5 and 13 each hold 4 fewer paragraph pieces (boxes of one row).
    expect(Object.values(BOXES).flat(2)).toHaveLength(38);
  });

  it("🔴 the result names the zero-based pages whose one-column regions were published flat (decision of 26/10, counted « transformed » by the bench since 20/11)", () => {
    // The pages of BOXES and no other: the trace never reaches the published page (nothing invisible is published),
    // it rides the result only, for the bench to tell a DECIDED flattening from a missed table (decision of 03/11/2026).
    expect(flattenedGridPages).toEqual(
      Object.keys(BOXES)
        .map((page) => Number(page) - 1)
        .sort((a, b) => a - b),
    );
  });

  it("🔴 no table remains on any page", () => {
    // FAILS WITH: expected [ +0, +0, +0, +0, 3, 2, 2, 3, 2, …(6) ] to deeply equal [ Array(15) ]
    // (today, per page: 0 0 0 0 3 2 2 3 2 5 7 2 7 3 2 tables)
    expect(pages.map((page) => page.filter((b) => b.kind === "table").length)).toEqual(
      Array.from({ length: 15 }, () => 0),
    );
  });

  it("🔴 each box is its paragraphs, contiguous and in row order, carrying today's cell text; the boxes keep their order on the page", () => {
    // FAILS WITH: page 5, box 1: expected -1 to be greater than or equal to 0
    for (const [pageNumber, boxes] of Object.entries(BOXES)) {
      const texts = pages[Number(pageNumber) - 1]!.filter((b) => b.kind === "paragraph").map(textOf);
      let from = 0;
      boxes.forEach((box, i) => {
        const at = indexOfRun(texts, box, from);
        expect(at, `page ${pageNumber}, box ${i + 1} « ${box[0]} »`).toBeGreaterThanOrEqual(0);
        from = at + box.length;
      });
    }
  });

  it("🔴 the prose around the boxes is untouched: each page holds today's blocks outside tables plus the boxes' paragraphs", () => {
    // FAILS WITH: expected { '5': 16, '6': 16, '7': 14, …(8) } to deeply equal { '5': 20, '6': 16, '7': 14, …(8) }
    const counts = Object.fromEntries(
      Object.keys(BLOCKS_PER_PAGE).map((pageNumber) => [pageNumber, pages[Number(pageNumber) - 1]!.length]),
    );
    expect(counts).toEqual(BLOCKS_PER_PAGE);
  });
});
