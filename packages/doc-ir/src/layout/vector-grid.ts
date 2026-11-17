/** The grid a page DRAWS: which painted lines are a table's boundaries, how
 *  the vote picks a region's extent, and how many regions one page holds.
 *  NOT here: the borderless case, read from aligned columns
 *  (`layout/aligned-grid.ts`), the cells read from real intersections
 *  (`layout/intersection-cells.ts`), nor what a grid becomes
 *  (`extractor/pdf-table-render.ts`).
 *  Called by: `extractor/pdf-table-detector.ts` and
 *  `tools/pdf-geometry-probe.ts`, through the `layout/geometry.ts` façade. */

import type { ClassifiedLine, TableGrid } from "./geometry-types";
import { CLUSTER_TOLERANCE, clusterGroups, clusterPositions, MIN_BOUNDARIES } from "./position-clusters";
import { lowerBound } from "./intervals";
import { splitByOrientation } from "./painted-paths";
import { MIN_COVERAGE, SAME_POSITION_PT } from "./tolerances";

// A candidate border line must span at least this fraction of the grid's
// own bounding box on its cross-axis to be treated as part of THIS grid,
// rather than an unrelated mark elsewhere on the page (a footer rule, a
// decorative underline) that merely happens to be axis-aligned.
const MIN_SPAN_COVERAGE = MIN_COVERAGE;

// LES DEUX DISCRIMINANTS D'UNE FRONTIÈRE DE LIGNE LOCALE (10/09/2026).
//
// Une horizontale qui ne traverse qu'une PARTIE du tableau est la signature
// d'une fusion verticale : elle dit littéralement que les cellules qu'elle ne
// traverse pas sont fusionnées avec celles du dessous. Encore faut-il la
// distinguer d'une décoration, et l'accrochage seul n'y suffit pas — une barre
// à sa valeur maximale et un fond de cellule s'accrochent aussi bien qu'un vrai
// séparateur (revue du 10/09/2026, deux contre-exemples nommés).
//
// VALEURS DE DÉPART À CALIBRER, toutes les deux, au même titre que
// `WRAP_FILL_RATIO` de `layout/cell-text`.

// Une extrémité à moins de ceci d'une frontière de colonne établie tombe
// DESSUS. Même valeur que le regroupement, et pour la même raison.
const SEPARATOR_SNAP_TOLERANCE = SAME_POSITION_PT;

// Beyond this thickness it is no longer a rule but a FILL: a cell background
// or a data bar. Measured on two templates: rules at 0.1 and 0.5 pt, fills and
// bars at 6.5 / 8.0 / 16.1 / 18.0 / 29.4 pt. The gap is clear, but it rests on
// two producers: gap 14 showed that a producer may paint its borders as thin
// filled rectangles.
//
// TWO USES: a local separator must be thinner (step 5), and a lying fill's
// short side does not vote (step 2). For the second, measured 22/09/2026 on 38
// French and English PDFs: the short sides of lying rectangles are ≤ 1.68 pt
// (319 underlines) or ≥ 3 pt (107 fills). STARTING VALUE TO CALIBRATE, for
// both uses.
const MAX_SEPARATOR_THICKNESS = 2;

const overlapFraction = (aMin: number, aMax: number, bMin: number, bMax: number): number => {
  const span = bMax - bMin;
  if (span <= 0) return 0;
  const overlap = Math.min(aMax, bMax) - Math.max(aMin, bMin);
  return Math.max(0, overlap) / span;
};

/** Stage 1 of §8's detector: a real grid read from vector-drawn border
 *  lines. La PREMIÈRE région de la page — voir `buildGridsFromVectorLines`
 *  pour les suivantes. */
export function buildGridFromVectorLines(lines: readonly ClassifiedLine[]): TableGrid | undefined {
  return buildGridsFromVectorLines(lines)[0];
}

/** Nombre maximal de régions cherchées sur une page. Borne de sûreté, pas une
 *  limite de conception : la boucle s'arrête d'elle-même dès qu'aucun groupe de
 *  verticales ne s'accorde plus. Elle existe pour qu'un document pathologique ne
 *  puisse jamais faire tourner cette recherche indéfiniment. */
const MAX_REGIONS_PER_PAGE = 8;

/** Passes, ACCEPTED OR NOT, that one page may cost. A pass whose region is dropped (it sits inside a band already
 *  accepted: the inner edges of a wide fill box) consumes its group and costs a pass without adding a grid, so counting
 *  passes alone ended the search with a box unexamined: doc 02 page 13 needs 9 passes for 7 boxes, against a cap of 8
 *  (`vector-grid.test.ts`). A pass costs whether its grid is accepted, discarded (inside a band already accepted) or its
 *  vote failed (`judgeRegion`). Each pass consumes at least its seed, so the loop ends by itself; this only bounds the
 *  cost. STARTING VALUE TO CALIBRATE: one measured page (9 passes), twice the region cap kept as the margin. */
const MAX_PASSES_PER_PAGE = 2 * MAX_REGIONS_PER_PAGE;

