import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PDFDocument, StandardFonts, rgb } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";

import { detectPdfPageSignals, detectPdfTableGrids, detectPdfTableOrigins, walkPage } from "./pdf-table-detector";
import { extractPdf } from "./pdf";
import { applyMatrix, composeMatrix, subpathsToSegments, IDENTITY_MATRIX } from "../layout/geometry";
import { decodePathSubpaths } from "./pdf-ops";

const here = dirname(fileURLToPath(import.meta.url));

describe("composeMatrix/applyMatrix", () => {
  it("identity composed with identity is identity", () => {
    expect(composeMatrix(IDENTITY_MATRIX, IDENTITY_MATRIX)).toEqual(IDENTITY_MATRIX);
  });

  it("a translate composed with a later scale matches manual point transformation (calibrated 04/09/2026 against a real nested transform in pdf.js's own operator list — see module doc)", () => {
    const translate = { a: 1, b: 0, c: 0, d: 1, e: 100, f: 200 };
    const scale = { a: 2, b: 0, c: 0, d: 3, e: 0, f: 0 };
    const ctm = composeMatrix(scale, translate);
    expect(ctm).toEqual({ a: 2, b: 0, c: 0, d: 3, e: 100, f: 200 });
    expect(applyMatrix(ctm, 10, 10)).toEqual({ x: 120, y: 230 });
    expect(applyMatrix(ctm, 30, 15)).toEqual({ x: 160, y: 245 });
  });
});

/** The one case that links the path decoder to the detector: the closing side, without which a whole frame vanished
 *  unreported. */
describe("decodePathSubpaths → subpathsToSegments", () => {
  it("un rectangle fermé rend ses QUATRE côtés, pas trois (régression du 11/09/2026 : le côté de fermeture était perdu, et avec lui tout encadrement dessiné une seule fois)", () => {
    const packed = [0, 0, 0, 1, 0, 100, 1, 200, 100, 1, 200, 0, 4];
    const segments = subpathsToSegments(decodePathSubpaths(packed), IDENTITY_MATRIX);
    expect(segments).toHaveLength(4);
    const closing = segments[3]!;
    expect({ x1: closing.x1, y1: closing.y1, x2: closing.x2, y2: closing.y2 }).toEqual({
      x1: 200,
      y1: 0,
      x2: 0,
      y2: 0,
    });
    // Both verticals are there: a grid needs two.
    expect(segments.filter((s) => s.x1 === s.x2)).toHaveLength(2);
  });
});

async function makePdfWithVectorGrid(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  // A real 2x2 grid: 3 horizontal + 3 vertical borders, drawn as individual lines (the common case for
  // table-generating PDF producers — one stroked line per grid line, not one complex multi-subpath object).
  const ys = [300, 250, 200];
  const xs = [50, 150, 250];
  for (const y of ys) page.drawLine({ start: { x: 50, y }, end: { x: 250, y }, thickness: 1, color: rgb(0, 0, 0) });
  for (const x of xs) page.drawLine({ start: { x, y: 200 }, end: { x, y: 300 }, thickness: 1, color: rgb(0, 0, 0) });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("A", { x: 60, y: 270, size: 10, font });
  page.drawText("B", { x: 160, y: 270, size: 10, font });
  page.drawText("C", { x: 60, y: 220, size: 10, font });
  page.drawText("D", { x: 160, y: 220, size: 10, font });
  return doc.save();
}

async function makePdfWithAlignedColumnsOnly(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  // No lines at all — 2 columns of text recurring at the same x across several lines (the borderless case).
  const rows: [string, string][] = [
    ["Matière", "Note"],
    ["Français", "14"],
    ["Maths", "16"],
    ["Histoire", "12"],
  ];
  let y = 300;
  for (const [left, right] of rows) {
    page.drawText(left, { x: 50, y, size: 10, font });
    page.drawText(right, { x: 200, y, size: 10, font });
    y -= 20;
  }
  return doc.save();
}

async function makePdfWithPlainProseOnly(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("The quick brown fox jumps", { x: 50, y: 300, size: 10, font });
  page.drawText("over the lazy dog near the", { x: 55, y: 280, size: 10, font });
  page.drawText("river bank at dawn today", { x: 48, y: 260, size: 10, font });
  return doc.save();
}

