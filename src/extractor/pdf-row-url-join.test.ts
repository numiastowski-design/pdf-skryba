/**
 * A URL is not cut from one table row to the next.
 * Run: npx vitest run --project=main src/extractor/pdf-row-url-join.test.ts
 */
import { describe, expect, it } from "vitest";

import type { IRBlock } from "doc-ir";
import { joinCutUrlRows } from "./pdf-row-url-join";

type TableBlock = Extract<IRBlock, { kind: "table" }>;

const p = (text: string): IRBlock => ({ kind: "paragraph", inlines: [{ text }] });
const row = (...cells: IRBlock[][]): TableBlock["rows"][number] => ({ cells: cells.map((blocks) => ({ blocks })) });
const textOf = (rows: TableBlock["rows"]): string[][] =>
  rows.map((r) =>
    r.cells.map((c) =>
      c.blocks.map((b) => ("inlines" in b ? b.inlines.map((i) => i.text).join("") : `[${b.kind}]`)).join("¶"),
    ),
  );

describe("une rangée étroite qui continue une URL", () => {
  it("revient dans la cellule du dessus, sans espace", () => {
    const rows = [
      row([p("Prescribed connection")], [p("See web link: https://exemple.org/my-db-")]),
      row([p("tool, for more information.")]),
    ];
    expect(textOf(joinCutUrlRows(rows))).toEqual([
      ["Prescribed connection", "See web link: https://exemple.org/my-db-tool, for more information."],
    ]);
  });

  it("joint même quand la coupure ne tombe pas sur un trait d'union : des lettres collées suffisent", () => {
    const rows = [row([p("a")], [p("https://exemple.org/pre")]), row([p("scribed")])];
    expect(textOf(joinCutUrlRows(rows))).toEqual([["a", "https://exemple.org/prescribed"]]);
  });

  it("ne joint pas quand la cellule du dessus ne finit pas par une URL", () => {
    const rows = [row([p("Signature:")], [p("")]), row([p("Please ensure the authorised signatory…")])];
    expect(joinCutUrlRows(rows)).toHaveLength(2);
  });

  it("ne joint pas « Total - » et « 12,00 » : il n'y a pas d'URL", () => {
    const rows = [row([p("a")], [p("Total -")]), row([p("12,00")])];
    expect(joinCutUrlRows(rows)).toHaveLength(2);
  });

  it("ne joint pas un mot coupé qui n'est pas dans une URL — on commence par les URL", () => {
    const rows = [row([p("a")], [p("quelque-")]), row([p("chose")])];
    expect(joinCutUrlRows(rows)).toHaveLength(2);
  });

  it("ne joint pas quand une espace suit l'URL : le document l'a écrite, rien n'est coupé", () => {
    const rows = [row([p("a")], [p("https://exemple.org/fini ")]), row([p("Suite indépendante")])];
    expect(joinCutUrlRows(rows)).toHaveLength(2);
  });

  it("ne joint pas quand la suite commence par une espace", () => {
    const rows = [row([p("a")], [p("https://exemple.org/cou")]), row([p(" pée")])];
    expect(joinCutUrlRows(rows)).toHaveLength(2);
  });

  it("ne joint pas quand la rangée étroite porte plusieurs cellules", () => {
    const rows = [
      row([p("a")], [p("b")], [p("https://exemple.org/quelque-")]),
      row([p("chose")], [p("et une autre cellule")]),
    ];
    expect(joinCutUrlRows(rows)).toHaveLength(2);
  });

  it("ne joint pas quand la rangée du dessus a autant de cellules", () => {
    const rows = [row([p("a")], [p("https://exemple.org/quelque-")]), row([p("chose")], [p("")])];
    expect(joinCutUrlRows(rows)).toHaveLength(2);
  });

  it("ne joint pas quand la cellule du dessus finit par un bloc qui n'est pas un paragraphe", () => {
    const rows = [
      row(
        [p("a")],
        [p("https://exemple.org/quelque-"), { kind: "image", ref: { sha256: "x", mimeType: "image/png" } }],
      ),
      row([p("chose")]),
    ];
    expect(joinCutUrlRows(rows)).toHaveLength(2);
  });

  it("garde les blocs suivants de la rangée étroite, après la jointure", () => {
    const rows = [row([p("a")], [p("https://exemple.org/quelque-")]), row([p("chose"), p("un second paragraphe")])];
    expect(textOf(joinCutUrlRows(rows))).toEqual([["a", "https://exemple.org/quelque-chose¶un second paragraphe"]]);
  });

  it("laisse un tableau sans rangée étroite exactement comme il est", () => {
    const rows = [row([p("a")], [p("b")]), row([p("c")], [p("d")])];
    expect(joinCutUrlRows(rows)).toEqual(rows);
  });
});
