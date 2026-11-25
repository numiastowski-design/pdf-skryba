/**
 * The large images of a PDF, published in their place (15/09/2026, MIKSUDOC "Functional specification" §6.6): the
 * placement rules on pages built here, and a made-up encrypted document.
 * NOT here: the cases on real documents the package may not carry.
 */
import { describe, expect, it } from "vitest";
import type { IRBlock } from "doc-ir";
import type { MergeMap } from "../layout/geometry";
import { renderPageTables } from "./pdf-page-tables";
import {
  extractPdf,
  interleaveImages,
  interleaveRegions,
  placeImages,
  readPageWithImages,
  type ImageAnchor,
  type ImageCandidate,
  type PageRegion,
} from "./pdf";
import { pagePlanReader } from "./pdf-page-plan";
import { encryptedPdf } from "./pdf-password-protected.test.support";

/** The plan of a test page, which carries the cuts. A new plan per call, as in production (one per page). */
const planOn = (...cuts: number[]): ReturnType<typeof pagePlanReader> =>
  pagePlanReader(cuts.length === 0 ? undefined : { cut: cuts[0]!, all: cuts });

/**
 * A VISUAL LINE IS SPLIT WHERE A GAP BETWEEN TWO FRAGMENTS CONTAINS A WHOLE GUTTER OF THE
 * BAND (21/09/2026, "option B"). On fixture 24 page 7, the label "GSM" (right of
 * the phone) and the label "Ecran PC" (on the PC screenshot) share a baseline within one
 * point: grouped as one line spanning both images, both went to the phone and the render
 * read "GSM Ecran PC".
 */
describe("a line straddling the gutter of a multi-image band is split at the gutter", () => {
  // Two boxed images side by side: L spans x 100–300, R spans x 350–500. Gutter: 300→350.
  const image = (id: string): IRBlock => ({ kind: "image", ref: { sha256: id, mimeType: "image/png" } });
  const boxed = (id: string, xMin: number, xMax: number, top: number, bottom: number): PageRegion => ({
    top,
    bottom: top,
    xMin,
    blocks: [image(id)],
    consumesBand: false,
    orderAt: (top + bottom) / 2,
    box: { top, bottom, xMin, xMax },
  });
  const band = [boxed("L", 100, 300, 400, 200), boxed("R", 350, 500, 420, 180)];
  const frag = (text: string, x: number, width: number, y: number, height = 10) =>
    ({ text, x, y, width, height }) as never;
  const para = (items: { text: string }[]): IRBlock[] =>
    items.map((i) => ({ kind: "paragraph", inlines: [{ text: i.text }] }));
  const labels = (blocks: IRBlock[]): string[] =>
    blocks.map((b) =>
      b.kind === "paragraph" ? b.inlines[0]!.text : b.kind === "image" ? `image:${b.ref.sha256}` : b.kind,
    );

  it("two labels on one baseline, one on each side of the gutter, each go to their own image", () => {
    // Old output: "left label" "right label" image:L image:R — the whole line went to L.
    const items = [frag("left label", 200, 60, 380), frag("right label", 400, 60, 380.8)];
    expect(labels(interleaveRegions(items, band, para))).toEqual(["left label", "image:L", "right label", "image:R"]);
  });

  it("a sentence crossing the gutter is never split — its word gaps cannot contain the gutter (16/09 link tail)", () => {
    const items = [frag("sentence start", 150, 170, 380), frag(" ", 320, 3, 380, 0), frag("link tail", 323, 97, 380)];
    expect(labels(interleaveRegions(items, band, para))).toEqual([
      "sentence start",
      " ",
      "link tail",
      "image:L",
      "image:R",
    ]);
  });

  it("a blank fragment inside the gutter neither prevents the split nor forms a piece of its own", () => {
    // Old output: "left" " " "right" image:L image:R. Counting the blank, no gap would contain
    // the gutter and the line would stay whole; it goes to the nearer text, "right" (77 vs 80).
    const items = [frag("left", 200, 40, 380), frag(" ", 320, 3, 380, 0), frag("right", 400, 40, 380)];
    expect(labels(interleaveRegions(items, band, para))).toEqual(["left", "image:L", " ", "right", "image:R"]);
  });
});

describe("interleaveImages", () => {
  const run = (text: string, y: number) => ({ text, x: 72, y, width: 100, height: 10 }) as never;
  const para = (items: { text: string }[]): IRBlock[] =>
    items.map((i) => ({ kind: "paragraph", inlines: [{ text: i.text }] }));
  const image: IRBlock = { kind: "image", ref: { sha256: "a", mimeType: "image/png" } };

  it("aucune ligne n'est perdue, et une ligne à côté d'une image passe après elle", () => {
    const anchors: ImageAnchor[] = [{ top: 500, xMin: 72, blocks: [image] }];
    const out = interleaveImages([run("avant", 600), run("a cote", 450), run("apres", 300)], anchors, para);
    expect(out.map((b) => (b.kind === "paragraph" ? b.inlines[0]!.text : b.kind))).toEqual([
      "avant",
      "image",
      "a cote",
      "apres",
    ]);
  });
});

