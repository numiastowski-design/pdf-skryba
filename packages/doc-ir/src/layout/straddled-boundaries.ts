/** Doubled grid boundaries: ONE thick rule drawn as two close edges is ONE boundary, not two. Two consecutive boundaries at
 *  most `delta` apart (inclusive) with no fragment centre in the CLOSED interval [b1, b2] are replaced by their midpoint.
 *  DEPUIS LE 30/10/2026, une seconde porte : une paire que le TEXTE TRAVERSE — un fragment commence avant sa frontière basse
 *  et finit après la haute — se replie AU-DELÀ de `delta`, et sur son BORD plutôt que sur son milieu. Le milieu d'une paire
 *  large n'appartient à aucun trait peint, et `merged-cells.ts` ne reconnaît une frontière qu'à 2 pt d'un trait : c'est cette
 *  contrainte, et non la largeur, qui interdisait de monter `delta`. Le garde des centres de fragment passe avant tout : une
 *  colonne qui CONTIENT du texte ne se replie jamais.
 *  Qualifying gaps that follow one another form a maximal segment: two gaps (three boundaries) merge at the midpoint of the
 *  EXTREMES; a gap holding a fragment centre cuts the chain (each remaining segment merges on its own); three gaps or more
 *  (four boundaries or more) abstain as a whole. Pure: numbers in, numbers out, inputs never mutated.
 *  NOT here: the value of `delta` (declared beside its caller, `DOUBLED_RAIL_MAX_GAP_PT` in `extractor/pdf-table-detector.ts`,
 *  with its populations), the choice of which boundaries to hand in, and any rewrite of cells after the merge.
 *  Called by: `extractor/pdf-table-detector.ts` (column boundaries of each stage-0 grid). */

/** The boundaries that replace the segment `first..last` (indices of boundaries, at least one qualifying gap): the segment itself when
 *  it abstains, else ONE boundary. A doubled rail on the hull is one thick rule whose ENVELOPE bounds the table: merging it to the
 *  midpoint would shrink the hull and eject glyphs the rule enclosed (141 p70: "(" at x-centre 55.39 inside the rail [54.2, 58.0]).
 *  So a segment touching the first boundary keeps its outer left edge, one touching the last keeps its outer right edge, an inner one
 *  takes the midpoint of its extremes. A segment spanning the whole list (two boundaries, or a chain of three) abstains, and so
 *  does one of three gaps or more. */
function replacementOf(boundaries: readonly number[], first: number, last: number): number[] {
  const touchesFirst = first === 0;
  const touchesLast = last === boundaries.length - 1;
  if (last - first > 2 || (touchesFirst && touchesLast)) return boundaries.slice(first, last + 1);
  if (touchesFirst) return [boundaries[first]!];
  if (touchesLast) return [boundaries[last]!];
  return [(boundaries[first]! + boundaries[last]!) / 2];
}

/**
 * Measured 27/10/2026 (boundaries probe, 63 PDF, 3124 boundaries):
 * - Rule A1 of the conception (a rail straddled by k lines is no boundary) was REJECTED by measure: the target boundary
 *   (47-GrandSoissons p10) is straddled on 59 % of its lines, while boundaries of FOUND tables are straddled at 78-100 %
 *   (074 p2, 106 p17, 123 p3 - their merged cells explain the straddling). No (k, s) separates the populations, so no rule.
 * - Row boundaries are NOT merged: 643 no-text row gaps <= 5 pt cannot be told apart from real thin rows (thinnest row WITH
 *   text: 2.39 pt). Columns only.
 */
export function mergeDoubledBoundaries(
  boundaries: readonly number[],
  fragmentCenters: readonly number[],
  delta: number,
  /**
   * LE TEXTE PASSE-T-IL AU-DESSUS de cette paire de frontières ? (30/10/2026 : inférer la colonne du TEXTE.)
   *
   * Une paire TRAVERSÉE se replie quel que soit son écart, là où `delta` seul ne sait pas trancher. Mesuré le
   * 30/10/2026 sur 77 PDF, 445 grilles, 193 colonnes de moins de 12 pt : 127 sont traversées (largeur moyenne
   * 5,67 pt — les éclats de filets doublés), 65 sont vides, et UNE SEULE porte son propre texte (6,50 pt,
   * `43-Safeguarding-Policy` p4). La largeur ne sépare pas les deux populations ; le fait que le texte passe
   * au-dessus, oui. Le garde des centres de fragment reste en vigueur : une colonne qui CONTIENT du texte ne se
   * replie jamais, traversée ou non.
   *
   * Absent : rien n'est traversé, et la fonction décide comme avant le 30/10/2026.
   */
  crosses?: (low: number, high: number) => boolean,
): number[] {
  // A DESCENDING list (TableGrid.rowBoundaries runs top-down) would make every negative gap "qualify" and the centre guard
  // unsatisfiable, mass-merging the whole list in silence (review of 27/10/2026). Mirror it instead, so either order is read
  // for what it is, and the caller's order is given back.
  if (boundaries.length > 1 && boundaries[0]! > boundaries[boundaries.length - 1]!) {
    return mergeDoubledBoundaries([...boundaries].reverse(), fragmentCenters, delta, crosses).reverse();
  }
  const out: number[] = [];
  const count = boundaries.length;
  /** POURQUOI une paire se replie, ou rien : `"gap"` quand son écart tient dans `delta`, `"crossed"` quand le texte la
   *  traverse. La raison est RENDUE plutôt qu'écrite à côté — un prédicat qui mute un tableau parallèle se lit mal, et
   *  son silence ne se distingue pas d'un « pas encore calculé » (revue du 30/10/2026). */
  const reasonOf = (i: number): "gap" | "crossed" | undefined => {
    const low = boundaries[i]!;
    const high = boundaries[i + 1]!;
    // Le garde des centres passe d'abord, et il ne cède à rien : une colonne qui CONTIENT du texte est une colonne.
    if (fragmentCenters.some((center) => center >= low && center <= high)) return undefined;
    if (high - low <= delta) return "gap";
    return crosses?.(low, high) === true ? "crossed" : undefined;
  };
  let i = 0;
  while (i < count) {
    const reason = i + 1 < count ? reasonOf(i) : undefined;
    if (reason === undefined) {
      out.push(boundaries[i]!);
      i += 1;
      continue;
    }
    let end = i + 1;
    while (end + 1 < count && reasonOf(end) !== undefined) end += 1;
    // UNE PAIRE TRAVERSÉE SE REPLIE SUR SON BORD, JAMAIS SUR LE MILIEU (30/10/2026). Le milieu d'une paire large
    // n'appartient à aucun trait peint, et `merged-cells.ts` ne reconnaît une frontière qu'à 2 pt d'un trait : chaque
    // rangée lirait alors un colspan par-dessus et le tableau s'effondrerait. Le bord, lui, EST le trait.
    out.push(...(reason === "crossed" ? [boundaries[i]!] : replacementOf(boundaries, i, end)));
    i = end + 1;
  }
  return out;
}
