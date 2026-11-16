/** The cells whose four sides are REALLY painted: the reading that elects no
 *  extent, so no frame ever absorbs the box it surrounds.
 *  NOT here: the grid built by vote from merged collinear lines
 *  (`layout/vector-grid.ts`), nor what a cell becomes
 *  (`extractor/pdf-table-render.ts`).
 *  Also: the verdict « boxes separated by voids » on a vector region
 *  (`isBoxesInVoidsRegion`).
 *  Called by: `extractor/pdf-table-detector.ts` through the
 *  `layout/geometry.ts` façade. */

import { maxOf, minOf } from "../lib/extent";
import type { CellRect, ClassifiedLine, TableGrid } from "./geometry-types";
import { CLUSTER_TOLERANCE, clusterGroups, MIN_BOUNDARIES } from "./position-clusters";
import { lowerBound, mergeIntervals } from "./intervals";
import { splitByOrientation } from "./painted-paths";
import { holdsRect, RECT_RULES, rawFromCell } from "./rect-rules";

/** Une plage continue de peinture à une position donnée. */
interface InkRun {
  lo: number;
  hi: number;
}

/** ⚠️ Oui, la tolérance ci-dessous est une DISTANCE, et on a mesuré le
 *  11/09/2026 qu'une distance ne peut pas dire si deux segments appartiennent à
 *  la même structure. Ce n'est pas la question posée ici. Ici on demande « y
 *  a-t-il de l'encre d'un bout à l'autre de CE bord », entre deux extrémités
 *  déjà fixées par des intersections. La réponse ne groupe rien et ne décide
 *  d'aucune appartenance : elle constate. */
/** Un vide plus petit que ceci ne coupe pas un bord en deux. Mesuré : un vrai
 *  séparateur de colonne peint en deux morceaux les espace de 2,4 pt.
 *  **Valeur de départ à calibrer** — mais elle ne porte qu'un CONSTAT de
 *  continuité entre deux extrémités connues, jamais une décision
 *  d'appartenance. */
const INK_CONTINUITY_TOLERANCE = 3;

const covers = (runs: readonly InkRun[] | undefined, lo: number, hi: number): boolean =>
  runs !== undefined && runs.some((r) => r.lo <= lo + CLUSTER_TOLERANCE && r.hi >= hi - CLUSTER_TOLERANCE);

/**
 * LES CELLULES PAR INTERSECTIONS — le chemin qui n'élit aucune emprise.
 *
 * POURQUOI IL EXISTE. `mergeCollinear` réduit chaque abscisse à UNE étendue
 * avant toute décision, et cette réduction est destructrice : un bord de cadre
 * qui en contient un autre l'efface, et le bloc qu'il encadrait disparaît du
 * rendu sans signalement (mesuré le 11/09/2026, voir le commentaire de
 * `mergeCollinear`). Deux correctifs locaux y sont morts.
 *
 * CE QUE FAIT CELUI-CI, À LA MANIÈRE DE pdfplumber
 * (`docs/ETUDE-BIBLIOTHEQUES-PDF.md` [purged 27/09/2026, git history] §2). Il part des INTERSECTIONS réelles et
 * retient, pour chacune, la plus petite cellule dont les QUATRE côtés portent
 * vraiment de l'encre. Aucune étendue n'est élue, donc rien n'est jamais
 * absorbé : un cadre de page y apporte ses intersections comme n'importe quel
 * trait, et comme les cellules retenues sont les plus PETITES, il n'avale
 * personne.
 *
 * CE À QUOI IL SERT. Il rend des cellules, pas des tableaux. Il n'est branché
 * qu'à un seul endroit : les bords des cellules peintes au-dessus d'une grille,
 * d'où la coupe bornée qui lit l'en-tête d'un bulletin en deux blocs
 * (`pdf-table-detector.ts#boundedCutAboveGrids`).
 *
 * ESSAYÉ PUIS ÉCARTÉ LE 15/09/2026 : en faire le chemin PRINCIPAL des tableaux.
 * Le regroupement des cellules en régions (`groupCellsIntoRegions`, avec une
 * règle « le vide peut être atteint, jamais faire pont ») a été écrit le
 * 11/09/2026 puis retiré, jamais branché. Mesuré contre `mergeCollinear` sur un
 * bulletin réel : il retrouvait l'encadré d'en-tête, mais créait trois régions
 * parasites en page 1 et soudait les deux tableaux de la page 2 en une seule
 * région 18x11. Et son seul gain ne comptait pas : l'ancien chemin perd le CADRE
 * de l'encadré, pas son texte, qui reste dans la page et donc cherchable. Le
 * code retiré est dans l'historique git (`2b097a1`, `06bd358`, `606f652`).
 */