describe("interleaveRegions — tableaux et images, un seul entrelacement", () => {
  // `run(text, centre)`: height 10, so `y = centre - 5`.
  const run = (text: string, center: number) => ({ text, x: 72, y: center - 5, width: 100, height: 10 }) as never;
  const para = (items: { text: string }[]): IRBlock[] =>
    items.map((i) => ({ kind: "paragraph", inlines: [{ text: i.text }] }));
  const labels = (blocks: IRBlock[]): string[] =>
    blocks.map((b) =>
      b.kind === "paragraph" ? b.inlines[0]!.text : b.kind === "image" ? `image:${b.ref.sha256}` : b.kind,
    );
  const table: IRBlock = { kind: "table", rows: [], columnWidths: [] } as never;
  const image = (id: string): IRBlock => ({ kind: "image", ref: { sha256: id, mimeType: "image/png" } });
  const tableRegion = (top: number, bottom: number): PageRegion => ({
    top,
    bottom,
    xMin: Number.NEGATIVE_INFINITY,
    blocks: [table],
    consumesBand: true,
  });
  const imageRegion = (top: number, xMin: number, id: string): PageRegion => ({
    top,
    bottom: top,
    xMin,
    blocks: [image(id)],
    consumesBand: false,
  });

  it("une image dont le haut dépasse le bas d'un tableau ne republie pas les lignes du tableau", () => {
    // Table 700 → 600; image from 620 to 400, kept (centre 510, outside the table).
    const items = [
      run("avant", 750),
      run("cellule haute", 650),
      run("cellule 610", 610),
      run("cellule 605", 605),
      run("a cote", 500),
      run("apres", 300),
    ];
    const out = labels(interleaveRegions(items, [tableRegion(700, 600), imageRegion(620, 72, "i")], para));
    expect(out).toEqual(["avant", "table", "image:i", "a cote", "apres"]);
  });

  it("plusieurs images, deux au même haut rangées de gauche à droite", () => {
    const items = [run("titre", 800), run("entre", 550), run("fin", 100)];
    const regions = [imageRegion(300, 50, "bas"), imageRegion(700, 320, "droite"), imageRegion(700, 60, "gauche")];
    expect(labels(interleaveRegions(items, regions, para))).toEqual([
      "titre",
      "image:gauche",
      "image:droite",
      "entre",
      "image:bas",
      "fin",
    ]);
  });

  it("une ligne à côté d'une image passe après elle, une ligne à son haut exact passe avant", () => {
    const items = [run("avant", 600), run("au bord", 500), run("a cote", 450), run("apres", 300)];
    expect(labels(interleaveRegions(items, [imageRegion(500, 72, "i")], para))).toEqual([
      "avant",
      "au bord",
      "image:i",
      "a cote",
      "apres",
    ]);
  });
});

/**
 * AN IMAGE WHOSE CENTRE IS INSIDE A RENDERED TABLE'S BOX GOES INTO THE CELL THAT
 * HOLDS ITS CENTRE; AN IMAGE BESIDE A TABLE KEEPS ITS OWN
 * PLACE (21/09/2026, decisions O1 and O4 as amended). Before, the vertical
 * band alone decided, and the image was neither read nor published.
 */
