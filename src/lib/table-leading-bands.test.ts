/** 16/10/2026, narrowed 24/10/2026: `withoutLeadingBands` is the empty-rows step of the PDF reader. A PDF paints a grey header as stacked
 *  rectangles; the grid search reads the 1 mm between them as rows, so the table starts with rows that hold nothing at all (49-GrandSoissons p. 9). Such a row is
 *  removed and its cells that span downward start one row lower with one row less to span. A row that holds text stays: the fold of a header cut into lines
 *  is `withoutLeadingBandsDeep` (`table-header-fold.test.ts`), which replaced the glue of one-row text cells (rule A, render 96).
 *  Run: npx vitest run --project=main src/lib/table-leading-bands.test.ts */
import { describe, expect, it } from "vitest";

import type { IRBlock } from "doc-ir";
import { withoutLeadingBands } from "./table-leading-bands";

type Table = Extract<IRBlock, { kind: "table" }>;
type Cell = Table["rows"][number]["cells"][number];

const p = (text: string): IRBlock[] => [{ kind: "paragraph", inlines: [{ text }] }];
const cell = (text: string, extra: Omit<Cell, "blocks"> = {}): Cell => ({ blocks: p(text), ...extra });
const blank = (extra: Omit<Cell, "blocks"> = {}): Cell => ({ blocks: [], ...extra });
const table = (rows: Cell[][]): Table => ({ kind: "table", rows: rows.map((cells) => ({ cells })) });
const shape = (t: Table): string[] =>
  t.rows.map((r) =>
    r.cells
      .map(
        (c) =>
          `${(c.blocks[0] as { inlines: { text: string }[] } | undefined)?.inlines[0]?.text ?? "∅"}${c.rowspan === undefined ? "" : `/${c.rowspan}`}`,
      )
      .join("|"),
  );

