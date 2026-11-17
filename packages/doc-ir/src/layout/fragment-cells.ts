/** Where each fragment of a page lands once a grid is known: its row band,
 *  its cell, and whether that placement is ambiguous — plus the "same y ⇒ same
 *  visual line" rule every caller shares.
 *  NOT here: how the grid is found (`layout/vector-grid.ts`,
 *  `layout/aligned-grid.ts`), which cells are merged
 *  (`layout/merged-cells.ts`), nor the cell text itself
 *  (`layout/cell-text.ts`).
 *  Called by: `extractor/pdf-table-render.ts`,
 *  `extractor/pdf-table-detector.ts`, `layout/cell-text.ts`, through the
 *  `layout/geometry.ts` façade. */

import { groupByBaseline } from "./baseline-lines";
import type { CellAssignment, Fragment, MergeMap, TableGrid } from "./geometry-types";
import { SAME_LINE_PT } from "./tolerances";

/** The "same y ⇒ same visual line" rule shared by every caller that needs
 *  per-fragment (not merged-text) line grouping — `pdf-table-detector.ts`'s
 *  own detection pass and `pdf.ts`'s table-rendering pass both build their
 *  OWN `Fragment[]` from their own (separate) `extractTextItems` call, then
 *  call this on it; kept here rather than duplicated so the grouping RULE
 *  has one definition, even though the underlying PDF document is
 *  read twice (a deliberate, documented tradeoff — see `pdf-table-
 *  detector.ts`'s own module doc). Distinct from `pdf.ts`'s own
 *  `linesFromItems`: that one merges fragments into a single TEXT string
 *  per line (paragraph reconstruction's need), this one keeps each
 *  fragment separate with its own x/width (column clustering's need). */
export function groupFragmentsIntoVisualLines(fragments: readonly Fragment[]): Fragment[][] {
  // ORDRE DE LECTURE GEOMETRIQUE, pas ordre d'emission — meme correctif et
  // meme motif que `pdf.ts`'s `linesFromItems`, dont le commentaire porte la
  // mesure complete (08/09/2026). Ici l'enjeu n'est pas la fusion de
  // paragraphes mais le DETERMINISME des predicats bâtis la-dessus :
  // `hasWeakTabularitySignal` rendait `false` sur la page 1 et `true` sur la
  // page 2 de `11-Brochure-Deux-Colonnes.pdf`, deux pages de mise en page
  // IDENTIQUE. Il mesure des ecarts entre fragments d'une meme ligne ; si la
  // ligne n'est pas la meme selon le generateur, le verdict ne l'est pas non
  // plus. Apres tri : `true` sur les deux.
  //
  // Un discriminant de colonnes se batira sur ce regroupement (point 13). Le
  // faire reposer sur l'ordre d'emission rendrait des verdicts differents sur
  // deux fichiers aux memes octets de mise en page — un symptome qui ne se
  // reproduit pas ou on l'observe.
  //
  // Tri strict puis regroupement puis tri interne, jamais un comparateur
  // unique a tolerance : celui-la ne serait pas transitif, et `Array.sort`
  // n'aurait aucun resultat garanti.
  return groupByBaseline(fragments.filter((f) => f.text.length > 0));
}

// A fragment edge within this many PDF points of a boundary is treated as
// "at" it, not "across" it, when checking for ambiguity (assignFragmentsToCells)
// — a boundary built as the exact midpoint between two lines grazes an
// ordinary fragment's own edge by construction (buildGridFromAlignedRows),
// which isn't a real straddle.
const STRADDLE_TOLERANCE = SAME_LINE_PT;

/** §8's "regroupement des blocs multi-lignes en ligne logique": buckets
 *  fragments into the row band (between two consecutive row boundaries)
 *  their y-center falls into — a wrapped cell's second visual line lands
 *  in the SAME band as its first, because both sit strictly between the
 *  same two boundaries. A fragment outside every band is simply not
 *  returned here (this is a row-axis-only grouping step, column
 *  assignment and the real conservation check both live in
 *  `assignFragmentsToCells`, which this function is NOT a replacement
 *  for — kept separate because the clustering fallback (stage 2, no
 *  vector grid) still wants logical rows before it has any column
 *  boundaries to build a full grid from). */