// No borders, no clean recurring column (each row's second value starts at
// a different x — a table whose column alignment is genuinely irregular,
// e.g. a badly-kerned PDF export), but a real wide gap recurs across rows —
// exactly the "probably a table, unparseable" case §8's correction insists
// must stay visible as `no-grid`, not be silently skipped like plain prose.
async function makePdfWithUnalignedTableRows(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const rows: [string, string, number][] = [
    ["Matière", "16,25", 200],
    ["Français", "14,50", 230],
    ["Histoire", "12,00", 210],
  ];
  let y = 300;
  for (const [left, right, rightX] of rows) {
    page.drawText(left, { x: 50, y, size: 10, font });
    page.drawText(right, { x: rightX, y, size: 10, font });
    y -= 20;
  }
  return doc.save();
}

describe("detectPdfTableOrigins (real synthetic PDFs, pdf-lib — never derived from real customer content)", () => {
  it("classifies a page with a real drawn grid as vector-borders", async () => {
    const bytes = await makePdfWithVectorGrid();
    expect(await detectPdfTableOrigins(bytes)).toEqual([{ pageIndex: 0, origin: "vector-borders" }]);
  });

  it("classifies a page with aligned-but-borderless columns as alignment-no-borders", async () => {
    const bytes = await makePdfWithAlignedColumnsOnly();
    expect(await detectPdfTableOrigins(bytes)).toEqual([{ pageIndex: 0, origin: "alignment-no-borders" }]);
  });

  it("reports NOTHING for ordinary prose — neither borders, nor alignment, nor even a weak tabularity signal", async () => {
    const bytes = await makePdfWithPlainProseOnly();
    expect(await detectPdfTableOrigins(bytes)).toEqual([]);
  });

  it("classifies an unparseable table (no borders, no clean recurring column, but a real gap pattern) as no-grid — never silently skipped like prose (§8, correction 04/09/2026)", async () => {
    const bytes = await makePdfWithUnalignedTableRows();
    expect(await detectPdfTableOrigins(bytes)).toEqual([{ pageIndex: 0, origin: "no-grid" }]);
  });

  it("reports one origin per page, independently, for a multi-page PDF — and NO entry at all for a plain-prose page", async () => {
    const gridDoc = await PDFDocument.load(await makePdfWithVectorGrid());
    const proseDoc = await PDFDocument.load(await makePdfWithPlainProseOnly());
    const combined = await PDFDocument.create();
    const [gridPage] = await combined.copyPages(gridDoc, [0]);
    const [prosePage] = await combined.copyPages(proseDoc, [0]);
    combined.addPage(gridPage);
    combined.addPage(prosePage);
    const bytes = await combined.save();
    expect(await detectPdfTableOrigins(bytes)).toEqual([{ pageIndex: 0, origin: "vector-borders" }]);
  });
});

// A title line before the table and a footer line after — the real shape
// §8 jalon 2's régime 1 rendering needs to isolate from surrounding prose
// (mirrors the result measured on real school reports: alignment-no-borders,
// page content isn't 100% table).
/** It carries two line rhythms on purpose: the borderless path builds no grid without a repeated second rhythm
 *  (`hasRepeatedSecondRhythm`). Rows of one line, evenly spaced, would be indistinguishable from two text columns;
 *  hence two-line cells (leading 12) and a separation between rows (20). */
async function makePdfWithProseAndAlignedTable(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Bulletin Trimestre 1", { x: 50, y: 360, size: 12, font });

  const LEADING = 12;
  const ROW_GAP = 20;
  /** One row is several lines, each with its two cells. */
  const rows: [string, string][][] = [
    [
      ["Matière", "Note"],
      ["évaluée", "sur vingt"],
    ],
    [
      ["Français", "14"],
      ["écrit", "puis oral"],
    ],
    [
      ["Maths", "16"],
      ["algèbre", "et analyse"],
    ],
    [
      ["Histoire", "12"],
      ["moderne", "et récente"],
    ],
  ];
  let y = 320;
  for (const row of rows) {
    for (const [left, right] of row) {
      page.drawText(left, { x: 50, y, size: 10, font });
      page.drawText(right, { x: 200, y, size: 10, font });
      y -= LEADING;
    }
    y -= ROW_GAP - LEADING;
  }
  page.drawText("Fin du document", { x: 50, y: 180, size: 10, font });
  return doc.save();
}

