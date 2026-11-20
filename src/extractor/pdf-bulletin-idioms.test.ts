/**
 * THE FOUR IDIOMS THAT ONLY THE REAL BULLETIN EXERCISED (20/09/2026).
 *
 * `docs/COMPORTEMENTS-GENERATEURS.md` [purged 27/09/2026, git history] listed four generator behaviours with
 * « aucune fixture » next to them: borders painted as thin FILLED rectangles, a
 * merged header repainted once per sub-column, a text cycle spanning several
 * cells, and data carried by colour alone. They were held by one real document,
 * so any of them could have been lost by a refactoring without a single test
 * turning red.
 *
 * `30-Bulletin-Fusion-Et-Couleur.pdf` carries all four, and its generator says
 * where each shape was measured.
 *
 * EVERY BEHAVIOUR COMES WITH A FIXTURE-INTEGRITY ASSERTION, and that is the
 * point of this file. A fixture is worth what it EXERCISES: if the page turned
 * out to hold a stroked rule, or a merged label painted once, or three separate
 * cycles, the behaviour assertions below would still pass and would prove
 * nothing. Each pair is therefore written together — first what the document
 * emits, then what we read from it.
 *
 * The four expectations were verified to FAIL before being trusted: the
 * sabotage that breaks each one is named in its own test.
 *
 * Nothing here is client content: the document is synthetic.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import type { IRBlock, Inline } from "doc-ir";
import { buildGlyphFragments, type GlyphFragment } from "./glyph-positions";
import { extractPdf } from "./pdf";
import type { PdfPathArg } from "./pdf-ops";
import { readPdfSource, type PdfTextRun } from "./pdf-source";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = "30-Bulletin-Fusion-Et-Couleur";
const bytes = new Uint8Array(readFileSync(join(here, `../../fixtures/pdf/${FIXTURE}.pdf`)));

/** The paint operators that draw a LINE. The fixture must not use a single one
 *  of them — see the first test. */
const STROKE_OPS = new Set([
  "stroke",
  "closeStroke",
  "fillStroke",
  "eoFillStroke",
  "closeFillStroke",
  "closeEOFillStroke",
]);

/** The three sub-columns of the merged header, measured on the real document:
 *  18.6 pt each. */
const SUB_COLUMN_WIDTH = 18.6;

type Table = Extract<IRBlock, { kind: "table" }>;
type Cell = Table["rows"][number]["cells"][number];

let blocks: IRBlock[];
let table: Table;
let ops: readonly Parameters<typeof buildGlyphFragments>[0][number][];
let runs: readonly PdfTextRun[];
let glyphs: GlyphFragment[];

beforeAll(async () => {
  const source = await readPdfSource(bytes, { wantOps: () => true });
  ops = source.pages[0]!.ops;
  runs = source.pages[0]!.runs;
  glyphs = buildGlyphFragments(ops);
  blocks = (await extractPdf(bytes)).pages[0]!;
  table = blocks.find((b): b is Table => b.kind === "table")!;
});

/** The text of a cell, images named rather than dropped. */
const cellText = (cell: Cell): string =>
  cell.blocks
    .map((b) => (b.kind === "image" ? `[${b.alt}]` : "inlines" in b ? b.inlines.map((i) => i.text).join("") : ""))
    .join("");

const inlinesOf = (block: IRBlock | undefined): Inline[] =>
  block !== undefined && "inlines" in block ? block.inlines : [];

describe("30 — a grid whose rules are FILLED rectangles, never strokes", () => {
  it("the page paints no stroke at all: every rule is a fill", () => {
    // Fixture integrity. Drop this and the next expectation would also pass on
    // a document with ordinary stroked borders, i.e. on nothing new.
    const paints = ops.filter((op) => op.op === "constructPath").map((op) => (op.args as PdfPathArg).paint);
    expect(paints.filter((paint) => paint !== undefined && STROKE_OPS.has(paint))).toEqual([]);
    expect(paints.filter((paint) => paint === "fill").length).toBeGreaterThan(50);
  });

  it("the table is read all the same, with the five column widths of the document", () => {
    // SABOTAGE VERIFIED: made `walkPage` keep the edges of stroked paths only
    // (`if (!FILL_OPS.has(paint))` around `segments.push`) — no grid at all is
    // found on this page, `table` is undefined and every test below dies.
    expect(table).toBeDefined();
    expect(table.rows).toHaveLength(5);
    const widths = table.columnWidths!;
    expect(widths).toHaveLength(5);
    expect(widths[0]).toBeCloseTo(120, 1);
    for (const width of widths.slice(1, 4)) expect(width).toBeCloseTo(SUB_COLUMN_WIDTH, 1);
    expect(widths[4]).toBeCloseTo(299.2, 1);
  });
});