export function findCellsByIntersection(lines: readonly ClassifiedLine[]): CellRect[] {
  const { verticals, horizontals } = splitByOrientation(lines);
  if (verticals.length < MIN_BOUNDARIES || horizontals.length < MIN_BOUNDARIES) return [];

  // Les abscisses et ordonnées candidates, et l'encre continue à chacune.
  const vGroups = clusterGroups(verticals, (v) => v.x);
  const hGroups = clusterGroups(horizontals, (h) => h.y).reverse(); // top to bottom
  const xs = vGroups.map((g) => g.center);
  const ys = hGroups.map((g) => g.center);
  const vRuns = new Map<number, InkRun[]>(vGroups.map((g) => [g.center, mergeIntervals(g.members.map((v) => ({ lo: v.yMin, hi: v.yMax })), INK_CONTINUITY_TOLERANCE)]));
  const hRuns = new Map<number, InkRun[]>(hGroups.map((g) => [g.center, mergeIntervals(g.members.map((h) => ({ lo: h.xMin, hi: h.xMax })), INK_CONTINUITY_TOLERANCE)]));

  const cells: CellRect[] = [];
  for (let i = 0; i < xs.length; i++) {
    for (let j = 0; j < ys.length; j++) {
      const xLeft = xs[i]!;
      const yTop = ys[j]!;
      // Le coin haut-gauche doit être une vraie intersection.
      if (!covers(vRuns.get(xLeft), yTop, yTop) || !covers(hRuns.get(yTop), xLeft, xLeft)) continue;

      // La PLUS PETITE cellule fermée : on balaie vers la droite puis vers le
      // bas, et la première qui ferme est la bonne.
      let found = false;
      for (let k = i + 1; k < xs.length && !found; k++) {
        const xRight = xs[k]!;
        if (!covers(hRuns.get(yTop), xLeft, xRight)) continue;
        for (let l = j + 1; l < ys.length && !found; l++) {
          const yBottom = ys[l]!;
          const closed =
            covers(vRuns.get(xLeft), yBottom, yTop) &&
            covers(vRuns.get(xRight), yBottom, yTop) &&
            covers(hRuns.get(yBottom), xLeft, xRight);
          if (closed) {
            cells.push({ xLeft, xRight, yBottom, yTop });
            found = true;
          }
        }
      }
    }
  }
  return cells;
}


/** Fewer painted cells than this and the rule abstains: a lone box is a legitimate 1x1 table.
 *  **Valeur de départ à calibrer.** Two populations, measured 01/10/2026 on RENDERED tables: 10 false regions (diagram PDFs:
 *  05-Groupes, 02, 03, 04, 07, 08, 05-libya p2-3 Word drawings) hold >= 2 closed painted cells none of which touches another;
 *  0 of the 121 real tables (7 bench PDFs + 05-libya docx p10-12) do — their lowest share of cells with a neighbour is 0.67. */
const MIN_ISOLATED_BOXES = 2;

/** Minimum overlap, on the axis ALONG the shared edge, for two cells to touch: a corner contact is not a contact. */
const TOUCH_MIN_OVERLAP = CLUSTER_TOLERANCE;

const encloses = (outer: CellRect, inner: CellRect): boolean =>
  holdsRect(RECT_RULES["cell-encloses"], rawFromCell(outer), rawFromCell(inner));

/** Gap <= CLUSTER_TOLERANCE on one axis (negative = overlap) AND an overlap of MORE than 2 pt on the other. */
const touches = (a: CellRect, b: CellRect): boolean => {
  const xOverlap = Math.min(a.xRight, b.xRight) - Math.max(a.xLeft, b.xLeft);
  const yOverlap = Math.min(a.yTop, b.yTop) - Math.max(a.yBottom, b.yBottom);
  return (xOverlap >= -CLUSTER_TOLERANCE && yOverlap > TOUCH_MIN_OVERLAP) || (yOverlap >= -CLUSTER_TOLERANCE && xOverlap > TOUCH_MIN_OVERLAP);
};