describe("detectPdfTableGrids (§8 jalon 2 — the richer result régime 1 rendering needs, alongside jalon 1's own origin signal)", () => {
  it("builds a grid straight from the vector-drawn lines, no lineRange needed (its own bounds already delimit the table)", async () => {
    const bytes = await makePdfWithVectorGrid();
    const [result] = await detectPdfTableGrids(bytes);
    expect(result?.origin).toBe("vector-borders");
    expect(result?.grid).toEqual({ rowBoundaries: [300, 250, 200], colBoundaries: [50, 150, 250] });
    expect(result?.lineRange).toBeUndefined();
  });

  /** A grid built on aligned rows sets one boundary per visual line, not per logical row: a two-line cell became two
   *  rows, and the renderer refused the grid on conservation. The detector applies the same rule upstream, so it no
   *  longer announces a grid nothing can render. */
  it("le cas aligné sans bordure n'annonce plus une grille que le rendu refuserait", async () => {
    const bytes = await makePdfWithProseAndAlignedTable();
    const [result] = await detectPdfTableGrids(bytes);
    expect(result?.origin).toBe("alignment-no-borders"); // the alignment is real, and still reported
    expect(result?.grid).toBeUndefined(); // but its cells do not hold its content
    expect(result?.lineRange).toBeUndefined();
  });

  it("reports no-grid with neither grid nor lineRange for an unparseable table", async () => {
    const bytes = await makePdfWithUnalignedTableRows();
    const [result] = await detectPdfTableGrids(bytes);
    expect(result?.origin).toBe("no-grid");
    expect(result?.grid).toBeUndefined();
    expect(result?.lineRange).toBeUndefined();
  });

  it("stays consistent with detectPdfTableOrigins's own projection of the same pages", async () => {
    const bytes = await makePdfWithProseAndAlignedTable();
    const grids = await detectPdfTableGrids(bytes);
    const origins = await detectPdfTableOrigins(bytes);
    expect(origins).toEqual(grids.map(({ pageIndex, origin }) => ({ pageIndex, origin })));
  });
});

/** The page geometry of a real school report, without its content: a change of `mergeCollinear` once lost two columns
 *  of a real table while every test stayed green. It exercises page geometry only, nothing of text composition. */
async function makePdfWithFramedHeaderBlock(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const black = rgb(0, 0, 0);

  // Page 1: page frame, framed header block, table. The three share one left margin, x = 28.3: that is the difficulty.
  const p1 = doc.addPage([595, 842]);
  p1.drawRectangle({ x: 28.3, y: 42.1, width: 539.9, height: 768.8, borderWidth: 0.5, borderColor: black });
  p1.drawRectangle({ x: 28.3, y: 740.0, width: 212.5, height: 70.9, borderWidth: 0.5, borderColor: black });

  // Two text blocks side by side at the same heights, one inside the frame, the other to its right.
  for (const [i, y] of [790, 772, 754].entries()) {
    p1.drawText(`Gauche ${i}`, { x: 40, y, size: 9, font });
    p1.drawText(`Droite ${i}`, { x: 300, y, size: 9, font });
  }
  // A straddling line whose right half is misaligned with its column edge (270 against 300). It must stay whole in
  // the two columns: the transverse rule could cut it in two places.
  p1.drawText("Gauche decale", { x: 40, y: 746, size: 9, font });
  p1.drawText("Droite decale", { x: 270, y: 746, size: 9, font });
  // A real transverse line: right of the cut, but starting before the edge of the right column.
  p1.drawText("Mention sous les deux blocs", { x: 258, y: 726, size: 8, font });

  // The table: borders painted cell by cell, one path per edge. Five inner verticals make the table's vote win over
  // the page frame, whose two edges share the table's outer abscissas.
  const cols = [28.3, 123.3, 141.7, 166.1, 184.5, 202.8, 567];
  const rows = [706.5, 606.5, 506.5, 406.5, 305.4];
  for (let r = 0; r + 1 < rows.length; r++) {
    for (let c = 0; c + 1 < cols.length; c++) {
      const [x0, x1] = [cols[c]!, cols[c + 1]!];
      const [y0, y1] = [rows[r + 1]!, rows[r]!];
      p1.drawLine({ start: { x: x0, y: y0 }, end: { x: x0, y: y1 }, thickness: 0.5, color: black });
      p1.drawLine({ start: { x: x1, y: y0 }, end: { x: x1, y: y1 }, thickness: 0.5, color: black });
      p1.drawLine({ start: { x: x0, y: y0 }, end: { x: x1, y: y0 }, thickness: 0.5, color: black });
      p1.drawLine({ start: { x: x0, y: y1 }, end: { x: x1, y: y1 }, thickness: 0.5, color: black });
      p1.drawText("x", { x: x0 + 2, y: y0 + 8, size: 8, font });
    }
  }

  // Page 2: a column separator painted in two pieces 2.4 pt apart.
  const p2 = doc.addPage([595, 842]);
  for (const y of [700, 600, 500])
    p2.drawLine({ start: { x: 50, y }, end: { x: 550, y }, thickness: 0.5, color: black });
  for (const x of [50, 550]) p2.drawLine({ start: { x, y: 500 }, end: { x, y: 700 }, thickness: 0.5, color: black });
  p2.drawLine({ start: { x: 300, y: 500 }, end: { x: 300, y: 597.6 }, thickness: 0.5, color: black });
  p2.drawLine({ start: { x: 300, y: 600 }, end: { x: 300, y: 700 }, thickness: 0.5, color: black });
  for (const y of [670, 570]) for (const x of [60, 310]) p2.drawText("x", { x, y, size: 9, font });

  return doc.save();
}