/** Boundaries (rows, columns) of a REAL region: 2 each, i.e. at least 1 row x 1 column (3 each until 27/10/2026, see below). Two uses, both after a FAILED vote:
 *  a grid must have it to be kept, and the grid that licenses the search to go on must have it too (a title box or a strip
 *  licenses nothing). STARTING VALUE TO CALIBRATE, two populations measured on 15/10/2026. To find: doc 07 p18, "Cohorts",
 *  2 x 2. To refuse: with the search going on unconditionally, 40 of 1 107 fixture pages changed (page-edge 1 x 3 and
 *  1 x 1 frames of doc 06, 1 x 1 boxes of doc 49, one-column boxes of docs 04, 10, 43) and 3 false tables appeared on
 *  the 77 well-built Word PDFs of at most 15 pages (126, 128, plus doc 10 of docx-heading-reel, which lost a heading).
 *  With this rule and the licence: 4 of 1 107 fixture pages and 8 of 3 511 word-corpus pages change, every added grid
 *  being 2 x 2 or more; on the 77 PDFs tables found 219 -> 221 of 319, missed 100 -> 98, false 42 -> 42 (cells that
 *  agree 115 -> 119). The gap is a count of rules, not a continuum. */
const MIN_BOUNDARIES_AFTER_FAILED_VOTE = 2;
// 27/10/2026, 3 -> 2: the real region of doc 07 p18 ("Cohorts", ONE row x 2 columns in the Word truth) died at 3. The edge sliver that
// satisfied 3 by accident died with the invisible-repaint rule. Measured on five documents (071, 49, 02, 01, 07): the 24 other grid
// regions that open at 2 are ALL absorbed downstream (one-column fill, `isBoxesInVoidsRegion`); nothing new is published.

/** Boundaries (rows, columns) a grid needs to LICENSE the search past a failed vote: 2 each, i.e. ONE row x one column at least.
 *  It was 3 until 28/10/2026, to keep a title strip from reopening the search (the cascade of false grids measured on 15/10/2026).
 *  MEASURED AT 2 on the whole corpus (28/10/2026, 247 of 326 PDFs rerun — those with at least one region at 3; the other 79 have no
 *  accepted grid, so the licence cannot apply): +47 regions (+1,0 %), of which 38 are published FLAT, 2 refused and 7 become tables;
 *  6 tables published that were absent at 3, all 6 TRUE against their Word twin, 0 false, 0 table lost, `tableFalse` unchanged
 *  (`tableFound` +7, `tableMissed` -7). The 15/10 cascade did not reproduce. Its fiche is at `core/bounds.ts`.
 *  WRITTEN LIMIT: the words of those 38 flat regions are counted by the bench of the same lot, not by this constant's measure. */
const MIN_BOUNDARIES_TO_LICENSE_SEARCH = 2;

const licensesSearch = (grid: TableGrid): boolean =>
  grid.rowBoundaries.length >= MIN_BOUNDARIES_TO_LICENSE_SEARCH &&
  grid.colBoundaries.length >= MIN_BOUNDARIES_TO_LICENSE_SEARCH;

const isWeakRegion = (grid: TableGrid): boolean =>
  grid.rowBoundaries.length < MIN_BOUNDARIES_AFTER_FAILED_VOTE ||
  grid.colBoundaries.length < MIN_BOUNDARIES_AFTER_FAILED_VOTE;

/** Merged verticals above which a page reads no vector grid at all: it abstains, and the text flows on (prose, or the
 *  gutter and alignment stages). A safety cap on COST, not a design limit: the vote is indexed, but a page of tens of
 *  thousands of separate border pieces is a drawing, not a table. STARTING VALUE TO CALIBRATE: one population measured,
 *  the synthetic dense page of the 01/10/2026 review (4 800 / 10 000 / 20 000 pieces, 3 / 19 / 73 ms before the
 *  two-pass change, 49 / 1 868 / 7 126 ms after it); the real pages are NOT measured (no corpus probe authorised): the
 *  bench and the PDF suite are unchanged with the cap in place, so no tested fixture reaches it. */
export const MAX_MERGED_VERTICALS_PER_PAGE = 2_000;

/**
 * TOUTES les grilles d'une page, dans l'ordre où le vote les trouve.
 *
 * **Pourquoi il en faut plusieurs (10/09/2026).** Le vote de l'étape 2 choisit
 * le plus grand groupe de verticales d'accord sur leur étendue. Il a été bâti
 * contre l'écart 14, il fait exactement son travail — mais il suppose UN SEUL
 * tableau par page. Mesuré sur la page 2 d'un bulletin réel : cinq verticales
 * s'accordent sur l'étendue du tableau du socle, trois sur celle du tableau
 * qui continue la page 1, et **le second groupe n'était jamais examiné**. Son
 * texte redescendait en prose, un tableau entier perdu sans le moindre
 * signalement.
 *
 * **CE QUI EST CONSOMMÉ À CHAQUE PASSE EST LE GROUPE DU VOTE, PAS TOUT CE QUI A
 * ÉTÉ ADMIS — et la nuance est load-bearing.** Le cadre de page et le bord
 * gauche traversent PLUSIEURS tableaux : ils sont admis comme frontière dans
 * chacun, mais ils n'appartiennent au groupe d'aucun. Les retirer dès la
 * première passe priverait la région suivante de son bord droit, donc de sa
 * dernière colonne. Mesuré sur ce même document : le cadre à `x = 567` couvre
 * les deux tableaux, et c'est la frontière droite des deux.
 */
