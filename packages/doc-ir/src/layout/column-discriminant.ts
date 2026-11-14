/** Whether a page in two bands is a TABLE, real text COLUMNS, or neither —
 *  the gutter that cuts it, the vertical rhythm that betrays a table, and the
 *  positive proof of prose that has been wrapped.
 *  NOT here: the reading order that follows the cut
 *  (`extractor/pdf-bands.ts`, `layout/gutter.ts`), nor the grids themselves
 *  (`layout/vector-grid.ts`, `layout/aligned-grid.ts`).
 *  Called by: `extractor/pdf-document-scale.ts`,
 *  `extractor/pdf-table-detector.ts` and `tools/pdf-geometry-probe.ts`,
 *  through the `layout/geometry.ts` façade; and directly by `layout/gutter.ts` (`bandsCarryProse`). */

import type { Fragment } from "./geometry-types";
import { modeOf } from "./mode";
import { dominantTextSize } from "./text-size";

// ===========================================================================
// POINT 13 — DISCRIMINANT DE COLONNES (architecture révisée le 08/09/2026)
// ===========================================================================
//
// Quatre étages, chacun avec un travail mesuré sur le corpus étalon. Les trois
// premiers vivent ici (géométrie pure) ; le zéroième est
// `buildGridFromVectorLines` (`layout/vector-grid.ts`), qui décide seul quand
// le document dessine vraiment sa grille.
//
//   étage 0  grille vectorielle       -> TABLEAU, décide seule
//   étage 1  gouttière ?              -> non : prose, on ne touche à rien
//   étage 2  second rythme répété ?   -> oui : TABLEAU (candidat sans bordure)
//   étage 3  densité + mots/fragment  -> oui : COLONNES ; non : abstention
//
// TROIS SIGNAUX ONT ÉTÉ RETIRÉS d'une première conception, chacun parce que la
// mesure les a démentis — c'est écrit ici pour qu'ils ne reviennent pas :
//   - la LARGEUR de la gouttière : inversée (80 pt pour un tableau contre 35
//     pour de vraies colonnes). La largeur n'a jamais été la grandeur utile ;
//   - l'ÉQUILIBRE des bandes : n'existait que pour rattraper un faux positif de
//     `detectAlignedColumns` sur 05a, que la gouttière écarte déjà mieux ;
//   - la PART DES ÉCARTS ÉGAUX AU MODE : met une page courte à deux colonnes du
//     côté des tableaux, et un bloc libellé/valeur au-dessus des vraies
//     colonnes. C'est le NOMBRE d'occurrences d'un second rythme qui sépare,
//     pas la part du premier.

/** Un bin d'abscisse couvert par plus que cette part des lignes n'est pas une
 *  gouttière. Le seuil laisse passer les quelques lignes pleine largeur d'un
 *  vrai document (titre, chapeau, encadré) sans laisser passer une colonne.
 *
 *  **Valeur de départ à calibrer, pas une mesure.** Le corpus ne contient que
 *  deux documents denses. Mesuré avec cette valeur : 0,13 et 0,17 pour les
 *  gouttières réelles des fixtures 11 et 16. */
const GUTTER_MAX_LINE_COVERAGE = 0.2;

/** Une gouttière plus étroite que ceci est un espacement, pas une séparation de
 *  colonnes.
 *
 *  **CE SEUIL ÉTAIT ABSOLU** — dix points — et il transportait donc une taille
 *  de page (corrigé le 11/09/2026, MIKSUDOC « Spécification technique » §5.4.1). Il vaut maintenant
 *  UNE FOIS le corps de texte dominant, ce qui reproduit la valeur d'origine
 *  là où elle avait été mesurée : les deux documents denses du corpus ont un
 *  corps de 11 pt et de 9 pt, donc dix points y valaient déjà de 0,9 à 1,1 fois
 *  le corps. Une gouttière large d'un caractère de haut n'est pas une
 *  gouttière, quelle que soit la source.
 *
 *  **Valeur de départ à calibrer** : le corpus ne contient que deux documents
 *  denses. */
