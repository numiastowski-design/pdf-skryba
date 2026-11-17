/** Whether a page is read as two bands rather than one column, and where that
 *  zone begins and ends.
 *  NOT here: where the cut itself falls (`layout/gutter.ts` for a gutter,
 *  `layout/geometry.ts` for a painted edge), nor what each band becomes
 *  (`extractor/pdf-image-anchors.ts#rowBlocks` for the container, `extractor/pdf-paragraphs.ts` for the paragraphs).
 *  Called by: `extractor/pdf-page-tables.ts`, `extractor/pdf-image-anchors.ts`. */

import { maxOf, minOf } from "doc-ir/lib/extent";
import { modeOf } from "doc-ir/layout/mode";
import type { PositionedItem } from "./pdf-model";
import { groupItemsIntoLines } from "./pdf-lines";
import { SAME_LINE_PT } from "doc-ir/layout/tolerances";

/**
 * L'ORDRE DE LECTURE D'UNE PAGE EN DEUX BANDES (point 13, lot 3).
 *
 * Le tri du lot 1 a rendu l'ordre des LIGNES géométrique ; il ne pouvait rien
 * pour l'entrelacement, puisque deux colonnes posées aux mêmes ordonnées SONT
 * une seule ligne visuelle. C'est ici que la page se relit en bandes.
 *
 * LA ZONE EN COLONNES SE DÉLIMITE PAR LES LIGNES QUI ONT DU TEXTE DES DEUX
 * CÔTÉS, ET PAR RIEN D'AUTRE. Une première version découpait la page en suites
 * de lignes « pleine largeur » contre « pas pleine largeur » ; elle s'est
 * cassée à la mesure, sur un cas parfaitement ordinaire : **la dernière ligne
 * d'un paragraphe est toujours plus courte**, donc elle ne traverse pas la
 * coupe, donc elle sortait du chapeau et devenait un paragraphe à elle seule.
 * Un remède qui casse ce qu'il vient réparer.
 *
 * La règle retenue tient en trois temps :
 *
 *  1. les lignes portant du texte des DEUX côtés de la coupe (sans qu'aucun
 *     fragment ne la traverse) délimitent la zone en colonnes, du haut au bas ;
 *  2. tout ce qui est AU-DESSUS et tout ce qui est EN DESSOUS de cette zone
 *     reste dans l'ordre du document — titre, chapeau, mention de pied de page.
 *     Une ligne courte y reste avec son paragraphe, puisqu'on ne juge plus
 *     ligne par ligne ;
 *  3. la zone elle-même se rend en deux segments : toute la bande gauche, puis
 *     toute la droite.
 *
 * REPLI EXPLICITE : si une ligne pleine largeur se trouve À L'INTÉRIEUR de la
 * zone (un encadré, une citation à cheval sur les deux colonnes), la page n'est
 * pas partitionnée du tout et retombe sur le comportement d'avant le point 13.
 * Couper autour d'elle demanderait d'empiler plusieurs zones ; aucun document
 * du corpus ne présente ce cas, donc rien ne permet de l'écrire autrement qu'à
 * l'aveugle.
 *
 * Chaque segment est reconstruit en paragraphes SÉPARÉMENT, et ce n'est pas
 * cosmétique : passer d'un bas de colonne gauche à un haut de colonne droite
 * est une remontée, donc un écart négatif, donc aucune rupture — les deux
 * colonnes fusionneraient en un seul paragraphe. C'est exactement le défaut de
 * l'écart signé que le lot 1 a fermé, et le partitionnement le rouvrirait s'il
 * ne découpait pas aussi la reconstruction.
 *
 * Sans coupe (`cut === undefined`), la fonction rend un unique segment : le
 * comportement d'avant le point 13, à l'identique.
 */
/** Les quatre parts d'une page lue en bandes, NOMMÉES. `readingSegments` les
 *  aplatit pour ses appelants historiques ; `renderPageTables` a besoin de
 *  savoir laquelle est la colonne gauche et laquelle la droite, pour en faire un
 *  bloc `columns` plutôt que deux suites de prose. */
export interface BandedSplit<T> {
  above: T[][];
  left: T[][];
  right: T[][];
  below: T[][];
}

