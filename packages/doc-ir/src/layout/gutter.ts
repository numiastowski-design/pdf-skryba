/** Where a column break falls when no line is painted to mark it — so a
 *  two-column page is not read in zigzag, and so a label column is not read as
 *  one either.
 *  NOT here: the reading order that uses it (`extractor/pdf-bands.ts`), the
 *  bordered-table case, which has real edges (`layout/geometry.ts`), nor the
 *  prose test the cut must pass (`layout/column-discriminant.ts`).
 *  Called by: `extractor/pdf-document-scale.ts`. */

import { maxOf, minOf } from "doc-ir/lib/extent";
import { bandsCarryProse, type BandFragment } from "doc-ir/layout/column-discriminant";

/**
 * gutter — LA COUPE DE COLONNES QUAND AUCUN TRAIT NE LA DONNE.
 *
 * POURQUOI CE MODULE EXISTE. L'ordre de lecture d'un PDF était un EFFET DE BORD
 * de la détection de tableaux : `pdf.ts#readingSegments` ne sépare deux colonnes
 * que si une coupe existe, et cette coupe ne venait que d'un **bord peint**. Une
 * page à deux colonnes sans aucun trait était donc lue en zigzag — et rien ne le
 * signalait.
 *
 * C'est le pire défaut au sens du critère du 15/09/2026 : le texte tressé
 * fabrique des phrases qui n'existent dans aucune colonne, et que Rovo peut
 * citer. Mesuré le 16/09/2026 sur 26 documents réels : **16 % des pages**
 * portent une gouttière franche sans qu'aucun trait ne l'accompagne.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CE QUE LE TRESSAGE EST VRAIMENT, et ça a mis trois essais à se voir
 *
 * Ce ne sont PAS « des lignes dans le désordre ». Les deux colonnes partagent
 * les mêmes lignes de base : un regroupement par ordonnée les fusionne, et la
 * ligne obtenue va d'un bord à l'autre —
 * « Etape 1 : ouvrir le dossierRegle A : jamais … ». **Au niveau des lignes,
 * toute gouttière est déjà refermée.** On mesure donc sur les FRAGMENTS.
 *
 * ET LES ÉLÉMENTS TRANSVERSES SE MASQUENT D'ABORD. Presque toute page à deux
 * colonnes porte un titre ou un bandeau à cheval : sans les écarter, ils
 * referment la gouttière et la page passe pour une colonne unique. C'est la
 * réponse de l'état de l'art (`docs/ETUDE-BIBLIOTHEQUES-PDF.md` [purged 27/09/2026, git history], leçon 17 :
 * masquer, découper, réinsérer) — et c'est aussi ce que fait `pdfalto`, le
 * lecteur de GROBID, qui traite l'ordre par projection XY avant tout modèle.
 *
 * UNE SEULE GOUTTIÈRE = DES COLONNES. PLUSIEURS = UNE GRILLE, donc un tableau
 * sans bordures, qu'on ne touche pas : `0000661` est un tarif médical, codes à
 * gauche et prix à droite, sur sept pages.
 * ─────────────────────────────────────────────────────────────────────────
 * ⚠️ UN RETRAIT PENDANT N'EST PAS UNE COLONNE — le faux positif du 16/09/2026,
 * trouvé APRÈS mise en production.
 *
 * `29-Entra-Gestion-Applications` est un document d'une seule colonne. Ses puces
 * débordent de 18 pt à gauche du corps, et le blanc entre le « • » et son texte
 * était lu comme une gouttière : trois pages coupées en deux, les six puces d'un
 * côté, tout le texte de l'autre. Les items partaient donc à la publication en
 * six paragraphes « • » suivis de leur texte détaché.
 *
 * La cause est un manque, pas un réglage : rien n'exigeait qu'une colonne soit
 * LARGE. Le côté gauche mesurait **5 points** — un glyphe. Le témoin positif,
 * lui, rend 142 et 144 points. Entre les deux, aucune valeur mesurée.
 *
 * Le trou n'était visible d'aucun test : le module rendait exactement ce qu'on
 * lui demandait. C'est le câblage des listes qui l'a fait sortir, en cherchant
 * des retraits et n'en trouvant aucun.
 */

