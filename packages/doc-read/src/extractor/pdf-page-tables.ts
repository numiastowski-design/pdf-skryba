/** A page carrying grids, laid out in full: every table it renders, the prose
 *  between them, and the images — in the flow, or in the cell holding their centre.
 *  NOT here: the rendering of one grid (`extractor/pdf-table-render.ts`), the
 *  reading order of the regions (`extractor/pdf-region-order.ts`), nor the
 *  fallback when nothing renders — the caller's, in `extractor/pdf.ts`.
 *  Called by: `extractor/pdf.ts`. */

import type { ImageRef, IRBlock } from "doc-ir/lib/ir";
import type { MergeMap, TableGrid } from "doc-ir/layout/geometry";
import { gridBandOf, type GridBand } from "doc-ir/layout/grid-band";
import type { HeadingLevel } from "doc-ir/layout/heading-sizes";
import { holdsPoint, RECT_RULES, rawFromEdges } from "doc-ir/layout/rect-rules";
import type { GlyphFragment } from "./glyph-positions";
import { bandedSplit } from "./pdf-bands";
import { imageRegion, placeImages } from "./pdf-image-anchors";
import { groupItemsIntoLines } from "./pdf-lines";
import type { ImageCandidate, Line, PositionedItem } from "./pdf-model";
import { paragraphsFromSegment } from "./pdf-paragraphs";
import { interleaveRegions } from "./pdf-region-order";
import { segmentsInDeclaredOrder } from "./pdf-reading-order";
import type { PdfTextRun } from "./pdf-source";
import { renderTableRegion } from "./pdf-table-render";

/** The top/bottom of the rendered regions that hold a table block (a region published flat carries no band). */
const tableBandsOf = (
  rendered: readonly { top: number; bottom: number; blocks: readonly IRBlock[] }[],
): { top: number; bottom: number }[] =>
  rendered.filter((r) => r.blocks.some((b) => b.kind === "table")).map((r) => ({ top: r.top, bottom: r.bottom }));

/**
 * UNE PAGE PEUT PORTER PLUSIEURS TABLEAUX, et jusqu'au 10/09/2026 elle n'en
 * rendait qu'un.
 *
 * Mesuré sur la page 2 d'un bulletin réel : deux régions, celle du tableau de
 * maîtrise du socle et celle qui continue le tableau de la page 1. Le vote qui
 * choisit l'emprise ne retenait que la première ; le texte de la seconde
 * redescendait en prose, **un tableau entier perdu sans signalement**.
 *
 * La prose est reconstruite entre les régions, et non plus seulement avant et
 * après une région unique : on descend la page, on écrit ce qui précède la
 * région courante, puis son tableau, et on recommence.
 *
 * **L'INVARIANT SE JUGE RÉGION PAR RÉGION, et c'est plus fin qu'avant.** Une
 * région qui ne s'explique pas retombe en texte plat **sans emporter les
 * autres** — ses items redeviennent de la prose parce qu'aucun tableau ne les
 * réclame, ce qui est exactement le repli d'avant, à sa seule région près.
 */