/**
 * THE RUN OF LINES BETWEEN TWO FULL-WIDTH LINES THAT HOLDS THE MOST STRADDLING LINES.
 *
 * Lines are walked top to bottom. A line that CROSSES a cut closes the run in progress; every other line extends
 * it. The run returned is the one with the most straddling lines (text on both sides of a cut) — on a tie the
 * highest, because a document reads top to bottom and a tie-break must be deterministic.
 *
 * A RUN KEEPS THE LINES THAT SIT IN ONE BAND ONLY (05/11/2026 on the published Federal Register
 * `sd-4133285` p1: « such registration or institute, je ne sais pas d'où il sort »). That line opens column 2 one
 * point above the first row that columns 1 and 3 also fill — they start lower, after the rule between two notices.
 * The zone used to begin at the highest STRADDLING line, so a line alone in its column at the zone's edge went
 * « above », and was published before the whole page. A line between two full-width lines that crosses no cut is
 * column content wherever it stands; the straddling lines decide WHICH run is the zone, not its extent. The
 * trimming to straddling lines came from `11-Brochure-Deux-Colonnes` (16/09/2026), and that document is unchanged:
 * its full-width paragraph still closes the run.
 *
 * ONE EXCEPTION, AT THE TOP EDGE: lines in the FIRST band only, before the first line that proves anything, stay
 * above. `16-Brochure-Dense` says why: the lead paragraph crosses the cut on its first lines and its last line is
 * short, so it sits in band 1 — it is the paragraph's wrap, and in the zone it became a paragraph of its own at the
 * head of column 1. A wrap of a full-width paragraph always returns to the left margin; a line alone in band 2 or
 * beyond cannot be one. For band 1 the reading order is the same either way, only the paragraph changes.
 */
const longestRun = <T extends PositionedItem>(
  groups: readonly T[][],
  banded: readonly T[][],
  spansCut: (group: readonly T[]) => boolean,
  firstBandOnly: (group: readonly T[]) => boolean,
): { lines: T[][]; straddling: number } => {
  const isBanded = new Set(banded);
  const runs: { lines: T[][]; straddling: number }[] = [];
  let current: T[][] = [];
  const close = (): void => {
    if (current.length > 0) runs.push({ lines: current, straddling: current.filter((g) => isBanded.has(g)).length });
    current = [];
  };
  for (const group of [...groups].sort((a, b) => b[0]!.y - a[0]!.y)) {
    if (spansCut(group)) close();
    else current.push(group);
  }
  close();
  const best = runs.reduce<{ lines: T[][]; straddling: number }>(
    (kept, run) => (run.straddling > kept.straddling ? run : kept),
    { lines: [], straddling: 0 },
  );
  const start = best.lines.findIndex((g) => isBanded.has(g) || !firstBandOnly(g));
  return { lines: start < 0 ? [] : best.lines.slice(start), straddling: best.straddling };
};

/**
 * HOW MANY STRADDLING LINES A ZONE FOUND BELOW OR ABOVE ANOTHER NEEDS (05/11/2026). The first zone of a page is the
 * best run, whatever its size — 742 tests hold that. A zone looked for in what is left is judged alone, and ONE
 * straddling line is one reading: `11-Brochure-Deux-Colonnes` p0 has the axis labels « 2023 2024 2025 » of a chart
 * on both sides of the cut, and fixture 17 has table rows (« 15 - 50 50 », « 31 mars 31 mars ») of one to three
 * lines. Measured zones: real column blocks found below a headline hold 4 to 38 lines (Federal Register notes 4–8,
 * `sd-3776780` 4–12, newspaper `sd-2479793` 6–15, `sd-1026348` 9–31); labels and table rows 1 to 3. Starting
 * value to calibrate.
 */
export const MIN_SUBZONE_LINES = 4;

/**
 * HOW MANY ZONES ONE PAGE IS CUT INTO AT MOST (06/11/2026, review). Each zone found above or below another re-reads
 * what is left (`readBands` on the `remainder`), so a page of N zones costs N passes over its items. Beyond the cap the
 * rest of the page is published full-width, with no new zone: the bias is « we publish ». Starting value to calibrate.
 * Real population: the newspaper `sd-2479793` holds three or four zones per page (the most measured). Hostile
 * population: one zone per headline, thousands on a generated page. 64 sits 16 times above the real maximum.
 */
export const MAX_BAND_ZONES_PER_PAGE = 64;