/** Ce que ce module a besoin de savoir d'un fragment. La forme est celle de
 *  `PositionedItem` sans la nommer : dépendre de moins. C'est aussi celle que
 *  `bandsCarryProse` demande, et les deux questions se posent sur les mêmes
 *  fragments : un seul nom. */
export type GutterItem = BandFragment;

/**
 * LES SEUILS, FIGÉS LE 16/09/2026 sur décision de Mikolaj — « mets ton seuil, on
 * adaptera lors de la vie du produit ». **Valeurs de départ à calibrer**, et
 * chacune porte ce qui l'a fixée :
 *
 *   `MIN_GUTTER_PT`      8    une gouttière plus étroite qu'un mot n'en est pas une
 *   `MIN_SIDE_ITEMS`     4    par côté ; à 8 le témoin tombait à zéro sur une petite page
 *   `TRANSVERSE_RATIO`   1,5  en largeurs médianes ; à 3 une ligne pleine largeur refermait tout
 *   `GUTTER_APART_PT`   20    deux frontières plus proches décrivent le même blanc
 *   `MIN_COLUMN_PT`     40    une colonne plus étroite qu'un mot n'en est pas une
 *
 * ⚠️ **L'ORDRE DE GRANDEUR EST SOLIDE, LE CHIFFRE NE L'EST PAS.** Quatre
 * réglages ont rendu 1 %, 10 %, 16 % et 19 % sur le même corpus. Et le seul
 * témoin positif, `11-Brochure-Deux-Colonnes`, sort de notre générateur — le
 * biais que `CLAUDE.md` nomme. Toute modification se relance contre lui.
 */
const MIN_GUTTER_PT = 8;
const MIN_SIDE_ITEMS = 4;
const TRANSVERSE_RATIO = 1.5;
const GUTTER_APART_PT = 20;
/**
 * LA LARGEUR MINIMALE D'UNE COLONNE — valeur de départ à calibrer, et les deux
 * populations qui l'ont fixée (16/09/2026, 26 documents réels) :
 *
 *   retrait pendant pris pour une colonne     **5 pt** — la largeur d'un « • »
 *   colonnes du seul témoin positif      **142 et 144 pt**
 *
 * Rien de mesuré entre les deux. Le biais du dépôt choisit donc le bas de
 * l'intervalle : une colonne étroite manquée laisse la page tressée — un défaut
 * qu'on sait — alors qu'un retrait pendant coupé en deux DÉTACHE les puces de
 * leur texte, et ça, personne ne le voit en relisant la page publiée.
 */
export const MIN_COLUMN_PT = 40;

export interface Gutter {
  /** L'abscisse de la coupe. */
  x: number;
  itemsLeft: number;
  itemsRight: number;
  widthPt: number;
  /** L'étendue du plus ÉTROIT des deux côtés. Une colonne a une largeur ; un
   *  retrait pendant n'en a pas — voir `MIN_COLUMN_PT`. */
  columnPt: number;
}

/** The horizontal extent of a group of fragments, from the left edge of the leftmost to the right edge of the
 *  rightmost. */
const spanOf = (items: readonly GutterItem[]): number =>
  items.length === 0 ? 0 : maxOf(items, (it) => it.x + it.width) - minOf(items, (it) => it.x);

/**
 * THE WHITE THAT EVERY LINE OF BOTH COLUMNS LEAVES, inside a white found among the kept fragments (10/11/2026, catalogue
 * `sd-1026348`). The widest fragments are hidden to FIND the white (`TRANSVERSE_RATIO`), but a hidden fragment that ends
 * before the right column starts (or starts after the left column ends) is a long line of its column, not a transverse:
 * the cut must not cross it. Measured: page 2 of the catalogue, a white of 219 to 314 among the kept fragments, its long
 * left lines ending at 279 — the cut moves from 266 to 296. A fragment that crosses the whole white stays a transverse
 * and is ignored, as before. Undefined when the lines close the white below `MIN_GUTTER_PT`: the old middle stands.
 */
const whiteOfEveryLine = (real: readonly GutterItem[], start: number, end: number): { start: number; end: number } | undefined => {
  let from = start;
  let to = end;
  for (const it of real) {
    const right = it.x + it.width;
    if (it.x < start && right > start && right <= end) from = Math.max(from, right);
    if (right > end && it.x >= start && it.x < end) to = Math.min(to, it.x);
  }
  if (from === start && to === end) return undefined;
  return to - from >= MIN_GUTTER_PT ? { start: from, end: to } : undefined;
};

