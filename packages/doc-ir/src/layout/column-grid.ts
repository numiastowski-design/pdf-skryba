/** Whether a page is a GRID OF COLUMNS, read on the left edges its blocks repeat rather than on the white between
 *  them — the signal that survives one stray fragment.
 *  NOT here: the gutter, which reads the white (`layout/gutter.ts`), nor the prose test a gutter cut must pass
 *  (`layout/column-discriminant.ts`), nor the band reading that uses the cuts (`extractor/pdf-bands.ts`).
 *  Called by: `extractor/pdf-document-scale.ts`. */

import { maxOf, minOf } from "doc-ir/lib/extent";
import type { GutterItem } from "./gutter";

/**
 * LA GRILLE DE COLONNES — l'idée de Mikolaj du 04/11/2026 : « on peut pas trouver les blocs de même largeur ? en
 * fait on voit pas qu'ils sont côte à côte ? ».
 *
 * POURQUOI UN SECOND SIGNAL. La gouttière est un blanc que PERSONNE ne traverse, donc **un seul fragment égaré la
 * referme**. Mesuré sur `sd-4133285` (Federal Register, quatre pages à trois colonnes) : zéro gouttière trouvée, et
 * ce sont quatre bouts d'habillage qui les referment — « Federal Register » (141→217), « PO 00000 » (202→231). La
 * page passe pour ordinaire et sort tressée. Ses bords gauches, eux, sont là : **45 × 95 fragments, 222 × 66,
 * 399 × 76**, pas de 177 pt deux fois. Soixante bords alignés survivent à un intrus ; un blanc, non.
 *
 * ⚠️ LE BORD DROIT D'UNE COLONNE SE PREND À LA MÉDIANE, JAMAIS AU MAXIMUM. Un titre pleine largeur qui COMMENCE
 * dans la colonne porte son bord droit jusqu'au bout de la page : au maximum, la première colonne du Federal
 * Register mesure 426 pt au lieu de 168, et le rapport des largeurs passe de 1,05 à 2,54. C'est la différence
 * entre un signal qui sépare et un signal qui ne sépare rien.
 *
 * ⚠️ CE MODULE NE DÉCIDE PAS SEUL CE QUI EST PUBLIÉ : il rend des abscisses. Qui lit les bandes est
 * `extractor/pdf-bands.ts`, et qui choisit entre ce signal et la gouttière est `extractor/pdf-document-scale.ts`.
 */

/** La part des fragments d'une page qu'un bord gauche doit tenir pour être un DÉPART de colonne. Deux populations
 *  mesurées le 04/11/2026 : les vrais départs tiennent 13 à 47 % des fragments de leur page (Federal Register
 *  45×95/222×66/399×76 sur 238, journal `sd-2479793` p3 95/78/75/59 sur 307) ; le bruit — une puce, un retrait, un
 *  libellé — tient 1 à 3 % (52×7, 56×5, 126×4 sur la même page de 238). **Valeur de départ à calibrer.** */
const MIN_COLUMN_SHARE = 0.1;

/** Et au moins ce nombre de fragments, quelle que soit la part : sur une page de vingt fragments, 10 % vaudrait
 *  deux. Même valeur et même raison que `MIN_SIDE_ITEMS` de la gouttière. */
const MIN_START_ITEMS = 4;

/** Sous ce nombre de départs, il n'y a pas de grille : une colonne unique n'est pas une grille, et c'est le cas
 *  des documents d'une seule colonne qui nous intéressait (fixture 24, un départ par page). */
const MIN_GRID_COLUMNS = 2;

/** Au-dessus de ce rapport entre la plus LARGE et la plus étroite des colonnes, les blocs ne forment pas une
 *  grille. Les deux populations, mesurées le 04/11/2026 sur les bords droits MÉDIANS :
 *
 *    vraies colonnes   1,00 · 1,01 · 1,03 · 1,04 · 1,04 · 1,05 · 1,05 · 1,05 · 1,09 · 1,13 · 1,17
 *    une seule colonne 15,21 (livret 26 p2 : une colonne de puces de 17 pt contre un texte de 263)
 *
 *  L'écart est franc et le seuil tombe dedans. **Valeur de départ à calibrer** : deux documents seulement du côté
 *  négatif. */
const MAX_WIDTH_RATIO = 1.2;

/** Le même rapport, mais sur le NOMBRE DE CARACTÈRES posés dans chaque colonne — le second indice proposé.
 *
 *  🔴 LES DEUX POPULATIONS SE CHEVAUCHENT, et c'est écrit plutôt que caché : vraies colonnes 1,05 à **2,70**
 *  (une page de titres à trois colonnes, `sd-5832532` p1 : 1281 / 474 / 609 caractères), une seule colonne **4,63**
 *  (livret 26 p2). Entre 2,70 et 4,63 il n'y a aucune mesure. Ce signal n'est donc PAS un discriminant au sens du
 *  dépôt, et il n'est ici que pour être comparé à l'œil (A/B/C demandé par Mikolaj le 04/11/2026). */
const MAX_CHARS_RATIO = 3;

/** Ce que la grille sait d'une colonne : où elle commence, où elle finit (bord droit MÉDIAN), ce qu'elle porte. */
interface GridColumn {
  at: number;
  right: number;
  count: number;
  chars: number;
}

/** Ce qui prouve la grille : des largeurs égales, ou des caractères en nombre voisin. */
type GridEvidence = "width" | "chars";