describe("géométrie d'un bulletin réel (fixture de non-régression du 11/09/2026)", () => {
  it("page 1 : le tableau garde EXACTEMENT ses lignes et ses colonnes malgré le cadre de page à la même marge", async () => {
    const grids = await detectPdfTableGrids(await makePdfWithFramedHeaderBlock());
    const page1 = grids.find((g) => g.pageIndex === 0);
    expect(page1?.origin).toBe("vector-borders");
    // 7 column boundaries, 5 row boundaries: an over-eager merge lowers these numbers and no other test sees it.
    expect(page1?.grid?.colBoundaries).toHaveLength(7);
    expect(page1?.grid?.rowBoundaries).toHaveLength(5);
  });

  it("page 2 : un séparateur peint en deux morceaux distants de 2,4 pt reste UNE colonne", async () => {
    const grids = await detectPdfTableGrids(await makePdfWithFramedHeaderBlock());
    const page2 = grids.find((g) => g.pageIndex === 1);
    expect(page2?.origin).toBe("vector-borders");
    expect(page2?.grid?.colBoundaries).toHaveLength(3); // 2 colonnes, le morcelé compris
  });

  it("DÉFAUT CONNU, VERROUILLÉ : l'encadré d'en-tête n'est PAS retenu comme région", async () => {
    const grids = await detectPdfTableGrids(await makePdfWithFramedHeaderBlock());
    const page1 = grids.find((g) => g.pageIndex === 0);
    // The frame's left edge shares its abscissa with the table's and the page frame's. `mergeCollinear` takes their
    // union, so the frame loses its own extent and is not rendered; its text stays. Accepted defect (replacing the
    // merge by intersections was tried and set aside): this test keeps it visible.
    const framed = (page1?.regions ?? []).filter((r) => {
      const rows = r.grid.rowBoundaries;
      return Math.max(...rows) > 730 && Math.min(...rows) > 700;
    });
    expect(framed).toHaveLength(0);
  });
});