export function buildGridsFromVectorLines(lines: readonly ClassifiedLine[]): TableGrid[] {
  const { horizontals, verticals } = splitByOrientation(lines);
  if (horizontals.length < MIN_BOUNDARIES || verticals.length < MIN_BOUNDARIES) return [];

  // ÉTAPE 1 — FUSION DES COLINÉAIRES (défaut A de l'écart 14). Un séparateur de
  // colonne n'est PAS un trait continu chez la plupart des producteurs : c'est
  // une pile de segments, un par cellule. Mesuré : 45 segments pour une seule
  // abscisse. Mesurer un segment isolé, c'est mesurer une hauteur de ligne
  // (29,4 pt) là où on croit mesurer une colonne (401 pt).
  const mergedVerticals = mergeCollinear(
    verticals.map((v) => ({ at: v.x, lo: v.yMin, hi: v.yMax, thickness: v.thickness ?? 0 })),
    true,
  );
  const mergedHorizontals = mergeCollinear(
    horizontals.map((h) => ({ at: h.y, lo: h.xMin, hi: h.xMax, thickness: h.thickness ?? 0 })),
  );

  if (mergedVerticals.length > MAX_MERGED_VERTICALS_PER_PAGE) return [];

  const grids: TableGrid[] = [];
  let pool: readonly MergedLine[] = mergedVerticals;
  const search = { failedVotes: 0, lastPassFailed: false };
  for (let pass = 0; pass < MAX_PASSES_PER_PAGE && grids.length < MAX_REGIONS_PER_PAGE; pass++) {
    const region = buildOneRegion(pool, mergedHorizontals);
    if (region === undefined) break;
    pool = pool.filter((v) => !region.consumed.has(v));
    // A vote that yields no region (typically the two ends of ONE hyperlink underline, which tie with a real two-border
    // table and win by sitting higher) is consumed, and the search goes on ONLY IF a grid that LICENSES it is already
    // accepted on the page (`MIN_BOUNDARIES_TO_LICENSE_SEARCH`, 3: a one-row strip does not reopen the search).
    // Since 27/10/2026 a region found after such a failure is ACCEPTED from 2 row boundaries (one row — doc 07 p18, the
    // 1x2 "Cohorts" fragment whose Word truth holds one row); the measured ghosts this admits were all absorbed downstream
    // on five documents. WRITTEN LIMIT, unmeasured: a 1-row MULTI-column page-edge strip (the refuse population of 15/10)
    // would now publish if nothing downstream absorbs it — to be counted on the fixture corpus before any further loosening.
    // The unconditional continuation was measured and set aside (see `buildOneRegion`, tried 1).
    const verdict = judgeRegion(region.grid, grids.some(licensesSearch), search);
    if (verdict === "stop") break;
    if (verdict === "skip") continue;

    // LES RÉGIONS NE S'IMBRIQUENT PAS — et c'est une règle, pas un seuil.
    //
    // Ce que les passes suivantes trouvent d'abord, ce sont les RESTES de ce
    // qui a déjà été accepté : les séparateurs d'un tableau qui s'arrêtent une
    // ligne plus tôt, et surtout les arêtes verticales des barres colorées de
    // l'écart 15. Mesuré sur la page 2 d'un bulletin réel — cinq régions
    // trouvées là où le document en porte deux, et les trois intruses tombaient
    // TOUTES à l'intérieur de la bande d'une région déjà acceptée.
    //
    // Un tableau ne vit pas dans les lignes d'un autre. Le rendu suppose
    // d'ailleurs la même chose, puisqu'il descend la page en alternant prose et
    // tableau. Le groupe du vote est consommé quand même, sinon la même région
    // serait réélue à la passe suivante.
    //
    // LIMITE ACCEPTÉE ET NOMMÉE : deux tableaux CÔTE À CÔTE, à la même hauteur,
    // se recouvrent verticalement — le second serait donc écarté. Aucun cas
    // mesuré à ce jour, et c'est exactement le comportement d'aujourd'hui pour
    // les deux.
    const top = verdict.rowBoundaries[0]!;
    const bottom = verdict.rowBoundaries[verdict.rowBoundaries.length - 1]!;
    const overlapsAccepted = grids.some((g) => {
      const gTop = g.rowBoundaries[0]!;
      const gBottom = g.rowBoundaries[g.rowBoundaries.length - 1]!;
      return top > gBottom && bottom < gTop;
    });
    if (!overlapsAccepted) grids.push(verdict);
  }
  return grids;
}

/** What to do with the region a vote produced: the grid to take, `"skip"` or `"stop"`.
 *  `"skip"` (the vote failed, its lines are consumed, the next vote is tried) is allowed ONLY once the page holds a real
 *  table (`realTableAccepted`) and never twice in a row. `"stop"` ends the search, as before: with no real table yet, a
 *  failed vote (an underline) is the brake that keeps invisible page frames from becoming grids (27 p1, 29 p5, 24 p1);
 *  two failures in a row are too much noise to trust the next region. Skipping blindly was measured: false grids. */