describe("30 — a merged header repainted once per covered sub-column", () => {
  it("« Moyennes » is painted THREE times at the same point, and stays one mark", () => {
    // Fixture integrity AND second colspan signal in one reading: the glyphs
    // survive once (overpaint is collapsed) and carry how many passes drew
    // them.
    // The merged cell only: from the first sub-column's left edge to the last
    // one's right edge. « Niveau atteint », further right on the same band, is
    // painted once and would drown the reading.
    const painted = glyphs.filter(
      (g) => g.y > 678 && g.y < 700 && g.x >= 180 && g.x < 180 + 3 * SUB_COLUMN_WIDTH && g.text.trim().length > 0,
    );
    expect(painted.map((g) => g.text).join("")).toBe("Moyennes");
    expect(painted.map((g) => g.paintCount)).toEqual([3, 3, 3, 3, 3, 3, 3, 3]);
  });

  it("the header cell spans three columns, and its text is not tripled", () => {
    // SABOTAGE VERIFIED: painting the label twice in the generator while the
    // separators still say three makes the two readings disagree, and
    // `renderPageTables` refuses the WHOLE table — `table` is undefined, the
    // page comes out as flat text. That refusal is the behaviour protected
    // here: a table built on two signals that contradict each other would be
    // exactly the « plausible and false » this path exists to avoid.
    const [first, merged, last] = table.rows[0]!.cells;
    expect(cellText(first!)).toBe("Matiere");
    expect(cellText(merged!)).toBe("Moyennes");
    expect(merged!.colspan).toBe(3);
    expect(cellText(last!)).toBe("Niveau atteint");
  });
});

describe("30 — one text cycle carrying three cells", () => {
  it("the reader gives ONE run for the three notes of a row, wider than two sub-columns", () => {
    // Fixture integrity, and it took a measurement to get right: an offset
    // written as kerning (`TJ`) or as a `Td` makes the reader insert a filler
    // item and yields three separate cycles. The aggregation comes from the
    // geometry — notes 17.5 pt wide in columns 18.6 pt wide, so joined up.
    const cycle = runs.find((r) => r.text.includes("17,42"))!;
    expect(cycle.text.replace(/\s+/g, " ").trim()).toBe("17,42 13,61 20,00");
    expect(cycle.width).toBeGreaterThan(2 * SUB_COLUMN_WIDTH);
  });

  it("each note lands in ITS OWN cell", () => {
    // SABOTAGE VERIFIED: made `buildGlyphFragments` place every glyph of a
    // cycle at the cycle's origin (advance forced to 0). The glyphs pile up on
    // one another, « Moyennes » collapses to "Moyens", nothing lands in a cell
    // and the table is refused outright — six of the ten tests here.
    const row = table.rows.find((r) => cellText(r.cells[0]!) === "Mathematiques")!;
    expect(cellText(row.cells[1]!)).toBe("17,42");
    expect(cellText(row.cells[3]!)).toBe("20,00");
    // The middle cell carries its note AND a pinned defect, below.
    expect(cellText(row.cells[2]!)).toContain("13,61");
  });
});

describe("30 — data carried by colour alone", () => {
  it("LA PERTE ASSUMÉE (23/09/2026) : la barre de chaque ligne n'est plus publiée", () => {
    for (const row of table.rows.slice(2)) {
      const last = row.cells[row.cells.length - 1]!;
      expect(
        last.blocks.filter((b) => b.kind === "image"),
        `la ligne « ${cellText(row.cells[0]!)} »`,
      ).toEqual([]);
    }
  });

  it("TÉMOIN : le TEXTE de chaque ligne reste entier — c'est une couleur qu'on perd, pas un mot", () => {
    const row = table.rows.find((r) => cellText(r.cells[0]!) === "Mathematiques")!;
    expect(cellText(row.cells[1]!)).toBe("17,42");
    expect(cellText(row.cells[3]!)).toBe("20,00");
  });

  it("a legend disc is no picture (07/10/2026): the digit it contained and the label it announced are plain text", () => {
    const legend = blocks.find(
      (b) => b.kind === "paragraph" && inlinesOf(b).some((i) => i.text.includes("Tres bonne")),
    );
    expect(inlinesOf(legend).filter((i) => i.image !== undefined)).toEqual([]);
    const text = inlinesOf(legend)
      .map((i) => i.text)
      .join("");
    expect(text).toContain("Tres bonne");
    expect(text).toContain("Non evalue");
  });
});

describe("30 — what the fixture ALSO found", () => {
  it("a rule painted as a fill ON a column boundary is not a colour bar of either cell", () => {
    // Found by building this fixture, 20/09/2026. A vertical rule 0.5 pt wide
    // sits exactly ON a column boundary, and its centre falls a floating-point
    // hair INSIDE the cell — 198.60000000000002 against 198.6. Until
    // 21/09/2026 the cell came out as « 13,61[Barre de couleur en 2 segments] »:
    // two rules published as data. `cellDataFills` closed it with « a fill that
    // crosses a cell boundary belongs to no cell », and the 23/09/2026 removal
    // of every colour bar closes it a second time, upstream: no fill is
    // published at all. The expectation stays as the witness of the cell TEXT.
    const row = table.rows.find((r) => cellText(r.cells[0]!) === "Mathematiques")!;
    expect(cellText(row.cells[2]!)).toBe("13,61");
  });
});
