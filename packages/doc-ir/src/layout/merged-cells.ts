/** Which cells of a row are merged, read from the gaps in the vertical
 *  separators — and the second reading that has to agree before a span is
 *  claimed. Also says how many top rows are the header (`headerRowCount`, the rows that carry `<th>`).
 *  NOT here: the grid itself (`layout/geometry.ts`), nor the cell text
 *  (`layout/cell-text.ts`).
 *  Called by: `extractor/pdf-table-detector.ts` (`detectMergedCells`), `extractor/pdf-table-render.ts`
 *  (`headerRowCount`) and `layout/slide-layout.ts` (`buildMergeMap`). */

/**
 * `layout/merged-cells`: which cells of a table are merged.
 *
 * THE SIGNAL, MEASURED AND UNAMBIGUOUS (09/09/2026). A merged cell leaves a
 * GAP in the vertical separators, and nothing else leaves one. Read on a real
 * seven-column report card, separator by separator and band by band:
 *
 *       row           |  123  142  167  185  204  222
 *       L 0  707..689 |    .    .    X    X    X    .
 *       L 1..L11      |    .    .    .    .    .    .
 *
 * Three gaps on the ONLY header row, exactly at the boundaries
 * `Élève | Clas. | - | +`, the four sub-columns « Moyennes » spans. Every other
 * row has its six separators. The `colspan` is READ in the document, never
 * guessed.
 *
 * BOTH AXES ARE READ. The `colspan` comes from the gaps in the vertical
 * separators (`detectColumnSpans`), the `rowspan` from the gaps in the
 * horizontal ones (`detectRowMerges`, since 10/09/2026, the two-level header
 * of the same report card). A boundary with no horizontal stroke at all is
 * no evidence and merges nothing.
 *
 * PURE, like the rest of `layout/`: numbers in, a structure out, no product
 * dependency (IRDoc included); the extractor turns the map into cells.
 */

import { type ClassifiedLine, type MergeMap, type MergedCell, type TableGrid } from "./geometry";
import { unionLength } from "./intervals";
import { splitByOrientation } from "./painted-paths";
import { MIN_COVERAGE, SAME_POSITION_PT } from "./tolerances";

/** Part de la hauteur d'une bande qu'un séparateur doit couvrir pour compter
 *  comme tracé. Un trait qui n'en couvre qu'un bout — un reste de bordure
 *  voisine, une marque décorative — ne sépare rien.
 *
 *  Même valeur que le `MIN_SPAN_COVERAGE` de `geometry`, et pour la même
 *  raison : on cherche « ce trait traverse-t-il vraiment », pas « ce trait
 *  existe-t-il quelque part ». */
const MIN_BAND_COVERAGE = MIN_COVERAGE;

/** Deux abscisses à moins de ce nombre de points sont la même frontière —
 *  identique à la tolérance de regroupement de `geometry`. */
const SAME_POSITION_TOLERANCE = SAME_POSITION_PT;

/**
 * Pour chaque ligne de la grille, les `colspan` de ses cellules, dans l'ordre.
 *
 * Leur somme vaut toujours le nombre de colonnes de la grille : une ligne sans
 * fusion rend `[1, 1, 1, …]`, une ligne entièrement fusionnée rend `[n]`.
 *
 * ⚠️ **ELLE S'APPELAIT `detectRowSpans`, ET C'ÉTAIT UN CONTRE-SENS** : elle rend
 * des `colspan`, pas des `rowspan`. Renommée le 10/09/2026, avant d'écrire un
 * vrai détecteur de fusion verticale — poser celui-ci à côté d'une fonction qui
 * portait déjà son nom aurait été un piège à relecture, pas une commodité.
 *
 * Pur : ni I/O, ni horloge, ni aléa. Ne mute jamais son entrée.
 */
