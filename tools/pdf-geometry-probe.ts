/**
 * pdf-geometry-probe — measuring probe for the painted geometry of a table.
 *
 * It reads a local PDF and prints geometry and counts only: no decision, no
 * rendering, no document content beyond the string the caller asks to count.
 *
 * It answers two questions about a table header on two levels:
 *
 *  1. can a partial horizontal be admitted as a row boundary? Both ends
 *     snapping to column boundaries is not enough alone (the bar of a chart, a
 *     coloured cell background), hence the rule thickness shown beside it;
 *  2. is the label of a vertically merged cell painted once, or once per row it
 *     covers?
 *
 * It calls the real functions of `src/layout/geometry`, never a
 * reimplementation: a probe that measures something other than the measured
 * code proves nothing.
 *
 *   npx tsx tools/pdf-geometry-probe.ts <file.pdf> [--page=N] [--needle=text]
 *                                       [--snap=2] [--max=200]
 *
 * `--page` is 1-based; without it every page is probed.
 * `--snap` is the snapping tolerance shown, in PDF points.
 *
 * From the monorepo root the path is `packages/reader/tools/pdf-geometry-probe.ts`.
 */

import { readFileSync } from "node:fs";

import { buildGlyphFragments, type GlyphFragment } from "../src/extractor/glyph-positions";
import { type PdfOp, type PdfPathArg } from "../src/extractor/pdf-ops";
import { readPdfSource } from "../src/extractor/pdf-source";
import {
  applyMatrix,
  buildGridFromVectorLines,
  classifyLineSegment,
  clusterPositions,
  composeMatrix,
  subpathsToSegments,
  IDENTITY_MATRIX,
  type ClassifiedLine,
  type Matrix2D,
  type TableGrid,
} from "../src/layout/geometry";

/** Default snapping tolerance. Starting value to calibrate: it is what this
 *  probe serves to establish, not what it assumes. */
const DEFAULT_SNAP_TOLERANCE = 2;

/** Coverage below which a horizontal is listed as partial. */
const CURRENT_MIN_SPAN_COVERAGE = 0.6;

type PaintKind = "stroke" | "fill" | "fill+stroke";

interface PaintedPath {
  paint: PaintKind;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  /** Stroke width of the graphics state, scaled by the CTM. A fill has none:
   *  its thickness is that of its box. */
  strokeWidth: number;
}

interface GraphicsState {
  matrix: Matrix2D;
  lineWidth: number;
}

/** A classified segment, with its provenance.
 *
 *  A filled rectangle is reduced to its four edges, so a cell background
 *  reaches the detector as two thin horizontals, no different from a rule.
 *  Thickness cannot be read on the segment: it lives only in the path the
 *  segment comes from. */
interface SourcedLine {
  line: ClassifiedLine;
  paint: PaintKind;
  /** Height of the source path's box: the stroke width for a stroked rule, the
   *  rectangle's height for the edge of a filled rectangle. This is what tells
   *  a background from a separator. */
  sourceHeight: number;
}

const n1 = (v: number): string => v.toFixed(1);
const pct = (v: number): string => `${(v * 100).toFixed(0)}%`;

/** The painted paths of a page, with their bounding box in page space, and the
 *  straight segments the detector derives from them. One walk for both: the
 *  probe must see exactly what the table detector sees. */