const GUTTER_MIN_WIDTH_RATIO = 1;

/** Repli quand le corps de texte n'est pas mesurable — l'ancienne valeur
 *  absolue, jamais une échelle inventée. */
const GUTTER_MIN_WIDTH_FALLBACK = 10;

/** Widest text box (in points) the gutter profile is built over. Above it the
 *  page abstains instead of allocating one bin per point. Valeur de départ à
 *  calibrer: not measured on a corpus yet, only meant to stop an absurd allocation. */
export const COLUMN_GUTTER_MAX_SPAN = 20_000;

/**
 * L'abscisse où couper une page en deux bandes, et rien d'autre.
 *
 * **CE QUE CE SIGNAL FAIT, ET CE QU'IL NE FAIT PAS.** Il répond à « cette page
 * a-t-elle une structure en bandes ? » et « où couper ? ». Il ne dit RIEN du
 * type de la structure : mesuré le 08/09/2026, la gouttière d'un tableau sans
 * bordure fait 80 pt et celle de vraies colonnes 35 pt. L'inversion est nette
 * et c'est l'étage 2 qui tranche le type.
 *
 * Le profil est calculé en FRACTION DES LIGNES qui couvrent chaque bin, pas en
 * présence/absence de fragment : sans cela, une seule ligne pleine largeur —
 * un titre, un chapeau — suffirait à effacer la gouttière de toute la page.
 *
 * C'est la garde d'entrée du dispositif, et la plus sûre : absente sur 05a,
 * 05d, 12 et 14, présente sur 11, 15, 16 et 17. Strictement meilleure que
 * `detectAlignedColumns` pour cet usage — 05a p0 déclenche celui-ci
 * (`[62.69, 83.95]`, deux bords 21 pt l'un de l'autre) et n'a aucune gouttière.
 */
export function detectColumnGutter(fragmentsByLine: readonly Fragment[][]): { cut: number; start: number; end: number } | undefined {
  // Non-finite geometry carries no position: such a fragment is ignored.
  const lines = fragmentsByLine
    .map((line) => line.filter((f) => f.text.trim().length > 0 && Number.isFinite(f.x) && Number.isFinite(f.y) && Number.isFinite(f.width)))
    .filter((line) => line.length > 0);
  if (lines.length === 0) return undefined;
  const all = lines.flat();
  let lo = Infinity;
  let hi = -Infinity;
  for (const f of all) {
    if (f.x < lo) lo = f.x;
    if (f.x + f.width > hi) hi = f.x + f.width;
  }
  if (!(hi - lo <= COLUMN_GUTTER_MAX_SPAN)) return undefined;
  const width = Math.ceil(hi - lo);
  if (width <= 0) return undefined;
  const body = dominantTextSize(all);
  const minGutter = body !== undefined && body > 0 ? GUTTER_MIN_WIDTH_RATIO * body : GUTTER_MIN_WIDTH_FALLBACK;

  const coverage = new Array<number>(width + 1).fill(0);
  for (const line of lines) {
    const bins = new Set<number>();
    for (const f of line) {
      const from = Math.max(0, Math.floor(f.x - lo));
      const to = Math.min(width, Math.ceil(f.x + f.width - lo));
      for (let i = from; i <= to; i++) bins.add(i);
    }
    for (const i of bins) coverage[i] = (coverage[i] ?? 0) + 1;
  }

  let best: { cut: number; start: number; end: number; width: number } | undefined;
  let runStart = -1;
  for (let i = 0; i <= width + 1; i++) {
    const empty = i <= width && coverage[i]! / lines.length <= GUTTER_MAX_LINE_COVERAGE;
    if (empty) {
      if (runStart < 0) runStart = i;
      continue;
    }
    if (runStart < 0) continue;
    const runWidth = i - runStart;
    // `runStart > 0 && i <= width` : une suite de bins vides qui touche un bord
    // de la boîte de texte est une MARGE, pas une gouttière.
    if (runWidth >= minGutter && runStart > 0 && i <= width && (best === undefined || runWidth > best.width)) {
      best = { cut: lo + runStart + runWidth / 2, start: lo + runStart, end: lo + i, width: runWidth };
    }
    runStart = -1;
  }
  return best ? { cut: best.cut, start: best.start, end: best.end } : undefined;
}