describe("images and rendered tables: beside in place, inside in their cell", () => {
  const image = (id: string): IRBlock => ({ kind: "image", ref: { sha256: id, mimeType: "image/png" } });
  const glyph = (text: string, x: number, y: number) => ({
    text,
    x,
    y,
    width: 30,
    height: 8,
    isSpace: false,
    matrix: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    runId: 0,
    stroked: false,
    paintCount: 1,
  });
  // Grid: rows 700 / 650 / 600, columns 100 / 200 / 300.
  const grid = { rowBoundaries: [700, 650, 600], colBoundaries: [100, 200, 300] };
  const glyphs = [
    glyph("A", 110, 680),
    glyph("B1", 210, 688),
    glyph("B2", 210, 655),
    glyph("C", 110, 620),
    glyph("D", 210, 620),
  ];
  const cellContent = (cell: { blocks: IRBlock[] }) =>
    cell.blocks.map((b) =>
      b.kind === "paragraph" ? b.inlines[0]!.text : b.kind === "image" ? `image:${b.ref.sha256}` : b.kind,
    );
  const reads: string[] = [];
  const candidate = (id: string, top: number, bottom: number, xMin: number, xMax: number): ImageCandidate => ({
    top,
    bottom,
    xMin,
    xMax,
    read: () => {
      reads.push(id);
      return [image(id)];
    },
  });
  const render = (candidates: ImageCandidate[], merge?: MergeMap) => {
    reads.length = 0;
    return renderPageTables(
      [],
      [{ grid, ...(merge ? { merge } : {}) }],
      glyphs,
      () => false,
      () => 5,
      undefined,
      undefined,
      undefined,
      candidates,
    )!;
  };

  it("an image inside the box lands in the cell holding its centre, between the cell's lines by height", () => {
    // "mid" is centred at y 672 in cell (row 0, col 1), between B1 (688) and B2 (655);
    // "low" at y 625 in cell (row 1, col 0), under C (620 + 8 high: its top is 628).
    const blocks = render([candidate("mid", 680, 664, 250, 290), candidate("low", 640, 610, 150, 190)]);
    expect(blocks.map((b) => b.kind)).toEqual(["table"]);
    const table = blocks[0] as Extract<IRBlock, { kind: "table" }>;
    expect(table.rows.map((r) => r.cells.map(cellContent))).toEqual([
      [["A"], ["B1", "image:mid", "B2"]],
      [["image:low", "C"], ["D"]],
    ]);
  });

  it("an image covering BOTH lines of its cell is published before them (23/09/2026)", () => {
    // "tall" spans 700 → 640 in cell (row 0, col 1), so it covers B1 (688) and
    // B2 (655), one on each side of its own centre (670). Failure value, which
    // is the defect of booklet 26 page 3 in miniature: ["B1", "image:tall", "B2"].
    const table = render([candidate("tall", 700, 640, 250, 290)])[0] as Extract<IRBlock, { kind: "table" }>;
    expect(table.rows[0]!.cells.map(cellContent)).toEqual([["A"], ["image:tall", "B1", "B2"]]);
  });

  // « C » and « D » sit 100 pt apart with no space glyph: since 15/10/2026 a cell writes a space at a word gap, so « C D », not « CD ».
  it("a merged cell receives an image centred in any of the cases it covers", () => {
    const merge: MergeMap = {
      cells: [
        { row: 0, col: 0, colspan: 1, rowspan: 1 },
        { row: 0, col: 1, colspan: 1, rowspan: 1 },
        { row: 1, col: 0, colspan: 2, rowspan: 1 },
      ],
      ownerAt: [
        [0, 1],
        [2, 2],
      ],
    };
    const table = render([candidate("wide", 615, 605, 250, 290)], merge)[0] as Extract<IRBlock, { kind: "table" }>;
    expect(table.rows[1]!.cells.map(cellContent)).toEqual([["C D", "image:wide"]]);
  });

  it("a cell image and an image beside the table are both read; the one beside keeps its place", () => {
    // "beside": centre y 675 is in the table's HEIGHT, x 400 is outside its WIDTH.
    const blocks = render([candidate("inside", 690, 670, 120, 180), candidate("beside", 690, 660, 350, 450)]);
    expect(reads).toEqual(["inside", "beside"]);
    expect(blocks.filter((b) => b.kind === "image")).toEqual([image("beside")]);
  });

  it("placeImages reads every candidate it is given and drops an unreadable one", () => {
    const readable = candidate("ok", 500, 400, 72, 300);
    const unreadable: ImageCandidate = { top: 300, bottom: 200, xMin: 72, xMax: 300, read: () => undefined };
    expect(placeImages([readable, unreadable]).map((a) => a.blocks)).toEqual([[image("ok")]]);
  });
});