/**
 * Every clear gutter of a page: a vertical band that NO fragment crosses, with enough fragments on each side.
 *
 * Zero crossings is not a calibrated threshold: it is the definition of a column, and the criterion the repository
 * applies elsewhere, the most generous one WITHOUT ANY wrong split.
 */
export function findGutters(items: readonly GutterItem[]): Gutter[] {
  const real = items.filter((it) => it.text.trim().length > 0);
  if (real.length < MIN_SIDE_ITEMS * 2) return [];

  const widths = [...real.map((it) => it.width)].sort((a, b) => a - b);
  const median = widths[Math.floor(widths.length / 2)] ?? 0;
  const kept = median > 0 ? real.filter((it) => it.width <= median * TRANSVERSE_RATIO) : real;
  if (kept.length < MIN_SIDE_ITEMS * 2) return [];

  const edges = [...new Set(kept.flatMap((it) => [it.x, it.x + it.width]))].sort((a, b) => a - b);
  const found: Gutter[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const start = edges[i]!;
    const end = edges[i + 1]!;
    const widthPt = end - start;
    if (widthPt < MIN_GUTTER_PT) continue;
    const middle = (start + end) / 2;
    if (kept.some((it) => it.x < middle && it.x + it.width > middle)) continue;
    const white = whiteOfEveryLine(real, start, end);
    const x = white === undefined ? middle : (white.start + white.end) / 2;
    const left = kept.filter((it) => it.x + it.width <= x);
    const right = kept.filter((it) => it.x >= x);
    if (left.length < MIN_SIDE_ITEMS || right.length < MIN_SIDE_ITEMS) continue;
    found.push({ x, itemsLeft: left.length, itemsRight: right.length, widthPt: white === undefined ? widthPt : white.end - white.start, columnPt: Math.min(spanOf(left), spanOf(right)) });
  }
  return found.filter((g, i) => i === 0 || g.x - found[i - 1]!.x > GUTTER_APART_PT);
}

/**
 * LA COUPE DE COLONNES D'UNE PAGE, ou rien.
 *
 * Rend une abscisse **seulement** quand la page porte UNE SEULE gouttière, ET
 * que les deux bandes qu'elle sépare portent de la prose. Plusieurs gouttières
 * décrivent une grille — un tableau sans bordures — et ce module n'a rien à y
 * dire : le couper en deux colonnes mentirait sur sa nature.
 *
 * **L'abstention est le comportement par défaut**, et elle est fréquente : sur
 * 135 pages réelles, 22 rendent une coupe, 24 sont des grilles, et le reste ne
 * porte aucune gouttière franche. Depuis le 22/09/2026 une seule page des 39 PDF
 * français et anglais rend encore une coupe de gouttière : `11-Brochure` p2.
 *
 * 🔴 **LIMITE ÉCRITE — LE LIVRET IMPOSÉ RESTE TRESSÉ, ET CE DÉCOMPTE EN EST LA
 * CAUSE (22/09/2026).** `25-Notice-Montre-InDesign` pose huit pages de livret
 * sur deux feuilles A4 : deux colonnes, cinq rangées. La gouttière du pli est
 * franche — `x = 292`, large de 39 pt, 210 pt de colonne de chaque côté — mais
 * la page en porte DEUX AUTRES (`396`/16 pt et `492`/13 pt), nées du blanc des
 * pages de droite, qui sont peu remplies. Trois gouttières, donc « une grille »,
 * donc abstention : les deux pages du livret partagent leurs lignes de base, et
 * chaque ligne publiée colle la page de gauche à celle de droite —
 * « …le texte apparaît soit en représenté par une illustration. », une phrase qui
 * n'existe dans aucune des deux. Mesuré : 48 jonctions tressées sur les 2 pages,
 * 35 des 318 coupures en pleine phrase du corpus, 155 blocs déplacés.
 *
 * Aucun réglage de ce module n'y répond, et ce n'est pas faute d'en avoir cherché
 * un : la largeur de gouttière est un discriminant INVERSÉ (mesuré le 08/09/2026)
 * et la garde de prose ci-dessous refuse les trois (3,78 · 3,47 · 4,34 mots par
 * fragment). Il y faut le découpage RÉCURSIF par profil de projection de l'état
 * de l'art (XY-cut ; `docs/ETUDE-BIBLIOTHEQUES-PDF.md` [purged 27/09/2026, git history] leçon 17), c'est-à-dire
 * couper la page en bandes horizontales AVANT de chercher une gouttière. Mesuré
 * le 22/09/2026 : à 20 pt de blanc, la page 1 se découpe en 10 bandes, et le pli
 * reparaît comme gouttière dans quatre d'entre elles (298, 292, 289, 290). C'est
 * un chantier, pas un réglage, et rien n'est décidé.
 */