/** Un second rythme vu moins de fois que ceci est du bruit, pas une
 *  périodicité. Mesuré : 5 occurrences pour la fixture 17 (tableau sans
 *  bordure), 3 pour la facture et pour la page à tableau 05a, **1** pour les
 *  deux fixtures de colonnes. **Valeur de départ à calibrer.** */
const MIN_SECOND_RHYTHM_OCCURRENCES = 3;

export interface VerticalRhythm {
  /** Écart d'interligne le plus fréquent, arrondi au point. */
  mode: number;
  modeCount: number;
  /** Deuxième écart le plus fréquent, s'il existe. */
  second?: number;
  secondCount: number;
  sampleSize: number;
}

/**
 * L'histogramme des écarts verticaux entre lignes consécutives, arrondis au
 * point. Les lignes sont supposées déjà triées par ordonnée décroissante — ce
 * que garantit `groupFragmentsIntoVisualLines` depuis le 08/09/2026.
 */
export function verticalRhythm(fragmentsByLine: readonly Fragment[][]): VerticalRhythm | undefined {
  const ys = fragmentsByLine.map((line) => line.find((f) => f.text.trim().length > 0)?.y).filter((y): y is number => y !== undefined);
  const gaps = ys.slice(0, -1).map((y, i) => Math.round(y - ys[i + 1]!)).filter((g) => g > 0);
  if (gaps.length === 0) return undefined;
  const histogram = new Map<number, number>();
  for (const g of gaps) histogram.set(g, (histogram.get(g) ?? 0) + 1);
  const mode = modeOf(histogram, "smallest")!;
  const rest = new Map(histogram);
  rest.delete(mode);
  const second = modeOf(rest, "smallest");
  return {
    mode,
    modeCount: histogram.get(mode)!,
    ...(second !== undefined ? { second } : {}),
    secondCount: second === undefined ? 0 : histogram.get(second)!,
    sampleSize: gaps.length,
  };
}

/**
 * **LE SIGNAL PRINCIPAL POUR DIRE « TABLEAU », JAMAIS POUR DIRE « COLONNES ».**
 *
 * La raison est physique, pas statistique : **de la prose a UN rythme
 * d'interligne, un tableau en a DEUX** — l'interligne à l'intérieur d'une
 * cellule, et la séparation entre rangées. Mesuré sur le corpus (08/09/2026) :
 *
 *   17 (tableau sans bordure) : mode 12 pt, second rythme 20 pt vu 5 fois
 *   15 (facture)              : mode 16 pt, second rythme 13 pt vu 3 fois
 *   05a (page à tableau)      : mode 16 pt, second rythme 18 pt vu 3 fois
 *   16 (colonnes denses)      : mode 12 pt, second rythme vu 1 fois
 *   11 (colonnes courtes)     : mode 26 pt, second rythme vu 1 fois
 *
 * Il repose sur un COMPTE et non sur une fraction, ce qui le rend lisible même
 * sur une page courte — là où toutes les fractions cessent de vouloir dire
 * quelque chose.
 *
 * **SON ABSENCE N'EST PAS UNE PREUVE DE COLONNES.** Un bloc libellé/valeur
 * isolé (quatre lignes de facture) est parfaitement mono-rythmé : 3 écarts sur
 * 3 identiques, aucun second rythme. Et ce ne sont pas des colonnes. « Pas de
 * second rythme » veut dire « aucune preuve de tableau », rien de plus — d'où
 * l'étage 3, qui exige une preuve POSITIVE avant de partitionner.
 *
 * **Limite de fabrication, mesurée sur une seule fixture** : le second rythme
 * de la fixture 17 est le padding CONSTANT entre rangées. Un tableau à padding
 * variable n'aurait pas de second mode répété, et le corpus n'en contient pas.
 */