export function renderPageTables(
  pageItems: readonly PdfTextRun[],
  regions: readonly { grid: TableGrid; merge?: MergeMap }[],
  glyphs: readonly GlyphFragment[],
  isBold: (item: PositionedItem) => boolean,
  wordWidthAt: (y: number, left?: number) => number,
  cut?: { cut: number; above: number },
  /** The bitmap marker placed before an item — see `linesFromGroups`. A page with a grid carries prose too, and that is
   *  where a bulletin's legend lives. */
  markerBefore?: (item: PositionedItem) => ImageRef | undefined,
  /** Le niveau de titre d'une taille — décidé à l'échelle du DOCUMENT, donc
   *  passé depuis l'appelant plutôt que recalculé sur cette page. */
  headingLevelOf?: (size: number) => HeadingLevel | undefined,
  /** Les grandes images de la page, pas encore lues — voir `placeImages`. */
  imageCandidates: readonly ImageCandidate[] = [],
  /** The container two lines share — see `pdf-line-breaks.ts#centredContainerReader`. */
  centredContainer?: (line: Line, next: Line, segment: readonly Line[]) => number | undefined,
  /** Receives what a rendered table removes on purpose — see `renderTableRegion`. */
  recordRemoval?: (text: string) => void,
  /** The vertical extent of each region's grid, when the caller already measured it (`PageContext.bands`). */
  gridBands: readonly GridBand[] = regions.map((region) => gridBandOf(region.grid)),
  /** Receives the top/bottom of each region published AS A TABLE, top to bottom (`tableBands` of the outcome): a region published
   *  flat is prose and carries no band — see where the array is built. */
  recordBands?: (bands: { top: number; bottom: number }[]) => void,
  /** The rank the document's structure tree gives a cycle (`./pdf-reading-order`), absent on an untagged page: the prose around the tables
   *  is read in that order too (a grid the table stage did not rebuild came out line by line across its cells: corpus doc 290, 22/10/2026; held
   *  by fixture 38 p. 7, `pipeline/letter-conservation.fixtures.test.ts`).
   *  Limit, written: a prose chunk the bounded cut splits into side-by-side blocks (`columns`) keeps its geometric order. */
  declaredRank?: (item: PdfTextRun) => number | undefined,
): IRBlock[] | undefined {
  // AN IMAGE WHOSE CENTRE IS INSIDE A GRID'S BOX, ON BOTH AXES, goes into that
  // grid's cell if the grid renders (21/09/2026, O1 and O4). An image
  // beside a table — in its height, not its width — stays in the page flow: on
  // fixture 24 page 3, once glyph widths exist, a small grid (x 242.7-353.4)
  // would otherwise swallow the two QR code pictures beside it. The
  // first grid whose box holds the centre claims the image; if that grid does
  // not render, the image goes back to the flow — judged against RENDERED
  // tables, never DETECTED grids (on fixture 24, a never-rendered row once set
  // aside 43R and 45R on page 3 and 72R on page 8).
  const boxes = regions.map(({ grid }, i) => ({
    ...gridBands[i]!,
    xMin: grid.colBoundaries[0]!,
    xMax: grid.colBoundaries[grid.colBoundaries.length - 1]!,
  }));
  const boxRects = boxes.map((b) => rawFromEdges({ left: b.xMin, right: b.xMax, bottom: b.bottom, top: b.top }));
  const claimedBy = imageCandidates.map((c) => {
    const x = (c.xMin + c.xMax) / 2;
    const y = (c.top + c.bottom) / 2;
    return boxRects.findIndex((r) => holdsPoint(RECT_RULES["grid-claim"], r, x, y));
  });
  const rendered = regions
    .map((region, i) => ({
      ...boxes[i]!,
      // A table block, or — one content column — the cells' blocks flat (`renderTableRegion`): either way the region's band is consumed.
      blocks: renderTableRegion(
        region.grid,
        glyphs,
        region.merge,
        imageCandidates.flatMap((c, k) => (claimedBy[k] === i ? [c] : [])),
        recordRemoval,
      ),
      index: i,
    }))
    .filter((r): r is typeof r & { blocks: IRBlock[] } => r.blocks !== undefined)
    .sort((a, b) => b.top - a.top);
  if (rendered.length === 0) return undefined;
  // ONLY THE BANDS OF THE REGIONS PUBLISHED AS A TABLE (26/10/2026). Its one consumer is the letters control, which CUTS these
  // bands out of the prose it judges (`pipeline/letter-conservation.ts#proseOrder`, which also reads the page `withoutTables`).
  // A region published flat is prose: its text stays in the page's reading, so cutting its band would drop the page out of the
  // order judgement — seen biting on fixtures 24, 33 and 44, and on the control that swaps two paragraphs of fixture 24 page 2
  // (it came back « ok », so the guard no longer bit).
  recordBands?.(tableBandsOf(rendered));

  // LA PROSE AUTOUR DES TABLEAUX PASSE PAR LA LECTURE EN BANDES (11/09/2026).
  // C'est ici, et pas au niveau de la page, que la coupe bornée doit agir : une
  // page à grille sort par `renderPageTables` et n'atteint JAMAIS le
  // `readingSegments` de la boucle principale. L'en-tête d'un bulletin restait
  // donc tressé quelle que soit la coupe produite — mesuré avant d'être corrigé.
  //
  // Passer TOUS les morceaux de prose est sans risque : `readingSegments`
  // n'examine que les lignes situées au-dessus de sa borne, donc un morceau
  // situé sous la grille ne porte aucune ligne éligible, rend un segment unique,
  // et retrouve exactement le comportement d'avant.
  /** `classe` à FAUX pour le contenu d'un bloc côte à côte — voir `prose`. */
  const asBlocks = (segment: PdfTextRun[][], classe = true): IRBlock[] =>
    // Outside a TABLE: a DETECTED grid is enough to forbid, rendered or not — that is what tells prose from a cell's line.
    paragraphsFromSegment(segment, { isBold, wordWidthAt, markerBefore, headingLevelOf, centredContainer }, classe);
  const prose = (items: readonly PdfTextRun[]): IRBlock[] => {
    const split = bandedSplit(items, cut?.cut, cut?.above);
    if (split === undefined) {
      const lines = groupItemsIntoLines(items);
      return declaredRank === undefined
        ? asBlocks(lines)
        : segmentsInDeclaredOrder([lines], declaredRank).flatMap((segment) => asBlocks(segment));
    }
    // DEUX BLOCS CÔTE À CÔTE, PAS DEUX SUITES DE PROSE. Empilés, ils se lisent
    // dans le bon ordre mais perdent le fait qu'ils sont côte à côte ; en
    // tableau, ils mentiraient sur leur nature (Matterhorn 15-004). Le bloc
    // `columns` dit exactement ce que le document montre.
    // AUCUNE TITRAILLE DANS UN BLOC CÔTE À CÔTE (14/09/2026). Deux bandes
    // côte à côte en haut d'une page sont un CARTOUCHE — un en-tête de lettre,
    // un bloc d'identification —, pas une section de document. Leurs tailles y
    // marquent des champs, pas une hiérarchie.
    //
    // MESURÉ SUR LE CORPUS ENTIER avant de trancher : tous les titres corrects
    // sont en prose LIBRE, et le seul qui vive dans un `columns` est le
    // « Bulletin du 1er Trimestre » d'un bulletin scolaire — un champ de
    // cartouche au même titre que le nom de l'élève, sa classe et son niveau,
    // qui l'entourent. Cette exclusion coûte donc exactement un titre, et aucun
    // titre correct.
    //
    // Le texte reste PUBLIÉ et à sa place : seule sa promotion en titre est
    // refusée.
    // DEPUIS LE 05/11/2026 LA TAILLE DÉCIDE AUSSI DANS UN BLOC CÔTE À CÔTE (« quitte à inventer des
    // titres ») : l'exclusion du cartouche (14/09) partait du principe inverse. « FACTURE » en 20 pt redevient un titre.
    const side = [asBlocks(split.left), asBlocks(split.right)].filter((cell) => cell.length > 0);
    return [
      ...asBlocks(split.above),
      ...(side.length > 1 ? [{ kind: "columns" as const, cells: side }] : side.flat()),
      ...asBlocks(split.below),
    ];
  };

  const inRenderedTable = new Set(rendered.map((r) => r.index));
  const outsideTables = placeImages(imageCandidates.filter((_, k) => !inRenderedTable.has(claimedBy[k]!)));
  return interleaveRegions(
    pageItems,
    [
      ...rendered.map((r) => ({
        top: r.top,
        bottom: r.bottom,
        // UN TABLEAU SE RANGE SUR SON VRAI BORD GAUCHE (23/09/2026). Il portait
        // `-∞`, ce qui le faisait passer AVANT tout ce qui partage sa bande —
        // en contradiction avec « les éléments côte à côte se lisent de gauche à
        // droite » (16/09), écrit dans `pdf-region-order.ts`. Le cas
        // mesuré : fixture 24 page 3, le cadre « Android / iPhone » (x 242,7)
        // sortait avant le code QR de GAUCHE (x 95,4), alors qu'il est entre les
        // deux. C'est la règle existante appliquée, pas une règle neuve.
        xMin: r.xMin,
        blocks: r.blocks,
        consumesBand: true,
        // L'EMPRISE, elle, reste pleine largeur : sans elle le tableau
        // n'attirerait aucune ligne, et une image voisine les prendrait toutes —
        // y compris celles qui le bordent. Ce sont deux questions distinctes :
        // où le tableau se RANGE, et quelles lignes lui appartiennent.
        //
        // 🔴 LIMITE ÉCRITE, ET C'EST UNE ABSTENTION CHOISIE (23/09/2026).
        // L'ordre est réparé ; L'APPARIEMENT NE L'EST PAS. Sur la fixture 24
        // page 3, le lecteur voit maintenant « lien Google · Android / iPhone ·
        // lien Apple » et rien ne dit LEQUEL des deux mots va avec quel code.
        // Les deux mots vivent dans le cadre, donc `nearestRegion` n'est jamais
        // appelé pour eux.
        //
        // Ce qu'il aurait fallu, et qui est mesuré : « Android » est à 47,3 pt
        // du code de gauche contre 102,3 du droit ; « iPhone » à 44,4 du droit
        // contre 110,1 du gauche — et une seconde lecture concorde, l'alignement
        // dans le cadre (Android à 7,2 pt du bord gauche, iPhone à 9,0 du bord
        // droit). Deux lectures qui concordent, donc la règle est défendable.
        //
        // Elle n'est pas écrite pour autant, sur décision (« on peut
        // laisser comme ça si la règle est trop fragile ») : elle demanderait de
        // FUSIONNER une grille 1×1 et deux régions d'image en un tableau de deux
        // cases — une transformation de structure neuve, calibrée sur UN cas
        // dans 46 PDF, et qui menace l'ordre des deux images.
        // Au moindre doute on ne le fait pas. À rouvrir avec un second cas.
        box: { top: r.top, bottom: r.bottom, xMin: Number.NEGATIVE_INFINITY, xMax: Number.POSITIVE_INFINITY },
      })),
      ...outsideTables.map(imageRegion),
    ],
    prose,
  );
}