/**
 * DEUX GOUTTIÈRES QUI ENCADRENT UN ÉCLAT DÉCRIVENT LE MÊME BLANC — défaut de `columnCuts` elle-même, trouvé en la
 * mesurant le jour où elle a été écrite (04/11/2026).
 *
 * `GUTTER_APART_PT` fond déjà deux frontières distantes de moins de 20 pt. Mais un habillage de marge POSÉ dans la
 * gouttière — un numéro de page, une date verticale, une puce — la coupe en deux blancs que 20 pt ne rapprochent
 * plus, et chacun se retrouve avec une bande voisine de la largeur de l'éclat. Les deux tombent alors sur
 * `MIN_COLUMN_PT` et la page reste tressée.
 *
 * Mesuré sur `sd-1026348` p1 : gouttières à 297 (35 pt) et 334 (30 pt), QUATRE fragments d'un mot larges de 6 pt
 * entre les deux, et des bandes de 405 et 214 pt portant 5,67 et 5,37 mots par fragment — une page franchement en
 * deux colonnes, qu'aucune des deux gouttières ne coupait.
 *
 * ⚠️ AUCUN SEUIL NEUF : la bande intercalaire se juge sur `MIN_COLUMN_PT`, le même critère qui refusait les deux
 * gouttières. Ce qui n'est pas assez large pour être une colonne ne sépare pas deux colonnes — ici on en tire la
 * conséquence au lieu de s'abstenir. On garde le blanc le plus FRANC des deux : c'est la séparation la mieux
 * attestée, et l'éclat retombe dans une vraie bande au lieu de rester seul dans une bande de 6 pt.
 */
const withoutSlivers = (gutters: readonly Gutter[], real: readonly GutterItem[]): Gutter[] => {
  const out: Gutter[] = [];
  for (const gutter of gutters) {
    const previous = out[out.length - 1];
    if (previous === undefined) {
      out.push(gutter);
      continue;
    }
    const between = real.filter((it) => {
      const middle = it.x + it.width / 2;
      return middle > previous.x && middle < gutter.x;
    });
    if (spanOf(between) >= MIN_COLUMN_PT) out.push(gutter);
    else if (gutter.widthPt > previous.widthPt) out[out.length - 1] = gutter;
  }
  return out;
};

/** The gutters, without the first or last one when the band it leaves at the page's edge is narrower than
 *  `MIN_COLUMN_PT` — a margin of numbers or bullets, not a column (10/11/2026, see `columnCut`). */
const withoutMarginBands = (gutters: readonly Gutter[], real: readonly GutterItem[]): Gutter[] => {
  const centre = (it: GutterItem): number => it.x + it.width / 2;
  const out = [...gutters];
  const first = out[0];
  if (first !== undefined && spanOf(real.filter((it) => centre(it) < first.x)) < MIN_COLUMN_PT) out.shift();
  const last = out[out.length - 1];
  if (last !== undefined && spanOf(real.filter((it) => centre(it) > last.x)) < MIN_COLUMN_PT) out.pop();
  return out;
};