function walkPaintedPaths(ops: readonly PdfOp[]): { paths: PaintedPath[]; segments: SourcedLine[] } {
  const strokeOps = new Set(["stroke", "closeStroke"]);
  const fillOps = new Set(["fill", "eoFill"]);
  const bothOps = new Set(["fillStroke", "eoFillStroke", "closeFillStroke", "closeEOFillStroke"]);

  const paths: PaintedPath[] = [];
  const segments: SourcedLine[] = [];
  const stack: GraphicsState[] = [{ matrix: IDENTITY_MATRIX, lineWidth: 1 }];

  for (const { op, args } of ops) {
    const top = stack[stack.length - 1]!;

    if (op === "save") {
      stack.push({ ...top });
    } else if (op === "restore") {
      if (stack.length > 1) stack.pop();
    } else if (op === "transform") {
      top.matrix = composeMatrix(args as Matrix2D, top.matrix);
    } else if (op === "setLineWidth") {
      top.lineWidth = (args as number[])[0] ?? top.lineWidth;
    } else if (op === "constructPath") {
      const { paint: paintOp, subpaths } = args as PdfPathArg;
      const paint: PaintKind | undefined =
        paintOp === undefined
          ? undefined
          : strokeOps.has(paintOp)
            ? "stroke"
            : fillOps.has(paintOp)
              ? "fill"
              : bothOps.has(paintOp)
                ? "fill+stroke"
                : undefined;
      if (paint === undefined) continue;

      const points = subpaths.flat().map((p) => applyMatrix(top.matrix, p.x, p.y));
      if (points.length === 0) continue;

      const { a, b, c, d } = top.matrix;
      const scale = Math.sqrt(Math.abs(a * d - b * c));
      const yMin = Math.min(...points.map((p) => p.y));
      const yMax = Math.max(...points.map((p) => p.y));
      const strokeWidth = paint === "fill" ? 0 : top.lineWidth * scale;
      paths.push({
        paint,
        xMin: Math.min(...points.map((p) => p.x)),
        xMax: Math.max(...points.map((p) => p.x)),
        yMin,
        yMax,
        strokeWidth,
      });

      const sourceHeight = paint === "stroke" ? strokeWidth : yMax - yMin;
      for (const seg of subpathsToSegments(subpaths, top.matrix)) {
        const classified = classifyLineSegment(seg);
        if (classified !== undefined) segments.push({ line: classified, paint, sourceHeight });
      }
    }
  }
  return { paths, segments };
}

/** Distance to the nearest boundary, and whether it falls within the tolerance. */
function snap(value: number, boundaries: readonly number[], tolerance: number): string {
  let best = boundaries[0];
  if (best === undefined) return "aucune frontiere";
  for (const b of boundaries) if (Math.abs(b - value) < Math.abs(best - value)) best = b;
  const distance = Math.abs(best - value);
  return `${distance <= tolerance ? "ok" : "--"} ${n1(best)} (d=${n1(distance)})`;
}

/** The visual lines, keeping the glyphs as they are, hence their `paintCount`,
 *  which a grouping into fragments would flatten. Same ordinate, same line. */
function visualLines(glyphs: readonly GlyphFragment[]): GlyphFragment[][] {
  const sorted = [...glyphs].sort((p, q) => q.y - p.y || p.x - q.x);
  const lines: GlyphFragment[][] = [];
  for (const g of sorted) {
    const current = lines[lines.length - 1];
    if (current !== undefined && Math.abs(current[0]!.y - g.y) <= 1) current.push(g);
    else lines.push([g]);
  }
  return lines.map((line) => [...line].sort((p, q) => p.x - q.x));
}

interface NeedleHit {
  box: string;
  paints: string;
  runIds: string;
}

/** Each occurrence of `needle` in a visual line, with its bounding box and the
 *  paint count of its glyphs. */
