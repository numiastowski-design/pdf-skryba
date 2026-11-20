/** B replaces A (24/10/2026, after the A/B/C comparison of 16-23/10 on 2 020 tables of 429 PDFs: B moved no word, crushed no table, came as close
 *  to the Word source as A — 1 932 rows off against 1 934): the PDF extraction's table call (`withoutLeadingBandsDeep`, `extractor/pdf.ts`) folds the whole
 *  group of rows tied by spans into ONE header row, after the rows that hold nothing at the top fall.
 *  Run: npx vitest run --project=main src/lib/table-header-fold.test.ts */
import { describe, expect, it } from "vitest";

import type { IRBlock } from "doc-ir";
import { withoutLeadingBandsDeep } from "./table-leading-bands";

type Table = Extract<IRBlock, { kind: "table" }>;
type Cell = Table["rows"][number]["cells"][number];

const p = (text: string): IRBlock[] => [{ kind: "paragraph", inlines: [{ text }] }];
const cell = (text: string, extra: Omit<Cell, "blocks"> = {}): Cell => ({ blocks: p(text), ...extra });
const blank = (extra: Omit<Cell, "blocks"> = {}): Cell => ({ blocks: [], ...extra });
const table = (rows: Cell[][]): Table => ({ kind: "table", rows: rows.map((cells) => ({ cells })) });
const joined = (c: Cell): string =>
  c.blocks.map((b) => (b as { inlines: { text: string }[] }).inlines.map((i) => i.text).join("")).join("+") || "∅";
const rowTexts = (t: Table): string[] => t.rows.map((r) => r.cells.map(joined).join(" | "));
const product = (t: Table): Table => withoutLeadingBandsDeep([t])[0] as Table;

/** 49 p. 9, table 1.6.3: the band row, the header cut into eight rows, two empty rows, the data row. */
const table163 = (): Table =>
  table([
    [blank(), blank(), blank(), blank(), blank()],
    [
      blank({ rowspan: 3 }),
      blank(),
      cell("Volume acheté durant l'exercice 2021 en m3", { rowspan: 8 }),
      cell("Variation des", { rowspan: 3 }),
      blank(),
    ],
    [cell("Volume acheté"), cell("Indice de")],
    [cell("durant", { rowspan: 2 }), cell("protection de la", { rowspan: 2 })],
    [cell("Fournisseur", { rowspan: 2 }), cell("volumes achetés", { rowspan: 2 })],
    [cell("l'exercice", { rowspan: 2 }), cell("ressource exercice", { rowspan: 2 })],
    [blank({ rowspan: 3 }), cell("en %", { rowspan: 3 })],
    [cell("2020 en m3"), cell("2021")],
    [blank(), blank()],
    [blank(), blank(), blank(), blank(), blank()],
    [cell("Total d'eaux traitées achetées"), cell("3 065"), cell("809"), cell("-73,6%"), cell("50")],
  ]);

describe("the PDF extraction folds a header cut into lines into ONE row (B)", () => {
  it("1.6.3: one header row, each column's pieces in reading order, the data row untouched", () => {
    const out = product(table163());
    expect(out.rows).toHaveLength(3);
    const header = out.rows[0]!.cells.map(joined);
    expect(header[0]).toBe("Fournisseur");
    expect(header[1]).toBe("Volume acheté+durant+l'exercice+2020 en m3");
    expect(header[3]).toBe("Variation des+volumes achetés+en %");
    expect(header[4]).toBe("Indice de+protection de la+ressource exercice+2021");
    expect(rowTexts(out)[2]).toContain("Total d'eaux traitées achetées");
  });

  it("a table nested in a cell is folded too", () => {
    const outer = table([[{ blocks: [table163()] }]]);
    const inner = (withoutLeadingBandsDeep([outer])[0] as Table).rows[0]!.cells[0]!.blocks[0] as Table;
    expect(inner.rows).toHaveLength(3);
  });

  it("left as they are: a cross table, a table with no text, a vertical label in an empty corner", () => {
    const cross = table([
      [blank(), cell("2019"), cell("2020")],
      [cell("Ventes"), cell("12"), cell("15")],
    ]);
    expect(product(cross)).toEqual(cross);
    const empty = table([
      [blank(), blank()],
      [blank(), blank()],
    ]);
    expect(product(empty)).toEqual(empty);
    const label = table([
      [blank({ rowspan: 3 }), cell("Equity"), cell("desc")],
      [cell("Property"), cell("d2")],
      [cell("Currency"), cell("d3")],
    ]);
    expect(product(label)).toEqual(label);
  });

  it("a header A glued wrongly (one spanning start only) is no longer touched: B abstains where it cannot prove a header cut into lines", () => {
    const t = table([
      [blank({ rowspan: 2 }), cell("Title", { rowspan: 3 }), blank()],
      [cell("a")],
      [blank(), cell("b")],
    ]);
    expect(product(t)).toEqual(t);
  });

  it("a folded cell keeps every piece's blocks in order, an image included, and the header flag of any piece", () => {
    const image = { kind: "image", attachmentName: "logo.png", alt: "" } as unknown as IRBlock;
    const t = table163();
    t.rows[2]!.cells[0] = { blocks: [...p("Volume acheté"), image] };
    t.rows[3]!.cells[0] = cell("durant", { rowspan: 2, header: true });
    const volume = product(t).rows[0]!.cells[1]!;
    expect(volume.blocks.map((b) => b.kind)).toEqual(["paragraph", "image", "paragraph", "paragraph", "paragraph"]);
    expect(volume.blocks[1]).toBe(image);
    expect(volume.header).toBe(true);
  });

  it("an entirely empty first row still falls", () => {
    const t = table([
      [blank(), blank()],
      [cell("Nom"), cell("Valeur")],
      [cell("a"), cell("1")],
    ]);
    expect(rowTexts(product(t))).toEqual(["Nom | Valeur", "a | 1"]);
  });

  it("known risk, written: a timetable of four rows or more is a « wall of bricks » too and is folded, no word lost", () => {
    const timetable = table([
      [blank(), cell("Mon"), cell("Notes", { rowspan: 4 })],
      [cell("8h"), cell("Maths", { rowspan: 2 })],
      [cell("9h")],
      [cell("10h"), cell("Physics", { rowspan: 2 })],
      [cell("11h")],
      [cell("12h"), cell("Lunch"), cell("x")],
    ]);
    const out = product(timetable);
    expect(out.rows.length).toBeLessThan(timetable.rows.length - 2);
    const words = rowTexts(out).join(" ");
    for (const w of ["Mon", "Notes", "8h", "9h", "10h", "11h", "Maths", "Physics", "Lunch"]) expect(words).toContain(w);
  });
});
