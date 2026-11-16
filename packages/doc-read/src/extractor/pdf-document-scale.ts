/** What cannot be decided page by page: which lines are page furniture, which
 *  sizes are headings, and where the column cut falls for the whole document.
 *  NOT here: the rules themselves (`layout/page-furniture.ts`,
 *  `layout/heading-sizes.ts`, `layout/gutter.ts`), nor anything about a single
 *  page (`extractor/pdf.ts`).
 *  Called by: `extractor/pdf.ts`. */

import type { PaintedBox } from "doc-ir/layout/hidden-repaints";
import { detectColumnGutter } from "doc-ir/layout/geometry";
import { documentColumnCut, documentColumnCuts, documentCutsRanked } from "doc-ir/layout/gutter";
import { gridCuts } from "doc-ir/layout/column-grid";
import { bodySizeOf, DEFAULT_HEADING_SIZE_RATIO, MAX_LEVEL, sizeClasses, type HeadingLevel } from "doc-ir/layout/heading-sizes";
import { isInBand, type GridBand } from "doc-ir/layout/grid-band";
import { quarterPoint } from "doc-ir/layout/mode";
import { detectPageFurniture, detectRepeatedHeadBlocks } from "doc-ir/layout/page-furniture";
import { groupItemsIntoLines } from "./pdf-lines";
import { minOf } from "doc-ir/lib/extent";
import { toFragment } from "./pdf-model";
import type { PdfTextRun } from "./pdf-source";
import { SAME_LINE_PT } from "doc-ir/layout/tolerances";

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

export type { GridBand };

/** Les trois décisions qui valent pour tout le document. */
export interface DocumentScale {
  /*
   * L'HABILLAGE N'EST PUBLIÉ NULLE PART, ET C'EST UNE DÉCISION QUI A ÉTÉ PRISE
   * DEUX FOIS.
   *
   * Le 21/09/2026 demande de le republier UNE fois en bas de la page
   * Confluence, sur une mesure : sur les 39 PDF français et anglais, 1 103
   * lettres d'habillage DISTINCT sont retirées, et **627 d'entre elles, 20
   * lignes, 13 documents, ne se lisaient nulle part ailleurs** — « Printed on
   * May 13, 2020 », « Mount Sinai Health System Confidential », « © Index
   * Education 2024 », « Document interne ». Livré le 22/09 (lot « 37 »).
   *
   * Le 23/09/2026 retire la republication : « on vire le footer partout
   * sans exception, sur tout PDF ». Né du communiqué 27, où « -30- » et le pied
   * revenaient en fin de page et n'y servaient rien. Ces 627 lettres ne sont donc
   * plus publiées ; elles étaient alors DÉCLARÉES au contrôle du texte (déclaration retirée le 19/10/2026, plus rien n'est retiré). C'est
   * MIKSUDOC « Spécification fonctionnelle » §9 qui redevient vraie : en-têtes et pieds sont « Ignoré ».
   *
   * Ce qui a été écrit puis retiré avec elle, plutôt que de le redécouvrir : la
   * ligne publiée était celle de la PREMIÈRE occurrence, numéros de page
   * neutralisés compris, et un texte encore présent dans le corps n'était jamais
   * republié (la fixture 25 garde son bandeau en page 1 et le perd en page 2).
   */
  /** Le niveau de titre d'une taille, ou rien. */
  headingLevelOf: (size: number) => HeadingLevel | undefined;
  /** Whether a size belongs to the document's BODY class — never true when the
   *  headings abstain because the prose is not representative (see below). */
  isBodySize: (size: number) => boolean;
  /** The sizes (quarter-point) that are the BODY of at least one page of the document — the size carrying the most
   *  letters on a page that has `MIN_PAGE_BODY_LETTERS` of them, the measure `scaleOfPage` makes. Such a size is never a
   *  title on any page (06/11/2026, see `scaleOfPage`). */
  pageBodySizes: ReadonlySet<number>;
  /** L'abscisse DOMINANTE où couper les colonnes, ou rien. C'est elle qui sert aux décisions qui ne connaissent que
   *  deux bandes : le bloc `columns` d'un tableau (`pdf-page-tables.ts`) et le conteneur centré
   *  (`pdf-line-breaks.ts`). */
  gutterCut: number | undefined;
  /** TOUTES les coupes du document, croissantes — une page à quatre colonnes en porte trois. Seule la lecture en
   *  bandes les emploie (`pdf-bands.ts#readingSegments`). */
  gutterCuts: readonly number[];
  /** The horizontal reach of the document's body text — the last-resort
   *  container of the centred-pair rule (`pdf-line-breaks.ts`). Undefined when
   *  there is no body class. */
  bodyTextArea: { left: number; right: number } | undefined;
}

