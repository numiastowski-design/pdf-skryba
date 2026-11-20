/**
 * A grid column with nothing in it is not published (22/09/2026,
 * `pdf-table-render.ts#dropEmptyColumns`).
 */
import { describe, expect, it } from "vitest";
import type { IRBlock } from "doc-ir";
import type { MergeMap } from "../layout/geometry";
import type { GlyphFragment } from "./glyph-positions";
import { renderTableRegion, type CellImage } from "./pdf-table-render";

type TableBlock = Extract<IRBlock, { kind: "table" }>;

const glyph = (text: string, x: number, y: number): GlyphFragment => ({
  text,
  x,
  y,
  width: 20,
  height: 8,
  isSpace: text.trim().length === 0,
  matrix: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
  runId: 0,
  stroked: false,
  paintCount: 1,
});

// Rows 700 / 650 / 600; columns 100 / 200 | 250 / 350. The middle column, x 200 to 250,
// is the one each test fills or leaves empty.
const grid = { rowBoundaries: [700, 650, 600], colBoundaries: [100, 200, 250, 350] };
const sides = [glyph("A", 110, 680), glyph("B", 260, 680), glyph("C", 110, 620), glyph("D", 260, 620)];

const shape = (table: TableBlock | undefined): string[][] =>
  table!.rows.map((row) =>
    row.cells.map((cell) => {
      const content = cell.blocks
        .map((b) => (b.kind === "paragraph" ? b.inlines.map((i) => i.text).join("") : b.kind))
        .join("+");
      return `${content}${cell.colspan !== undefined ? ` /${cell.colspan}` : ""}`;
    }),
  );

describe("dropEmptyColumns: a column empty in every row is not published", () => {
  it("drops the middle column and its width", () => {
    const table = renderTableRegion(grid, sides, undefined)?.[0] as TableBlock | undefined;
    expect(shape(table)).toEqual([
      ["A", "B"],
      ["C", "D"],
    ]);
    expect(table!.columnWidths).toEqual([100, 100]);
  });

  it("a column holding only spaces is empty", () => {
    expect(
      shape(renderTableRegion(grid, [...sides, glyph(" ", 215, 680)], undefined)?.[0] as TableBlock | undefined),
    ).toEqual([
      ["A", "B"],
      ["C", "D"],
    ]);
  });

  it("keeps a column holding a single glyph", () => {
    const table = renderTableRegion(grid, [...sides, glyph("x", 215, 620)], undefined)?.[0] as TableBlock | undefined;
    expect(shape(table)).toEqual([
      ["A", "", "B"],
      ["C", "x", "D"],
    ]);
    expect(table!.columnWidths).toEqual([100, 50, 100]);
  });

  it("keeps a column that has a heading and empty values (22/09/2026)", () => {
    // An entirely empty column has no heading either. Measured case: the four mastery
    // levels of the real bulletin's "socle" table, headed and empty below.
    const table = renderTableRegion(grid, [...sides, glyph("H", 215, 680)], undefined)?.[0] as TableBlock | undefined;
    expect(shape(table)).toEqual([
      ["A", "H", "B"],
      ["C", "", "D"],
    ]);
    expect(table!.rows[0]!.cells.every((c) => c.header === true)).toBe(true);
  });

  it("keeps a column holding only an image: such a cell is not empty", () => {
    const image: CellImage = {
      top: 690,
      bottom: 660,
      xMin: 205,
      xMax: 245,
      read: () => [{ kind: "image", ref: { sha256: "i", mimeType: "image/png" } }],
    };
    expect(shape(renderTableRegion(grid, sides, undefined, [image])?.[0] as TableBlock | undefined)).toEqual([
      ["A", "image", "B"],
      ["C", "", "D"],
    ]);
  });

  // Row 0 is one cell across the three columns.
  const titleRow: MergeMap = {
    cells: [
      { row: 0, col: 0, colspan: 3, rowspan: 1 },
      { row: 1, col: 0, colspan: 1, rowspan: 1 },
      { row: 1, col: 1, colspan: 1, rowspan: 1 },
      { row: 1, col: 2, colspan: 1, rowspan: 1 },
    ],
    ownerAt: [
      [0, 0, 0],
      [1, 2, 3],
    ],
  };

  it("keeps a column crossed by a merged cell whose content lies IN it", () => {
    // The title's only glyph is centred in the middle column: dropping it would say nothing
    // wrong about the text, but the rule keeps every column that holds content.
    const glyphs = [glyph("T", 215, 680), glyph("C", 110, 620), glyph("D", 260, 620)];
    expect(shape(renderTableRegion(grid, glyphs, titleRow)?.[0] as TableBlock | undefined)).toEqual([
      ["T /3"],
      ["C", "", "D"],
    ]);
  });

  it("drops a column crossed by a merged cell whose content lies elsewhere: the cell loses one colspan", () => {
    // The shape of safedocs 0000713 p3: a row-wide cell whose text sits in one column.
    const glyphs = [glyph("T", 110, 680), glyph("C", 110, 620), glyph("D", 260, 620)];
    const table = renderTableRegion(grid, glyphs, titleRow)?.[0] as TableBlock | undefined;
    expect(shape(table)).toEqual([["T /2"], ["C", "D"]]);
    expect(table!.columnWidths).toEqual([100, 100]);
  });
});