describe("readPageWithImages — deux colonnes et une image", () => {
  // `run(text, x, y)`: height and size 10. Column cut at 300.
  const run = (text: string, x: number, y: number) => ({ text, x, y, width: 200, height: 10, fontSize: 10 }) as never;
  const lines = (segment: { text: string }[][]): IRBlock[] =>
    segment.map((line) => ({ kind: "paragraph", inlines: [{ text: line.map((it) => it.text).join(" ") }] }));
  const labels = (blocks: IRBlock[]): string[] =>
    blocks.map((b) =>
      b.kind === "paragraph"
        ? b.inlines.map((i) => i.text).join("")
        : b.kind === "table"
          ? `table(${b.rows.flatMap((r) => r.cells.flatMap((c) => labels(c.blocks))).join(",")})`
          : "image",
    );
  const items = [
    run("G1", 72, 700),
    run("D1", 320, 700),
    run("G2", 72, 680),
    run("D2", 320, 680),
    run("D3", 320, 560),
    run("G3", 72, 400),
    run("D4", 320, 400),
    run("G4", 72, 380),
    run("D5", 320, 380),
  ];

  it("sans image, chaque colonne se lit d'un bloc", () => {
    expect(labels(readPageWithImages(items, [], planOn(300), { layout: "flow" }, lines))).toEqual([
      "G1",
      "G2",
      "G3",
      "G4",
      "D1",
      "D2",
      "D3",
      "D4",
      "D5",
    ]);
  });

  // A picture is placed by what it covers of the columns:
  //   inside its column       → in the flow of its column, at its height;
  //   wider than its column   → under the block of columns, with its caption;
  //   across the full width   → it cuts the page.
  const picture = (xMin: number, xMax: number): ImageAnchor => ({
    top: 600,
    bottom: 450,
    xMin,
    xMax,
    blocks: [{ kind: "image", ref: { sha256: "i", mimeType: "image/png" } }],
  });

  it("🔴 une image dans SA colonne reste dans le flux de sa colonne, à sa hauteur", () => {
    expect(labels(readPageWithImages(items, [picture(72, 272)], planOn(300), { layout: "flow" }, lines))).toEqual([
      "G1",
      "G2",
      "image",
      "G3",
      "G4",
      "D1",
      "D2",
      "D3",
      "D4",
      "D5",
    ]);
  });

  it("🔴 une image qui DÉPASSE sa colonne sort APRÈS le bloc de colonnes, dans une table d'une cellule à sa largeur ; les colonnes restent entières", () => {
    // The picture and its caption go in a one-column container of the picture's width, so the caption wraps under it.
    const blocks = readPageWithImages(items, [picture(200, 400)], planOn(300), { layout: "flow" }, lines);
    expect(blocks.at(-1)).toMatchObject({ kind: "table", width: "image" });
    expect(labels(blocks)).toEqual(["G1", "G2", "G3", "G4", "D1", "D2", "D3", "D4", "D5", "table(image)"]);
  });

  it("🔴 sa légende — les lignes plus petites que le corps, juste sous elle, dans sa largeur — sort avec elle, en UN paragraphe", () => {
    // Width decides: the lines of a caption fit in the picture's width and are one paragraph whatever their size (a
    // title at 8.15 pt inside an 8 pt caption used to cut it in two).
    const small = (text: string, y: number, fontSize = 7) =>
      ({ text, x: 210, y, width: 150, height: 7, fontSize }) as never;
    const page = [...items, small("cap1", 440), small("cap2", 430, 7.15)];
    expect(labels(readPageWithImages(page, [picture(200, 400)], planOn(300), { layout: "flow" }, lines))).toEqual([
      "G1",
      "G2",
      "G3",
      "G4",
      "D1",
      "D2",
      "D3",
      "D4",
      "D5",
      "table(image,cap1 cap2)",
    ]);
  });

  it("🔴 deux images débordantes empilées : la légende de la seconde n'est pas avalée par la première, aucun mot deux fois (revue 06/11/2026, point 4)", () => {
    const upper = picture(200, 400);
    const lower: ImageAnchor = {
      top: 440,
      bottom: 300,
      xMin: 205,
      xMax: 400,
      blocks: [{ kind: "image", ref: { sha256: "j", mimeType: "image/png" } }],
    };
    const capB = { text: "capB", x: 210, y: 290, width: 150, height: 7, fontSize: 7 } as never;
    const blocks = readPageWithImages([...items, capB], [upper, lower], planOn(300), { layout: "flow" }, lines);
    expect(labels(blocks).slice(-2)).toEqual(["table(image)", "table(image,capB)"]);
  });

  it("une image sur toute la largeur coupe toujours la page à sa hauteur (la médiane décide, 16/09/2026)", () => {
    expect(labels(readPageWithImages(items, [picture(60, 540)], planOn(300), { layout: "flow" }, lines))).toEqual([
      "G1",
      "G2",
      "D1",
      "D2",
      "D3",
      "image",
      "G3",
      "G4",
      "D4",
      "D5",
    ]);
  });

  it("une ancre sans bord droit connu garde l'ancien comportement : elle coupe la page", () => {
    const anchors: ImageAnchor[] = [
      { top: 600, bottom: 450, xMin: 72, blocks: [{ kind: "image", ref: { sha256: "i", mimeType: "image/png" } }] },
    ];
    expect(labels(readPageWithImages(items, anchors, planOn(300), { layout: "flow" }, lines))).toEqual([
      "G1",
      "G2",
      "D1",
      "D2",
      "D3",
      "image",
      "G3",
      "G4",
      "D4",
      "D5",
    ]);
  });
});

/**
 * AN IMAGE'S MEDIAN DECIDES THE ORDER (decision, 16/09/2026).
 *
 * One rule, six situations, no exception — and that is the point: nothing here
 * asks to guess whether a text laid on an image is its caption, a
 * watermark or an annotation.
 *
 * The case that triggered the rule is the first: on the MFA guide, the label
 * "Ecran PC" is painted 27 pt BELOW the top edge of its screenshot, and came out
 * behind the whole image.
 */