function findNeedle(glyphs: readonly GlyphFragment[], needle: string): NeedleHit[] {
  const found: NeedleHit[] = [];
  for (const line of visualLines(glyphs)) {
    const starts: number[] = [];
    let cursor = 0;
    for (const g of line) {
      starts.push(cursor);
      cursor += g.text.length;
    }
    const text = line.map((g) => g.text).join("");
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
      const end = at + needle.length;
      const matched = line.filter((g, i) => starts[i]! < end && starts[i]! + g.text.length > at);
      if (matched.length === 0) continue;
      const xMin = Math.min(...matched.map((g) => g.x));
      const xMax = Math.max(...matched.map((g) => g.x + g.width));
      const yMin = Math.min(...matched.map((g) => g.y));
      const yMax = Math.max(...matched.map((g) => g.y + g.height));
      const paints = [...new Set(matched.map((g) => g.paintCount))].sort((p, q) => p - q);
      found.push({
        box: `x=[${n1(xMin)};${n1(xMax)}] y=[${n1(yMin)};${n1(yMax)}]`,
        paints: paints.join(", "),
        runIds: [...new Set(matched.map((g) => g.runId))].join(", "),
      });
    }
  }
  return found;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined =>
    argv
      .find((a) => a.startsWith(`--${name}=`))
      ?.split("=")
      .slice(1)
      .join("=");
  const file = argv.find((a) => !a.startsWith("--"));
  if (file === undefined) {
    console.error(
      "usage: npx tsx tools/pdf-geometry-probe.ts <fichier.pdf> [--page=N] [--needle=Matieres] [--snap=2] [--max=200]",
    );
    process.exitCode = 1;
    return;
  }
  const pageFlag = flag("page");
  const snapFlag = flag("snap");
  const maxFlag = flag("max");
  const onlyPage = pageFlag === undefined ? undefined : Number(pageFlag);
  const needle = flag("needle") ?? "Matières";
  const tolerance = snapFlag === undefined ? DEFAULT_SNAP_TOLERANCE : Number(snapFlag);
  const max = maxFlag === undefined ? 200 : Number(maxFlag);

  // Reads through the reader's own entry: a probe that opens the document
  // another way probes something else.
  const source = await readPdfSource(new Uint8Array(readFileSync(file)), {
    wantOps: (i) => onlyPage === undefined || i === onlyPage - 1,
  });

  console.log(`Fichier : ${file}`);
  console.log(`Pages : ${source.pages.length} — tolerance d'accrochage affichee : ${n1(tolerance)} pt`);

  for (let p = 1; p <= source.pages.length; p++) {
    if (onlyPage !== undefined && p !== onlyPage) continue;
    const { paths, segments } = walkPaintedPaths(source.pages[p - 1]!.ops);

    console.log(`\n${"=".repeat(78)}\nPAGE ${p} — ${paths.length} chemins peints, ${segments.length} segments d'axe`);

    const grid: TableGrid | undefined = buildGridFromVectorLines(segments.map((s) => s.line));
    if (grid === undefined) {
      console.log("Aucune grille vectorielle sur cette page : rien a situer dans une emprise.");
      continue;
    }
    const cols = grid.colBoundaries;
    const rows = grid.rowBoundaries;
    const colExtent = { lo: cols[0]!, hi: cols[cols.length - 1]! };
    const rowExtent = { lo: rows[rows.length - 1]!, hi: rows[0]! };
    const gridWidth = colExtent.hi - colExtent.lo;
    const gridHeight = rowExtent.hi - rowExtent.lo;

    console.log(`Grille : ${rows.length - 1} lignes x ${cols.length - 1} colonnes`);
    console.log(`  frontieres de colonne : ${cols.map(n1).join("  ")}`);
    console.log(`  frontieres de ligne   : ${rows.map(n1).join("  ")}`);
    console.log(`  emprise : x=[${n1(colExtent.lo)};${n1(colExtent.hi)}] y=[${n1(rowExtent.lo)};${n1(rowExtent.hi)}]`);

    const inside = paths.filter(
      (q) => q.xMax >= colExtent.lo && q.xMin <= colExtent.hi && q.yMax >= rowExtent.lo && q.yMin <= rowExtent.hi,
    );
    const ordered = [...inside].sort((q, r) => r.yMax - q.yMax || q.xMin - r.xMin);

    console.log(
      `\n-- CHEMINS PEINTS DANS L'EMPRISE (${inside.length})${inside.length > max ? ` — ${max} affiches` : ""}`,
    );
    console.log(
      "   sens position                    longueur  epaisseur  couverture  extremite 1          extremite 2          peinture",
    );
    for (const q of ordered.slice(0, max)) {
      const width = q.xMax - q.xMin;
      const height = q.yMax - q.yMin;
      const horizontal = width >= height;
      const length = horizontal ? width : height;
      const thickness = Math.max(horizontal ? height : width, q.strokeWidth);
      const extent = horizontal ? gridWidth : gridHeight;
      const coverage = extent > 0 ? length / extent : 0;
      const position = horizontal
        ? `y=${n1(q.yMin + height / 2)} x=[${n1(q.xMin)};${n1(q.xMax)}]`
        : `x=${n1(q.xMin + width / 2)} y=[${n1(q.yMin)};${n1(q.yMax)}]`;
      const ends = horizontal
        ? [snap(q.xMin, cols, tolerance), snap(q.xMax, cols, tolerance)]
        : [snap(q.yMin, rows, tolerance), snap(q.yMax, rows, tolerance)];
      console.log(
        `   ${horizontal ? "H" : "V"}    ${position.padEnd(30)}${n1(length).padStart(8)}${n1(thickness).padStart(11)}${pct(coverage).padStart(12)}  ${ends[0]!.padEnd(21)}${ends[1]!.padEnd(21)}${q.paint}`,
      );
    }

    const partials = ordered.filter((q) => {
      const width = q.xMax - q.xMin;
      const height = q.yMax - q.yMin;
      return width >= height && gridWidth > 0 && width / gridWidth < CURRENT_MIN_SPAN_COVERAGE;
    });
    console.log(
      `\n-- HORIZONTALES PARTIELLES (couverture < ${pct(CURRENT_MIN_SPAN_COVERAGE)}, donc REJETEES aujourd'hui) : ${partials.length}`,
    );
    console.log("   C'est la population du geste 1 du plan, et c'est aussi celle des barres et des fonds colores.");

    const filled = inside.filter((q) => q.paint !== "stroke");
    const longestFill = filled.reduce<PaintedPath | undefined>((best, q) => {
      const length = Math.max(q.xMax - q.xMin, q.yMax - q.yMin);
      const bestLength = best === undefined ? -1 : Math.max(best.xMax - best.xMin, best.yMax - best.yMin);
      return length > bestLength ? q : best;
    }, undefined);
    console.log(`\n-- BARRE REMPLIE LA PLUS LONGUE (${filled.length} chemins remplis dans l'emprise)`);
    if (longestFill === undefined) {
      console.log("   aucune");
    } else {
      const width = longestFill.xMax - longestFill.xMin;
      const height = longestFill.yMax - longestFill.yMin;
      console.log(
        `   longueur=${n1(Math.max(width, height))}  epaisseur=${n1(Math.min(width, height))}  x=[${n1(longestFill.xMin)};${n1(longestFill.xMax)}]  y=[${n1(longestFill.yMin)};${n1(longestFill.yMax)}]`,
      );
    }

    // The view that matters for question 1: the horizontals after the collinear
    // ones are merged, which is what a grid is decided on. The per-path view
    // above counts a separator drawn cell by cell once per cell: it
    // over-represents the partials and says nothing of the decision.
    const horizontals = segments.filter(
      (s): s is SourcedLine & { line: Extract<ClassifiedLine, { orientation: "horizontal" }> } =>
        s.line.orientation === "horizontal",
    );
    const merged = clusterPositions(horizontals.map((s) => s.line.y))
      .map((at) => {
        const members = horizontals.filter((s) => Math.abs(s.line.y - at) <= 2);
        const lo = Math.min(...members.map((s) => s.line.xMin));
        const hi = Math.max(...members.map((s) => s.line.xMax));
        const fills = members.filter((s) => s.paint !== "stroke");
        return {
          at,
          lo,
          hi,
          coverage: gridWidth > 0 ? (hi - lo) / gridWidth : 0,
          insideRows: at >= rowExtent.lo - 2 && at <= rowExtent.hi + 2,
          isBoundary: rows.some((r) => Math.abs(r - at) <= 2),
          thinnest: Math.min(...members.map((s) => s.sourceHeight)),
          fromFillOnly: fills.length === members.length,
          maxFillHeight: fills.length === 0 ? 0 : Math.max(...fills.map((s) => s.sourceHeight)),
        };
      })
      .filter((m) => m.insideRows)
      .sort((m, o) => o.at - m.at);

    console.log(
      `\n-- HORIZONTALES FUSIONNÉES DANS L'EMPRISE (${merged.length}) — la vue sur laquelle le geste 1 décide`,
    );
    console.log(
      "   y          etendue                 couverture  frontiere  extremite 1          extremite 2          source la plus fine  fond max",
    );
    for (const m of merged) {
      console.log(
        `   ${n1(m.at).padEnd(11)}x=[${n1(m.lo)};${n1(m.hi)}]`.padEnd(41) +
          `${pct(m.coverage).padStart(10)}  ${(m.isBoundary ? "gardee" : "REJETEE").padEnd(11)}${snap(m.lo, cols, tolerance).padEnd(21)}${snap(m.hi, cols, tolerance).padEnd(21)}${n1(m.thinnest).padStart(11)}        ${m.fromFillOnly ? `${n1(m.maxFillHeight)} (remplissage seul)` : n1(m.maxFillHeight)}`,
      );
    }

    const glyphs = buildGlyphFragments(source.pages[p - 1]!.ops);
    const overpainted = glyphs.filter((g) => g.paintCount > 1).length;
    console.log(`\n-- PEINTURE DE "${needle}"  (${glyphs.length} glyphes sur la page, dont ${overpainted} sur-peints)`);
    const occurrences = findNeedle(glyphs, needle);
    if (occurrences.length === 0) console.log("   aucune occurrence");
    for (const o of occurrences) console.log(`   ${o.box}  peintures=${o.paints}  runId=${o.runIds}`);
    console.log(`   occurrences distinctes : ${occurrences.length}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