/**
 * A SPACE GLYPH PAST THE GRID DOES NOT VETO THE TABLE (01/10/2026). Word ends a wrapped line in a cell with a
 * space whose centre lies a few points past the right border: 4 of the 4 bordered tables of
 * `fixtures/docx-reel/07-moj-data-sharing-guidance-Word.pdf` (pages 10, 11, 13, 14) had exactly one such glyph,
 * `outside` = 1, and were all published as prose. Only a glyph that carries text is content the table must explain.
 */
describe("the outside guard looks at text, not at spaces", () => {
  const space = (x: number, y: number): GlyphFragment => glyph(" ", x, y);

  it("publishes the table when the only glyph outside the grid is a space", () => {
    const table = renderTableRegion(grid, [...sides, space(345, 680)], undefined)?.[0] as TableBlock | undefined; // centre 355 > 350
    expect(shape(table)).toEqual([
      ["A", "B"],
      ["C", "D"],
    ]);
  });

  it("still refuses the table when a glyph with text is outside the grid", () => {
    expect(renderTableRegion(grid, [...sides, glyph("X", 345, 680)], undefined)).toBeUndefined();
  });
});

/**
 * A LINK IN A TABLE CELL (07/10/2026). The glyphs a link is tied to (`pdf-links.ts`) carry its `href`; the
 * cell's inlines are cut at those glyphs, and a space between two glyphs of the same link takes it (rule 4).
 */
describe("a glyph tied to a link carries it into its cell", () => {
  const H = "https://example.com/a";
  const wide = { rowBoundaries: [700, 650], colBoundaries: [100, 300] };
  const linked = (text: string, x: number): GlyphFragment => ({ ...glyph(text, x, 680), href: H });

  it("cuts the cell's paragraph at the linked glyphs, the space between them included", () => {
    const cell = [
      glyph("x", 100, 680),
      glyph(" ", 120, 680),
      linked("a", 140),
      linked("b", 160),
      glyph(" ", 180, 680),
      linked("c", 200),
      linked("d", 220),
    ];
    // A one-column region publishes its cell's blocks flat (26/10/2026): the region's blocks ARE the cell's, same expectation.
    expect(renderTableRegion(wide, cell, undefined)).toEqual([
      { kind: "paragraph", inlines: [{ text: "x " }, { text: "ab cd", href: H }] },
    ]);
  });

  it("a line break in the cell splits the link into two with the same target: no <a> wraps a <br/>", () => {
    // Two columns, so the cell's lines are never joined into prose; 12 pt apart at 8 pt glyphs, one paragraph.
    const twoColumns = { rowBoundaries: [700, 650], colBoundaries: [100, 300, 400] };
    const cell = [
      linked("a", 100),
      linked("b", 120),
      { ...glyph("c", 100, 668), href: H },
      { ...glyph("d", 120, 668), href: H },
      glyph("z", 310, 680),
    ];
    const table = renderTableRegion(twoColumns, cell, undefined)?.[0] as TableBlock | undefined;
    expect(table!.rows[0]!.cells[0]!.blocks).toEqual([
      { kind: "paragraph", inlines: [{ text: "ab", href: H }, { text: "\n" }, { text: "cd", href: H }] },
    ]);
  });
});