describe("la bande haute se relit en deux blocs (11/09/2026)", () => {
  it("le détecteur rend une coupe BORNÉE au haut de la grille, tirée du bord peint de l'encadré", async () => {
    const signals = await detectPdfPageSignals(await makePdfWithFramedHeaderBlock());
    const cut = signals.columnCuts.find((c) => c.pageIndex === 0);
    expect(cut).toBeDefined();
    // The frame's right edge, not an inferred gutter.
    expect(cut?.cut).toBeCloseTo(240.8, 0);
    // Bounded: below the grid the table's lines have text on both sides of this abscissa, and the column zone would
    // swallow the table.
    expect(cut?.above).toBeCloseTo(706.5, 0);
  });

  it("les deux blocs sortent CÔTE À CÔTE, au lieu d'être tressés ligne à ligne", async () => {
    const { pages } = await extractPdf(await makePdfWithFramedHeaderBlock());
    const columns = (pages[0] ?? []).find((b) => b.kind === "columns");
    expect(columns).toBeDefined();
    if (columns?.kind !== "columns") throw new Error("bloc colonnes attendu");

    const cellText = (i: number): string =>
      (columns.cells[i] ?? [])
        .map((b) => (b.kind === "paragraph" ? b.inlines.map((x) => x.text).join("") : ""))
        .join(" ");
    // Avant : un seul flux, « Gauche 0 Droite 0 Gauche 1 Droite 1 ... ».
    expect(cellText(0)).toContain("Gauche 0");
    expect(cellText(0)).toContain("Gauche 2");
    expect(cellText(0)).not.toContain("Droite");
    expect(cellText(1)).toContain("Droite 0");
    expect(cellText(1)).toContain("Droite 2");
    expect(cellText(1)).not.toContain("Gauche");
  });

  it("une ligne à cheval MAL ALIGNÉE avec sa colonne reste entière, elle n'est pas coupée en deux endroits", async () => {
    const { pages } = await extractPdf(await makePdfWithFramedHeaderBlock());
    const page = pages[0] ?? [];
    const columns = page.find((b) => b.kind === "columns");
    if (columns?.kind !== "columns") throw new Error("bloc colonnes attendu");
    const cellText = (i: number): string =>
      (columns.cells[i] ?? [])
        .map((b) => (b.kind === "paragraph" || b.kind === "heading" ? b.inlines.map((x) => x.text).join("") : ""))
        .join(" ");

    expect(cellText(0)).toContain("Gauche decale");
    expect(cellText(1)).toContain("Droite decale");
    // And nowhere else: nothing leaked under the blocks.
    const after = page
      .filter((b) => b.kind === "paragraph" || b.kind === "heading")
      .map((b) => (b.kind === "paragraph" || b.kind === "heading" ? b.inlines.map((x) => x.text).join("") : ""))
      .join(" | ");
    expect(after).not.toContain("decale");
  });

  it("une ligne qui ne commence PAS au bord de sa colonne sort sous les deux blocs", async () => {
    const { pages } = await extractPdf(await makePdfWithFramedHeaderBlock());
    const page = pages[0] ?? [];
    const columns = page.find((b) => b.kind === "columns");
    if (columns?.kind !== "columns") throw new Error("bloc colonnes attendu");
    const inCells = columns.cells
      .flat()
      .map((b) => (b.kind === "paragraph" || b.kind === "heading" ? b.inlines.map((x) => x.text).join("") : ""))
      .join(" ");
    expect(inCells).not.toContain("Mention sous les deux blocs");

    const idxColumns = page.indexOf(columns);
    const after = page
      .slice(idxColumns + 1)
      .map((b) => (b.kind === "paragraph" || b.kind === "heading" ? b.inlines.map((x) => x.text).join("") : ""))
      .join(" | ");
    expect(after).toContain("Mention sous les deux blocs");
  });
});

describe("la conservation décide AVANT la détection, pas au rendu (14/09/2026)", () => {
  /** A grid whose text cycles do not fit its cells is no grid. The renderer refused it already, but too late: the
   *  band existed, and heading detection abstained because the prose left outside it no longer stood for the
   *  document. The reading is independent of the one that built the grid (one groups left edges, the other counts
   *  cycles against cells): a second opinion, not a stricter threshold. Zero tolerance needs no calibration: the
   *  grids measured hold either no ambiguous cycle or about half of them. */
  it("15-Facture : aucune grille n'est produite — les cycles ne tiennent pas dedans", async () => {
    const bytes = new Uint8Array(readFileSync(join(here, "../../fixtures/pdf/15-Facture-Libelle-Valeur.pdf")));
    const signals = await detectPdfPageSignals(bytes);
    for (const g of signals.grids) expect(g.grid, `page ${g.pageIndex}`).toBeUndefined();
  });

  it("05a-Rapport : la grille bordée est conservée — ses cycles tiennent", async () => {
    const bytes = new Uint8Array(readFileSync(join(here, "../../fixtures/pdf/05a-Rapport-Annuel-Digital.pdf")));
    const signals = await detectPdfPageSignals(bytes);
    const avecGrille = signals.grids.filter((g) => g.grid !== undefined);
    expect(avecGrille).toHaveLength(1);
    expect(avecGrille[0]!.grid!.rowBoundaries.length - 1).toBe(4);
  });
});