export function hasRepeatedSecondRhythm(fragmentsByLine: readonly Fragment[][]): boolean {
  const rhythm = verticalRhythm(fragmentsByLine);
  return rhythm !== undefined && rhythm.secondCount >= MIN_SECOND_RHYTHM_OCCURRENCES;
}

/** En dessous de ce nombre de lignes, aucun signal exprimé en fraction n'a de
 *  sens — trois signaux indépendants l'ont montré le 08/09/2026 en classant la
 *  fixture 11 (8 et 6 lignes, de vraies colonnes) du côté des tableaux.
 *
 *  **Valeur de départ à calibrer** : le corpus ne contient que deux documents
 *  denses. Mais la porte elle-même n'est pas un contournement, et la raison
 *  n'est pas statistique — voir `looksLikeTextColumns`. */
const MIN_COLUMN_LINES = 10;

/** En dessous de cette moyenne, une bande porte des étiquettes ou des valeurs,
 *  pas de la prose. Mesuré : 2,00 à 2,25 pour un bloc libellé/valeur isolé,
 *  1,69 à 3,00 pour la facture entière, 4,80 à 8,77 pour de vraies colonnes.
 *  **Valeur de départ à calibrer.** */
const MIN_WORDS_PER_FRAGMENT = 4;

const wordCount = (text: string): number => text.trim().split(/\s+/).filter((w) => w.length > 0).length;

/** Ce qu'il faut savoir d'un fragment pour dire s'il porte de la prose : son
 *  texte et son emprise horizontale. Ni ordonnée ni hauteur — c'est ce qui
 *  permet à `layout/gutter.ts` de poser la même question. */
export interface BandFragment {
  text: string;
  x: number;
  width: number;
}

/**
 * LES DEUX BANDES D'UNE COUPE PORTENT-ELLES DE LA PROSE, ou l'une n'est-elle
 * qu'une colonne d'étiquettes ?
 *
 * C'est le critère des mots par fragment de l'étage 3, SEUL — sans la porte des
 * dix lignes ni le durcissement par les minuscules initiales. Isolé ici parce
 * que la coupe de gouttière (`layout/gutter.ts`) a besoin de celui-là et
 * d'aucun des deux autres : elle sert des pages courtes, et elle ne cherche pas
 * à rescaper un formulaire bavard.
 *
 * **LES DEUX POPULATIONS, mesurées le 22/09/2026 sur les 39 PDF français et
 * anglais**, sur les coupes que la gouttière retenait vraiment (mots par
 * fragment de la bande la plus pauvre) :
 *
 *   colonne d'étiquettes lue comme une colonne de texte
 *     0000523 p5 « 1/3 »                        1,00
 *     0000713 p1 pied de page                   1,20
 *     0000713 p2 « Documents d'informations »   1,80
 *     0000109 p1 « HB 173 », « HB 192 »…        2,00
 *     24 p4 étiquettes d'images                 2,57
 *     0000713 p6 « Personne de contact : »      2,75
 *     24 p7                                     3,20
 *     24 p5                                     3,57
 *   vraies colonnes de prose
 *     11-Brochure-Deux-Colonnes p2              5,75
 *
 * Écart 3,57 → 5,75, et `MIN_WORDS_PER_FRAGMENT` (4) tombe dedans : aucun seuil
 * neuf n'est introduit, c'est celui de l'étage 3 qui sert une seconde fois.
 */
export function bandsCarryProse(fragments: readonly BandFragment[], cut: number): boolean {
  const real = fragments.filter((f) => f.text.trim().length > 0);
  // Les deux bandes doivent porter de la prose, pas une seule : une page dont
  // une bande est vide n'est pas en colonnes, elle est en une colonne.
  for (const side of [(f: BandFragment) => f.x + f.width / 2 < cut, (f: BandFragment) => f.x + f.width / 2 >= cut]) {
    const band = real.filter(side);
    if (band.length === 0) return false;
    const words = band.reduce((sum, f) => sum + wordCount(f.text), 0) / band.length;
    if (words < MIN_WORDS_PER_FRAGMENT) return false;
  }
  return true;
}