function judgeRegion(
  grid: TableGrid | undefined,
  realTableAccepted: boolean,
  state: { failedVotes: number; lastPassFailed: boolean },
): TableGrid | "skip" | "stop" {
  if (grid === undefined) {
    if (!realTableAccepted || state.lastPassFailed) return "stop";
    state.failedVotes++;
    state.lastPassFailed = true;
    return "skip";
  }
  state.lastPassFailed = false;
  return state.failedVotes > 0 && isWeakRegion(grid) ? "stop" : grid;
}

/** Une région : le vote, l'admission, et les verticales que ce vote CONSOMME. */
function buildOneRegion(
  mergedVerticals: readonly MergedLine[],
  mergedHorizontals: readonly MergedLine[],
): { grid: TableGrid | undefined; consumed: Set<MergedLine> } | undefined {
  // STEP 2 — THE EXTENT BY VOTE, NOT BY THRESHOLD (defect B of gap 14).
  //
  // The old version took the reference extent over ALL lines, page frame
  // included, then required a vertical to cover 60 % of it. The frame thus set
  // the reference to the whole sheet, and no table separator could reach it:
  // 213 real verticals, ONE survivor. The original comment said this filter
  // kept "an isolated mark from making a false column"; its real effect was the
  // reverse: the isolated mark was the frame, and it eliminated the real grid.
  //
  // A mutual overlap was tried and MEASURED INSUFFICIENT: on a second document
  // the table filled 82 % of the page height, so the frame passed the 60 %
  // threshold again and the extent reopened on the sheet. A threshold on a
  // continuum does not separate these two populations.
  //
  // What really separates them is in the data: the separators of one table
  // have NEARLY IDENTICAL intervals (seven times `[66 ; 707]`), while the frame
  // is ALONE on its interval. Hence a vote, the largest group of verticals
  // agreeing on their extent, and a vote does not depend on the ratio between
  // the table's height and the page's.
  //
  // A LYING FILL DOES NOT VOTE (22/09/2026). The short side of a filled
  // rectangle wider than tall is a vertical as long as the rectangle is thick.
  // Two such sides agree with each other exactly, so a logo fill ties with a
  // two-border table and wins the tie by height (`largestAgreeingExtent`);
  // its region then fails and the search stops. Measured on safedocs 0000754:
  // both instruction tables lost to prose.
  //
  // The rule: thicker than a rule (`MAX_SEPARATOR_THICKNESS`) AND no longer
  // than its thickness plus `CLUSTER_TOLERANCE`. Two existing constants, no new
  // one. The two populations, measured on 38 French and English PDFs, among
  // verticals thicker than 2 pt, length minus thickness: -5.70 to 0.29 pt for
  // the short sides of lying fills (107), 4.46 pt and more for everything else
  // (128: standing fills, page frames). STARTING VALUE TO CALIBRATE; the 0.29
  // comes from Canva's rounded fills. Such a vertical stays ADMISSIBLE as a
  // boundary (step 3); it is only kept out of the vote. Effect measured: 6
  // pages change in 4 documents, no false grid gained.
  //
  // WHAT IS SAFE BY CONSTRUCTION. A border painted as a thin fill (0.48 pt on
  // 0000754) is at most 2 pt thick, so it still votes; a standing fill (the
  // bars of gap 15) is longer than its thickness by at least 4.46 pt. Remaining
  // risk: a table painted ONLY with lying row backgrounds and no rule loses its
  // stage-0 grid. None in the corpus; 0000109's highlight bands come closest.
  // Since 15/10/2026 their regions are found on p1 and p2 (after a failed vote) and refused downstream
  // (`isBoxesInVoidsRegion`): no table is published (`pdf-vector-failed-vote.fixtures.test.ts`).
  //
  // TRIED AND SET ASIDE, so nobody does it again:
  // 1. **Keeping the search going after a failed region** instead of stopping:
  //    8 false grids. NARROWED 15/10/2026 (`judgeRegion`): it goes on only on a page with a real table and keeps
  //    only 2 x 2 regions or more.
  // 2. **Also keeping THIN short sides out of the vote** (underlines, ≤ 1.68
  //    pt; 22/09/2026). An underline stops the search on 35 passes
  //    over 18 documents and never yields a region, yet it acts as a brake:
  //    without it, 27 p1 and 29 p5 gain a false table (an invisible page
  //    frame), 24 p1, 29 p6 and 0000523 p2 a mute grid, and document 29 loses
  //    5 of its 29 `h1` headings, turned into bold paragraphs. Its only target,
  //    0000713 p2, stays refused: the 9 × 2 grid is then found, and refused for
  //    67 glyphs outside its columns. WRITTEN LIMIT: on 0000713 p2 the
  //    underline still wins and stops the search.
  //    RETRIED 01/10/2026 on the bench documents (a vertical of at most 2 pt and no longer than its thickness
  //    + 2 pt stays out of the vote). It fixes doc 07: the Word hyperlink underlines (10 ends of 0.60-0.84 pt, against
  //    table borders of 296.31 pt and more) beat the table borders 2 votes to 1 on pages 9 and 12 of the bench, and
  //    07 went from 2 to 4 tables of 4, the other six bench documents unmoved. It breaks FIVE existing tests, so it
  //    was reverted: `pdf-block-images` (24 p1, two tests: a fourth image), `pdf-page-decoration` (24 p1), `pdf-cell-prose`
  //    (0000713: 139 paragraphs instead of 141) and `pdf` (29 p5, a centred line). The brake is real on those pages.
  //    Real marks of the two 07 pages: `layout/vector-grid.test.ts` (expected failures). A rule that lets 07 through
  //    and keeps the brake on 24, 29 and 0000713 needs a discriminant measured ON THOSE DOCUMENTS (not done: out of scope).
  //
  // WRITTEN LIMITS, bench of 01/10/2026 (no discriminant defined, so we abstain; words are kept in every case):
  // 1. **A banner painted as ONE lone fill is no grid** (doc 06 p8: "PRO-FORMA TO BE SUBMITTED ON COMPANY HEADED PAPER",
  //    a 405.9 x 19.6 pt fill with no rule). Its two short sides are lying fill ends, which do not vote; the truth is a
  //    one-cell table, we publish a heading. Letting such a side vote is the 22/09 rule undone (logo fills).
  // 2. **A stack of shaded text lines reads as a one-column table** (doc 08 p13, the one false grid of the bench: ten
  //    link lines, each on a 14.6 pt band from x = 65.5 to 566.5, bands touching). The touching bands chain into one
  //    border per side (`mergeCollinear`), which is no longer a lying fill. Doc 02 p13 shows why a "fills only, no rule"
  //    veto is not safe: its seven code boxes, true one-cell tables, are painted with fills alone. Nothing measured
  //    tells a shaded paragraph from a shaded one-column table (row count: 3 boundaries per true box against 11 here,
  //    two populations of one document each: not a threshold).
  // 3. **A one-cell table with no mark at all** (doc 06 p5, the title "Security Administrator Form": the topmost mark of
  //    the page is the 4-column grid below it). Nothing to read; the heading is published.
  const vote = largestAgreeingExtent(mergedVerticals.filter((v) => !isLyingFillEnd(v)));
  if (vote === undefined) return undefined;
  const rowExtent = vote.extent;
  const consumed = new Set(vote.members);

  // ÉTAPE 3 — l'admission, elle, reste généreuse : toute verticale qui COUVRE
  // l'emprise en est une frontière. C'est ce qui récupère le bord droit du
  // tableau quand il est confondu avec le cadre de page (mesuré : une seule
  // abscisse porte les deux), et les séparateurs qui s'arrêtent une ligne plus
  // tôt.
  const gridVerticals = mergedVerticals.filter(
    (v) => overlapFraction(v.lo, v.hi, rowExtent.lo, rowExtent.hi) >= MIN_SPAN_COVERAGE,
  );
  const colBoundaries = clusterPositions(gridVerticals.map((v) => v.at)).sort((a, b) => a - b);
  if (colBoundaries.length < MIN_BOUNDARIES) return { grid: undefined, consumed };

  // ÉTAPE 4 — les horizontales sont bornées à l'emprise du tableau, EN PLUS de
  // devoir le traverser. Sans la borne, les horizontales du cadre — qui
  // traversent toute la largeur, donc passent le test de couverture — rouvrent
  // la grille sur la feuille et y aspirent l'en-tête et le pied de page.
  const colExtent = { lo: colBoundaries[0]!, hi: colBoundaries[colBoundaries.length - 1]! };

  // ÉTAPE 5 — LES FRONTIÈRES LOCALES, celles qui portent le `rowspan`.
  //
  // Le séparateur entre les deux niveaux d'un en-tête ne court que sous les
  // sous-colonnes qu'il sépare : mesuré à 11 % de la largeur du tableau sur un
  // bulletin réel, donc rejeté par le seuil de couverture. C'était le MÊME
  // défaut que l'écart 14, sur l'autre axe — un seuil qui jette précisément le
  // signal cherché.
  //
  // Deux garde-fous, parce que l'accrochage seul ne suffit pas (§3.1 du plan) :
  // les deux extrémités tombent sur des frontières de colonne DÉJÀ établies, et
  // la source est un filet, pas un aplat.
  //
  // MESURÉ AVANT D'ÊTRE ÉCRIT : sur la page du bulletin, 16 horizontales
  // fusionnées, 15 déjà gardées, et EXACTEMENT UNE admise par cette règle —
  // celle qu'on cherche. Sur la page du tableau du socle, aucune.
  const snapsToColumn = (x: number): boolean => colBoundaries.some((b) => Math.abs(b - x) <= SEPARATOR_SNAP_TOLERANCE);
  const isLocalSeparator = (h: MergedLine): boolean =>
    h.hi > h.lo && h.thickness <= MAX_SEPARATOR_THICKNESS && snapsToColumn(h.lo) && snapsToColumn(h.hi);

  const gridHorizontals = mergedHorizontals.filter(
    (h) =>
      (overlapFraction(h.lo, h.hi, colExtent.lo, colExtent.hi) >= MIN_SPAN_COVERAGE || isLocalSeparator(h)) &&
      h.at >= rowExtent.lo - CLUSTER_TOLERANCE &&
      h.at <= rowExtent.hi + CLUSTER_TOLERANCE,
  );
  const rowBoundaries = clusterPositions(gridHorizontals.map((h) => h.at)).sort((a, b) => b - a);
  if (rowBoundaries.length < MIN_BOUNDARIES) return { grid: undefined, consumed };
  return { grid: { rowBoundaries, colBoundaries }, consumed };
}