/** 🔴 TOUTES les coupes d'une page, et non la seule qu'elle porterait (04/11/2026).
 *
 *  POURQUOI, MESURÉ. `columnCut` ci-dessous s'abstient dès qu'une page a plus d'une gouttière : une page à quatre
 *  colonnes est donc lue en zigzag à travers les quatre. Coût mesuré sans aucune référence extérieure (sonde
 *  `broken_neighbours`, 100 documents du corpus, 6 pages chacun) : 1 534 voisinages cassés sur 17 813 paires de
 *  segments voisins dans le flux ET sur la page, 51 documents touchés, et **5 documents en portent 67 %** — tous à
 *  plusieurs colonnes, vérifié sur leur géométrie. Le pire, un journal, a ses bords gauches à 60, 205, 365 et 520 pt
 *  et sort deux lignes consécutives du même paragraphe séparées de 723 mots.
 *
 *  🔴 CHAQUE GOUTTIÈRE EST JUGÉE SUR SES DEUX BANDES ADJACENTES, jamais sur les deux moitiés de la page. Sans cela,
 *  une page à trois colonnes dont deux portent de la prose validerait la troisième par contagion, et la garde du
 *  22/09/2026 — une colonne d'ÉTIQUETTES n'est pas une colonne de texte — tomberait là où elle protège le plus.
 *  La largeur minimale se vérifie de même sur la bande, pas sur la moitié : `findGutters` rend un `columnPt` qui
 *  mesure tout ce qui est d'un côté, ce qui ne dit rien d'une colonne au milieu.
 *
 *  Ne décide RIEN de l'ordre : elle rend des abscisses, croissantes. Qui lit les bandes est `extractor/pdf-bands.ts`. */
export function columnCuts(items: readonly GutterItem[]): number[] {
  const real = items.filter((it) => it.text.trim().length > 0);
  const gutters = withoutSlivers(findGutters(items), real);
  if (gutters.length === 0) return [];
  const xs = gutters.map((g) => g.x);

  return xs.filter((x, index) => {
    // La bande de gauche s'arrête à la gouttière précédente, celle de droite commence à la suivante : les deux
    // voisines de CETTE coupe, et rien d'autre.
    const from = index === 0 ? Number.NEGATIVE_INFINITY : xs[index - 1]!;
    const to = index === xs.length - 1 ? Number.POSITIVE_INFINITY : xs[index + 1]!;
    const between = real.filter((it) => {
      const middle = it.x + it.width / 2;
      return middle > from && middle < to;
    });
    const left = between.filter((it) => it.x + it.width / 2 < x);
    const right = between.filter((it) => it.x + it.width / 2 >= x);
    if (spanOf(left) < MIN_COLUMN_PT || spanOf(right) < MIN_COLUMN_PT) return false;
    return bandsCarryProse(between, x);
  });
}

export function columnCut(items: readonly GutterItem[]): number | undefined {
  const real = items.filter((it) => it.text.trim().length > 0);
  // 🔴 A COLUMN OF NUMBERS IS NOT A COLUMN (10/11/2026, catalogue `sd-1026348`; Mikolaj: « il faut juste un espace après
  // les numéros de paragraphe »). The blank between a lot's number and its text made a gutter of its own, three on the
  // page, and the count below abstained. A band narrower than `MIN_COLUMN_PT` at the page's edge, or between two gutters
  // (`withoutSlivers`), is a margin of numbers: its gutter is not counted. The prose guard below still judges the cut.
  const gutters = withoutMarginBands(withoutSlivers(findGutters(items), real), real);
  const only = gutters.length === 1 ? gutters[0]! : undefined;
  // ⚠️ LA LARGEUR SE VÉRIFIE ICI, PAS DANS `findGutters`, et la nuance a coûté
  // trois tests (16/09/2026). Écarter une gouttière trop étroite AVANT le
  // décompte fait tomber une grille à une seule gouttière — donc la déclare
  // « deux colonnes ». `15-Facture-Libelle-Valeur` en porte deux, dont une de
  // 36 pt : la refuser à la mesure transformait le faux positif le plus
  // redouté du dépôt en partition. `findGutters` MESURE, `columnCut` DÉCIDE.
  if (only === undefined || only.columnPt < MIN_COLUMN_PT) return undefined;

  // ⚠️ UNE COLONNE D'ÉTIQUETTES N'EST PAS UNE COLONNE DE TEXTE (22/09/2026).
  //
  // Ce module rendait une coupe dès qu'une page portait UNE gouttière franche,
  // sans jamais demander ce que les deux bandes contiennent. Il était le SEUL
  // producteur de coupe à ne pas le demander : l'autre chemin, celui du
  // détecteur de tableaux, passe par l'étage 3 du discriminant
  // (`pdf-table-detector.ts`, `looksLikeTextColumns`) depuis le 08/09/2026.
  //
  // Le coût de ce trou est mesuré, et il est exactement l'inverse du tressage
  // qu'on voulait fermer : un formulaire « libellé | valeur » se lisait en DEUX
  // BANDES, donc tous les libellés à la suite, puis toutes les valeurs. Sur
  // `0000109` les dix numéros de loi (« HB 173 », « HB 192 »…) sortaient d'un
  // bloc, séparés de leur auteur et de leur objet ; sur `0000713` « Appel
  // d'offres n° : », « Fonction : » et « Généralités : » précédaient en bloc
  // les trois valeurs qui leur répondent.
  //
  // La question posée est celle de l'étage 3, réduite à ce que la gouttière
  // peut porter : les DEUX bandes portent-elles de la prose ? Les deux
  // populations et le seuil réemployé sont sur `bandsCarryProse`.
  //
  // ⚠️ LA MESURE PORTE SUR TOUS LES FRAGMENTS DE LA PAGE, pas sur ceux que
  // `findGutters` garde : le masquage des transverses sert à TROUVER le blanc,
  // pas à décrire ce que les bandes contiennent. Ce sont les valeurs de la
  // mesure ci-dessus.
  return bandsCarryProse(items, only.x) ? only.x : undefined;
}