export function groupFragmentsIntoRowBands(
  fragments: readonly Fragment[],
  rowBoundaries: readonly number[],
): Fragment[][] {
  const bands: Fragment[][] = rowBoundaries.slice(0, -1).map(() => []);
  for (const f of fragments) {
    const cy = f.y + f.height / 2;
    for (let row = 0; row < rowBoundaries.length - 1; row++) {
      const top = rowBoundaries[row]!;
      const bottom = rowBoundaries[row + 1]!;
      if (cy <= top && cy >= bottom) {
        bands[row]!.push(f);
        break;
      }
    }
  }
  return bands;
}

/** §8's lightweight conservation invariant, computed once here rather than
 *  reimplemented at jalon 2 — see `CellAssignment`'s own doc for what
 *  `ambiguous`/`outside` actually mean and why "landing in no band" isn't
 *  the useful signal (bands are contiguous across the grid's own bounds by
 *  construction, so that can only happen at floating-point edges). */
/** Générique sur le type de fragment : un appelant qui passe des glyphes
 *  (`GlyphFragment`, avec son `paintCount`) les récupère tels quels dans les
 *  cellules. Sans cela, l'assignation les aplatirait en `Fragment` et
 *  l'information du second signal se perdrait au milieu de la chaîne. */
export function assignFragmentsToCells<T extends Fragment>(
  fragments: readonly T[],
  grid: TableGrid,
  merge?: MergeMap,
): CellAssignment<T> {
  const { rowBoundaries, colBoundaries } = grid;
  const rows = rowBoundaries.length - 1;
  const cols = colBoundaries.length - 1;
  // Fuzz finding (04/09/2026, STATUS.md): a grid with EXACTLY one boundary
  // on either axis has zero real rows/cols despite `insideBounds` still
  // being satisfiable (xMin === xMax, or yMin === yMax, lets a fragment
  // whose coordinate matches exactly slip through) — there is no valid
  // cell to place it in. Both real grid builders enforce MIN_BOUNDARIES=2
  // before ever returning a grid, so this never fires on a real pipeline
  // grid; guarded here anyway since this function is itself exported and
  // has no such contract of its own. A grid with no real cells explains
  // nothing — every fragment routes to `outside`, same as a fragment that
  // falls outside a well-formed grid's own bounds.
  if (rows < 1 || cols < 1) return { cells: [], ambiguous: [], outside: [...fragments] };

  const xMin = colBoundaries[0]!;
  const xMax = colBoundaries[colBoundaries.length - 1]!;
  const yMin = rowBoundaries[rowBoundaries.length - 1]!;
  const yMax = rowBoundaries[0]!;

  const cells: T[][][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => [] as T[]));
  const ambiguous: T[] = [];
  const outside: T[] = [];

  /** L'identité de la CELLULE qui occupe une case, fusions comprises, SUR LES
   *  DEUX AXES. Sans carte de fusion, chaque case est sa propre cellule — le
   *  comportement d'avant, à la ligne près.
   *
   *  Sert au contrôle d'ambiguïté : un fragment qui déborde sur une case
   *  voisine FUSIONNÉE avec la sienne ne traverse aucune frontière, il occupe
   *  sa cellule. Le signaler ambigu ferait replier sur du texte plat un
   *  tableau parfaitement lisible — mesuré sur un en-tête « Moyennes » à
   *  quatre sous-colonnes.
   *
   *  🔴 LA SYMÉTRIE EST LA RAISON D'ÊTRE DE CE CHANGEMENT (10/09/2026). La
   *  version précédente ne connaissait les fusions que sur l'axe des COLONNES ;
   *  sur celui des lignes, elle comparait l'indice de bande brut. Mesuré sur un
   *  bulletin réel : la boîte du libellé « Matières » va de `y = 696,3` à
   *  `y = 702,8` et le séparateur des deux niveaux d'en-tête est à `y = 698,5`
   *  — le libellé TRAVERSE la frontière. Admettre cette frontière sans une
   *  identité de cellule bidimensionnelle aurait donc envoyé le libellé en
   *  `ambiguous` et fait retomber la page en texte plat, au lieu de produire le
   *  `rowspan` qu'on cherche.
   *
   *  Le contrôle est ici plutôt que sur la sortie : filtrer `ambiguous` après
   *  coup demanderait de reconstruire la même géométrie ailleurs, et deux
   *  traversées jumelles finissent par diverger. */
  const cellIdAt = (row: number, col: number): number => merge?.ownerAt[row]?.[col] ?? row * cols + col;

  /** The band this ordinate falls in, or NOTHING when it falls in none.
   *  Abstains with `undefined` like every other detector in `layout/`, and
   *  not with the `-1` it used until 20/09/2026: the sentinel type-checked
   *  as an index, so each of the six readers below had to remember to test
   *  it by hand before passing it to `cellIdAt`. The compiler remembers now. */
  const bandIndexOf = (v: number, boundaries: readonly number[], ascending: boolean): number | undefined => {
    const count = boundaries.length - 1;
    for (let i = 0; i < count; i++) {
      const lo = ascending ? boundaries[i]! : boundaries[i + 1]!;
      const hi = ascending ? boundaries[i + 1]! : boundaries[i]!;
      if (v >= lo && v <= hi) return i;
    }
    return undefined;
  };

  for (const f of fragments) {
    const cx = f.x + f.width / 2;
    const cy = f.y + f.height / 2;
    const insideBounds = cx >= xMin && cx <= xMax && cy >= yMin && cy <= yMax;
    if (!insideBounds) {
      outside.push(f);
      continue;
    }

    const row = bandIndexOf(cy, rowBoundaries, false);
    const col = bandIndexOf(cx, colBoundaries, true);
    // Contiguous bands spanning [xMin,xMax]×[yMin,yMax] make an abstention
    // here a floating-point edge case, not a real gap — clamp rather than
    // silently drop, "rien n'est perdu" applies even to that edge.
    const clampedRow = row === undefined ? (cy >= (rowBoundaries[0]! + rowBoundaries[1]!) / 2 ? 0 : rows - 1) : row;
    const clampedCol = col === undefined ? (cx <= (colBoundaries[0]! + colBoundaries[1]!) / 2 ? 0 : cols - 1) : col;
    cells[clampedRow]![clampedCol]!.push(f);

    // The real ambiguity check (§8 Q7, "fragments à cheval sur une
    // frontière"): does the fragment's own bounding box — not just its
    // center — cross into a DIFFERENT row or column band than the one it
    // was just assigned to? A merged cell's content, or a wrapped line
    // whose height nudges past the next row boundary, shows up this way.
    // Shrunk by STRADDLE_TOLERANCE first: a boundary built as the exact
    // midpoint between two lines' own y (§8 jalon 2's borderless grid,
    // `buildGridFromAlignedRows`) sits so close to an ordinary fragment's
    // own edge that it grazes it by construction, every time — not a real
    // merged cell, just where the math places an evenly-spaced boundary.
    const rowStart = bandIndexOf(f.y + f.height - STRADDLE_TOLERANCE, rowBoundaries, false);
    const rowEnd = bandIndexOf(f.y + STRADDLE_TOLERANCE, rowBoundaries, false);
    const colStart = bandIndexOf(f.x + STRADDLE_TOLERANCE, colBoundaries, true);
    const colEnd = bandIndexOf(f.x + f.width - STRADDLE_TOLERANCE, colBoundaries, true);
    const ownCell = cellIdAt(clampedRow, clampedCol);
    const straddles =
      (rowStart !== undefined && cellIdAt(rowStart, clampedCol) !== ownCell) ||
      (rowEnd !== undefined && cellIdAt(rowEnd, clampedCol) !== ownCell) ||
      (colStart !== undefined && cellIdAt(clampedRow, colStart) !== ownCell) ||
      (colEnd !== undefined && cellIdAt(clampedRow, colEnd) !== ownCell);
    if (straddles) ambiguous.push(f);
  }

  return { cells, ambiguous, outside };
}
