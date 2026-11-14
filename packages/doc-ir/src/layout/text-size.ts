/** The document's dominant body size, the normaliser that turns a threshold in
 *  points into a threshold in multiples of the text itself.
 *  NOT here: the thresholds that use it — the gutter
 *  (`layout/column-discriminant.ts`), the heading rule
 *  (`layout/heading-sizes.ts`), the wrapped-cell text (`layout/cell-text.ts`).
 *  Called by: `extractor/pdf-table-render.ts` and
 *  `layout/column-discriminant.ts`, through the `layout/geometry.ts` façade. */

import type { Fragment } from "./geometry-types";
import { modeOf, quarterPoint } from "./mode";

/**
 * LE CORPS DE TEXTE DOMINANT — le normalisateur des seuils typographiques.
 *
 * POURQUOI CETTE FONCTION EXISTE (11/09/2026). Un seuil en points absolus,
 * calibré sur un générateur, ENCODE ce générateur : c'est la faille de
 * généralité nommée à la MIKSUDOC « Spécification technique » §5.4.1. Un seuil exprimé en multiples
 * du corps de texte s'adapte à n'importe quelle source.
 *
 * POURQUOI LA HAUTEUR, ET PAS LA LARGEUR D'UN CARACTÈRE. Les deux ont été
 * mesurées sur les onze documents du corpus le 11/09/2026, et la largeur est
 * DISQUALIFIÉE : sa médiane va de 3,47 pt à 16,22 pt, un facteur 4,7 qui
 * transfère la fragilité du seuil au normalisateur. La hauteur donne un vrai
 * mode, de 6,50 pt à 22,00 pt, et surtout **concentré** : la taille dominante
 * rassemble de 72 % à 100 % des caractères du document selon la source. Un
 * normalisateur qui n'est pas dominant n'en est pas un.
 *
 * PONDÉRÉ PAR LES CARACTÈRES, JAMAIS PAR LES FRAGMENTS. Un titre isolé est un
 * fragment comme un autre ; ce qu'on cherche est la taille où le TEXTE se
 * trouve. Compter les fragments ferait gagner la taille la plus morcelée.
 *
 * Les hauteurs sont arrondies au quart de point avant d'être comptées : un même
 * corps sort à 6,499 et 6,501 selon le fragment, et deux classes voisines se
 * partageraient le mode.
 *
 * Rend `undefined` quand rien n'est mesurable — l'appelant garde alors sa valeur
 * absolue de repli plutôt que d'inventer une échelle.
 */
export function dominantTextSize(fragments: readonly Fragment[]): number | undefined {
  const charsBySize = new Map<number, number>();
  for (const f of fragments) {
    const chars = f.text.replace(/\s/g, "").length;
    if (chars === 0 || !(f.height > 0)) continue;
    const size = quarterPoint(f.height);
    charsBySize.set(size, (charsBySize.get(size) ?? 0) + chars);
  }
  // On an exact tie the SMALLEST size wins: the body is smaller than the headings, and the golden master needs a
  // deterministic tie-break (same input, same bytes).
  return modeOf(charsBySize, "smallest");
}