/**
 * LA COUPE DE COLONNES SE DÉCIDE À L'ÉCHELLE DU DOCUMENT, jamais de la page (16/09/2026, `layout/gutter.ts`). Même
 * raison que la titraille, et vécu en la branchant : page par page, les deux pages de `11-Brochure-Deux-Colonnes` —
 * géométrie IDENTIQUE — sortaient l'une séparée et l'autre tressée. L'habillage est retiré d'abord : un pied de page
 * court ne doit pas peser dans la décision.
 *
 * DEUX RÉPONSES SUR LA MÊME MESURE (04/11/2026) : la coupe DOMINANTE, pour les décisions qui ne connaissent que deux
 * bandes, et TOUTES les coupes, croissantes, pour la lecture en bandes — une page à quatre colonnes en porte trois.
 */
/** 🔴 QUEL SIGNAL DIT « COLONNES » (04/11/2026, essai A/B/C demandé).
 *  `gutter` est le produit d'aujourd'hui : le blanc que personne ne traverse, donc aveugle dès qu'un bout
 *  d'habillage le referme. `width` et `chars` lisent au contraire les bords gauches RÉPÉTÉS des blocs
 *  (`layout/column-grid.ts`), et se prouvent par des largeurs égales ou des caractères en nombre voisin.
 *  🔴 `gutter` reste le DÉFAUT tant que les trois n'ont pas été regardés sur des pages publiées. */
export type ColumnEvidence = "gutter" | "width" | "chars";

interface DocumentCuts {
  cut: number | undefined;
  all: readonly number[];
}

/** La grille, pour les deux preuves qui ne sont pas la gouttière. La décision reste à l'échelle du DOCUMENT
 *  (invariant du 16/09/2026) : seule la preuve change. Sans coupe dominante au sens de la gouttière, c'est la
 *  première coupe qui tient ce rôle — elle ne sert qu'aux décisions à deux bandes. */
const gridOfDocument = (pages: readonly (readonly PdfTextRun[])[], evidence: Exclude<ColumnEvidence, "gutter">): DocumentCuts => {
  const { all, dominant } = documentCutsRanked(pages, (page) => gridCuts(page, evidence));
  return { cut: dominant, all };
};

const documentGutters = (items: readonly (readonly PdfTextRun[])[], furniture: ReadonlySet<PdfTextRun>, evidence: ColumnEvidence): DocumentCuts => {
  const pages = items.map((rawItems) => rawItems.filter((it) => !furniture.has(it)));
  if (evidence !== "gutter") return gridOfDocument(pages, evidence);
  return { cut: documentColumnCut(pages), all: documentColumnCuts(pages) };
};