/**
 * A ZONE THAT STANDS ALONE IS FOUNDED TWICE: at least `MIN_SUBZONE_LINES` straddling lines, AND fragments of several
 * words on both sides of each cut. Fixture 17 (`canada-account-annual-report`) says why the second condition: its
 * borderless financial tables hold five to twelve rows astride the document's cut — labels on the left (« Chine »,
 * « Türkiye »), figures on the right (« 255 1 279 1 ») — and read as columns they lose their rows, and the page its
 * heading « Note 4. Prêts ». A table paints ONE fragment per cell, of one or two tokens; a line of prose is a
 * fragment of several words.
 *
 * THE TWO POPULATIONS (05/11/2026, words per fragment of the POORER side of the cut, zones of 4 lines and more):
 *   table rows read as a zone — fixture 17, nine zones          1.0  1.0  1.0  1.0  1.0  1.1  1.1  1.1  1.1
 *   real column zones under a headline — `sd-3776780` 1.9 ; newspaper `sd-2479793` 3.2  3.2  3.2  3.8  3.8  4.5 ;
 *   Federal Register `sd-4133285` 4.7  4.9  4.9  5.7
 * `MIN_WORDS_PER_ZONE_FRAGMENT` sits in the gap 1.1 → 1.9. The 4 words per fragment of
 * `layout/column-discriminant.ts#bandsCarryProse` answers another question (a label column against prose) and
 * refused the newspaper's own zones (3.2) and `sd-3776780` (1.9): measured, 85 and 139 broken neighbourhoods
 * against 64 and 71 without it. Words per LINE was tried and discarded: `sd-3776780`'s left band has 2.5 words a
 * line, below fixture 17's rows at 3.6 to 4.0. Starting value to calibrate.
 */
export const MIN_WORDS_PER_ZONE_FRAGMENT = 1.5;

const wordsPerFragment = (fragments: readonly { text: string }[]): number =>
  fragments.reduce(
    (sum, f) =>
      sum +
      f.text
        .trim()
        .split(/\s+/)
        .filter((w) => w.length > 0).length,
    0,
  ) / Math.max(1, fragments.length);

const standsAloneAsZone = <T extends PositionedItem>(
  zoneLines: readonly T[][],
  straddling: number,
  cuts: readonly number[],
): boolean => {
  if (straddling < MIN_SUBZONE_LINES) return false;
  const ink = zoneLines.flat().filter((it) => it.text.trim() !== "");
  return cuts.every((cut) => {
    const sides = [ink.filter((it) => it.x + it.width / 2 < cut), ink.filter((it) => it.x + it.width / 2 >= cut)];
    return sides.every((side) => side.length > 0 && wordsPerFragment(side) >= MIN_WORDS_PER_ZONE_FRAGMENT);
  });
};

