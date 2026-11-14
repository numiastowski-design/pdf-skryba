/** Where a painted path lands in page space, and whether the segment it gives
 *  is an axis-aligned line at all — plus the key that pairs two readings of the
 *  same document by coordinates.
 *  NOT here: the path encoding (first inherited from pdf.js), a format decoder
 *  (`extractor/pdf-ops.ts`), nor what a set of lines becomes
 *  (`layout/vector-grid.ts`, `layout/intersection-cells.ts`).
 *  Called by: `layout/vector-grid.ts`, `layout/intersection-cells.ts`, `layout/merged-cells.ts`, `extractor/pdf-table-detector.ts`, `extractor/glyph-positions.ts`,
 *  `extractor/pdf.ts`, through the `layout/geometry.ts` façade. */

import type { ClassifiedLine, LineSegment, Matrix2D } from "./geometry-types";

// ---------------------------------------------------------------------------
// Arithmetique de matrices et decodage de chemins — deplaces depuis
// `extractor/pdf-table-detector.ts` le 09/09/2026. Ces fonctions etaient pures
// mais vivaient du cote couple (le fichier qui importe unpdf et pdfjs), donc
// intestables sans charger pdf.js et inextractibles avec le reste. Rien de leur
// contenu n'a change ; seule leur place a change.
// ---------------------------------------------------------------------------

export const IDENTITY_MATRIX: Matrix2D = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export const translateMatrix = (e: number, f: number): Matrix2D => ({ a: 1, b: 0, c: 0, d: 1, e, f });

/** PDF/PostScript matrix composition: `newM` applies FIRST (in the local
 *  frame it introduces), then `old` — i.e. this is what the `cm` operator
 *  computes when it prepends a new matrix onto the current one. Verified
 *  empirically (04/09/2026) against a real nested translate+scale in a
 *  synthetic PDF, not derived from memory of the PDF spec alone: a
 *  local rectangle drawn inside `translate(100,200)` then `scale(2,3)`
 *  landed at exactly the page-space corners this formula predicts. */
export function composeMatrix(newM: Matrix2D, old: Matrix2D): Matrix2D {
  return {
    a: newM.a * old.a + newM.b * old.c,
    b: newM.a * old.b + newM.b * old.d,
    c: newM.c * old.a + newM.d * old.c,
    d: newM.c * old.b + newM.d * old.d,
    e: newM.e * old.a + newM.f * old.c + old.e,
    f: newM.e * old.b + newM.f * old.d + old.f,
  };
}

export function applyMatrix(m: Matrix2D, x: number, y: number): { x: number; y: number } {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

/** ⚠️ `decodePathSubpaths` A QUITTÉ CE FICHIER le 14/09/2026 pour
 *  `extractor/pdf-ops.ts`. C'était un DÉCODEUR DE FORMAT pdf.js
 *  — l'encodage `0`=moveTo / `1`=lineTo / `4`=closePath, non documenté en amont
 *  — et il vivait du côté NEUTRE de l'arborescence, où rien ne signalait qu'une
 *  montée de `pdfjs-dist` pouvait l'invalider. `subpathsToSegments` ci-dessous
 *  reste ici : elle ne connaît que des points. */

export const subpathsToSegments = (subpaths: { x: number; y: number }[][], ctm: Matrix2D, thickness?: number): LineSegment[] => {
  const segments: LineSegment[] = [];
  const extra = thickness !== undefined ? { thickness } : {};
  for (const points of subpaths) {
    for (let i = 0; i + 1 < points.length; i++) {
      const p1 = applyMatrix(ctm, points[i]!.x, points[i]!.y);
      const p2 = applyMatrix(ctm, points[i + 1]!.x, points[i + 1]!.y);
      segments.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, ...extra });
    }
  }
  return segments;
};

// A segment closer to axis-aligned than this (PDF points) is treated as
// horizontal/vertical; anything more diagonal is not a table border line —
// out of scope for jalon 1 (rotated tables), not silently mis-detected.
const AXIS_TOLERANCE = 0.5;

/** Classifies a raw segment as a table-border candidate, or discards it
 *  (too short in both axes to be a line at all, or genuinely diagonal). */
export function classifyLineSegment(seg: LineSegment): ClassifiedLine | undefined {
  const dx = Math.abs(seg.x2 - seg.x1);
  const dy = Math.abs(seg.y2 - seg.y1);
  const thickness = seg.thickness !== undefined ? { thickness: seg.thickness } : {};
  if (dy <= AXIS_TOLERANCE && dx > AXIS_TOLERANCE) {
    return { orientation: "horizontal", y: (seg.y1 + seg.y2) / 2, xMin: Math.min(seg.x1, seg.x2), xMax: Math.max(seg.x1, seg.x2), ...thickness };
  }
  if (dx <= AXIS_TOLERANCE && dy > AXIS_TOLERANCE) {
    return { orientation: "vertical", x: (seg.x1 + seg.x2) / 2, yMin: Math.min(seg.y1, seg.y2), yMax: Math.max(seg.y1, seg.y2), ...thickness };
  }
  return undefined;
}

/** Appariement (abscisse, ordonnee, texte) entre deux lectures du MEME
 *  document, qui rendent exactement les memes coordonnees. Jamais un
 *  appariement par indice : les deux listes n'ont pas la meme longueur. */
export const positionKey = (x: number, y: number, text: string): string => `${Math.round(x * 100)}|${Math.round(y * 100)}|${text}`;

/** The classified lines split by orientation, each side in its input order. */
export function splitByOrientation(lines: readonly ClassifiedLine[]): {
  horizontals: Extract<ClassifiedLine, { orientation: "horizontal" }>[];
  verticals: Extract<ClassifiedLine, { orientation: "vertical" }>[];
} {
  const horizontals: Extract<ClassifiedLine, { orientation: "horizontal" }>[] = [];
  const verticals: Extract<ClassifiedLine, { orientation: "vertical" }>[] = [];
  for (const line of lines) {
    if (line.orientation === "vertical") verticals.push(line);
    else horizontals.push(line);
  }
  return { horizontals, verticals };
}