/**
 * LA COUPE DE COLONNES D'UN DOCUMENT, décidée UNE FOIS pour toutes ses pages.
 *
 * ⚠️ **CE N'EST PAS UNE OPTIMISATION, C'EST UN INVARIANT.** Décider page par
 * page rend deux pages de géométrie IDENTIQUE différemment dès qu'un seuil passe
 * d'un côté sur l'une et de l'autre sur la seconde — vécu le 16/09/2026 en
 * branchant ce module : `11-Brochure-Deux-Colonnes` sortait sa page 0 séparée et
 * sa page 1 tressée, alors que les deux pages ont les mêmes coordonnées. C'est
 * le défaut que le lot du 08/09/2026 avait fermé sur le regroupement en lignes
 * (« deux fichiers visuellement identiques, deux lectures différentes »), et un
 * seuil de page le rouvrait.
 *
 * Même raison, même forme que `heading-sizes` : *« la titraille se décide à
 * l'échelle du DOCUMENT, jamais de la page »*.
 *
 * LA RÈGLE : on retient l'abscisse qui revient sur le PLUS de pages, à 10 pt
 * près. Une seule page suffit à la fonder — un document d'une page à deux
 * colonnes est légitime — mais elle vaut alors pour toutes.
 *
 * L'appliquer à une page qui n'a pas de colonnes ne casse rien :
 * `pdf.ts#bandedSplit` retombe de lui-même sur « aucune partition » dès qu'une
 * ligne pleine largeur traverse la coupe à l'intérieur de la zone.
 */
/** Les abscisses qui décrivent la MÊME coupe, à 10 pt près, regroupées — chaque groupe rendu par son médian.
 *  Les groupes sortent dans l'ordre croissant. */
const cutGroups = (cuts: readonly number[]): number[][] => {
  const groups: number[][] = [];
  for (const x of [...cuts].sort((a, b) => a - b)) {
    const last = groups[groups.length - 1];
    if (last !== undefined && x - last[last.length - 1]! <= 10) last.push(x);
    else groups.push([x]);
  }
  return groups;
};

const representative = (group: readonly number[]): number => group[Math.floor(group.length / 2)]!;

export function documentColumnCut(pages: readonly (readonly GutterItem[])[]): number | undefined {
  const groups = cutGroups(pages.map(columnCut).filter((x): x is number => x !== undefined));
  if (groups.length === 0) return undefined;
  // eslint-disable-next-line sonarjs/reduce-initial-value -- groups is non-empty here (the line above returned otherwise)
  return representative(groups.reduce((a, b) => (b.length > a.length ? b : a)));
}

