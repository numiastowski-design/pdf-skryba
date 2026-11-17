/** 🔒 **CE MODULE NE SE SUPPRIME PAS** (30/10/2026). Il ne répare encore rien — les 26 « o » de
 *  `013-ft4-sharing-cities-report` restent des paragraphes, quelque chose en aval les refuse — et il ne casse rien
 *  non plus : le projet `pdf` entier est vert avec lui. Il reste parce qu'il est **la première induction de motif
 *  qui tienne dans ce dépôt**, avec sa mesure et ses gardes écrites, et qu'il doit servir de modèle aux suivantes
 *  (mobilier à fente, formats de référence, en-têtes de tableau).
 *
 *  🔎 **CE QUI LUI MANQUE EST MESURÉ, PAS SUPPOSÉ** (sondes du 30/10 sur `013`). L'induction FAIT son travail :
 *  `induced=["o"]`, le marqueur sort (`{kind:"bullet",length:2}`), et la ligne est bien retirée — les puces tiennent
 *  leur colonne à **93 pt** quand aucune ligne de corps n'y est (le corps en occupe six autres : 111, 57, 54, 72, 56,
 *  36). Le refus vient d'APRÈS : une suite de liste se forme sur des candidats CONTIGUS, et les 26 items ne le sont
 *  jamais — la suite des blocs est `O..O...O.O...O......O..O`, un à six blocs entre deux puces. **Prochain fil, nommé :
 *  ces blocs intercalés sont-ils la SUITE du même item, coupée en paragraphes ? Si oui, le défaut est le découpage en
 *  paragraphes, pas la liste.**
 *
 *  Les marqueurs de liste qu'UN DOCUMENT se donne, induits de lui-même (30/10/2026).
 *  Decides: quels jetons courts, inconnus de la liste fixe de `list.ts#markerOf`, ce document emploie comme puces —
 *  et rien d'autre. Ne décide ni des niveaux, ni de ce qu'on publie.
 *
 *  LE DÉFAUT QUI L'A FAIT ÉCRIRE : `013-ft4-sharing-cities-report` publie 25 items en paragraphes, parce que leur
 *  puce est un « o » — la puce de niveau 2 de Word, rendue comme la lettre o. `markerOf` ne connaît qu'une liste
 *  FIXE (puces dessinées, tiret, romain, lettre suivie d'un point) : une lettre seule n'en fait pas partie.
 *
 *  🔴 CE QUI REND LA RÈGLE SÛRE EST SA PRÉCONDITION, PAS UN SEUIL : un jeton n'est un marqueur que si LE DOCUMENT
 *  s'en sert comme tel — le même jeton ouvre au moins trois lignes, toutes au MÊME retrait. C'est ce qui sépare la
 *  puce « o » du mot italien « o » (STATUS, règle à deux populations) : le mot ouvre des phrases à des retraits
 *  quelconques, la puce tient sa colonne. La règle s'abstient d'elle-même là où le document n'est pas cohérent.
 *
 *  MESURÉ AVANT D'ÊTRE ÉCRITE (30/10/2026, 270 PDF du corpus) : dix documents portent au moins deux marqueurs tapés ;
 *  trois donnent à chacun son retrait, sept les mêlent au même. L'induction ne mord donc que sur les documents
 *  cohérents, par construction.
 *
 *  NOT here: la liste fixe des marqueurs (`layout/list.ts#markerOf`), le regroupement des items en listes
 *  (`layout/list.ts#listRuns`), ni la décision de publier (`extractor/pdf-paragraphs.ts`). Rien n'enlève le marqueur
 *  du texte : un PDF garde son marqueur visible (02/10/2026).
 *  Called by: `extractor/pdf-paragraphs.ts`. */

/** Une ligne telle que l'induction la lit : son texte, et le bord gauche de son bloc. */
export interface MarkerLine {
  text: string;
  left: number;
}

/** Trois lignes : sous ce compte, un jeton répété est une coïncidence. Même plancher que les règles de mobilier. */
const MIN_LINES = 3;
/** Le bruit de rendu sur un retrait : au-delà, deux lignes ne tiennent pas la même colonne. Mesuré sur les retraits
 *  des puces du corpus le 30/10/2026 : les vraies suites tiennent à moins d'un point, les fausses s'écartent de 20 et plus. */
const SAME_INDENT_PT = 1.5;
/** Un marqueur est court : deux caractères au plus (« o », « §§ »). Un mot n'est pas un marqueur. */
const MAX_MARKER_CHARS = 2;

/** Le premier jeton d'une ligne, quand il est suivi d'une espace puis d'une lettre. Le motif ne borne PAS sa longueur :
 *  `MAX_MARKER_CHARS` la décide, seul (revue du 30/10/2026 — le motif la portait aussi, et `pdf-paragraphs.ts` en
 *  tenait une seconde copie ; une borne écrite deux fois finit par ne plus l'être au même endroit). */
const LEADING_TOKEN = /^(\S+)\s+\p{L}/u;
/** Ce que la liste FIXE reconnaît déjà : inutile de l'induire. Tenu volontairement ici plutôt que partagé — la règle
 *  ne vaut que par ce que son appelant garantit (leçon du 29/10/2026, « Total - » collé à « 12,00 »). */
const ALREADY_KNOWN = /^(?:[-–—•·▪*]|[a-zA-Z0-9][.)]|[IVXivx]{1,4}[.)])$/u;

/** Le jeton qui OUVRE une ligne, quand il peut être un marqueur : court, et pas déjà reconnu par la liste FIXE. Rendu
 *  avec la longueur du marqueur ET de son espace, la seule dont un appelant ait besoin pour couper le texte.
 *  Les DEUX lecteurs du motif passent par ici — celui qui induit les marqueurs du document, et celui qui les relit
 *  ligne à ligne (`extractor/pdf-paragraphs.ts#inducedMarkerOf`). */
export const leadingMarkerToken = (text: string): { token: string; length: number } | undefined => {
  const found = LEADING_TOKEN.exec(text.trimStart());
  const token = found?.[1];
  if (found === null || token === undefined || token.length > MAX_MARKER_CHARS || ALREADY_KNOWN.test(token))
    return undefined;
  return { token, length: found[0].length - 1 };
};

/** The order `Array.prototype.sort` gives strings with no comparator (UTF-16 code units), written out; never `localeCompare`. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : Number(a > b));

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

/**
 * Les marqueurs que ce document emploie, triés pour que deux lectures du même document rendent le même tableau.
 *
 * Pur : ni I/O, ni horloge, ni aléa. Ne mute jamais son entrée.
 */
export function inducedMarkers(lines: readonly MarkerLine[]): string[] {
  const lefts = new Map<string, number[]>();
  for (const line of lines) {
    const token = leadingMarkerToken(line.text)?.token;
    if (token === undefined) continue;
    const list = lefts.get(token) ?? [];
    list.push(line.left);
    lefts.set(token, list);
  }

  const kept: string[] = [];
  for (const [token, xs] of lefts) {
    if (xs.length < MIN_LINES) continue;
    const column = median(xs);
    if (xs.every((x) => Math.abs(x - column) <= SAME_INDENT_PT)) kept.push(token);
  }
  return kept.sort(byCodeUnit);
}