/**
 * LES STYLES D'UNE PAGE SE DÉCIDENT PAR PAGE (05/11/2026 : « moins risqué par page »), sur la seule chose que le
 * PDF dit explicitement — la taille de chaque fragment — SANS défaire la hiérarchie du document. Le corps de la page est
 * la taille qui porte le plus de lettres ; il n'y est jamais un titre, ni ce qui en est à moins de
 * `DEFAULT_HEADING_SIZE_RATIO`. En dessous du corps d'au moins ce rapport : du petit texte (« Small text », §92).
 *
 * UN TITRE DE LA PAGE est une taille au-dessus du corps de la page (`DEFAULT_HEADING_SIZE_RATIO`), que le document la
 * classe ou non (05/11/2026 : le seuil « 2 fois le corps » du matin est retiré le jour même) — « Alouette » (168 pt),
 * « La langue française en fête » (54), vus une fois, que l'échelle du document laissait en paragraphes. Les titres de
 * la page se rangent par taille, une classe du document tenant un seul rang, deux tailles seules à moins du rapport
 * l'une de l'autre aussi. LE NIVEAU est le rang, mais jamais au-dessus du niveau que le document donne : une page qui
 * ne porte que des sections `h3` les garde en `h3` (02-jvmalin, niveaux exacts 61 → 27 avec le rang seul), et la date
 * de la une (12,8 pt, `h3` pour le document) descend au `h4` que son rang lui donne après 168, 54 et 24-22.
 *
 * LE COÛT ASSUMÉ, posé au banc (05/11/2026, `tools/structure-truth/bench.fixtures.test.ts`) : 01-osfi invente 8 titres
 * (lignes seules à 1,2-1,5 × corps) ; 08-ontario tombe de 21 à 1 et 10-lpc de 17 à 0 — leurs sections Word sont au
 * corps (gras seul) ou à 1,17 du corps, sous `DEFAULT_HEADING_SIZE_RATIO` ; gains : 02-jvmalin 63 → 66 trouvés et
 * 61 → 66 niveaux exacts, 06-homes 6 → 3 faux. Une page sans assez de lettres pour avoir un corps (une couverture, un
 * titre seul) garde l'échelle du document telle quelle : `MIN_PAGE_BODY_LETTERS`. Une taille de moins de
 * `MIN_RANK_LETTERS` lettres ne prend pas de rang (la lettrine).
 */
export const MIN_PAGE_BODY_LETTERS = 400;

/** A SIZE WITH FEWER LETTERS THAN THIS ON THE PAGE TAKES NO RANK: the drop cap « C' » of the newspaper's front page (36 pt,
 *  two letters) took a rank of its own between the 54 pt title and the 24 pt masthead line. A title has words. */
export const MIN_RANK_LETTERS = 3;

export interface PageScale {
  headingLevelOf: (size: number) => HeadingLevel | undefined;
  isBodySize: (size: number) => boolean;
  /** Smaller than the page's body by at least the heading ratio: « Small text ». */
  isSmallSize: (size: number) => boolean;
}

/** Letters and digits per quarter-point size on a page, rotated runs left out. */
const lettersBySizeOf = (items: readonly PdfTextRun[]): Map<number, number> => {
  const charsBySize = new Map<number, number>();
  for (const it of items) {
    if (it.rotated || it.text.trim().length === 0) continue;
    let letters = 0;
    for (const ch of it.text) if (LETTER_OR_DIGIT.test(ch)) letters++;
    const size = quarterPoint(it.fontSize);
    charsBySize.set(size, (charsBySize.get(size) ?? 0) + letters);
  }
  return charsBySize;
};

/** The ranks of a page's title sizes, largest first: a size of the same document class as the rank's first joins it; a
 *  lone size within the ratio of a lone first joins it too. The level is the rank, never above the document's. */
const rankedLevels = (titles: readonly number[], documentLevelOf: (size: number) => HeadingLevel | undefined, ratio: number): Map<number, HeadingLevel> => {
  const levels = new Map<number, HeadingLevel>();
  let rank = 0;
  let first: number | undefined;
  for (const size of titles) {
    const documentLevel = documentLevelOf(size);
    const sameClass = first !== undefined && documentLevel !== undefined && documentLevelOf(first) === documentLevel;
    const sameLone = first !== undefined && documentLevel === undefined && documentLevelOf(first) === undefined && first / size < ratio;
    if (!sameClass && !sameLone) {
      rank += 1;
      first = size;
    }
    levels.set(size, Math.min(Math.max(rank, documentLevel ?? 1), MAX_LEVEL) as HeadingLevel);
  }
  return levels;
};