/** How close a painted line must lie to an image side, and how far at most it may
 *  run past it, to be that side's frame. The collinear-grouping tolerance, reused. */
const IMAGE_FRAME_TOLERANCE = CLUSTER_TOLERANCE;

/**
 * THE PAINTED LINES MINUS IMAGE FRAMES (22/09/2026). A rectangle whose FOUR sides
 * each run along one image is a frame around that image, never a grid border.
 * Safedocs 0000754 strokes a grey 1-pt rectangle 0.5 pt outside each screenshot;
 * two such frames share an abscissa, merge, cover 60.5 % of the table's height
 * (`MIN_SPAN_COVERAGE`), and gave the table two empty columns.
 *
 * A side is a line parallel to an image side, within `IMAGE_FRAME_TOLERANCE` of
 * it, whose extent stays within the image's own ± the same tolerance. Measured on
 * 39 French and English PDFs, lines within 2 pt of an image side: frames at d ≤
 * 1.6 pt overhanging the image side by ≤ 0.65 pt (27 lines), against real table
 * borders overhanging it by ≥ 29.15 pt (13 lines). No real border makes the four
 * sides of an image. STARTING VALUES TO CALIBRATE. The d gap is narrow: 1.6
 * against 2.57 pt, the lower edge of the 0000669 footer on its colour band, which
 * has no overhang. Effect measured: one page changes, 0000754 p1 (grid 8 × 4 →
 * 4 × 2).
 *
 * TRIED AND SET ASIDE, so nobody does it again:
 * 1. **"Edge", line by line**: every line along an image side, framed or not
 *    (49 lines, 4 documents). It makes a false 1 × 2 grid "Ecran PC | GSM" on
 *    fixture 24 p7: the left edge of the GSM box, glued to the screenshot,
 *    leaves, and the vote admits the rest.
 * 2. **"Contained in an image"**: every line inside an image's box. 26 p1 moves
 *    711 words of its table to p4 to p7, and 24 p7 and p8 lose their grids.
 */