export function detectColumnSpans(lines: readonly ClassifiedLine[], grid: TableGrid): number[][] {
  const { verticals } = splitByOrientation(lines);
  const { rowBoundaries, colBoundaries } = grid;
  const columnCount = colBoundaries.length - 1;
  if (columnCount < 1) return [];

  const spans: number[][] = [];
  for (let row = 0; row + 1 < rowBoundaries.length; row++) {
    const top = rowBoundaries[row]!;
    const bottom = rowBoundaries[row + 1]!;
    const height = top - bottom;

    /** Le séparateur interne d'indice `i` (entre les colonnes `i` et `i+1`)
     *  traverse-t-il cette bande ? Les segments d'une même abscisse sont
     *  RÉUNIS avant d'être mesurés — le cas courant est qu'un trait soit dessiné
     *  cellule par cellule, et mesurer un segment isolé rejouerait exactement le
     *  défaut A de l'écart 14, sur l'autre axe. */
    const crosses = (x: number): boolean => {
      if (height <= 0) return false;
      // UNION des recouvrements, jamais leur SOMME — et l'erreur a été faite
      // avant d'être corrigée. Ce document REPEINT ses traits (voir
      // `collapseOverpaint`) : deux segments superposés comptaient double, un
      // séparateur couvrant la moitié d'une bande passait donc le seuil de
      // 60 %, et aucune fusion n'était jamais détectée. Sommer des intervalles
      // qui se chevauchent ne mesure pas une longueur.
      const covered = unionLength(
        verticals
          .filter((v) => Math.abs(v.x - x) <= SAME_POSITION_TOLERANCE)
          .map((v) => [Math.max(v.yMin, bottom), Math.min(v.yMax, top)] as const)
          .filter(([lo, hi]) => hi > lo),
      );
      return covered / height >= MIN_BAND_COVERAGE;
    };

    const rowSpans: number[] = [];
    let current = 1;
    for (let i = 1; i < columnCount; i++) {
      if (crosses(colBoundaries[i]!)) {
        rowSpans.push(current);
        // eslint-disable-next-line sonarjs/no-redundant-assignments -- false positive: current is read by the next iteration
        current = 1;
      } else {
        current += 1;
      }
    }
    rowSpans.push(current);
    spans.push(rowSpans);
  }
  return spans;
}

/**
 * The merge map of the grid, the contract everything downstream consumes.
 *
 * It carries both axes: the `colspan` of each row (`detectColumnSpans`) and
 * the vertical merges (`detectRowMerges`); a cell grows downward only while
 * every column it spans is merged downward (`buildMergeMap`).
 *
 * Pure: no I/O, no clock, no randomness; never mutates its input.
 */
export function detectMergedCells(lines: readonly ClassifiedLine[], grid: TableGrid): MergeMap {
  return buildMergeMap(grid, detectColumnSpans(lines, grid), detectRowMerges(lines, grid));
}

/**
 * LE SIGNAL SYMÉTRIQUE — quelles cellules sont fusionnées avec celle du dessous.
 *
 * `mergedDown[row][col]` vaut `true` quand la frontière entre `row` et `row+1`
 * **ne traverse pas** la colonne `col`. Une horizontale qui s'interrompt dit
 * littéralement que les cellules qu'elle ne traverse pas sont fusionnées
 * verticalement — c'est exactement ce que dit un trou dans les séparateurs
 * verticaux pour le `colspan`, sur l'autre axe.
 *
 * Le tableau a donc UNE LIGNE DE MOINS que la grille : la dernière frontière est
 * le bas du tableau, et rien n'y est fusionné avec quoi que ce soit.
 *
 * Même mesure que pour les colonnes : l'UNION des recouvrements, jamais leur
 * somme. Un document qui repeint ses traits compterait double.
 *
 * Pur : ni I/O, ni horloge, ni aléa. Ne mute jamais son entrée.
 */
function detectRowMerges(lines: readonly ClassifiedLine[], grid: TableGrid): boolean[][] {
  const { horizontals } = splitByOrientation(lines);
  const { rowBoundaries, colBoundaries } = grid;
  const rowCount = rowBoundaries.length - 1;
  const colCount = colBoundaries.length - 1;
  if (rowCount < 2 || colCount < 1) return [];

  const merges: boolean[][] = [];
  for (let row = 0; row + 1 < rowCount; row++) {
    const y = rowBoundaries[row + 1]!;
    const atBoundary = horizontals.filter((h) => Math.abs(h.y - y) <= SAME_POSITION_TOLERANCE);
    // AUCUN TRAIT DU TOUT À CETTE FRONTIÈRE : ce n'est pas une fusion, c'est une
    // absence de preuve. La nuance est tout sauf théorique — une grille bâtie
    // par ALIGNEMENT (`buildGridFromAlignedRows`) n'a aucune horizontale, et
    // conclure « tout est fusionné » y transformerait un tableau sans bordures
    // en une seule cellule géante. Le signal est le trou dans un trait qui
    // existe, jamais l'absence de trait.
    if (atBoundary.length === 0) {
      merges.push(Array.from({ length: colCount }, () => false));
      continue;
    }
    const rowMerges: boolean[] = [];
    for (let col = 0; col < colCount; col++) {
      const left = colBoundaries[col]!;
      const right = colBoundaries[col + 1]!;
      const width = right - left;
      if (width <= 0) {
        rowMerges.push(false);
        continue;
      }
      const covered = unionLength(
        atBoundary.map((h) => [Math.max(h.xMin, left), Math.min(h.xMax, right)] as const).filter(([lo, hi]) => hi > lo),
      );
      rowMerges.push(covered / width < MIN_BAND_COVERAGE);
    }
    merges.push(rowMerges);
  }
  return merges;
}