/** THE BODY OF EACH PAGE, as `scaleOfPage` measures it (raw items, turned runs left out): a size that is the body of one
 *  page is body text of this document, whatever the document-wide classes made of it (06/11/2026). */
const pageBodySizesOf = (items: readonly (readonly PdfTextRun[])[]): Set<number> => {
  const sizes = new Set<number>();
  for (const rawItems of items) {
    const letters = lettersBySizeOf(rawItems);
    const body = bodySizeOf(letters);
    if (body !== undefined && (letters.get(body) ?? 0) >= MIN_PAGE_BODY_LETTERS) sizes.add(body);
  }
  return sizes;
};

export const scaleOfPage = (items: readonly PdfTextRun[], scale: Pick<DocumentScale, "headingLevelOf" | "isBodySize" | "pageBodySizes">): PageScale => {
  const charsBySize = lettersBySizeOf(items);
  const body = bodySizeOf(charsBySize);
  if (body === undefined || (charsBySize.get(body) ?? 0) < MIN_PAGE_BODY_LETTERS) return { ...scale, isSmallSize: () => false };
  const ratio = DEFAULT_HEADING_SIZE_RATIO;
  // UNE TAILLE QUE LE DOCUMENT CLASSE RESTE UN TITRE SUR CHAQUE PAGE (même taille → même niveau partout) : seule la
  // bande du corps de LA page la rétrograde. Mesuré en le cassant (bench structure-truth, 05/11/2026) : avec la porte
  // « ≥ 1,2 × corps de la page » appliquée aussi aux tailles classées, 08-ontario tombait de 21 titres trouvés à 1 et
  // 10-lpc à 0 — leurs sections Word sont à 1,17 du corps de leurs pages. Une taille NON classée, elle, doit la passer.
  //
  //
  // AND A SIZE THAT IS THE BODY OF A PAGE OF THE DOCUMENT IS A HEADING ON NO PAGE (06/11/2026, `pageBodySizes`).
  // Measured on p4 of the Alouette bulletin (fixture 58 p2, `corpus-local/diag-alouette-tailles.ts`): the programme in
  // 7.5 pt holds 2,972 letters and is the body of the page; the Argument and "Informations pratiques" in 9 pt hold
  // 1,739, and 9 pt is the body of p3 (6,960 letters). Yet the DOCUMENT ranks 9 pt as `h6`: on four-column pages,
  // almost every 9 pt line overlaps the gutter (the 14/09 rule above) and drops out of the distribution,
  // so 7.5 pt becomes the document's body and 9 pt a heading class. On p4, 9 / 7.5 = 1.2 exactly: the prose
  // passed the gate and came out as `<h6>`, sentence by sentence. A size that carries the body of a whole page is
  // not a heading style; the page reads it as paragraphs.
  // TRIED THEN DROPPED THE SAME DAY: "a size of the document's body BAND (`isBodySize`) is never a
  // heading" — no effect here (9 pt is not in it), and 08-ontario fell from 8 headings found to 0 on the structure-truth bench:
  // its Word sections sit at 1.17 of the body, inside the band. The band is too wide; the measured body of a page is not.
  const isTitle = (size: number): boolean => {
    if (scale.pageBodySizes.has(size)) return false;
    return scale.headingLevelOf(size) !== undefined ? !(size < body * ratio && size * ratio > body) : size >= body * ratio;
  };
  const titles = [...charsBySize.entries()].filter(([size, letters]) => letters >= MIN_RANK_LETTERS && isTitle(size)).map(([size]) => size).sort((a, b) => b - a);
  const levels = rankedLevels(titles, scale.headingLevelOf, ratio);
  return {
    headingLevelOf: (size) => levels.get(quarterPoint(size)),
    isBodySize: (size) => {
      const q = quarterPoint(size);
      return q < body * ratio && q * ratio > body;
    },
    isSmallSize: (size) => quarterPoint(size) * ratio <= body,
  };
};