export function withoutImageFrames(
  lines: readonly ClassifiedLine[],
  images: readonly { xMin: number; xMax: number; yMin: number; yMax: number }[],
): ClassifiedLine[] {
  const T = IMAGE_FRAME_TOLERANCE;
  type Side = "left" | "right" | "bottom" | "top";
  const sideOf = (l: ClassifiedLine, b: (typeof images)[number]): Side | undefined => {
    if (l.orientation === "vertical") {
      if (l.yMin < b.yMin - T || l.yMax > b.yMax + T) return undefined;
      if (Math.abs(l.x - b.xMin) <= T) return "left";
      if (Math.abs(l.x - b.xMax) <= T) return "right";
      return undefined;
    }
    if (l.xMin < b.xMin - T || l.xMax > b.xMax + T) return undefined;
    if (Math.abs(l.y - b.yMin) <= T) return "bottom";
    if (Math.abs(l.y - b.yMax) <= T) return "top";
    return undefined;
  };
  const framed = images.filter(
    (b) => new Set(lines.map((l) => sideOf(l, b)).filter((s) => s !== undefined)).size === 4,
  );
  if (framed.length === 0) return [...lines];
  return lines.filter((l) => !framed.some((b) => sideOf(l, b) !== undefined));
}

/** Une ligne fusionnée : une position, et l'étendue UNION de tous les segments
 *  qui la composent. */
export interface MergedLine {
  at: number;
  lo: number;
  hi: number;
  /** La source la plus FINE parmi les segments réunis. Un aplat et un filet
   *  peuvent partager une position — le bord d'un fond de cellule coïncide avec
   *  la bordure qu'il longe. Prendre le minimum répond donc à la seule question
   *  utile : « y a-t-il un vrai trait ici ? » */
  thickness: number;
}