/** The fill colour follows `save`/`restore`. On fixture 24, page 1, a frame is filled white, red text is set inside a
 *  `save`…`restore`, then the next frame is filled with no new colour, hence white: a colour never popped published
 *  it red. */
describe("walkPage — la couleur de remplissage fait partie de l'état graphique", () => {
  const rect = (x: number, y: number) => ({
    op: "constructPath",
    args: {
      paintOp: 23,
      paint: "eoFill",
      subpaths: [
        [
          { x, y },
          { x: x + 80, y },
          { x: x + 80, y: y + 27 },
          { x, y: y + 27 },
        ],
      ],
    },
  });

  it("une couleur posée dans un save/restore ne survit pas au restore", () => {
    const { filled } = walkPage(
      [
        { op: "setFillRGBColor", args: ["#ffffff"] },
        rect(89, 268),
        { op: "save", args: null },
        { op: "setFillRGBColor", args: ["#ff0000"] },
        { op: "restore", args: null },
        rect(380, 221),
      ],
      595,
      842,
    );
    expect(filled.map((f) => f.color)).toEqual(["#ffffff", "#ffffff"]);
  });
});

/**
 * A FILL PAINTED AT ZERO FILL OPACITY LEAVES NO INK (lot « 33 », 22/09/2026).
 * Canva ends every page of fixture 26 with `/gs2 gs` (`ca 0`) and one invisible
 * rectangle per tagged figure, in the initial colour, black: published as black panels.
 */
describe("walkPage — a fill at ca 0 is no fill", () => {
  const rect = (x: number, y: number) => ({
    op: "constructPath",
    args: {
      paintOp: 23,
      paint: "fill",
      subpaths: [
        [
          { x, y },
          { x: x + 80, y },
          { x: x + 80, y: y + 27 },
          { x, y: y + 27 },
        ],
      ],
    },
  });

  it("a rectangle filled under ca 0 records no fill; ca comes back with restore", () => {
    const { filled } = walkPage(
      [
        { op: "save", args: null },
        { op: "setGState", args: [[["ca", 0]]] },
        rect(51, 278),
        { op: "restore", args: null },
        rect(200, 400),
      ],
      595,
      842,
    );
    expect(filled.map((f) => f.xMin)).toEqual([200]);
  });

  it("a partial opacity still records the fill: only exactly 0 is decided", () => {
    const { filled } = walkPage([{ op: "setGState", args: [[["ca", 0.5]]] }, rect(51, 278)], 595, 842);
    expect(filled).toHaveLength(1);
  });
});

/**
 * A two-column page of prose that also carries a DIAGRAM of two separate boxes (rule R1 rejects the box region). The
 * rejection used to end the page's examination (`no-grid`, then `continue`), so the gutter stage never ran: the columns
 * were read side by side and their sentences interleaved (01/10/2026 review). Same for the « OFFICIAL » banner pages whose
 * frame region comes out as a one-cell table: see the written limit at the detector.
 */
async function makePdfWithTwoColumnProseAndTwoBoxes(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 500]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawRectangle({ x: 50, y: 440, width: 100, height: 40, borderWidth: 1, borderColor: rgb(0, 0, 0) });
  page.drawRectangle({ x: 250, y: 440, width: 100, height: 40, borderWidth: 1, borderColor: rgb(0, 0, 0) });
  const left = "and then the old river carried every small boat down past the quiet mill";
  const right = "while the farmers counted what the long dry summer had left in the barns";
  for (let i = 0; i < 20; i++) {
    page.drawText(`${left} ${i}`.slice(0, 40), { x: 30, y: 420 - i * 12, size: 8, font });
    page.drawText(`${right} ${i}`.slice(0, 40), { x: 230, y: 420 - i * 12, size: 8, font });
  }
  return doc.save();
}

describe("a page whose vector regions are all rejected still gets its column cut", () => {
  it("cuts a dense two-column page that holds a diagram of two separate boxes", async () => {
    const signals = await detectPdfPageSignals(await makePdfWithTwoColumnProseAndTwoBoxes());
    expect(signals.grids.find((g) => g.pageIndex === 0)?.origin).toBe("no-grid");
    const cut = signals.columnCuts.find((c) => c.pageIndex === 0);
    expect(cut).toBeDefined();
    expect(cut!.cut).toBeGreaterThan(150);
    expect(cut!.cut).toBeLessThan(250);
  });
});