/**
 * A ONE-ROW STRIP OF SINGLE CHARACTERS (form cover sheets: one letter per box, safedocs 0000523 p1). Read cell by cell it
 * is a row of one-letter cells, which no search finds and which the column cap withholds past 21 boxes (« CHINO ROCES
 * AVE.MAKATI CITY » was lost, 24 letters). A TIGHT comb is published as ONE cell joined into words (an empty box between
 * two letters being a word space), whatever its column count; any other strip past the cap as one cell space-separated;
 * any other strip at or under the cap stays a table.
 */
describe("a one-row strip of single characters: a tight comb joined, a wide strip past the cap spaced", () => {
  const BOX = 20;
  const comb = (boxes: number, box = BOX) => ({
    rowBoundaries: [700, 650],
    colBoundaries: Array.from({ length: boxes + 1 }, (_, i) => 100 + i * box),
  });
  /** One glyph per box: `text` characters from box 0, a space character leaving its box empty. */
  const letters = (text: string, box = BOX): GlyphFragment[] =>
    [...text].flatMap((c, i) => (c === " " ? [] : [{ ...glyph(c, 100 + i * box + 3, 680), width: 6 }]));
  const cellOf = (table: TableBlock | undefined): string[][] => shape(table);
  /** 22 filled boxes: enough to pass the 21-column cap, followed by an empty box. */
  const PAD = "ABCDEFGHIJKLMNOPQRSTUV ";
  const over = (text: string, box = BOX) =>
    renderTableRegion(comb(PAD.length + text.length, box), letters(PAD + text, box), undefined)?.[0] as
      TableBlock | undefined;
  const PAD_JOINED = "ABCDEFGHIJKLMNOPQRSTUV ";

  it("joins adjacent boxes into a word and an empty box into a space", () => {
    const text = "CHINO ROCES AVE.MAKATI CITY";
    const table = renderTableRegion(comb(text.length), letters(text), undefined)?.[0] as TableBlock | undefined;
    expect(cellOf(table)).toEqual([[text]]);
    expect(table!.columnWidths).toEqual([text.length * BOX]);
  });

  it("joins a tight comb under the cap too: the 21-box address of 0000523", () => {
    const text = "3RD FLR.DACON BLDG. 2281";
    expect(
      cellOf(renderTableRegion(comb(text.length), letters(text), undefined)?.[0] as TableBlock | undefined),
    ).toEqual([[text]]);
  });

  it("leaves a non-tight strip at or under the cap a table of cells", () => {
    expect(
      cellOf(
        renderTableRegion(comb(21, 60), letters("ABCDEFGHIJKLMNOPQRSTU", 60), undefined)?.[0] as TableBlock | undefined,
      )[0],
    ).toHaveLength(21);
  });

  it("PINNED BIAS, accepted: a tight weekday legend (S M T W T F S in 20-pt boxes) is joined into one token", () => {
    expect(cellOf(renderTableRegion(comb(7), letters("SMTWTFS"), undefined)?.[0] as TableBlock | undefined)).toEqual([
      ["SMTWTFS"],
    ]);
  });

  it("publishes a non-tight strip past the cap as one cell, the characters space-separated", () => {
    const text = "ABCDEFGHIJKLMNOPQRSTUVWXYZab";
    expect(
      cellOf(renderTableRegion(comb(text.length, 30), letters(text, 30), undefined)?.[0] as TableBlock | undefined),
    ).toEqual([[[...text].join(" ")]]);
  });

  it("leaves a calendar, a Y/N row and lettered headers in wide boxes, under the cap, as cells", () => {
    const wide = (text: string) =>
      cellOf(renderTableRegion(comb(text.length, 48), letters(text, 48), undefined)?.[0] as TableBlock | undefined);
    expect(wide("1234567")).toEqual([["1", "2", "3", "4", "5", "6", "7"]]);
    expect(wide("YNYNYNY")).toEqual([["Y", "N", "Y", "N", "Y", "N", "Y"]]);
    expect(wide("ABCDEF")).toEqual([["A", "B", "C", "D", "E", "F"]]);
  });

  it("does not join digits, even in a tight comb", () => {
    expect(
      cellOf(renderTableRegion(comb(22), letters("1234567890123456789012"), undefined)?.[0] as TableBlock | undefined),
    ).toEqual([["1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2"]]);
  });

  it("does not join a right-to-left strip, past the cap", () => {
    const hebrew = "אבגדהוזחטיכלמנסעפצקרשתאבג";
    expect(
      cellOf(renderTableRegion(comb(hebrew.length), letters(hebrew), undefined)?.[0] as TableBlock | undefined),
    ).toEqual([[[...hebrew].join(" ")]]);
  });

  it("does not join boxes of unequal widths", () => {
    const text = "ABCDEFGHIJKLMNOPQRSTUV";
    const uneven = {
      rowBoundaries: [700, 650],
      colBoundaries: [
        100,
        ...Array.from({ length: text.length }, (_, i) => 120 + i * 20 + (i === text.length - 1 ? 200 : 0)),
      ],
    };
    expect(cellOf(renderTableRegion(uneven, letters(text), undefined)?.[0] as TableBlock | undefined)).toEqual([
      [[...text].join(" ")],
    ]);
  });

  it("counts a box as one character by grapheme: a decomposed accent and a ligature are one", () => {
    const accent = [
      ...letters(PAD),
      { ...glyph("e", 100 + PAD.length * BOX + 3, 680), width: 4 },
      { ...glyph("́", 100 + PAD.length * BOX + 8, 680), width: 1 },
    ];
    expect(cellOf(renderTableRegion(comb(PAD.length + 1), accent, undefined)?.[0] as TableBlock | undefined)).toEqual([
      [PAD_JOINED + "é"],
    ]);
    const ligature = [...letters(PAD), { ...glyph("ﬁ", 100 + PAD.length * BOX + 3, 680), width: 8 }];
    expect(cellOf(renderTableRegion(comb(PAD.length + 1), ligature, undefined)?.[0] as TableBlock | undefined)).toEqual(
      [[PAD_JOINED + "ﬁ"]],
    );
  });

  it("strips zero-width characters, left-to-right marks included, from a box", () => {
    const marks = [
      ...letters(PAD),
      { ...glyph("‎", 100 + PAD.length * BOX + 1, 680), width: 1 },
      { ...glyph("F", 100 + PAD.length * BOX + 5, 680), width: 6 },
    ];
    expect(cellOf(renderTableRegion(comb(PAD.length + 1), marks, undefined)?.[0] as TableBlock | undefined)).toEqual([
      [PAD_JOINED + "F"],
    ]);
  });

  it("reads consecutive, leading and trailing empty boxes as at most one space, trimmed", () => {
    expect(cellOf(over("  AB   CDEF  GH "))).toEqual([[PAD_JOINED + "AB CDEF GH"]]);
  });

  it("leaves a strip where one box holds more than one grapheme a table of cells", () => {
    const glyphs = [
      ...letters(PAD),
      { ...glyph("H", 100 + PAD.length * BOX + 3, 680), width: 6 },
      { ...glyph("I", 100 + PAD.length * BOX + 10, 680), width: 6 },
    ];
    const row = cellOf(renderTableRegion(comb(PAD.length + 1), glyphs, undefined)?.[0] as TableBlock | undefined)[0]!;
    expect(row).toHaveLength(23);
    expect(row[22]).toMatch(/^H\s?I$/);
  });

  it("leaves a linked strip alone: the links live in the cells", () => {
    const linked = letters(PAD).map((g) => ({ ...g, href: "https://example.com/a" }));
    expect(
      cellOf(renderTableRegion(comb(PAD.length), linked, undefined)?.[0] as TableBlock | undefined)[0],
    ).toHaveLength(22);
  });

  it("leaves a strip with an image alone", () => {
    const image = { top: 690, bottom: 660, xMin: 100, xMax: 120, read: () => undefined };
    expect(
      cellOf(renderTableRegion(comb(PAD.length), letters(PAD), undefined, [image])?.[0] as TableBlock | undefined)[0]!
        .length,
    ).toBeGreaterThan(1);
  });

  it("leaves a strip with a merged cell alone", () => {
    const n = PAD.length;
    const cells = Array.from({ length: n - 1 }, (_, c) => ({
      row: 0,
      col: c === 0 ? 0 : c + 1,
      colspan: c === 0 ? 2 : 1,
      rowspan: 1,
    }));
    const merge: MergeMap = { cells, ownerAt: [[0, 0, ...cells.slice(1).map((_, k) => k + 1)]] };
    expect(
      cellOf(renderTableRegion(comb(n), letters(PAD), merge)?.[0] as TableBlock | undefined)[0]!.length,
    ).toBeGreaterThan(1);
  });
});