/** Regroupe par position (à `CLUSTER_TOLERANCE` près) et prend l'union des
 *  étendues. C'est tout le défaut A : sans cette étape, chaque segment est
 *  mesuré seul.
 *
 *  ⚠️ L'UNION EST DESTRUCTRICE, ET C'EST UN DÉFAUT CONNU, NON CORRIGÉ. Quand un
 *  segment en contient un autre à la même position, l'union vaut le contenant et
 *  le contenu DISPARAÎT. Mesuré le 11/09/2026 sur un bulletin réel : à la marge
 *  gauche de la page 1, trois structures partagent l'abscisse — le bord du cadre
 *  de page, le bord du tableau peint en quatorze segments contigus, et le bord
 *  d'un encadré d'en-tête. Le cadre avale les deux autres, l'encadré perd son
 *  étendue propre, aucun vote ne peut se former autour de lui, et le CADRE
 *  disparaît du rendu sans signalement. **Son texte, lui, reste** : vérifié le
 *  15/09/2026, les sept fragments de l'encadré sont dans la sortie, en prose.
 *
 *  ESSAYÉ PUIS ÉCARTÉ le même jour, pour que personne ne le refasse :
 *
 *  1. **Exclure de la fusion tout segment qui en contient un autre**, en le
 *     gardant admissible comme frontière. Isole bien l'encadré — il ressort en
 *     région 1x1 à ses coordonnées exactes — mais ne suffit pas seul : les
 *     quatorze segments du tableau et le bord de l'encadré sont TOUS des
 *     non-contenants, donc leur union les remélange. Il faut les chaîner, donc
 *     réintroduire une distance.
 *  2. **Chaîner les restants par leur écart.** Mort à la mesure. Sur les filets
 *     seuls — les barres pleines de l'écart 15 faussaient une première
 *     mesure —, les écarts entre pièces d'un MÊME séparateur valent 20,2 / 29,0
 *     / 29,0 pt, et ceux entre structures DIFFÉRENTES 10,1 / 10,1 / 26,3 / 26,3
 *     / 33,7 pt. Les deux séries s'entrelacent : aucune coupure n'existe. À 2 pt
 *     de tolérance, un vrai séparateur de la page 2 peint en morceaux distants
 *     de 2,4 pt se brisait, et le tableau perdait deux colonnes.
 *
 *  CE QUE ÇA DIT. Le sujet n'est pas le critère de fusion, c'est le fait même de
 *  réduire chaque abscisse à UNE SEULE étendue avant de décider. Les deux
 *  architectures de référence ne créent jamais ce problème : pdfplumber part des
 *  intersections et retient la plus petite cellule dont les quatre côtés sont
 *  reliés, pdf2docx construit la grille théorique à partir de TOUTES les
 *  coordonnées puis teste la présence de chaque frontière
 *  (`docs/ETUDE-BIBLIOTHEQUES-PDF.md` [purged 27/09/2026, git history], §2 et §11).
 *  3. **Remplacer ce chemin par les intersections**, à la manière de pdfplumber.
 *     Écarté le 15/09/2026 après mesure : voir `findCellsByIntersection`.
 *
 *  UPDATE 01/10/2026, VERTICALS ONLY (`cutUncrossedGaps`). Item 2 above is not dead
 *  for every gap, only for the gap SIZE: what separates the two populations is
 *  what crosses the gap. Measured on docx-reel 02, 06, 07 and safedocs 0000441,
 *  0000713, 0000754, fixture 26 (every same-abscissa gap over 2 pt): a border
 *  painted in pieces has another border running across the gap (0000713 p3:
 *  18.4 and 19.2 pt, crossed by the left border; the synthetic 2.4 pt one of
 *  the detector test); stacked tables and an underline's end beside a border
 *  have nothing across it (07 p13: 14.2 to 18.3 pt; 0000441 p1: 36 pt). The
 *  sizes interleave, the crossing does not. Cutting at EVERY gap (a plain
 *  "chain within 2 pt") was tried the same day and set aside: it split the
 *  borders of 0000713 p3, and the grid lost its right column. HORIZONTALS keep
 *  the union: no measurement asked for the cut. WRITTEN LIMIT: a page frame
 *  crosses every gap, so beside one the union stays (today's behaviour).
 *
 *  CE DÉFAUT RESTE, ET IL EST ACCEPTÉ : il perd un cadre, jamais du texte, et le
 *  critère du produit est la recherche. `npm run check` est resté VERT pendant
 *  qu'une page 2 perdait deux colonnes : le seul document qui exerce ce code est
 *  hors dépôt. */