describe("readPageWithImages en `rows` — le titre qui ouvre la première cellule (constat n°9 de la revue, 06/11/2026)", () => {
  // Two columns, cut at 300: G at x 72, D at x 320, five lines each on shared baselines. A run of 14 pt is a heading, the
  // rest a paragraph (`toBlocks` below stands for the paragraph builder's size rule).
  const run = (text: string, x: number, y: number, fontSize = 10) =>
    ({ text, x, y, width: 150, height: fontSize, fontSize }) as never;
  const column = (x: number, first: string, firstSize: number, label: string) => [
    run(first, x, 700, firstSize),
    ...[680, 660, 640, 620].map((y, i) => run(`${label}${String(i + 1)}`, x, y)),
  ];
  const toBlocks = (segment: { text: string; fontSize: number }[][]): IRBlock[] =>
    segment.map((line) =>
      line[0]!.fontSize >= 14
        ? { kind: "heading", level: 2, inlines: [{ text: line.map((it) => it.text).join(" ") }] }
        : { kind: "paragraph", inlines: [{ text: line.map((it) => it.text).join(" ") }] },
    );
  const labels = (blocks: IRBlock[]): string[] =>
    blocks.map((b) =>
      "inlines" in b
        ? b.inlines.map((i) => i.text).join("")
        : b.kind === "table"
          ? `table(${b.rows.flatMap((r) => r.cells.flatMap((c) => labels(c.blocks))).join(",")})`
          : b.kind,
    );

  it("🔴 le titre dont la voisine est du TEXTE COURANT coiffe la zone : il sort au-dessus du tableau (« Programme » du bulletin Alouette)", () => {
    // No real fixture other than the bulletin has this case on a page the suite reads whole; the bulletin itself is pinned
    // by `pdf-column-tables.fixtures.test.ts` (« Programme » top level). Built here to hold the rule alone.
    const page = [...column(72, "Programme", 14, "G"), ...column(320, "Performances de slam", 10, "D")];
    expect(labels(readPageWithImages(page, [], planOn(300), { layout: "rows" }, toBlocks))).toEqual([
      "Programme",
      "table(G1,G2,G3,G4,Performances de slam,D1,D2,D3,D4)",
    ]);
  });

  it("🔴 deux colonnes qui commencent chacune par SON titre : aucun titre ne sort, la hiérarchie reste dans les cellules", () => {
    // No real fixture of the repository has two columns each opened by a heading on a shared baseline: built here (06/11/2026).
    const page = [...column(72, "Introduction", 14, "G"), ...column(320, "Results", 14, "D")];
    // Failure value (today's rule, every document): ["Introduction", "table(G1,…,Results,…)"] — « Introduction » above both columns.
    expect(labels(readPageWithImages(page, [], planOn(300), { layout: "rows" }, toBlocks))).toEqual([
      "table(Introduction,G1,G2,G3,G4,Results,D1,D2,D3,D4)",
    ]);
  });

  // THE FIGURE UNDER THE TABLE OF ITS OWN ZONE (06/11/2026, « on avait dit EN DESSOUS du tableau, pas au-dessus »): in
  // `rows`, an image that overflows its column follows the column table of the zone it belongs to, outside it, in the one-cell
  // table of 05/11 — not at the bottom of the page after every table (05/11), not a `colspan` row inside the table (refused on
  // the published page the same day: visible borders of empty cells). The `flow` tests above keep the 05/11 form.
  const grid = (table: IRBlock): string[][] =>
    (table as Extract<IRBlock, { kind: "table" }>).rows.map((r) =>
      r.cells.map((c) => `${String(c.colspan ?? 1)}:${labels(c.blocks).join(",")}`),
    );

  it("🔴 en `rows`, une image qui DÉPASSE sa colonne SUIT le tableau de sa zone, hors du tableau, avant le bloc suivant de la page", () => {
    // Columns G 72..222 and D 320..470 (cut 300), two zones one above the other: the image 100..350 overlaps the FIRST zone in
    // height and crosses the cut. Failure value (05/11 rule): the figure after BOTH tables, last on the page.
    const zone = (label: string, ys: number[]) =>
      ys.flatMap((y, i) => [
        { text: `${label}G${String(i)}`, x: 72, y, width: 150, height: 10, fontSize: 10 },
        { text: `${label}D${String(i)}`, x: 320, y, width: 150, height: 10, fontSize: 10 },
      ]) as never[];
    const page = [
      ...zone("a", [700, 680, 660, 640, 620]),
      { text: "Across the page", x: 72, y: 560, width: 400, height: 10, fontSize: 10 } as never,
      ...zone("b", [500, 480, 460, 440, 420]),
    ];
    const anchors: ImageAnchor[] = [
      {
        top: 690,
        bottom: 600,
        xMin: 100,
        xMax: 350,
        blocks: [{ kind: "image", ref: { sha256: "i", mimeType: "image/png" } }],
      },
    ];
    const blocks = readPageWithImages(page, anchors, planOn(300), { layout: "rows" }, toBlocks);
    // The second zone's form is the band reader's business (here it stays braided, five lines under the full-width one):
    // what this test pins is the figure's PLACE, between the first table and the full-width line.
    expect(labels(blocks).slice(0, 3)).toEqual([
      "table(aG0,aG1,aG2,aG3,aG4,aD0,aD1,aD2,aD3,aD4)",
      "table(image)",
      "Across the page",
    ]);
    expect(labels(blocks).slice(3).join(" ")).toContain("bG0");
    expect(blocks[1]).toMatchObject({ kind: "table", width: "image" });
    expect(grid(blocks[0]!)).toEqual([["1:aG0,aG1,aG2,aG3,aG4", "1:aD0,aD1,aD2,aD3,aD4"]]);
  });

  it("🔴 une image sur deux colonnes d'une grille de trois suit de même le tableau, la grille reste une rangée de trois", () => {
    // Cuts 150 and 300: G at 72, M at 170, D at 320 (width 60 each). Centres 101, 225, 365. The image 160..400 covers M and D.
    const narrow = (label: string, x: number) =>
      [700, 680, 660, 640, 620].map(
        (y, i) => ({ text: `${label}${String(i)}`, x, y, width: 60, height: 10, fontSize: 10 }) as never,
      );
    const page = [...narrow("G", 72), ...narrow("M", 170), ...narrow("D", 320)];
    const anchors: ImageAnchor[] = [
      {
        top: 690,
        bottom: 600,
        xMin: 160,
        xMax: 400,
        blocks: [{ kind: "image", ref: { sha256: "i", mimeType: "image/png" } }],
      },
    ];
    const blocks = readPageWithImages(page, anchors, planOn(150, 300), { layout: "rows" }, toBlocks);
    expect(labels(blocks)).toEqual(["table(G0,G1,G2,G3,G4,M0,M1,M2,M3,M4,D0,D1,D2,D3,D4)", "table(image)"]);
    expect(grid(blocks[0]!)).toEqual([["1:G0,G1,G2,G3,G4", "1:M0,M1,M2,M3,M4", "1:D0,D1,D2,D3,D4"]]);
  });
});