export const decideDocumentScale = (
  items: readonly PdfTextRun[][],
  bandsByPage: readonly (readonly GridBand[])[],
  /** The page heights (MediaBox): the page-edge exceptions of the furniture rules need them. */
  pageHeights: readonly number[] = [],
  /** The y of each page's bottom edge in user space (`view[1]`): band tests are made relative to it. */
  pageBottoms: readonly number[] = [],
  /** `fillsByPage` nourrissait les bandes grises des titres, retirées le 05/11/2026 (la taille seule fait un titre) :
   *  l'option reste pour ne pas casser les appels, plus rien ne la lit. `evidence` : le signal qui dit « colonnes »,
   *  `gutter` étant le produit et les deux autres l'essai du 04/11/2026.
   *  ⚠️ LES DEUX SONT DANS UN OBJET, ET SANS VALEUR PAR DÉFAUT, et les deux points sont dus au cliquet qualité —
   *  jamais relevé pour faire passer du code (`docs/BONNES-PRATIQUES-CODE.md`). À six paramètres positionnels la
   *  fonction dépassait `max-params` ; avec deux défauts dans la déstructuration elle dépassait `complexity` (17
   *  pour 15), un défaut valant une branche. L'appelant les donne tous les deux. */
  { evidence }: { fillsByPage: ReadonlyMap<number, readonly PaintedBox[]>; evidence: ColumnEvidence },
): DocumentScale => {
  // L'HABILLAGE DE PAGE, RECONNU UNE FOIS POUR TOUT LE DOCUMENT.
  //
  // Il ne peut pas se décider page par page : la preuve d'un pied de page est
  // qu'il REVIENT au même endroit sur une autre page. La comparaison a donc
  // lieu ici, avant la boucle, et ses lignes sont ensuite retirées des items —
  // ce qui les fait disparaître de la prose comme du repli, sans que rien en
  // aval ait à le savoir.
  //
  // La garde d'emprise reçoit les bandes des tableaux détectés : l'en-tête d'un
  // tableau se répète lui aussi d'une page à l'autre, et il ne doit jamais être
  // pris pour de l'habillage (`layout/page-furniture` porte la mesure).
  const linesByPage = items.map((pageItems) => groupItemsIntoLines(pageItems));
  const pageLines = linesByPage.map((lines) =>
    lines.map((line) => ({
      y: line[0]!.y,
      x: minOf(line, (it) => it.x),
      size: line[0]!.fontSize,
      text: line.map((it) => it.text).join(""),
    })),
  );

  // DEUX RÈGLES, VOLONTAIREMENT DISTINCTES, réunies seulement ici : l'habillage
  // se reconnaît à la répétition AU MÊME ENDROIT, la reprise de tête à un texte
  // déjà vu plus haut dans le document. La seconde est la plus risquée — voir
  // son coût, écrit dans `layout/page-furniture`.
  const furnitureByPage = detectPageFurniture(pageLines, bandsByPage, pageHeights, pageBottoms);
  const repeatedByPage = detectRepeatedHeadBlocks(pageLines, bandsByPage, pageHeights, pageBottoms);

  const removed = (pageIndex: number, lineIndex: number): boolean =>
    furnitureByPage[pageIndex]?.[lineIndex] === true || repeatedByPage[pageIndex]?.[lineIndex] === true;

  const furniture = new Set<PdfTextRun>();
  linesByPage.forEach((lines, pageIndex) => {
    lines.forEach((line, lineIndex) => {
      if (removed(pageIndex, lineIndex)) for (const it of line) furniture.add(it);
    });
  });

  // LA TITRAILLE SE DÉCIDE À L'ÉCHELLE DU DOCUMENT, jamais de la page — et ce
  // n'est pas un détail de performance. Mesuré le 11/09/2026 : par page, `05a`
  // met « Gouvernance » en `h1` là où ses sœurs sont en `h2`, parce que le corps
  // d'une page n'est pas celui du document. La distribution se construit donc
  // ici, une fois, avant la boucle.
  //
  // DEUX EXCLUSIONS, toutes deux nécessaires. L'HABILLAGE d'abord : un copyright
  // de pied de page n'est pas de la titraille, et sur un bulletin réel c'est lui
  // qui posait le seul rapport tombant dans l'intervalle libre. Les GRILLES
  // ensuite : les tailles d'un tableau ne disent rien de la prose, et une
  // colonne de notes en petit corps déplacerait le corps du document.
  //
  // Les tailles viennent des ITEMS, déjà lus : reconstruire les glyphes de
  // chaque page pour les compter ferait payer une seconde lecture du flux
  // d'opérateurs à tout document, y compris ceux qui n'ont aucune grille.
  const charsBySize = new Map<number, number>();
  const lettersBySize = new Map<number, number>();
  const pagesBySize = new Map<number, Set<number>>();
  /** La même distribution, mais sur TOUT le texte — bandes de tableau comprises.
   *  Elle ne sert qu'à une chose : dire si la prose hors tableau représente
   *  encore le document (voir juste en dessous). */
  const charsBySizeAll = new Map<number, number>();
  /**
   * TROISIÈME EXCLUSION : LES LIGNES QUI CHEVAUCHENT UNE GOUTTIÈRE (14/09/2026).
   *
   * La règle n'est pas neuve — le dépôt l'a tranchée sur un bulletin : « un bloc
   * CÔTE À CÔTE ne porte pas de titraille, deux bandes en haut d'une page sont
   * un cartouche, pas une section ». Ce qui manquait est son APPLICATION ici :
   * l'exclusion passait par `columnCuts`, qui exige `looksLikeTextColumns` —
   * mesuré FAUX sur `15` comme sur `11`, qui est pourtant du vrai deux-colonnes.
   * Ce prédicat ne répond pas à la question que la titraille pose.
   *
   * La gouttière y répond directement. Mesuré sur `15` : elle vaut
   * `[188 ; 340]`, et l'en-tête la chevauche — émetteur à gauche, destinataire
   * à droite, 165 pt de blanc entre les deux. « FACTURE » tient d'un seul côté.
   *
   *     15   « ATELIER MIKSUMIA… » 12 pt   CHEVAUCHE   → écartée
   *     15   « FACTURE »           20 pt   un côté     → gardée
   *     17   « Registre des… »     15 pt   un côté     → gardée
   *     05a  aucune gouttière                          → rien d'écarté
   *
   * AUCUN SEUIL AJOUTÉ : `detectColumnGutter` est un signal déjà mesuré et déjà
   * utilisé, et « chevaucher » est une question binaire. On écarte la ligne de
   * la DISTRIBUTION, pas seulement de la classification : sans ça, sa taille
   * resterait une classe de titre que plus aucune ligne n'habite.
   */
  const straddlesGutter = new Set<PdfTextRun>();
  linesByPage.forEach((lines) => {
    const gutter = detectColumnGutter(lines.map((line) => line.map(toFragment)));
    if (gutter === undefined) return;
    for (const line of lines) {
      const real = line.filter((it) => it.text.trim().length > 0);
      const left = real.some((it) => it.x + it.width <= gutter.start + SAME_LINE_PT);
      const right = real.some((it) => it.x >= gutter.end - SAME_LINE_PT);
      if (left && right) for (const it of real) straddlesGutter.add(it);
    }
  });
  items.forEach((rawItems, pageIndex) => {
    const bands = bandsByPage[pageIndex] ?? [];
    for (const it of rawItems) {
      if (furniture.has(it) || straddlesGutter.has(it)) continue;
      const chars = it.text.replace(/\s/g, "").length;
      if (chars === 0 || !(it.fontSize > 0)) continue;
      const size = quarterPoint(it.fontSize);
      charsBySizeAll.set(size, (charsBySizeAll.get(size) ?? 0) + chars);
      const cy = it.y + it.fontSize / 2;
      if (isInBand(cy, bands)) continue;
      charsBySize.set(size, (charsBySize.get(size) ?? 0) + chars);
      let letters = 0;
      for (const ch of it.text) if (LETTER_OR_DIGIT.test(ch)) letters++;
      lettersBySize.set(size, (lettersBySize.get(size) ?? 0) + letters);
      const pages = pagesBySize.get(size) ?? new Set<number>();
      pages.add(pageIndex);
      pagesBySize.set(size, pages);
    }
  });

  const gutters = documentGutters(items, furniture, evidence);

  // ON NE CLASSE RIEN QUAND LA PROSE RESTANTE N'EST PAS UN CORPS DE DOCUMENT.
  //
  // Un tableau qui avale la page laisse derrière lui des miettes, et le corps
  // calculé dessus est faux. Mesuré le 14/09/2026 sur `15-Facture-Libelle-Valeur`
  // : la grille sans bordures couvre toute la facture, et la prose restante est
  // DEUX MENTIONS LÉGALES de pied de page. Leur taille devenait le corps, et
  // l'en-tête de lettre — plus grand qu'elles — sortait en `h1` pendant que le
  // vrai titre « FACTURE » restait un paragraphe.
  //
  // LE TEST NE PORTE AUCUNE CONSTANTE : on compare le corps mesuré HORS tableau
  // au corps mesuré sur TOUT le texte. S'ils ne désignent pas la même taille, la
  // prose restante ne représente plus le document, et on s'abstient. Le seuil
  // d'effectif a été écarté après mesure : `17` a lui aussi un corps de deux
  // lignes, mais elles sont à la taille du corps réel — elles le représentent.
  //
  // Passé sur le corpus entier : `15` est le SEUL document où les deux corps
  // divergent, et c'est le seul faux positif connu.
  const proseClasses = sizeClasses(charsBySize, undefined, { pageCount: items.length, lettersBySize, pagesBySize });
  const proseIsRepresentative = proseClasses.bodySize !== undefined && proseClasses.bodySize === bodySizeOf(charsBySizeAll);
  const classes = proseIsRepresentative ? proseClasses : { body: new Set<number>(), levels: new Map<number, HeadingLevel>() };
  const headingLevelOf = (size: number): HeadingLevel | undefined => classes.levels.get(quarterPoint(size));
  const isBodySize = (size: number): boolean => classes.body.has(quarterPoint(size));

  // THE BODY TEXT AREA, measured on the whole DOCUMENT: Word's margins hold for
  // every page, and a page carrying only a centred title would otherwise define
  // its area as that title. No constant: the leftmost and rightmost edges of the
  // body-size text, furniture and detected grids excluded.
  let areaLeft = Infinity;
  let areaRight = -Infinity;
  for (const [pageIndex, pageItems] of items.entries()) {
    const bands = bandsByPage[pageIndex] ?? [];
    for (const it of pageItems) {
      if (furniture.has(it) || it.rotated || it.text.trim().length === 0 || !isBodySize(it.fontSize)) continue;
      if (isInBand(it.y + it.fontSize / 2, bands)) continue;
      areaLeft = Math.min(areaLeft, it.x);
      areaRight = Math.max(areaRight, it.x + it.width);
    }
  }
  const bodyTextArea = areaRight > areaLeft ? { left: areaLeft, right: areaRight } : undefined;

  return { headingLevelOf, isBodySize, pageBodySizes: pageBodySizesOf(items), gutterCut: gutters.cut, gutterCuts: gutters.all, bodyTextArea };
};