export function mergeCollinear(segments: readonly MergedLine[], cutUncrossedGaps = false): MergedLine[] {
  // The members of each abscissa are the chained group's own (never a window around its centre); one sort, no rescans
  // (indexed 01/10/2026: 20 000 pieces cost 7 s when each abscissa scanned the whole page).
  const groups = clusterGroups(segments, (s) => s.at);
  if (!cutUncrossedGaps) {
    return groups.map(({ center: at, members }) => {
      const union: MergedLine = { at, lo: Infinity, hi: -Infinity, thickness: Infinity };
      for (const m of members) {
        union.lo = Math.min(union.lo, m.lo);
        union.hi = Math.max(union.hi, m.hi);
        union.thickness = Math.min(union.thickness, m.thickness);
      }
      return union;
    });
  }

  // Chain each abscissa into runs of segments that touch (within `CLUSTER_TOLERANCE`).
  const runsByPosition = groups.map(({ center: at, members }) => {
    const runs: MergedLine[] = [];
    for (const m of [...members].sort((a, b) => a.lo - b.lo || a.hi - b.hi)) {
      const last = runs[runs.length - 1];
      if (last !== undefined && m.lo <= last.hi + CLUSTER_TOLERANCE) {
        last.hi = Math.max(last.hi, m.hi);
        last.thickness = Math.min(last.thickness, m.thickness);
      } else runs.push({ at, lo: m.lo, hi: m.hi, thickness: m.thickness });
    }
    return runs;
  });
  // A GAP between two runs of one abscissa is a CUT only when no run at ANOTHER abscissa crosses it. A border painted
  // in pieces is bridged by the table's other borders (the left one runs on across the gap); two stacked tables, or
  // an underline's end beside a border, have nothing across it. Measured: pieces of one separator (0000713 p3: gaps
  // 18.4 and 19.2 pt, bridged by the left border; a test fixture: 2.4 pt) against separate structures (07 p13: gaps
  // 14.2 to 18.3 pt, nothing across): the sizes interleave, the crossing does not. STARTING RULE, not a calibrated
  // threshold: it only reuses `CLUSTER_TOLERANCE`.
  //
  // The question is « does a run of another abscissa start at or before `a.hi + tol` and end at or after `b.lo - tol` »:
  // the runs sorted by start, with a running best end per prefix (the two best ends of two DIFFERENT abscissae, so that
  // the asker's own abscissa can be set aside), answer it by binary search. The runs are never modified (the output
  // holds copies), so the index is built once. Two distinct abscissae are more than `CLUSTER_TOLERANCE` apart (cluster
  // centres of separated clusters), so « another abscissa » is « another index ».
  const byStart = runsByPosition
    .flatMap((runs, group) => runs.map((run) => ({ run, group })))
    .sort((a, b) => a.run.lo - b.run.lo);
  interface PrefixBest {
    hi: number;
    group: number;
    otherHi: number;
  }
  const prefix: PrefixBest[] = [];
  for (const { run, group } of byStart) {
    const prev = prefix[prefix.length - 1] ?? { hi: -Infinity, group: -1, otherHi: -Infinity };
    if (run.hi > prev.hi) {
      prefix.push({ hi: run.hi, group, otherHi: group === prev.group ? prev.otherHi : prev.hi });
    } else if (group !== prev.group && run.hi > prev.otherHi) {
      prefix.push({ hi: prev.hi, group: prev.group, otherHi: run.hi });
    } else prefix.push(prev);
  }
  const crossed = (a: MergedLine, group: number, b: MergedLine): boolean => {
    const upTo = lowerBound(byStart.length, (i) => byStart[i]!.run.lo > a.hi + CLUSTER_TOLERANCE);
    if (upTo === 0) return false;
    const best = prefix[upTo - 1]!;
    return (best.group === group ? best.otherHi : best.hi) >= b.lo - CLUSTER_TOLERANCE;
  };
  return runsByPosition.flatMap((runs, group) => {
    const out: MergedLine[] = [];
    for (const r of runs) {
      const last = out[out.length - 1];
      if (last !== undefined && crossed(last, group, r)) {
        last.hi = Math.max(last.hi, r.hi);
        last.thickness = Math.min(last.thickness, r.thickness);
      } else out.push({ ...r });
    }
    return out;
  });
}

/** The short side of a lying fill: thicker than a rule, and no longer than
 *  its own thickness — see step 2 of `buildOneRegion`. */
const isLyingFillEnd = (v: MergedLine): boolean =>
  v.thickness > MAX_SEPARATOR_THICKNESS && v.hi - v.lo <= v.thickness + CLUSTER_TOLERANCE;

/**
 * The extent on which the GREATEST NUMBER of lines agree, both ends within
 * `CLUSTER_TOLERANCE`.
 *
 * The grouping is deliberately TIGHT here and the admission generous above:
 * that combination is what holds. Tight to find the extent, because a page
 * frame agrees with no one; generous to admit boundaries, because a separator
 * may stop one row early.
 *
 * On a tie, the HIGHEST group wins (`hi` descending, then `lo` ascending): an
 * arbitrary but deterministic choice, a condition of the golden master. Two
 * lines that agree only because they are the two ends of ONE mark tie with a
 * real two-border table and win when they sit higher: the lying fills are
 * therefore filtered out before this call, the thin underlines are not (step
 * 2 says why).
 */
export function largestAgreeingExtent(
  lines: readonly MergedLine[],
): { extent: MergedLine; members: MergedLine[] } | undefined {
  // Indexed by `lo`: the lines agreeing with a seed all lie in its `lo` window, found by binary search, instead of a scan of every
  // line per seed. The members come back in the input order, as before.
  const order = lines.map((_, i) => i).sort((a, b) => lines[a]!.lo - lines[b]!.lo || a - b);
  let best: { extent: MergedLine; members: MergedLine[] } | undefined;
  let bestCount = 0;
  for (const seed of lines) {
    const first = lowerBound(order.length, (i) => lines[order[i]!]!.lo >= seed.lo - CLUSTER_TOLERANCE);
    const agreeing: number[] = [];
    for (let k = first; k < order.length && lines[order[k]!]!.lo <= seed.lo + CLUSTER_TOLERANCE; k++) {
      if (Math.abs(lines[order[k]!]!.hi - seed.hi) <= CLUSTER_TOLERANCE) agreeing.push(order[k]!);
    }
    const better =
      best === undefined ||
      agreeing.length > bestCount ||
      (agreeing.length === bestCount &&
        (seed.hi > best.extent.hi || (seed.hi === best.extent.hi && seed.lo < best.extent.lo)));
    if (better) {
      best = { extent: seed, members: [...agreeing].sort((a, b) => a - b).map((i) => lines[i]!) };
      bestCount = agreeing.length;
    }
  }
  return best;
}