/**
 * A RAISED CALL IN A CELL IS PUBLISHED AS A SUPERSCRIPT (23/10/2026: « garder l'exposant là où on peut »). A cell's text
 * stays the document's; the glyphs its line reads as raised calls (`layout/cell-text.ts`, same reading as the page flow) carry
 * `sup` into the cell's inlines, by the same glyph-to-character mapping as links. Spaces and line breaks never take the mark.
 */
describe("a raised call in a cell becomes a superscript", () => {
  const wide = { rowBoundaries: [700, 650], colBoundaries: [100, 300] };
  const g = (text: string, x: number, y = 680, size = 8): GlyphFragment => ({
    ...glyph(text, x, y),
    width: 6,
    height: size,
  });
  const word = (text: string, x0: number, y = 680, size = 8): GlyphFragment[] =>
    [...text].map((c, i) => g(c, x0 + i * 6, y, size));
  // `wide` is a one-column region, published flat since 26/10/2026: its first block is the cell's first block, read directly.
  const inlinesOf = (cell: GlyphFragment[], region = wide) => {
    const b = renderTableRegion(region, cell, undefined)![0]!;
    return b.kind === "paragraph" ? b.inlines : [];
  };

  it("🔴 « dosis² con »: the call is a sup inline, the words around it plain", () => {
    // FAILS WITH: [{ text: "dosis2 con" }] (a cell's text was one plain inline).
    expect(inlinesOf([...word("dosis", 100), g("2", 130, 682.5, 5), g(" ", 136), ...word("con", 142)])).toEqual([
      { text: "dosis" },
      { text: "2", marks: ["sup"] },
      { text: " con" },
    ]);
  });

  it("🔴 « 4² » alone in its cell", () => {
    expect(inlinesOf([g("4", 100), g("2", 106, 682.5, 5)])).toEqual([{ text: "4" }, { text: "2", marks: ["sup"] }]);
  });

  it("🔴 a link and a call in one cell: both kept", () => {
    const H = "https://example.com/a";
    expect(
      inlinesOf([
        ...word("ab", 100).map((f) => ({ ...f, href: H })),
        g("1", 112, 682.5, 5),
        g(" ", 118),
        ...word("cd", 124),
      ]),
    ).toEqual([{ text: "ab", href: H }, { text: "1", marks: ["sup"] }, { text: " cd" }]);
  });

  it("a same-size digit glued to a word stays plain", () => {
    expect(inlinesOf(word("covid19", 100))).toEqual([{ text: "covid19" }]);
  });
});