const median = (xs: readonly number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

/** Les DÉPARTS de colonnes d'une page : les bords gauches que les fragments répètent, dans l'ordre croissant. */
export function columnStarts(items: readonly GutterItem[]): GridColumn[] {
  const real = items.filter((it) => it.text.trim().length > 0);
  if (real.length === 0) return [];
  const groups: { at: number; count: number }[] = [];
  for (const it of [...real].sort((a, b) => a.x - b.x)) {
    const last = groups[groups.length - 1];
    // Deux points : la tolérance de `SAME_LINE_PT` serait celle d'une ligne, pas celle d'un bord de colonne.
    if (last !== undefined && it.x - last.at <= 2) last.count += 1;
    else groups.push({ at: it.x, count: 1 });
  }
  const enough = Math.max(MIN_START_ITEMS, real.length * MIN_COLUMN_SHARE);
  const starts = groups.filter((g) => g.count >= enough).map((g) => g.at);

  return starts.map((at, index) => {
    const to = starts[index + 1] ?? Number.POSITIVE_INFINITY;
    // Ce qui appartient à la colonne : ce qui COMMENCE entre ce départ et le suivant. Un fragment transverse n'est
    // donc pas écarté — il est noyé par la médiane, ce qui est tout l'intérêt.
    const own = real.filter((it) => it.x >= at - 2 && it.x < to - 2);
    return { at, count: own.length, right: median(own.map((it) => it.x + it.width)), chars: own.reduce((n, it) => n + it.text.trim().length, 0) };
  });
}

/**
 * LES COUPES D'UNE PAGE LUE COMME UNE GRILLE, ou rien.
 *
 * Une coupe tombe au MILIEU du blanc entre deux colonnes — entre le bord droit médian de l'une et le départ de la
 * suivante. Des colonnes qui se chevauchent (bord droit médian au-delà du départ suivant) ne sont pas une grille :
 * on s'abstient en entier plutôt que de couper au jugé.
 */
export function gridCuts(items: readonly GutterItem[], evidence: GridEvidence): number[] {
  const columns = columnStarts(items);
  if (columns.length < MIN_GRID_COLUMNS) return [];
  if (columns.some((c, i) => i + 1 < columns.length && c.right >= columns[i + 1]!.at)) return [];

  const measured = evidence === "width" ? columns.map((c) => c.right - c.at) : columns.map((c) => c.chars);
  const low = minOf(measured, (m) => m);
  if (low <= 0) return [];
  if (maxOf(measured, (m) => m) / low > (evidence === "width" ? MAX_WIDTH_RATIO : MAX_CHARS_RATIO)) return [];

  const real = items.filter((it) => it.text.trim().length > 0);
  return columns.slice(0, -1).map((c, i) => placeCut(real, c.right, columns[i + 1]!.at));
}

/**
 * 🔴 OÙ POSER LA COUPE DANS LE BLANC — et ce n'est pas son milieu (04/11/2026, payé d'un seul point).
 *
 * `extractor/pdf-bands.ts` abandonne TOUTE la zone en colonnes dès qu'un fragment traverse la coupe à l'intérieur.
 * Une coupe est donc une position, pas une moyenne. Mesuré sur le journal `sd-2479793` : la gouttière coupait à
 * 357, la grille à 356 — un fragment traverse 356 et pas 357 — et le même document passait de 148 à 363 voisinages
 * cassés, avec les mêmes trois colonnes trouvées. Le milieu géométrique était un hasard.
 *
 * On pose donc la coupe là où le MOINS de fragments la traversent. Les bords des fragments qui traversent
 * l'intervalle découpent le blanc en morceaux, et dans un morceau le compte ne change pas : la coupe se pose au
 * MILIEU du morceau le moins traversé, le plus large à égalité, puis le plus près du milieu du blanc.
 *
 * 🔴 PAS SUR LE BORD D'UN FRAGMENT (05/11/2026). La première règle retenait le bord même du fragment le plus long,
 * sans marge : sur le Federal Register `sd-4133285`, les lignes justifiées de la colonne 2 dépassent son bord droit
 * MÉDIAN (373) jusqu'à 390, la colonne 3 part à 399, et la coupe tombait à 388,7, 389,8 et 388,8 selon la page. La
 * coupe du DOCUMENT, 389, tombait alors un point DANS la colonne 2 de la page 2 : quatre lignes « transverses », la
 * page lue par morceaux, les notes en tresse. Au milieu du blanc restant, 394, aucune page ne la traverse.
 */
function placeCut(items: readonly GutterItem[], from: number, to: number): number {
  const middle = (from + to) / 2;
  const crossing = items.filter((it) => it.x < to && it.x + it.width > from);
  if (crossing.length === 0) return middle;
  const edges = [...new Set([from, to, ...crossing.flatMap((it) => [it.x, it.x + it.width]).filter((x) => x > from && x < to)])].sort((a, b) => a - b);
  const cost = (x: number): number => crossing.filter((it) => it.x < x && it.x + it.width > x).length;
  const pieces = edges.slice(0, -1).map((a, i) => ({ at: (a + edges[i + 1]!) / 2, width: edges[i + 1]! - a }));
  return pieces.reduce((best, piece) => {
    const [here, there] = [cost(piece.at), cost(best.at)];
    if (here !== there) return here < there ? piece : best;
    if (piece.width !== best.width) return piece.width > best.width ? piece : best;
    return Math.abs(piece.at - middle) < Math.abs(best.at - middle) ? piece : best;
  }).at;
}