/**
 * 🔴 LES COUPES DU DOCUMENT — l'invariant ci-dessus tenu sur N coupes (04/11/2026).
 *
 * Ce qui ne change pas : la décision est celle du DOCUMENT, jamais de la page. Ce qui change : un document peut
 * porter PLUSIEURS coupes, et la règle de `documentColumnCut` — « une seule page suffit à fonder une abscisse, mais
 * elle vaut alors pour toutes » — s'applique à CHAQUE groupe au lieu du seul plus fourni.
 *
 * 🔴 C'EST CE PASSAGE À L'ÉCHELLE DU DOCUMENT QUI RÉPARE LE JOURNAL, et non une décision page par page — qui
 * rouvrirait le défaut du 16/09/2026. Mesuré sur `sd-2479793` : la garde de prose refuse ses pages 1 et 2 (2,9 mots
 * par fragment, la population des ÉTIQUETTES) et retient les trois coupes de sa page 3 (4,5 à 5,4 mots). Décidées
 * au document, ces trois coupes valent pour les pages 1 et 2, qu'aucun réglage de seuil n'aurait sauvées.
 */
export function documentColumnCuts(pages: readonly (readonly GutterItem[])[]): number[] {
  return documentCutsOf(pages, columnCuts);
}

/** La même règle, pour un AUTRE producteur de coupes que la gouttière (`layout/column-grid.ts`, essai du
 *  04/11/2026) : ce qui est partagé est la décision à l'échelle du DOCUMENT, pas la preuve qui la fonde. */
export function documentCutsOf(
  pages: readonly (readonly GutterItem[])[],
  cutsOfPage: (page: readonly GutterItem[]) => readonly number[],
): number[] {
  return documentCutsRanked(pages, cutsOfPage).all;
}

/** Les mêmes coupes, ET celle qui fait autorité quand une seule est permise.
 *
 *  ⚠️ LA DOMINANTE EST CELLE QUE LE PLUS DE PAGES FONDENT, jamais la première venue — payé le 04/11/2026. En
 *  rendant `all[0]`, l'essai de la grille retenait les MÊMES trois coupes que la gouttière sur le journal
 *  `sd-2479793` et dégradait pourtant sa lecture de 148 à 363 voisinages cassés : la dominante passait de 356 à
 *  201, et elle ne sert pas qu'à la lecture en bandes — le bloc `columns` d'un tableau et le conteneur centré la
 *  lisent aussi. Une comparaison de signaux doit changer LE SIGNAL, pas une règle qui n'a rien à y voir. */
export function documentCutsRanked(
  pages: readonly (readonly GutterItem[])[],
  cutsOfPage: (page: readonly GutterItem[]) => readonly number[],
): { all: number[]; dominant: number | undefined } {
  const groups = cutGroups(pages.flatMap((page) => [...cutsOfPage(page)]));
  if (groups.length === 0) return { all: [], dominant: undefined };
  // eslint-disable-next-line sonarjs/reduce-initial-value -- groups is non-empty here (the line above returned otherwise)
  const dominant = representative(groups.reduce((a, b) => (b.length > a.length ? b : a)));
  return { all: apart(groups), dominant };
}

/**
 * 🔴 DEUX COUPES PLUS PROCHES QUE `MIN_COLUMN_PT` DÉCRIVENT LA MÊME FRONTIÈRE, et une seule survit (04/11/2026).
 *
 * Le groupement à 10 pt ci-dessus rapproche ce qui est manifestement la même abscisse. Il ne dit rien de deux
 * abscisses fondées par des pages DIFFÉRENTES, à 11 ou 30 pt l'une de l'autre : appliquées ensemble à toutes les
 * pages, elles découpent une bande plus étroite qu'un mot. Mesuré sur `sd-4979761` : trois coupes en 42 points
 * (256, 287, 298), une par page, et le document passait de 6 à 62 voisinages cassés.
 *
 * AUCUN SEUIL NEUF — `MIN_COLUMN_PT` est déjà la largeur minimale d'une colonne partout ailleurs ici. On garde la
 * mieux fondée, celle que le plus de pages portent ; à égalité, la plus à gauche, pour que le choix soit
 * déterministe et non l'ordre de visite des pages.
 */
function apart(groups: readonly (readonly number[])[]): number[] {
  const byStrength = [...groups].sort((a, b) => b.length - a.length || representative(a) - representative(b));
  const kept: number[] = [];
  for (const group of byStrength) {
    const x = representative(group);
    if (!kept.some((other) => Math.abs(other - x) < MIN_COLUMN_PT)) kept.push(x);
  }
  return kept.sort((a, b) => a - b);
}