/**
 * A REGION OF ONE CONTENT COLUMN IS PUBLISHED AS ITS CELLS' BLOCKS, FLAT, IN ROW ORDER — NOT AS A TABLE (26/10/2026, on
 * measurement; supersedes « one-column tables stay tables » of 22/09/2026, the TRIED THEN REJECTED note of `pdf-table-render.ts`).
 * A one-column grid has no second reading that confirms a table: nothing aligns across columns, the two readings diverge, so the
 * table abstains and the prose is published. No exception of form. The count is the CONTENT column count (`contentColumnCount`),
 * the one `dropEmptyColumns` publishes: an empty sliver beside the text column is not a second column.
 *
 * The cells keep being read glyph by glyph (`recomposeCellText`, the one-column join included): the page is NOT re-read as prose —
 * the 22/09 attempt did, and cut 38 paragraphs on corpus doc 29 p3. Written exceptions: ABSTAIN (the table stays) when a cell
 * carries an image the grid claims; an empty cell yields nothing; a region of two or more content columns is untouched.
 *
 * Contract pinned here: for such a region `renderTableRegion` returns the cells' blocks as an ARRAY, in row order. `published`
 * reads either shape (a table block or an array), so the two-column and image cases hold whatever the return type becomes.
 */
describe("a region of one content column is published flat, as its cells' blocks in row order", () => {
  const oneColumn = { rowBoundaries: [700, 650, 600, 550], colBoundaries: [100, 300] };
  /** Two adjacent glyphs, read as one word `text` (two letters), in the row whose glyph baseline is `y`. */
  const word = (text: string, y: number): GlyphFragment[] => [glyph(text[0]!, 110, y), glyph(text[1]!, 130, y)];
  const published = (out: unknown): IRBlock[] => {
    if (out === undefined) return [];
    return Array.isArray(out) ? (out as IRBlock[]) : [out as IRBlock];
  };
  const paragraph = (text: string): IRBlock => ({ kind: "paragraph", inlines: [{ text }] });

  it("🔴 three rows of one column come out as three paragraphs, in row order, with the cells' text", () => {
    // FAILS WITH: expected [ { kind: 'table', …(2) } ] to deeply equal [ { kind: 'paragraph', …(1) }, …(2) ]
    // (today's table: columnWidths [200], three rows of one cell, « Ab » / « Cd » / « Ef »)
    const out = published(
      renderTableRegion(oneColumn, [...word("Ab", 680), ...word("Cd", 630), ...word("Ef", 580)], undefined),
    );
    expect(out).toEqual([paragraph("Ab"), paragraph("Cd"), paragraph("Ef")]);
  });

  it("🔴 an empty cell yields nothing: two filled rows around an empty one are two paragraphs", () => {
    // FAILS WITH: expected [ { kind: 'table', …(2) } ] to deeply equal [ { kind: 'paragraph', …(1) }, …(1) ]
    // (today's table keeps the empty middle row: three rows, « Ab » / « » / « Ef »)
    const out = published(renderTableRegion(oneColumn, [...word("Ab", 680), ...word("Ef", 580)], undefined));
    expect(out).toEqual([paragraph("Ab"), paragraph("Ef")]);
  });

  it("🔴 the count is the CONTENT column count: a grid of two columns whose first is an empty sliver is published flat too", () => {
    // The shape of safedocs 0000713 p3, p4 and p6: a 5-pt sliver beside the text column.
    // FAILS WITH: expected [ { kind: 'table', …(2) } ] to deeply equal [ { kind: 'paragraph', …(1) }, …(1) ]
    // (today's table: the sliver dropped, columnWidths [195], two rows of one cell)
    const sliver = { rowBoundaries: [700, 650, 600], colBoundaries: [100, 105, 300] };
    const out = published(renderTableRegion(sliver, [...word("Ab", 680), ...word("Cd", 630)], undefined));
    expect(out).toEqual([paragraph("Ab"), paragraph("Cd")]);
  });

  it("declares the flattening to its caller, and only on the flat path (decision of 26/10, counted apart by the bench since 20/11/2026)", () => {
    let flattened = 0;
    const record = (): number => flattened++;
    renderTableRegion(oneColumn, [...word("Ab", 680), ...word("Cd", 630)], undefined, [], { flattened: record });
    expect(flattened).toBe(1);
    renderTableRegion(grid, sides, undefined, [], { flattened: record });
    expect(flattened).toBe(1);
  });

  it("a region of two content columns is untouched: still one table", () => {
    // Green today: protects the two-column table against the flat publication reaching past one column.
    const [table, ...rest] = published(renderTableRegion(grid, sides, undefined));
    expect(rest).toEqual([]);
    expect(table?.kind).toBe("table");
    expect(shape(table as TableBlock)).toEqual([
      ["A", "B"],
      ["C", "D"],
    ]);
  });

  it("a one-column region whose cell carries an image the grid claims stays a table (abstention)", () => {
    // Green today: protects the image's place in its cell — flat, the image would have no cell to live in.
    const twoRows = { rowBoundaries: [700, 650, 600], colBoundaries: [100, 300] };
    const image: CellImage = {
      top: 640,
      bottom: 610,
      xMin: 150,
      xMax: 250,
      read: () => [{ kind: "image", ref: { sha256: "i", mimeType: "image/png" } }],
    };
    const [table, ...rest] = published(renderTableRegion(twoRows, word("Ab", 680), undefined, [image]));
    expect(rest).toEqual([]);
    expect(table?.kind).toBe("table");
    expect(shape(table as TableBlock)).toEqual([["Ab"], ["image"]]);
  });
});