describe("l'ordre du texte autour d'une image se décide à sa médiane", () => {
  /** An image 100 pt high: top edge 300, bottom edge 200, median 250. */
  const image: ImageAnchor = {
    top: 300,
    bottom: 200,
    xMin: 100,
    blocks: [{ kind: "image", ref: { sha256: "abc", mimeType: "image/png" } }],
  };
  const ligne = (y: number, x = 100, text = `y${y}`) =>
    ({
      text,
      x,
      y,
      width: 40,
      height: 10,
      fontSize: 10,
      matrix: [1, 0, 0, 1, x, y],
      fontId: undefined,
      weight: "unknown",
      rotated: false,
      hasEOL: false,
      dir: "ltr",
    }) as never;
  /** The published order, as "text" or "IMAGE". */
  const ordre = (...lignes: ReturnType<typeof ligne>[]): string[] =>
    interleaveImages(lignes, [image], (items) =>
      items.map((it) => ({ kind: "paragraph" as const, inlines: [{ text: it.text }] })),
    ).map((b) => (b.kind === "image" ? "IMAGE" : "inlines" in b ? b.inlines.map((i) => i.text).join("") : b.kind));

  it("entièrement AU-DESSUS de l'image : avant", () => {
    expect(ordre(ligne(340))).toEqual(["y340", "IMAGE"]);
  });

  it("qui CHEVAUCHE le bord haut : avant", () => {
    // centre at 300 — exactly the top edge, hence above the median
    expect(ordre(ligne(295))).toEqual(["y295", "IMAGE"]);
  });

  it("POSÉ sur la moitié HAUTE : avant — c'est le cas « Ecran PC »", () => {
    // centre at 273, i.e. 27 pt below the top edge: the geometry of the MFA guide
    expect(ordre(ligne(268))).toEqual(["y268", "IMAGE"]);
  });

  it("POSÉ sur la moitié BASSE : après", () => {
    expect(ordre(ligne(220))).toEqual(["IMAGE", "y220"]);
  });

  it("qui CHEVAUCHE le bord bas : après", () => {
    expect(ordre(ligne(195))).toEqual(["IMAGE", "y195"]);
  });

  it("entièrement EN DESSOUS : après", () => {
    expect(ordre(ligne(150))).toEqual(["IMAGE", "y150"]);
  });

  it("À CÔTÉ de l'image, à droite : sa moitié décide, pas son abscisse", () => {
    expect(ordre(ligne(280, 400))).toEqual(["y280", "IMAGE"]);
    expect(ordre(ligne(220, 400))).toEqual(["IMAGE", "y220"]);
  });

  it("AUCUNE LIGNE N'EST PERDUE NI DOUBLÉE, quelle que soit sa position", () => {
    // The cursor trap: moving the boundary without moving `above` would make
    // any line laid between the old and the new threshold come out twice.
    const lignes = [340, 295, 268, 250, 220, 195, 150].map((y) => ligne(y));
    const sortie = ordre(...lignes);
    expect(sortie.filter((s) => s !== "IMAGE")).toEqual(["y340", "y295", "y268", "y250", "y220", "y195", "y150"]);
    expect(sortie.filter((s) => s === "IMAGE")).toHaveLength(1);
  });

  it("une ancre SANS hauteur connue garde l'ancien comportement — son bord haut", () => {
    const sansBas: ImageAnchor = { top: 300, xMin: 100, blocks: image.blocks };
    const rendu = interleaveImages([ligne(268)], [sansBas], (items) =>
      items.map((it) => ({ kind: "paragraph" as const, inlines: [{ text: it.text }] })),
    );
    expect(rendu.map((b) => b.kind)).toEqual(["image", "paragraph"]);
  });
});