/**
 * BOXES SEPARATED BY VOIDS IS NOT A TABLE (rule R1, 01/10/2026).
 * True when the vector region `grid` holds at least `MIN_ISOLATED_BOXES` painted cells (of `cells`, the page's closed
 * rectangles) and NONE of them touches another: that is a diagram of boxes (PowerPoint, Word drawing) or a layout of cards,
 * not rows and columns. The page then flows as paragraphs and images in reading order, all words kept (bias: a missed table
 * over an invented one; the text stays searchable).
 * The region's cells are those inside the grid extent (2 pt margin). A cell that encloses another one is ignored: a full-page
 * background fill (960x540 on 05-Groupes p0) lies inside the extent of the grid it helped to vote.
 * Caveats: both constants are starting values to calibrate (see `MIN_ISOLATED_BOXES`); the connector of 05-Groupes is a fill
 * 1.98 pt wide, just under the clustering tolerance, so it is not a cell and a drawing whose connectors were wider could
 * read as touching; a real table made of cards separated by gutters is dropped to prose (accepted, nothing lost).
 */
export function isBoxesInVoidsRegion(grid: TableGrid, cells: readonly CellRect[]): boolean {
  if (grid.colBoundaries.length === 0 || grid.rowBoundaries.length === 0) return false;
  const xMin = minOf(grid.colBoundaries, (b) => b) - CLUSTER_TOLERANCE;
  const xMax = maxOf(grid.colBoundaries, (b) => b) + CLUSTER_TOLERANCE;
  const yMin = minOf(grid.rowBoundaries, (b) => b) - CLUSTER_TOLERANCE;
  const yMax = maxOf(grid.rowBoundaries, (b) => b) + CLUSTER_TOLERANCE;
  const inside = cells.filter((c) => c.xLeft >= xMin && c.xRight <= xMax && c.yBottom >= yMin && c.yTop <= yMax);
  // Cells are grouped by left edge (groups sorted by xLeft), each group sorted by bottom edge, so that what can enclose or touch a
  // cell is a window of x-groups and, inside each group, a window of y: neither all-pairs scan survives 8 000 isolated cells
  // (7 s), nor one tall column or full-width bands that all share a left edge (1.8 s for 20 000 with a window on x only).
  // The result is the same as comparing every pair.
  const index = (list: readonly CellRect[]) => {
    const byX = new Map<number, CellRect[]>();
    for (const c of list) {
      const group = byX.get(c.xLeft);
      if (group === undefined) byX.set(c.xLeft, [c]);
      else group.push(c);
    }
    const groups = [...byX.entries()]
      .sort((p, q) => p[0] - q[0])
      .map(([xLeft, cells]) => {
        cells.sort((p, q) => p.yBottom - q.yBottom);
        return { xLeft, cells, maxHeight: cells.reduce((m, c) => Math.max(m, c.yTop - c.yBottom), 0) };
      });
    /** True when `test` holds for a cell other than `c` whose left edge is in [c.xLeft, xTo] and whose bottom edge is in
     *  [yFrom, yTo]; `useHeight` widens the lower end by the tallest cell of the group (a tall cell starting far below can
     *  still reach up to `yFrom`). */
    return (c: CellRect, xTo: number, yFrom: number, yTo: number, useHeight: boolean, test: (o: CellRect) => boolean): boolean => {
      for (let g = lowerBound(groups.length, (i) => groups[i]!.xLeft >= c.xLeft); g < groups.length && groups[g]!.xLeft <= xTo; g++) {
        const group = groups[g]!;
        const start = lowerBound(group.cells.length, (i) => group.cells[i]!.yBottom >= (useHeight ? yFrom - group.maxHeight : yFrom));
        for (let k = start; k < group.cells.length && group.cells[k]!.yBottom <= yTo; k++) {
          const o = group.cells[k]!;
          if (o !== c && test(o)) return true;
        }
      }
      return false;
    };
  };
  // An enclosed cell starts at or after its outer cell, inside it: x in [xLeft, xRight], bottom edge in [yBottom, yTop].
  const anyInside = index(inside);
  const boxes = inside.filter((c) => !anyInside(c, c.xRight, c.yBottom, c.yTop, false, (o) => encloses(c, o)));
  if (boxes.length < MIN_ISOLATED_BOXES) return false;
  // Two cells touch only if the later one starts within the tolerance of the earlier one's right edge, and their y extents
  // come within the tolerance of each other (a gap larger than that, on either axis, is no contact).
  const anyBox = index(boxes);
  for (const c of boxes) {
    if (anyBox(c, c.xRight + CLUSTER_TOLERANCE, c.yBottom - CLUSTER_TOLERANCE, c.yTop + CLUSTER_TOLERANCE, true, (o) => touches(c, o))) return false;
  }
  return true;
}