/**
 * DURCISSEMENT DE LA BRANCHE DENSE (09/09/2026) — deux constantes, et deux
 * raisons qu'il faut lire avant d'y toucher.
 *
 * ===========================================================================
 * CE QUE CE SIGNAL FAIT, ET SURTOUT CE QU'IL NE FAIT PAS
 * ===========================================================================
 * Une ligne qui commence par une MINUSCULE est la continuation de la
 * précédente : c'est le seul indice, sans modèle et sans dictionnaire, qu'un
 * texte a été REPLIÉ. Un bloc libellé/valeur n'en produit jamais.
 *
 * **Il DURCIT la branche dense, il n'élargit rien.** Il ne sert qu'à REFUSER
 * un partitionnement que les autres critères auraient accepté ; il n'en
 * autorise aucun de plus. Le cas SANS REMÈDE reste exactement ce qu'il est —
 * les pages courtes à deux bandes dont les lignes sont des items complets ne
 * sont pas partitionnées, et `11-Brochure-Deux-Colonnes.pdf` en relève
 * toujours. Ce n'était pas le but et ça ne l'est pas devenu : mesuré sur des
 * documents réels, ce signal ne rescape pas les pages courtes (voir le bloc
 * consigné au STATUS le 09/09/2026).
 *
 * Ce qu'il attrape, et c'est étroit : un formulaire LONG dont les libellés
 * seraient assez bavards pour franchir `MIN_WORDS_PER_FRAGMENT`. C'est le seul
 * faux positif que la géométrie laisse passer.
 *
 * ===========================================================================
 * LA GARDE PAR LA PART DE CARACTÈRES À CASSE N'EST PAS UNE OPTIMISATION
 * ===========================================================================
 * **Sans elle, ce signal vaut 0,00 sur tout document japonais, chinois ou
 * coréen — et refuserait donc de partitionner un document CJK correctement
 * mis en colonnes.** Han, kana et hangul n'ont pas de casse : l'absence de
 * minuscule initiale n'y est pas une information, c'est un silence.
 *
 * Mesuré le 09/09/2026 sur le livre blanc 情報通信白書 (総務省), corps de
 * texte, 1 145 lignes : part de minuscules initiales **0,00 à 0,03** (le
 * résidu est du latin incrusté — sigles, unités), contre 0,67 en français et
 * 0,29 en allemand. Aucun substitut n'atteint le rapport signal/bruit
 * nécessaire : le hiragana initial sépare 0,02 (page de libellés) de 0,19
 * (prose), soit 1,5 événement attendu sur une page de huit lignes.
 *
 * La garde teste la part de caractères À CASSE, pas la langue : la langue
 * n'est pas disponible à cet étage (`detect-language.ts` tourne dans
 * l'orchestrateur, sur l'IRDoc enrichi, et seulement si l'harmonisation est
 * activée), tandis que la casse se lit dans le texte lui-même.
 *
 * **Ne retire pas cette condition en « simplifiant ».** Elle a l'air d'un
 * garde-fou superflu tant qu'on ne teste qu'avec des documents latins.
 *
 * Note sur l'état actuel, pour ne pas se tromper sur qui protège quoi :
 * aujourd'hui `MIN_WORDS_PER_FRAGMENT` abstient DÉJÀ sur le japonais, mais par
 * effet de bord — `wordCount` coupe sur les espaces, et le japonais n'en met
 * pas entre les mots, donc tout fragment y compte pour un seul mot. La garde
 * de casse est ce qui rendra le refus correct le jour où ce comptage sera
 * corrigé, au lieu de dépendre d'un accident.
 *
 * ===========================================================================
 * LES DEUX SEUILS
 * ===========================================================================
 * **Valeurs de départ à calibrer, pas des mesures.** Et 0,15 a une marge
 * mince, il faut le savoir : il vient de deux documents réels seulement, et le
 * rapport allemand mesuré descend à **0,20 sur ses pages les plus pauvres**
 * (médiane 0,29, contre 0,67 pour le français — un facteur 2,3, l'allemand
 * mettant une majuscule à tous ses substantifs). Un seuil relevé au-dessus de
 * 0,20 cesserait de reconnaître de la prose allemande.
 */