/**
 * THE EXCEPTION TO THE MEDIAN: AN IMAGE THAT COVERS SEVERAL LINES IS NOT INSERTED
 * BETWEEN THEM (decision, 23/09/2026).
 *
 * The real case is the CEO's message of booklet 26 page 3: the photo is on the LEFT,
 * the message to its right over its whole height, and the median cut it in two.
 * Here the geometry is written by hand, so that each situation of the rule
 * is readable at a glance. The image carries a FOOTPRINT (`xMax` known): without a
 * footprint, nothing ever changes — that is the test that closes the series.
 */
describe("une image qui couvre plusieurs lignes passe avant le bloc", () => {
  /** An image 100 pt high and 100 wide: 300 → 200, 100 → 200, median 250. */
  const image: ImageAnchor = {
    top: 300,
    bottom: 200,
    xMin: 100,
    xMax: 200,
    blocks: [{ kind: "image", ref: { sha256: "abc", mimeType: "image/png" } }],
  };
  const ligne = (y: number, x = 400, text = `y${y}`) =>
    ({
      text,
      x,
      y,
      width: 40,
      height: 10,
      fontSize: 10,
      matrix: [1, 0, 0, 1, x, y],
      fontId: undefined,
      weight: "unknown",
      rotated: false,
      hasEOL: false,
      dir: "ltr",
    }) as never;
  const ordre = (...lignes: ReturnType<typeof ligne>[]): string[] =>
    interleaveImages(lignes, [image], (items) =>
      items.map((it) => ({ kind: "paragraph" as const, inlines: [{ text: it.text }] })),
    ).map((b) => (b.kind === "image" ? "IMAGE" : "inlines" in b ? b.inlines.map((i) => i.text).join("") : b.kind));

  it("deux lignes couvertes de part et d'autre de la médiane : l'image passe avant les deux", () => {
    // y280 and y220 are both WITHIN the height of the image, one on each
    // side of its median. Failure value, and it is the published defect:
    // "y280, IMAGE, y220".
    expect(ordre(ligne(280), ligne(220))).toEqual(["IMAGE", "y280", "y220"]);
  });

  it("deux lignes couvertes du MÊME côté : rien ne bouge", () => {
    // The median already reads both of them before the image: there is nothing to
    // cut. That is the shape of the labels of the MFA guide.
    expect(ordre(ligne(280), ligne(270))).toEqual(["y280", "y270", "IMAGE"]);
  });

  it("une image VRAIMENT entre deux lignes ne bouge pas", () => {
    // y340 is above the image, y150 below it: neither is covered.
    expect(ordre(ligne(340), ligne(150))).toEqual(["y340", "IMAGE", "y150"]);
  });

  it("une ligne couverte SEULE ne déclenche rien, où qu'elle soit", () => {
    expect(ordre(ligne(280))).toEqual(["y280", "IMAGE"]);
    expect(ordre(ligne(220))).toEqual(["IMAGE", "y220"]);
  });

  it("AUCUNE LIGNE N'EST PERDUE NI DOUBLÉE quand la frontière remonte au bord haut", () => {
    // The cursor trap: the boundary goes up, `above` does not, so
    // the skipped lines must come out right after the image — measured lost
    // on fixtures 24 p7 and 26 p8 before this fix.
    const lignes = [340, 295, 280, 220, 195, 150].map((y) => ligne(y));
    const sortie = ordre(...lignes);
    expect(sortie.filter((s) => s !== "IMAGE")).toEqual(["y340", "y295", "y280", "y220", "y195", "y150"]);
    expect(sortie.filter((s) => s === "IMAGE")).toHaveLength(1);
  });

  it("SANS EMPRISE connue, la médiane décide encore — l'ancienne règle, mot pour mot", () => {
    const sansEmprise: ImageAnchor = { top: 300, bottom: 200, xMin: 100, blocks: image.blocks };
    const rendu = interleaveImages([ligne(280), ligne(220)], [sansEmprise], (items) =>
      items.map((it) => ({ kind: "paragraph" as const, inlines: [{ text: it.text }] })),
    );
    expect(
      rendu.map((b) =>
        b.kind === "image" ? "IMAGE" : "inlines" in b ? b.inlines.map((i) => i.text).join("") : b.kind,
      ),
    ).toEqual(["y280", "IMAGE", "y220"]);
  });
});