describe("withoutLeadingBands", () => {
  it("an empty first row goes: its cells that span downward start one row lower with one row less to span", () => {
    const t = table([[blank({ rowspan: 2 }), blank({ rowspan: 3 }), blank()], [cell("a")], [blank(), cell("b")]]);
    expect(shape(withoutLeadingBands(t))).toEqual(["∅|∅/2|a", "∅|b"]);
  });

  it("a first row with an empty corner and a text cell that spans downward STAYS (the fold of a header cut into lines is `withoutLeadingBandsDeep`)", () => {
    const t = table([
      [blank({ rowspan: 2 }), cell("Title", { rowspan: 3 }), blank()],
      [cell("a")],
      [blank(), cell("b")],
    ]);
    expect(withoutLeadingBands(t)).toBe(t);
  });

  it("a table WITHOUT spans (49 p. 9 table 1.6.4: « Volumes vendus » on one row, an empty corner) is left alone: it looks like a cross table", () => {
    const t = table([
      [blank(), cell("Volumes vendus"), cell("Volumes vendus"), blank()],
      [cell("Acheteurs"), cell("durant"), cell("durant"), cell("Variation en %")],
    ]);
    expect(withoutLeadingBands(t)).toBe(t);
  });

  it("a cross table keeps its header: the corner is empty by design and its cells hold text on one row", () => {
    const t = table([
      [blank(), cell("2019"), cell("2020")],
      [cell("Ventes"), cell("12"), cell("15")],
    ]);
    expect(withoutLeadingBands(t)).toBe(t);
  });

  it("a first row whose corner holds text stays", () => {
    const t = table([[cell("x", { rowspan: 2 }), cell("y", { rowspan: 2 })], [cell("z")]]);
    expect(withoutLeadingBands(t)).toBe(t);
  });

  it("an empty corner with one text cell on a single row stays (nothing would be merged, so nothing is guessed)", () => {
    const t = table([
      [blank(), cell("H")],
      [cell("a"), cell("b")],
    ]);
    expect(withoutLeadingBands(t)).toBe(t);
  });

  it("an entirely empty first row goes", () => {
    expect(
      shape(
        withoutLeadingBands(
          table([
            [blank(), blank()],
            [cell("a"), cell("b")],
          ]),
        ),
      ),
    ).toEqual(["a|b"]);
  });

  it("a single-row table is left alone", () => {
    const t = table([[blank(), blank()]]);
    expect(withoutLeadingBands(t)).toBe(t);
  });

  it("a rowspan that ends one row below loses its attribute; a fractional one counts as the table's own rule (ceil)", () => {
    const two = table([[blank(), blank({ rowspan: 2 })], [cell("a")]]);
    expect(shape(withoutLeadingBands(two))).toEqual(["a|∅"]);
    const frac = table([[blank(), blank({ rowspan: 2.5 })], [cell("a")], [cell("b")]]);
    expect(shape(withoutLeadingBands(frac))).toEqual(["a|∅/2", "b"]);
  });

  it("columns widths and header flags are kept; a hostile pile of empty leading rows costs a bounded number of passes", () => {
    const rows: Cell[][] = Array.from({ length: 40 }, () => [blank(), blank()]);
    rows.push([cell("a"), cell("b")]);
    const t: Table = { ...table(rows), columnWidths: [10, 20] };
    const out = withoutLeadingBands(t);
    expect(out.columnWidths).toEqual([10, 20]);
    expect(out.rows.length).toBeGreaterThanOrEqual(1);
    expect(out.rows.length).toBeLessThan(rows.length);
  });

  describe("a row that holds text is never taken for an empty band (nothing is glued)", () => {
    it("a cross table is NOT touched: no cell of its first row spans downward", () => {
      const t = table([
        [blank(), cell("2019"), cell("2020")],
        [cell("Ventes"), cell("12"), cell("15")],
      ]);
      expect(withoutLeadingBands(t)).toBe(t);
      const t2 = table([
        [blank(), cell("Volumes vendus"), cell("Volumes vendus"), blank()],
        [cell("Acheteurs"), cell("durant"), cell("durant"), cell("Variation en %")],
      ]);
      expect(withoutLeadingBands(t2)).toBe(t2);
    });

    it("a table whose only spanning cell is an EMPTY corner (a vertical label the PDF did not give back) is NOT touched: its rows are distinct rows (057 p. 6)", () => {
      const t = table([
        [blank({ rowspan: 3 }), cell("Equity Implied Volatility"), cell("Equity implied volatility risk")],
        [cell("Property risk"), cell("Within the Market")],
        [cell("Currency risk"), cell("Within the Market")],
      ]);
      expect(withoutLeadingBands(t)).toBe(t);
    });

    it("a table with no text at all is NOT touched (a blank form keeps its empty rows: 066 p. 6, 003 p. 8)", () => {
      const t = table([
        [blank(), blank()],
        [blank(), blank()],
        [blank(), blank()],
      ]);
      expect(withoutLeadingBands(t)).toBe(t);
    });

    it("DATA rows are not glued: a form whose first column is empty and which has a « Remarques » text cell spanning downward (review 16/10)", () => {
      const t = table([
        [blank(), cell("10"), cell("Rem", { rowspan: 3 })],
        [blank(), cell("20")],
        [blank(), cell("30")],
      ]);
      expect(withoutLeadingBands(t)).toBe(t); // « 10 » would meet « 20 »: a one-row cell below is a data cell, nothing is glued
    });

    it("a header with an empty corner and a « Notes » cell spanning two rows is not glued to the data row under it", () => {
      const t = table([
        [blank(), cell("Q1"), cell("Q2"), cell("Notes", { rowspan: 2 })],
        [cell("Item"), cell("100"), cell("200")],
      ]);
      expect(withoutLeadingBands(t)).toBe(t);
    });

    it("no cell below to glue to (a different colspan): the row stays", () => {
      const t = table([
        [blank({ rowspan: 2 }), cell("Ventes", { colspan: 2 })],
        [cell("Q1"), cell("Q2")],
      ]);
      expect(withoutLeadingBands(t)).toBe(t);
    });
  });

  describe("what stays as it is", () => {
    it("a first row holding text stays whole, whatever the cells below", () => {
      const t = table([
        [blank(), cell("A"), cell("B"), cell("Span", { rowspan: 2 })],
        [cell("x"), cell("y", { rowspan: 2 })],
      ]);
      expect(withoutLeadingBands(t)).toBe(t);
    });

    it("a table of two rows whose first row holds text is left as it is", () => {
      const t = table([
        [blank(), cell("A")],
        [cell("x"), cell("y")],
      ]);
      expect(withoutLeadingBands(t)).toBe(t);
    });
  });
});