const MIN_LOWERCASE_LINE_STARTS = 0.15;

/** En dessous de cette part de caractères à casse, l'écriture n'est pas
 *  bicamérale et `MIN_LOWERCASE_LINE_STARTS` n'a aucun sens. Mesuré : 0,83
 *  (français) et 0,81 (allemand) contre 0,07 à 0,20 (japonais).
 *  **Valeur de départ à calibrer.** */
const MIN_CASED_CHAR_FRACTION = 0.5;

const CASED_CHAR = /\p{Lu}|\p{Ll}/gu;
const STARTS_LOWERCASE = /^\s*["«(\[]?\p{Ll}/u;

/**
 * Étage 3 : la preuve POSITIVE qu'on a affaire à deux colonnes de prose, et
 * non à l'absence de preuve du contraire.
 *
 * **POURQUOI LA DENSITÉ EST UNE CONDITION ET NON UN RÉGLAGE.** Le bloc
 * métadonnées d'une facture — libellés à gauche, valeurs à droite — a été
 * mesuré ISOLÉ le 08/09/2026, c'est-à-dire exactement dans l'état où se
 * présente une page courte à deux bandes :
 *
 *                        bloc libellé/valeur   colonnes denses (16)
 *   lignes                        4                    48
 *   gouttière                  230 pt                 35 pt
 *   second rythme               aucun                 aucun
 *   lignes des deux côtés        1,00                  0,92
 *   remplissage             0,82 / 0,93           0,95 / 0,92
 *   mots par fragment       2,25 / 2,00           8,74 / 8,77
 *
 * Il passe TOUS les signaux sauf un — gouttière plus franche que la brochure,
 * rythme unique comme elle, lignes des deux côtés PLUS systématiques. Seul
 * l'écart des mots par fragment reste. On distinguerait donc une page courte à
 * deux colonnes d'un bloc libellé/valeur sur un signal UNIQUE, alors que les
 * libellés d'une vraie facture sont souvent des phrases. Un signal seul n'est
 * pas un discriminant.
 *
 * **Conséquence assumée et consignée** : les pages courtes à deux colonnes ne
 * sont pas partitionnées, leur texte reste entrelacé, et
 * `11-Brochure-Deux-Colonnes.pdf` — la fixture qui a servi à écrire le point 13
 * — relève de ce cas. Le point est clos pour les documents denses, pas clos
 * tout court.
 */
export function looksLikeTextColumns(fragmentsByLine: readonly Fragment[][], cut: number): boolean {
  const lines = fragmentsByLine.map((line) => line.filter((f) => f.text.trim().length > 0)).filter((line) => line.length > 0);
  if (lines.length < MIN_COLUMN_LINES) return false;
  if (!bandsCarryProse(lines.flat(), cut)) return false;
  for (const side of [(f: Fragment) => f.x + f.width / 2 < cut, (f: Fragment) => f.x + f.width / 2 >= cut]) {
    const linesOnSide = lines.map((line) => line.filter(side)).filter((line) => line.length > 0);
    const fragments = linesOnSide.flat();

    // Le durcissement — voir MIN_LOWERCASE_LINE_STARTS pour les deux raisons
    // qui le tiennent. Mesuré PAR BANDE et non sur la ligne visuelle entière :
    // c'est bien la bande qui est ou n'est pas de la prose repliée, et le
    // premier fragment d'une bande est son début de ligne (le regroupement
    // trie par abscisse croissante).
    const text = fragments.map((f) => f.text).join("");
    const casedFraction = (text.match(CASED_CHAR) ?? []).length / Math.max(1, text.length);
    if (casedFraction < MIN_CASED_CHAR_FRACTION) continue;
    const lowercaseStarts = linesOnSide.filter((line) => STARTS_LOWERCASE.test(line[0]!.text)).length / linesOnSide.length;
    if (lowercaseStarts < MIN_LOWERCASE_LINE_STARTS) return false;
  }
  return true;
}