/** 🔴 THE REAL DOCUMENT THAT REVEALED THE REGRESSION OF ENCRYPTED PDFs (17/09/2026).
 *
 *  `pdf-lib` opens the image stream only on the strength of the dictionary, and does not
 *  decrypt. `pdf-embedded-images.ts` therefore now abstains when the
 *  bytes ARE NOT what they announce. This abstention must not cost
 *  the image: our reader (`pdf-decrypt.ts`) decrypts, so the image is re-read identically. (Before pdf.js was removed,
 *  it was the one that decrypted, and its pixels already served the QR codes, no longer decoded since 06/10/2026.)
 *  The witness here is the made-up encrypted document (`fixtures/pdf/59-Document-Chiffre-RC4.pdf`, a JPEG and a
 *  deflated square); the real one is held by the application's tests. */
describe("un PDF chiffré (document fabriqué)", () => {
  it("🔴 son image est publiée, et ses octets sont une VRAIE image", async () => {
    const { images } = await extractPdf(encryptedPdf());
    const publiables = (images ?? []).filter((i) => !i.selfDescribed);
    expect(publiables.length, "the image of the encrypted document must be published, not dropped").toBeGreaterThan(0);
    for (const img of publiables) {
      const tete = Buffer.from(img.bytes.slice(0, 4)).toString("hex");
      const vraie = tete.startsWith("ffd8ff") || tete === "89504e47";
      expect(vraie, `octets illisibles pour ${img.mimeType} : ${tete}`).toBe(true);
    }
  });
});

/**
 * 🔴 AN IMAGE WITH NO TEXT AT ITS HEIGHT BELONGS TO NO COLUMN (10/11/2026, auction catalogue `sd-1026348`, on the
 * published page: « tateward auctions, le titre, se retrouve en bas de page, pourquoi ? »). The logo heads every page,
 * x 197..396 across the cut 297, y 760..814 above all the text (whose top is 723). Crossing the cut without covering both
 * columns, it was an « overflowing » figure, belonged to no zone, and was published last on the page.
 */
describe("readPageWithImages — an image above every line of text", () => {
  const run = (text: string, x: number, y: number, width = 150) =>
    ({ text, x, y, width, height: 10, fontSize: 10 }) as never;
  const toBlocks = (segment: { text: string }[][]): IRBlock[] =>
    segment.map((line) => ({ kind: "paragraph", inlines: [{ text: line.map((it) => it.text).join(" ") }] }));
  const labels = (blocks: IRBlock[]): string[] =>
    blocks.map((b) =>
      "inlines" in b
        ? b.inlines.map((i) => i.text).join("")
        : b.kind === "table"
          ? `table(${b.rows.flatMap((r) => r.cells.flatMap((c) => labels(c.blocks))).join(",")})`
          : b.kind,
    );
  const page = [
    run("Fine Wine & Spirits", 150, 723, 300),
    ...[700, 680, 660, 640, 620].flatMap((y, i) => [run(`G${String(i)}`, 65, y), run(`D${String(i)}`, 349, y)]),
  ];
  const logo: ImageAnchor = {
    top: 814,
    bottom: 760,
    xMin: 197,
    xMax: 396,
    blocks: [{ kind: "image", ref: { sha256: "logo", mimeType: "image/png" } }],
  };

  it("🔴 the logo comes first, at its height, before the title", () => {
    const blocks = readPageWithImages(page, [logo], planOn(297), { layout: "rows" }, toBlocks);
    expect(labels(blocks)[0]).toBe("image");
    expect(labels(blocks)[1]).toBe("Fine Wine & Spirits");
  });
});