/**
 * Assemble la carte à partir des `colspan` par ligne.
 *
 * **L'ORDRE DE PARCOURS EST LE CONTRAT** : ligne par ligne, colonne par
 * colonne, donc `cells` est dans l'ordre de lecture. C'est ce que l'aval
 * suppose pour émettre ses `<tr>` sans retrier.
 *
 * Une entrée incohérente — des `colspan` dont la somme ne fait pas le nombre de
 * colonnes — ne produit pas une carte à trous : les colonnes restantes
 * deviennent des cellules ordinaires. **Chaque case a un propriétaire, toujours**,
 * parce que c'est de cet invariant que le contrôle d'ambiguïté tire sa validité.
 */
export function buildMergeMap(
  grid: TableGrid,
  columnSpans: readonly (readonly number[])[],
  rowMerges: readonly (readonly boolean[])[] = [],
): MergeMap {
  const rowCount = Math.max(0, grid.rowBoundaries.length - 1);
  const colCount = Math.max(0, grid.colBoundaries.length - 1);
  const cells: MergedCell[] = [];
  const ownerAt: number[][] = Array.from({ length: rowCount }, () => Array.from({ length: colCount }, () => -1));

  /** Le `colspan` d'une cellule qui COMMENCE à cette case, 0 sinon. Une table
   *  plutôt qu'une consommation séquentielle : dans une ligne partiellement
   *  couverte par une fusion venue du dessus, les cellules restantes ne
   *  commencent plus à la colonne 0. */
  const spanAt: number[][] = Array.from({ length: rowCount }, () => Array.from({ length: colCount }, () => 0));
  for (let row = 0; row < rowCount; row++) {
    let col = 0;
    for (const span of columnSpans[row] ?? []) {
      if (col >= colCount) break;
      spanAt[row]![col] = Math.min(Math.max(1, span), colCount - col);
      col += spanAt[row]![col]!;
    }
  }

  for (let row = 0; row < rowCount; row++) {
    for (let col = 0; col < colCount; col++) {
      if (ownerAt[row]![col] !== -1) continue;
      const colspan = spanAt[row]![col] || 1;

      // La fusion verticale ne s'étend que si TOUTES les colonnes couvertes
      // sont fusionnées vers le bas : une cellule reste un RECTANGLE. Une
      // fusion en escalier n'existe pas en HTML, et l'inventer produirait un
      // tableau que le générateur ne saurait pas rendre.
      let rowspan = 1;
      while (row + rowspan < rowCount) {
        const boundary = rowMerges[row + rowspan - 1];
        if (boundary === undefined) break;
        let allMerged = true;
        for (let c = col; c < col + colspan && allMerged; c++) allMerged = boundary[c] === true;
        if (!allMerged) break;
        rowspan += 1;
      }

      const index = cells.length;
      cells.push({ row, col, colspan, rowspan });
      for (let r = row; r < row + rowspan; r++) {
        for (let c = col; c < col + colspan; c++) ownerAt[r]![c] = index;
      }
    }
  }
  return { cells, ownerAt };
}

/**
 * La hauteur du bloc d'en-tête, LUE dans la fusion.
 *
 * Une cellule de la première ligne qui ENJAMBE la suivante décrit un en-tête à
 * deux niveaux : « Matières » et « Pos. » couvrent les deux lignes pendant que
 * « Moyennes » chapeaute ses sous-colonnes. Le bloc d'en-tête a donc la hauteur
 * de la plus grande de ces fusions.
 *
 * Sans fusion verticale, la valeur vaut 1 : la première ligne est l'en-tête,
 * c'est-à-dire la règle d'avant, inchangée.
 *
 * Pur : ni I/O, ni horloge, ni aléa.
 */
export function headerRowCount(merge: MergeMap | undefined): number {
  return Math.max(1, ...(merge?.cells ?? []).filter((cell) => cell.row === 0).map((cell) => cell.rowspan));
}