export const bandedSplit = <T extends PositionedItem>(
  pageItems: readonly T[],
  cut: number | undefined,
  bound?: number,
  {
    standsAlone = false,
    innerCuts = [],
  }: {
    /** True for a zone looked for above or below another one: it must then be founded on its own (`standsAloneAsZone`). */
    standsAlone?: boolean;
    /** The document's other cuts: a side that one of them will split again holds several columns, and has no ONE edge. */
    innerCuts?: readonly number[];
  } = {},
): BandedSplit<T> | undefined => {
  const groups = groupItemsIntoLines(pageItems);
  if (cut === undefined || groups.length === 0) return undefined;

  // Les items de REMPLISSAGE d'`unpdf` (`str: " "`, largeur de tout l'espace
  // entre deux runs) sont exclus de toute décision géométrique. Mesuré : sur la
  // brochure dense, le remplissage d'une ligne à deux colonnes s'étend de la
  // fin de la colonne gauche au début de la droite, donc il TRAVERSE la coupe —
  // toutes les lignes passaient pour pleine largeur et la zone en colonnes
  // était vide. Ils ne portent aucun texte : rien à perdre à les ignorer, et
  // dans la zone en colonnes ils représentent justement la gouttière, qui n'a
  // plus lieu d'être une fois les bandes séparées.
  const real = (group: readonly T[]): T[] => group.filter((it) => it.text.trim().length > 0);
  const leftOf = (it: T): boolean => it.x + it.width / 2 < cut;
  const spansCut = (group: readonly T[]): boolean => real(group).some((it) => it.x < cut && it.x + it.width > cut);
  const straddles = (group: readonly T[]): boolean =>
    !spansCut(group) && real(group).some(leftOf) && real(group).some((it) => !leftOf(it));

  // UNE COUPE PEUT ÊTRE BORNÉE À LA BANDE HAUTE (11/09/2026). Sur un bulletin,
  // l'en-tête est en deux blocs côte à côte AU-DESSUS d'un tableau pleine
  // largeur. Sans borne, les lignes du tableau ont elles aussi du texte des deux
  // côtés de la coupe : la zone en colonnes avalerait le tableau, ou un fragment
  // de cellule traverserait la coupe et la fonction s'abstiendrait — dans les
  // deux cas l'en-tête resterait tressé. `above` limite la zone aux lignes
  // situées plus haut, et le reste de la page retrouve le comportement d'avant.
  const eligible = bound === undefined ? groups : groups.filter((g) => g[0]!.y > bound);
  const banded = eligible.filter(straddles);
  if (banded.length === 0) return undefined;

  // L'ÉTENDUE DE LA ZONE DÉPEND DE CE QUI A FOURNI LA COUPE.
  //
  // Sans borne, la coupe vient d'une gouttière statistique et on ne sait pas où
  // la zone en colonnes commence : on la resserre donc sur les lignes à cheval,
  // les seules qui prouvent quelque chose.
  //
  // Avec une borne, la coupe vient d'un bord de cellule RÉELLEMENT PEINT, et
  // elle affirme déjà que toute la bande est en deux blocs. La resserrer laissait
  // passer un défaut mesuré le 11/09/2026 : une seule ligne à cheval était
  // séparée, mais la DERNIÈRE ligne du bloc droit fusionnait ensuite en
  // paragraphe avec la PREMIÈRE du bloc gauche — deux lignes voisines à l'oeil,
  // une phrase qui n'existe dans aucun des deux blocs.
  //
  // La garde qui compte reste en place juste en dessous : si un fragment TRAVERSE
  // la coupe dans la zone, on s'abstient entièrement.
  // ⚠️ SANS BORNE, LA ZONE EST UNE SUITE CONTIGUË DE LIGNES À CHEVAL — pas leur
  // enveloppe (16/09/2026).
  //
  // L'enveloppe était le comportement d'avant, et elle a un mode de défaillance
  // mesuré sur `11-Brochure-Deux-Colonnes`. Sa page 0 porte, tout en bas, un
  // graphique dont les étiquettes « 2023 2024 2025 » se répartissent de part et
  // d'autre de la coupe : cette ligne est donc À CHEVAL, elle étire l'enveloppe
  // jusqu'en bas de page, et le paragraphe PLEINE LARGEUR du milieu s'y retrouve
  // enfermé. La garde d'abstention se déclenchait alors et la page entière
  // restait tressée — pendant que la page 1, de géométrie identique mais sans
  // graphique, se séparait. Deux pages jumelles, deux lectures.
  //
  // Une ligne pleine largeur ne fait donc plus abandonner la page : elle FERME
  // la suite en cours. On retient la plus fournie. C'est le « plusieurs zones »
  // que le commentaire d'origine écartait faute de document pour l'exiger — il y
  // en a un maintenant.
  const run =
    bound === undefined
      ? longestRun(groups, banded, spansCut, (g) => real(g).every(leftOf))
      : { lines: eligible, straddling: banded.length };
  const zoneLines = run.lines;
  if (zoneLines.length === 0 || (standsAlone && !standsAloneAsZone(zoneLines, run.straddling, [cut]))) return undefined;
  const top = maxOf(zoneLines, (g) => g[0]!.y);
  const bottom = minOf(zoneLines, (g) => g[0]!.y);

  const inZone = (group: readonly T[]): boolean => group[0]!.y >= bottom && group[0]!.y <= top;
  if (groups.some((g) => spansCut(g) && inZone(g))) return undefined;

  const above = groups.filter((g) => g[0]!.y > top);
  const inside = groups.filter(inZone);
  const below = groups.filter((g) => g[0]!.y < bottom);
  // UNE LIGNE À CHEVAL N'EST JAMAIS TRANSVERSE, et ses moitiés ne se jugent pas.
  //
  // Le risque est le SYMÉTRIQUE de celui corrigé juste au-dessus. Juger la ligne
  // entière ramenait la phrase fausse ; juger chaque moitié sans précaution
  // découperait une vraie ligne à cheval dont une moitié serait mal alignée avec
  // sa colonne — la moitié gauche resterait en colonne, la droite partirait sous
  // les blocs, et la ligne sortirait en deux endroits.
  //
  // La garde est une définition, pas un réglage : un élément transverse
  // n'appartient à AUCUNE des deux colonnes. Une ligne qui porte du texte des
  // deux côtés de la coupure appartient manifestement à la bande, donc elle
  // n'est pas transverse, et rien ne peut l'en faire sortir.
  const straddling = new Set(inside.filter((g) => real(g).some(leftOf) && real(g).some((it) => !leftOf(it))));
  // A HALF KEEPS THE SPACE ITEMS BETWEEN ITS WORDS (21/09/2026). Keeping only
  // real items here dropped the document's own spaces, and the line then glued
  // its words: "EUROCONTROL*estuneorganisation" (safedocs 0000713 p1), "Die
  // Obergrenze" (0000944 p2). Only the blanks at a half's two ends go — the
  // gutter filler, which separates nothing inside the column.
  const halfOf = (g: readonly T[], side: (it: T) => boolean): T[] => {
    const items = g.filter(side);
    const isText = (it: T): boolean => it.text.trim().length > 0;
    const first = items.findIndex(isText);
    if (first < 0) return [];
    const last = items.length - 1 - [...items].reverse().findIndex(isText);
    return items.slice(first, last + 1);
  };
  const left = inside.map((g) => ({ g, half: halfOf(g, leftOf) })).filter((x) => x.half.length > 0);
  const right = inside.map((g) => ({ g, half: halfOf(g, (it) => !leftOf(it)) })).filter((x) => x.half.length > 0);

  // UNE LIGNE QUI TRAVERSE LE BORD GAUCHE D'UNE COLONNE N'APPARTIENT PAS À
  // CETTE COLONNE (11/09/2026).
  //
  // Mesuré sur un bulletin réel : la mention « aucun duplicata » est centrée sur
  // la PAGE, à `x = [249,4 ; 345,9]`, alors que les huit lignes de la colonne de
  // droite commencent TOUTES à `x = 291,8`. Son centre tombant du côté droit de
  // la coupure, elle partait dans la colonne de droite, où elle n'a rien à
  // faire : elle est sous les deux blocs, pas dans l'un d'eux.
  //
  // Le discriminant est le bord de la colonne, pas le centre de la page — donc
  // rien à calibrer et aucune largeur de page à connaître. Une ligne de la
  // colonne commence À son bord ; une ligne qui commence AVANT le bord et finit
  // APRÈS le franchit, donc elle est transverse. C'est la leçon 17 de l'étude,
  // le pré-masquage des éléments transverses, réduite à ce que la mesure porte.
  const columnEdge = (segments: readonly T[][]): number | undefined => {
    const starts = segments.map((g) => minOf(g, (it) => it.x));
    const counts = new Map<number, number>();
    for (const x of starts) {
      const key = [...counts.keys()].find((k) => Math.abs(k - x) <= SAME_LINE_PT) ?? x;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const at = modeOf(counts, "smallest");
    return at !== undefined && counts.get(at)! >= 2 ? at : undefined;
  };

  // A FRAGMENT CROSSES THE EDGE, not the line's extent (10/11/2026, auction catalogue `sd-1026348`). A lot opens with its
  // number BEFORE the column's text edge, a blank between them (« 6 » at 314, its title at 349): measured on the line's
  // extent, the line crossed the edge and its title was published under the columns. A number that ends before the edge
  // is part of its line (« il faut juste un espace après les numéros de paragraphe »); the centred notice above
  // is ONE fragment across the edge, and still leaves. Blank fragments (the gap filler) never decide.
  const crossesEdge = (group: readonly T[], edge: number | undefined): boolean =>
    edge !== undefined && real(group).some((it) => it.x < edge - SAME_LINE_PT && it.x + it.width > edge + SAME_LINE_PT);

  // LE JUGEMENT PORTE SUR LA DEMI-LIGNE, PAS SUR LA LIGNE ENTIÈRE. Une ligne à
  // cheval — le libellé d'un champ à gauche, la valeur du bloc d'en face à
  // droite — franchit forcément un bord de colonne si on la mesure entière, et
  // la sortir ENTIÈRE de la zone ramènerait exactement la phrase fausse que la
  // lecture en bandes vient de supprimer. Mesuré en le cassant.
  // LE BORD NE JUGE PAS UNE BANDE QU'UNE COUPE RESTANTE PARTAGERA ENCORE (05/11/2026, Federal Register p1). Lue par sa
  // première coupe, que rien ne traverse, la page livre une bande droite à DEUX colonnes ; le bord retenu était le départ
  // de la plus fournie, et toute ligne des deux colonnes sans voisine à gauche passait pour transverse — « notice of the
  // filing of the application for Joint Industry Plan; Notice of Filing of », sous les blocs.
  const leftEdge = innerCuts.some((c) => c < cut) ? undefined : columnEdge(left.map((x) => x.half));
  const rightEdge = innerCuts.some((c) => c > cut) ? undefined : columnEdge(right.map((x) => x.half));
  const keep = (x: { g: T[]; half: T[] }, edge: number | undefined): boolean =>
    straddling.has(x.g) || !crossesEdge(x.half, edge);
  const pulled = [...left.filter((x) => !keep(x, leftEdge)), ...right.filter((x) => !keep(x, rightEdge))]
    .map((x) => x.half)
    .sort((a, b) => b[0]!.y - a[0]!.y);

  return {
    above,
    left: left.filter((x) => keep(x, leftEdge)).map((x) => x.half),
    right: right.filter((x) => keep(x, rightEdge)).map((x) => x.half),
    // Réinsérées SOUS la zone : elles sont géométriquement sous les deux blocs,
    // et c'est là qu'on les relit.
    below: [...pulled, ...below],
  };
};

/**
 * Les quatre parts aplaties, ou la page entière en un seul segment quand rien ne se sépare.
 *
 * 🔴 N COUPES, PAS UNE (04/11/2026). Une page à quatre colonnes porte TROIS gouttières, et `bandedSplit` n'en lit
 * qu'une : ses colonnes 1-2 comme 3-4 restaient tressées entre elles, puisque deux colonnes posées aux mêmes
 * ordonnées sont une seule ligne visuelle. Mesuré sans référence extérieure (sonde `broken_neighbours`, 100
 * documents) : 1 534 voisinages cassés, dont 67 % sur cinq documents à plusieurs colonnes ; sur le pire, deux
 * lignes consécutives du même paragraphe sortent séparées de 723 mots.
 *
 * LA RÉCURSION EST LA FORME MINIMALE, et c'est pour ça qu'elle a été choisie : la page se coupe à la première
 * abscisse, puis CHAQUE bande se recoupe sur les suivantes. `bandedSplit` n'est pas touchée — ses zones, ses lignes
 * à cheval, son abstention quand un fragment traverse la coupe valent à l'identique, appliquées une fois de plus
 * sur moins de fragments. Les coupes arrivent croissantes (`layout/gutter.ts#documentColumnCuts`), donc la bande
 * gauche est toujours une colonne entière et la récursion ne porte que sur ce qui reste à droite.
 *
 * UNE COUPE QUI NE SÉPARE RIEN NE BLOQUE PAS LES AUTRES : `bandedSplit` s'abstient page par page, et on passe à la
 * suivante au lieu de rendre la page entière. C'est ce qui permet de décider les coupes à l'échelle du document
 * (l'invariant du 16/09/2026) sans exiger que chacune morde sur chaque page.
 */
/**
 * 🔴 LA PAGE COUPÉE EN N BANDES D'UN SEUL COUP (04/11/2026: « en fait pourquoi tu parles de rowspan
 * alors que le pdf a 3 cols très nettes…... »).
 *
 * IL AVAIT RAISON, ET L'ESCALIER ÉTAIT DE MOI. Couper en deux puis RECOUPER la moitié droite donne deux zones
 * différentes : la première coupe sépare la colonne 1 sur toute la hauteur, la seconde ne s'applique qu'au reste
 * et sa zone commence plus bas. Il en sortait une bande « colonnes 2 et 3 encore mêlées » qui n'existe que dans
 * la façon de découper — sur `sd-4133285` p1, 49 paragraphes d'une ligne et le titre de la 3 au milieu de la 2.
 *
 * ICI, UNE SEULE ZONE POUR TOUTES LES COUPES : une ligne est à cheval dès qu'elle porte du texte dans au moins
 * deux bandes, et elle est transverse dès qu'un de ses fragments traverse UNE QUELCONQUE coupe. La zone est la
 * plus longue suite de lignes à cheval qu'aucune transverse n'interrompt — la règle du 16/09/2026, inchangée,
 * appliquée à N coupes au lieu d'une.
 *
 * `undefined` : aucune ligne à cheval, ou une transverse dans la zone. L'appelant retombe alors sur la lecture
 * d'avant, et c'est voulu — mieux vaut une page entière en bloc qu'une partition au jugé.
 */
export const bandedSplitN = <T extends PositionedItem>(
  pageItems: readonly T[],
  cuts: readonly number[],
  bound?: number,
  standsAlone = false,
): { above: T[][]; bands: T[][][]; below: T[][] } | undefined => {
  const groups = groupItemsIntoLines(pageItems);
  if (cuts.length === 0 || groups.length === 0) return undefined;
  const real = (group: readonly T[]): T[] => group.filter((it) => it.text.trim().length > 0);
  /** La bande d'un fragment : le nombre de coupes qui passent à gauche de son MILIEU, comme partout ailleurs. */
  const bandOf = (it: T): number => cuts.filter((cut) => it.x + it.width / 2 >= cut).length;
  const crosses = (group: readonly T[]): boolean =>
    real(group).some((it) => cuts.some((cut) => it.x < cut && it.x + it.width > cut));
  const straddles = (group: readonly T[]): boolean => !crosses(group) && new Set(real(group).map(bandOf)).size > 1;

  const eligible = bound === undefined ? groups : groups.filter((g) => g[0]!.y > bound);
  const banded = eligible.filter(straddles);
  if (banded.length === 0) return undefined;
  const run =
    bound === undefined
      ? longestRun(groups, banded, crosses, (g) => real(g).every((it) => bandOf(it) === 0))
      : { lines: eligible, straddling: banded.length };
  const zoneLines = run.lines;
  if (zoneLines.length === 0 || (standsAlone && !standsAloneAsZone(zoneLines, run.straddling, cuts))) return undefined;
  const top = maxOf(zoneLines, (g) => g[0]!.y);
  const bottom = minOf(zoneLines, (g) => g[0]!.y);
  const inZone = (group: readonly T[]): boolean => group[0]!.y >= bottom && group[0]!.y <= top;
  if (groups.some((g) => crosses(g) && inZone(g))) return undefined;

  const inside = groups.filter(inZone);
  // LA MOITIÉ GARDE LES ESPACES DU DOCUMENT ENTRE SES MOTS (21/09/2026) : seuls les blancs des deux bouts partent,
  // le remplissage de gouttière, qui ne sépare plus rien une fois les bandes séparées.
  const partOf = (group: readonly T[], band: number): T[] => {
    const items = group.filter((it) => bandOf(it) === band);
    const isInk = (it: T): boolean => it.text.trim().length > 0;
    const first = items.findIndex(isInk);
    if (first < 0) return [];
    const last = items.length - 1 - [...items].reverse().findIndex(isInk);
    return items.slice(first, last + 1);
  };
  const bands = Array.from({ length: cuts.length + 1 }, (_, band) =>
    inside.map((g) => partOf(g, band)).filter((part) => part.length > 0),
  );
  return {
    above: groups.filter((g) => g[0]!.y > top),
    bands: bands.filter((band) => band.length > 0),
    below: groups.filter((g) => g[0]!.y < bottom),
  };
};

export const readingSegments = <T extends PositionedItem>(
  pageItems: readonly T[],
  cuts: readonly number[],
  bound?: number,
): T[][][] => readingBands(pageItems, cuts, bound).map((segment) => segment.lines);

/** Un segment de lecture, ET s'il est une COLONNE de la page ou du texte pleine largeur au-dessus ou en dessous
 *  d'elles. La distinction ne change rien à l'ordre — elle sert à poser de vraies colonnes Confluence
 *  (`lib/ir.ts`, bloc `columns`) plutôt qu'une suite de paragraphes (04/11/2026). */
export interface ReadSegment<T> {
  lines: T[][];
  column: boolean;
}

export const readingBands = <T extends PositionedItem>(
  pageItems: readonly T[],
  cuts: readonly number[],
  bound?: number,
  /** Vrai quand l'appel vient d'une bande déjà séparée : ce qui en sort est une colonne, même si aucune des coupes
   *  restantes ne mord dessus. Faux au premier appel, sur la page entière. */
  inBand = false,
): ReadSegment<T>[] =>
  readBands(pageItems, cuts, { bound, inBand, standsAlone: false, zonesLeft: { count: MAX_BAND_ZONES_PER_PAGE } });

/** Whether one inked fragment of the page spans the cut: the condition that bounds a zone (`bandedSplit`). */
const crossedByAnyLine = <T extends PositionedItem>(pageItems: readonly T[], cut: number): boolean =>
  pageItems.some((it) => it.text.trim() !== "" && it.x < cut && it.x + it.width > cut);

const readBands = <T extends PositionedItem>(
  pageItems: readonly T[],
  cuts: readonly number[],
  options: { bound: number | undefined; inBand: boolean; standsAlone: boolean; zonesLeft: { count: number } },
): ReadSegment<T>[] => {
  const { bound, inBand, standsAlone, zonesLeft } = options;
  // A PAGE HOLDS SEVERAL COLUMN ZONES (05/11/2026). `longestRun` keeps ONE run of lines between two full-width
  // lines — the one with the most straddling lines. Everything above and below it was published as it came, lines
  // braided across the columns. Measured on the newspaper `sd-2479793`: three or four zones per page, separated by
  // headlines over two or three columns; the one-pass split of 04/11 read 192 broken neighbourhoods against 148 for
  // the cascade it replaced, and `sd-3776780` 141 against 117 — the cascade split each half again and so found a
  // second zone by accident. What is above and below the zone is read again with the SAME cuts: a further zone is
  // split in turn, the rest stays full-width. Each call removes at least one line, so it ends. Only on the
  // statistical path: a cut bound to a painted cell edge (`bound`) already declares its whole band.
  const remainder = (part: T[][]): ReadSegment<T>[] => {
    if (part.length === 0) return [];
    if (bound !== undefined) return [{ lines: part, column: false }];
    // Past `MAX_BAND_ZONES_PER_PAGE` the rest is published full-width, with no new zone.
    if (zonesLeft.count <= 0) return [{ lines: groupItemsIntoLines(part.flat()), column: false }];
    zonesLeft.count -= 1;
    return readBands(part.flat(), cuts, { bound: undefined, inBand: false, standsAlone: true, zonesLeft });
  };
  // 🔴 À PARTIR DE DEUX COUPES, LA PAGE SE COUPE D'UN SEUL TENANT (04/11/2026) : la cascade fabriquait un escalier
  // que le document n'a pas. À UNE coupe, le chemin d'origine est gardé tel quel — il porte toute la finesse de
  // `bandedSplit` (bornes, bords de colonne, lignes retirées de la zone), et 742 tests le tiennent.
  // 🔴 UNE COUPE QUE RIEN NE TRAVERSE SÉPARE LA PAGE D'ABORD, SUR TOUTE SA HAUTEUR (05/11/2026, une du journal
  // `sd-2479793`). Sa barre latérale court du haut au bas de la page à gauche de la coupe 1, que rien ne traverse ;
  // à droite, le titre et son chapeau traversent les coupes 2 et 3 au-dessus de trois colonnes. Coupée d'un seul
  // tenant, la page prenait ce titre pour la borne de SA zone : la barre sortait en deux morceaux et son haut, tressé
  // avec le titre — « Et au fait, la Francophonie, c'est Association suisse des journalistes de langue française ».
  // Une coupe que rien ne traverse n'a pas de zone à chercher : elle vaut sur toute la hauteur, et chaque côté se
  // lit ensuite sur les coupes qui restent — le chemin à une coupe ci-dessous. Statistique seulement : une coupe
  // bornée à une cellule peinte (`bound`) a déjà sa bande.
  const clean =
    bound === undefined && cuts.length > 1 ? cuts.find((cut) => !crossedByAnyLine(pageItems, cut)) : undefined;
  if (cuts.length > 1 && clean === undefined) {
    const whole = bandedSplitN(pageItems, cuts, bound, standsAlone);
    if (whole !== undefined) {
      return [
        ...remainder(whole.above),
        ...whole.bands.map((lines) => ({ lines, column: true })),
        ...remainder(whole.below),
      ].filter((segment) => segment.lines.length > 0);
    }
  }
  const [first, ...rest] = clean === undefined ? cuts : [clean, ...cuts.filter((cut) => cut !== clean)];
  const split =
    first === undefined ? undefined : bandedSplit(pageItems, first, bound, { standsAlone, innerCuts: rest });
  if (split === undefined) {
    if (rest.length > 0) return readBands(pageItems, rest, options);
    return [{ lines: groupItemsIntoLines(pageItems), column: inBand }];
  }
  // Une bande déjà séparée se relit sur les coupes RESTANTES, jamais sur celle qui vient de la produire.
  const deeper = (band: T[][]): ReadSegment<T>[] =>
    rest.length === 0 || band.length === 0
      ? [{ lines: band, column: true }]
      : readBands(band.flat(), rest, { ...options, inBand: true });
  // 🔴 CE QUI EST AU-DESSUS D'UNE SOUS-COUPE N'EST UNE COLONNE DE PERSONNE (04/11/2026, vu sur la page
  // publiée, corrigé deux fois).
  //
  // The columns of a page do not all start at the same height: on `sd-4133285` p1, column 1 opens on its title
  // while columns 2 and 3 are still mixed together above their own separation. That zone belongs to NEITHER of
  // the two.
  //
  // TRIED THEN DROPPED: pouring it into the first sub-column. It brought 49 one-line paragraphs there (against
  // 25 and 14 in the neighbouring columns) and column 3's title in the middle of column 2's body: "SECURITIES AND
  // EXCHANGE proceedings to determine whether such". It therefore comes out FULL WIDTH, and whatever composes
  // the page does what it wants with it: a `colspan` row put it across, in its place (the `table` variant of
  // `pdf-image-anchors.ts`, removed on 06/11/2026); `rows` leaves it full width.
  return [...remainder(split.above), ...deeper(split.left), ...deeper(split.right), ...remainder(split.below)].filter(
    (segment) => segment.lines.length > 0,
  );
};
