/** The running headers and footers of a document: text recognised by strict
 *  repetition across pages — content, size and position, page numbers
 *  neutralised. Images are not looked at here.
 *  A line that differs from its siblings only by its digits is furniture too
 *  when it touches an exactly repeated line at the same edge; a table band
 *  protects only its upper half (a repeated table header).
 *  An edge line on 3 pages or more whose one figure rises by 1 per page is furniture whatever its words (a
 *  page counter), unless its type is a title's; a long edge block (4 lines or 25 words) needs 3 text pages, or
 *  every text page of its parity.
 *  Also holds a second, riskier rule: blocks repeated at the head of several pages, compared on their exact text
 *  (`detectRepeatedHeadBlocks`).
 *  DETECTION only: nothing is removed from a page (furniture is published). `extractor/pdf-document-scale.ts` uses it to keep
 *  the furniture out of its document-wide measures (heading sizes, column cut, body text area).
 *  NOT here: those measures, nor the heading
 *  rules they are distinguished from (`layout/heading-*.ts`).
 *  Called by: `extractor/pdf-document-scale.ts`. */

import { isInBand, type GridBand } from "./grid-band";
import { SAME_LINE_PT } from "doc-ir/layout/tolerances";

/**
 * `layout/page-furniture` — les en-têtes et pieds de page, reconnus par répétition.
 *
 * **LA DÉFINITION, POSÉE PAR MIKOLAJ LE 10/09/2026** : *un élément qui se répète
 * strictement à l'identique sur plusieurs pages — contenu, taille et position,
 * numéros de page neutralisés — est un en-tête ou un pied de page.*
 *
 * C'est aussi celle de la littérature. La méthode de référence s'appelle *page
 * association* (Lin, SPIE Document Recognition and Retrieval, 2003) et son
 * postulat est le même : le trait le plus stable d'un habillage est qu'il se
 * répète sur les pages voisines, et la décision combine similarité de texte ET
 * position géométrique.
 *
 * ---
 *
 * **🔴 L'ABSCISSE EST CE QUI REND LA RÈGLE UTILISABLE, et c'est une mesure qui
 * l'a montré.** Sur un bulletin réel de deux pages, quatre lignes se répètent au
 * mot près. Sans l'abscisse, TROIS d'entre elles passeraient pour de
 * l'habillage — dont le titre du document :
 *
 *       texte                       |   y1 /   y2   |    x1 /    x2   | taille
 *       « © Index Education 2024 »  |  29,0 /  29,0 | 513,2 /  513,2  | 5,04 / 5,04
 *       « Bulletin du 1er Trimestre»| 799,0 /  799,2 | 291,8 /  274,8 | 12,96 / 12,96
 *       « NOM Prénom » (l'élève)    | 779,7 /  783,4 | 291,8 /  274,8 | 9,96 / 9,96
 *
 * Les ordonnées du titre ne diffèrent que de 0,2 pt — n'importe quelle tolérance
 * raisonnable les confond. **Ce sont les abscisses qui les séparent**, de 17 pt,
 * parce que le bloc de la page 2 est cadré différemment. Le pied de page, lui,
 * revient exactement au même point sur les trois axes.
 *
 * **ET LA RÉPÉTITION SEULE NE SUFFIT PAS.** La définition dit aussi *premier ou
 * dernier élément de la page*, et cette moitié-là n'est pas décorative : un
 * document dont deux pages ont la même mise en page voit TOUT son contenu se
 * répéter à l'identique. Sans la contrainte de bord, tout serait supprimé —
 * mesuré le 10/09/2026 sur `fixtures/pdf/11-Brochure-Deux-Colonnes.pdf`, dont
 * les deux pages ont la même géométrie, et attrapé par un test qui existait
 * déjà.
 *
 * **L'AUTRE PIÈGE, FERMÉ ICI PLUTÔT QU'À DÉCOUVRIR** : l'en-tête d'un TABLEAU se
 * répète lui aussi d'une page à l'autre, mot pour mot — c'est même la preuve
 * qu'un tableau se continue (passe retirée : les tableaux ne se joignent plus). Sur le
 * même document il revient 68,8 pt plus haut, donc la position l'écarte déjà.
 * Mais un document dont chaque page commencerait son tableau à la MÊME ordonnée
 * y échapperait : d'où la garde explicite, **une ligne située dans l'emprise
 * d'une grille détectée n'est jamais de l'habillage.**
 *
 * ---
 *
 * **ESSAYÉ, MESURÉ, ABANDONNÉ : RÉPÉTER LE BLANC PLUTÔT QUE LE TEXTE (23/09/2026).**
 *
 * L'idée : *ce qui est détaché du bloc de texte par un blanc franc
 * (`MAX_RUN_GAP_RATIO`), à la même hauteur sur au moins deux pages, est de
 * l'habillage* — en union avec la règle ci-dessus, sans constante nouvelle, avec
 * la garde « une page dont tout le contenu tombe dans la bande n'est pas
 * dépouillée ». Elle visait les pieds dont le TEXTE change d'une page à l'autre,
 * que la répétition ne peut pas voir. C'est aussi ce qu'un modèle de vision
 * regarde.
 *
 * **Mesurée sur les 39 PDF français et anglais : 13 lignes de plus retirées,
 * 4 justes et 9 FAUSSES.** Justes : `0000602` (« 1 | Page », « 2 | Page », que la
 * grammaire de folio rate à cause de la barre) et `0000523` (une URL en bas).
 * Fausses : les sept instructions du guide MFA (« Pas 2 : Sélectionnez… »,
 * « Pas 7 : Félicitations ! ») et les deux titres de `11-Brochure-Deux-Colonnes`.
 *
 * **DEUX CAUSES INDÉPENDANTES, ET AUCUNE NE SE RÈGLE PAR UN SEUIL.**
 *
 * 1. **Un blanc entre deux lignes de TEXTE n'est pas un blanc.** Guide MFA page 4 :
 *    « Pas 2 : … » est à y=760,6 et le texte suivant à y=478 — 282 pt d'écart,
 *    occupés par TROIS captures d'écran. Toute image, figure ou grille fabrique un
 *    faux blanc, et la ligne au-dessus paraît détachée. Le blanc d'un modèle de
 *    vision est vraiment vide ; le nôtre veut seulement dire « pas de texte ici ».
 * 2. **Un titre de page est géométriquement indiscernable d'un en-tête courant.**
 *    `11-Brochure-Deux-Colonnes` page 1 : titre à y=780, corps à y=730, soit 50 pt
 *    pour un corps de 16 — 3,1 fois, juste au-dessus de la borne — et il revient à
 *    la même hauteur sur chaque page. Le blanc y est RÉEL, aucune image en cause.
 *    Le discriminant n'existe pas.
 *
 * Signal de plus : faire passer cette règle demandait de retourner l'attendu du
 * test « une ligne répétée au MILIEU de la page n'est jamais de l'habillage », qui
 * encode exactement la cause 2. Le test avait raison.
 *
 * ---
 *
 * **CODÉE, MESURÉE, ABANDONNÉE PAR MIKOLAJ : LA CONJONCTION
 * « GÉOMÉTRIE + `/Artifact` » SUR LE TEXTE (23/09/2026).**
 *
 * **La variante « au BAS de page seulement » a été proposée et refusée le même
 * jour.** Elle sauvait les deux dégâts ci-dessous, tous deux en HAUT de page :
 * l'en-tête de lettre EUROCONTROL est à y=804→739 et le bloc de tête du livret
 * Canva aussi, sur des pages de 841,6. Mais la liste des États membres, elle, est
 * en BAS (y=98,4→51,2, les 12 derniers pour cent), et elle serait toujours
 * retirée. **Question posée à Mikolaj — « une liste d'États membres imprimée en
 * bas d'un papier à lettres, pied de page ou contenu ? » — réponse : « c'est pas
 * un pied de page ».** La conjonction est donc abandonnée sur toute la hauteur.
 *
 * La règle demandée : *si notre géométrie penche déjà pour un pied de page ET que
 * le PDF déclare la zone `/Artifact`, alors c'en est un.* Elle visait l'habillage
 * qui ne PARAÎT QU'UNE FOIS, que la répétition ne peut pas voir. Codée telle quelle
 * — la déclaration remplace la répétition, le bord reste exigé, donc une ligne
 * déclarée au milieu de la page n'est jamais retirée — elle retire du CONTENU RÉEL
 * sur deux documents des 39 français et anglais, et l'arrêt a été demandé avant de
 * la livrer.
 *
 * **CE QU'ELLE RETIRE, REGARDÉ EN IMAGE (`pdftoppm -r 110`) :**
 *
 *   · booklet 26 p8 — the page TITLE and the whole block of postal addresses
 *     that follows it (four lines). Canva declares all of it `/Artifact`, and it
 *     opens the page: the walk from the top takes it whole.
 *   · `corpus-safedocs/0000713` p1 — l'en-tête de lettre EUROCONTROL (4 lignes) et
 *     la liste des États membres (4 lignes). Le TITRE « APPEL D'OFFRES PAR VOIE
 *     ÉLECTRONIQUE », lui, survit : 88 pt de blanc le séparent de l'en-tête, donc
 *     plus que `MAX_RUN_GAP_RATIO`, et la remontée s'arrête avant lui.
 *
 * **CE QU'ELLE RETIRE À JUSTE TITRE** : `0000602` p1 et p2, « 1 | Page », que la
 * grammaire de folio rate à cause de la barre (déjà noté plus haut comme un manque).
 *
 * **LA CAUSE, ET C'EST LA MÊME QUE CELLE DU BLANC RÉPÉTÉ** : un bloc de tête de page
 * est géométriquement indiscernable d'un en-tête courant, et la déclaration ne les
 * distingue pas non plus — Word déclare son numéro de page, Canva déclare son titre.
 * « Au bord » ne suffit pas comme second témoin quand le premier élément de la page
 * EST le titre de la page.
 *
 * Les deux spécimens sont tenus par `extractor/pdf-artifact-furniture.fixtures.test.ts`,
 * qui exige que ce contenu soit publié ET que le document le déclare `/Artifact` :
 * le jour où la règle est reprise, ce test dit tout de suite ce qu'elle coûte.
 *
 * ---
 *
 * CE MODULE EST PUR, comme le reste de `layout/` : des nombres et des chaînes en
 * entrée, des booléens en sortie. Aucune dépendance au produit.
 */

/** Une ligne visuelle, réduite à ce dont la comparaison a besoin. */
export interface PageLine {
  /** Ordonnée de la ligne, en espace page. */
  y: number;
  /** Abscisse de son premier fragment — le critère qui sauve les titres. */
  x: number;
  /** Corps du texte. Deux lignes de tailles différentes ne sont pas la même. */
  size: number;
  text: string;
}

/** The vertical band of a detected table, for the extent guard. */
export type TableBand = GridBand;

/** Deux positions à moins de ceci sont la même position.
 *
 *  VALEUR DE DÉPART À CALIBRER. Mesuré : le pied de page revient à 0,0 pt près,
 *  et la ligne la plus proche de lui être confondue en est à 17 pt. L'écart est
 *  franc, mais il repose sur un seul générateur. */
const POSITION_TOLERANCE = SAME_LINE_PT;

/** Idem pour le corps du texte : `7,92` et `8,04` ont été mesurés sur deux
 *  occurrences d'une même ligne, donc l'égalité stricte serait trop dure. */
const SIZE_TOLERANCE = 0.25;

/** Un habillage doit se répéter sur au moins ce nombre de pages. Deux, parce
 *  qu'un document de deux pages n'offre pas plus de preuve — et que c'est le cas
 *  du corpus mesuré. */
const MIN_PAGES = 2;

/** Au-delà de ce multiple du corps du texte, deux lignes ne font plus partie du
 *  même bloc. Il BORNE la remontée depuis le bord : sans lui, une ligne de corps
 *  qui se trouve être répétée est avalée par le pied de page dès qu'elle le
 *  précède dans l'ordre de lecture, quelle que soit la distance qui les sépare.
 *
 *  VALEUR DE DÉPART À CALIBRER, du même ordre que le `PARAGRAPH_BREAK_GAP_RATIO`
 *  de l'extracteur PDF (2,2). Mesuré sur le bulletin : les deux lignes d'un même
 *  bloc d'en-tête sont à 1,2 corps l'une de l'autre, quand le pied de page est à
 *  soixante-treize corps de la ligne qui le précède. */
const MAX_RUN_GAP_RATIO = 3;

/** A run may cross ONE larger gap to reach a block that repeats EXACTLY below it (a banner above a lone page number).
 *
 *  VALEUR DE DÉPART À CALIBRER. Measured on the 76 PDFs of the local corpus (<= 15 pages), 14/10/2026: the one real case
 *  (094, Polish form: banner, 34.8 pt gap, page number in 11 pt) is at 3.2 sizes; the bound is twice the ordinary
 *  one. The crossing needs an exact repeat on the far side and an anchored run on this side. */
const MAX_BANNER_GAP_RATIO = 6;

/** A run longer than this that also covers more than half of its page is refused: it swallowed the page, not a block.
 *
 *  VALEUR DE DÉPART À CALIBRER. Measured on the same 76 PDFs, every page that loses lines to the edge walk: legitimate
 *  runs hold 1 to 7 lines (074: 4 above + 3 below), and the one swallowed page pair (024 hydralabplus p6-p7) holds 23 of
 *  23 lines. Short pages that are only furniture (a number alone, 2 of 2 lines) stay below the floor. */
const MAX_FURNITURE_RUN_LINES = 8;

/** A run of this many lines, or of this many words, is a BLOCK, not a line or two of furniture: it must repeat on
 *  `LONG_BLOCK_PAGES_THRESHOLD` pages (or on every page of a shorter document), and it never covers every line of its page.
 *
 *  VALEUR DE DÉPART À CALIBRER. Measured on the 78 « bien construit » Word-made PDFs of the local corpus (<= 15 pages), 15/10/2026:
 *  two section openings that two pages shared were published as furniture and lost 189 words (080 pages 6, 8: « Titre de niveau 1 »
 *  + a 4-line paragraph; 024 pages 6-7: 42 words); the true runs measured then (tool since retired) were 1 to 3 lines and 2 to
 *  20 words (the longest declared header holds 7 lines, 074 Geneva form, repeated on every page). Three pages is the floor
 *  `EDGE_COUNTER_PAGES_THRESHOLD` already uses for the same reason. */
const LONG_BLOCK_LINES_THRESHOLD = 4;
const LONG_BLOCK_WORDS_THRESHOLD = 25;
const LONG_BLOCK_PAGES_THRESHOLD = 3;

/** A page counter written as a rising figure inside a long line (« …AWS Schweiz 2 ») needs this many words of text
 *  around the figure, so that a one-per-page title (« Annexe 1 », fixture 19) is never taken for one.
 *
 *  VALEUR DE DÉPART À CALIBRER. Counters measured on the corpus: 9 to 20 words of text (« 1 | G l o s s a i r e »
 *  counts 9 letters as words); the titles to keep apart: 1 word (« Annexe N »). The gap is wide but rests on few
 *  documents. */
const COUNTER_TEXT_WORDS_THRESHOLD = 3;

/** A rising figure in a line that also holds ANOTHER figure which never changes (« September 2021 N SY 2021-22 », « 430 - N »,
 *  « 14/10/2026 0078.docx N ») is a page counter wherever it stands in the line and however few words surround it, provided the
 *  line repeats at the SAME position inside the page edge band on at least this many pages. The words and the place the strict
 *  rule asks for are what keeps a one-per-page title (« Annexe N ») apart; a constant figure beside the rising one, at the edge,
 *  on three pages, is what a running line has and a title has not.
 *
 *  VALEUR DE DÉPART À CALIBRER. Measured on the 78 « bien construit » Word-made PDFs of the local corpus (<= 15 pages), 15/10/2026:
 *  eight documents carry such a counter (3 to 15 pages each, ~544 invented words before); the titles to keep apart (« Annexe N »,
 *  fixture 19; « Article N : … ») hold no second figure or are not in the edge band. Three pages is the floor under which a
 *  coincidence of two lines proves nothing. */
const EDGE_COUNTER_PAGES_THRESHOLD = 3;

/** The relaxed counter rule never takes a line larger than this multiple of the document's body size: a title is clearly
 *  bigger than the text, a running footer is body-sized or a point over it.
 *
 *  VALEUR DE DÉPART À CALIBRER. Footer measured over the body: 1.1 (fixture 39: 11 pt over 10 pt), 0.75 (footers of 122, 157,
 *  176: 9 over 12); title to keep apart: 1.5 (18 over 12, synthetic « Question N of 20 »). Few real titles measured: the gap is wide on paper only. */
const MAX_COUNTER_SIZE_RATIO = 1.2;

/** The largest figure taken for a page counter: a year or a reference number that changes by one per page is not one.
 *  VALEUR DE DÉPART À CALIBRER. Counters measured: 1 to 14 (15 pages at most); the figures to keep apart: years (2023+). */
const MAX_COUNTER_FIGURE = 999;

/** The outer fraction of the page height where running headers and footers live. Unstructured uses 7 % and 93 %.
 *  Used only when the caller knows the page heights.
 *
 *  VALEUR DE DÉPART À CALIBRER. Measured: furniture lines sit at 2 % to 6 % from an edge (074: 2.7 %, 094: 4.6 %); the
 *  repeated body text that must NOT be dropped sits at 7.6 % or more (054 p6: 15.7 %, 120 p7: 12 %, 047 p5: 7.9 %). */
const MAX_EDGE_BAND_FRACTION = 0.07;

/** Les numéros de page changent d'une page à l'autre : c'est la seule variation
 *  admise, et elle est neutralisée avant comparaison.
 *
 *  **SEUL CE QUI A LA FORME D'UN NUMÉRO DE PAGE EST NEUTRALISÉ (15/09/2026).**
 *  La première version remplaçait TOUS les nombres. Mesuré sur la fixture
 *  `19-Annexes-Titre-Repete` : « Annexe 1 », « Annexe 2 », « Annexe 3 » au même
 *  point devenaient la même ligne, et trois titres disparaissaient sans trace. La
 *  règle, posée le même jour : *un en-tête qui change autrement que par son
 *  numéro de page n'est pas un en-tête.*
 *
 *  Deux autres lectures avaient été mesurées et écartées, chiffres au STATUS :
 *  « l'habillage est plus petit que le corps » (les reprises d'en-tête du
 *  bulletin réel sont plus GRANDES que son corps) et « le nombre suit la page »
 *  (« Annexe N » en page N le suit exactement).
 *
 *  La grammaire est courte et fermée, français et anglais :
 *  - une ligne qui n'est QUE le numéro : `3`, `- 3 -`, `3/30`, `3 sur 30` ;
 *  - un mot de page suivi du numéro, où qu'il soit dans la ligne : `p 3`,
 *    `p. 3`, `pg 3`, `Page 3`, `page 3 sur 30`. `P1` collé n'en est pas un.
 *  Un `n/N` derrière un autre mot (« Annexe 1/3 ») n'est PAS un numéro de page.
 *  Les chiffres romains des pages liminaires ne sont pas reconnus : écarté, non
 *  mesuré. **Aucun document du corpus ne porte de numéro de page** : la liste
 *  vient de l'usage courant ; la fixture `23` l'exerce, elle ne la valide pas.
 *
 *  ⚠️ Réservée à la détection d'HABILLAGE. La détection des reprises de tête
 *  (`detectRepeatedHeadBlocks`) compare le texte EXACT : y neutraliser les
 *  chiffres ferait coïncider « 402 » avec un « 4 » isolé, ce qui a été observé
 *  sur une sonde le 10/09/2026. */
const PAGE_NUMBER_ALONE = /^[-–—\s]*\d+(?:\s*(?:\/|sur|of)\s*\d+)?[-–—\s]*$/iu;
/** The words for « page », a written list (FR, EN, DE, ES, IT, PT, PL, NL, SV, DA). `p` alone needs a space after it. */
const PAGE_WORDS = "page|pg\\.?|pag\\.?|pág\\.?|pagina|página|seite|strona|sida|side|bladzijde|str\\.|p\\.|p(?=\\s)";
/** « of » between the page and the total in the same languages (« Strona 4 z 11 »). */
const OF_WORDS = "\\/|sur|of|z|von|de|di|van|av|af";
/** A figure, or a Roman numeral up to 39 (front matter pages; « mix » is not one). */
const PAGE_FIGURE = "(?:\\d+|(?=[ivx])x{0,3}(?:ix|iv|v?i{0,3}))";
const PAGE_NUMBER_AFTER_WORD = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${PAGE_WORDS})\\s*[|:]?\\s*${PAGE_FIGURE}(?:\\s*(?:${OF_WORDS})\\s*\\d+)?(?![\\p{L}\\p{N}])`,
  "giu",
);
/** The figure BEFORE a page word, after a bar: « 12 | Page ». The bar is the evidence; « 3 page » alone is prose. */
const PAGE_NUMBER_BEFORE_WORD = new RegExp(`(?<![\\p{L}\\p{N}])${PAGE_FIGURE}\\s*\\|\\s*(?:${PAGE_WORDS})(?![\\p{L}\\p{N}])`, "giu");
/** Four letters or more, each alone between single spaces (« P a g e », « G l o s s a i r e »): the way Word spaces out some footers. */
const LETTER_SPACED = /(?<![\p{L}\p{N}])\p{L}(?: \p{L}){3,}(?![\p{L}\p{N}])/gu;
export const normalizeText = (text: string): string => {
  const trimmed = text.trim().replace(LETTER_SPACED, (run) => run.replace(/ /g, ""));
  if (PAGE_NUMBER_ALONE.test(trimmed)) return "#";
  return trimmed.replace(PAGE_NUMBER_AFTER_WORD, "p#").replace(PAGE_NUMBER_BEFORE_WORD, "p#");
};

const bucket = (value: number, tolerance: number): number => Math.round(value / tolerance);

/** Are two lines' baselines within `ratio` times the larger size? */
const within = (a: PageLine, b: PageLine, ratio: number): boolean => {
  const size = Math.max(a.size, b.size);
  return size > 0 && Math.abs(a.y - b.y) <= size * ratio;
};

/** Two neighbouring lines belong to one block when their baselines are within `MAX_RUN_GAP_RATIO` of the larger size. */
const contiguous = (a: PageLine, b: PageLine): boolean => within(a, b, MAX_RUN_GAP_RATIO);

/** Does a run of this length swallow its page (see `MAX_FURNITURE_RUN_LINES`)? */
const swallowsPage = (length: number, pageLines: number): boolean => length > MAX_FURNITURE_RUN_LINES && length * 2 > pageLines;

/** What the edge walk and its acceptance tests read about one page. */
interface RunContext {
  lines: readonly PageLine[];
  loose: readonly boolean[];
  exact: readonly boolean[];
  mostlyRepeated: boolean;
  /** On how many pages each line repeats (its exact form, else its digits-free form). */
  support: readonly number[];
  /** On how many pages OF THIS PARITY each line repeats (its position without the abscissa). */
  paritySupport: readonly number[];
  /** How many pages of the document carry text, and how many of them have this page's parity. */
  textPages: number;
  sameParityTextPages: number;
}

/**
 * The lines of one edge run (walked from `from` by `step`) that are furniture, or none. See the walk's comment in
 * `detectPageFurniture` for the rules: loose repeats, one exact anchor, the bounded gap crossing, the page-swallowing bound.
 */
const edgeRun = (
  page: RunContext,
  from: number,
  step: 1 | -1,
): number[] => {
  const { lines, loose, exact, mostlyRepeated } = page;
  const run: number[] = [];
  let beforeGap: number | undefined;
  for (let i = from; i >= 0 && i < lines.length && loose[i] === true; i += step) {
    if (i !== from && !contiguous(lines[i - step]!, lines[i]!)) {
      const mayCross = beforeGap === undefined && !mostlyRepeated && exact[i] === true && run.some((j) => exact[j] === true);
      if (!mayCross || !within(lines[i - step]!, lines[i]!, MAX_BANNER_GAP_RATIO)) break;
      beforeGap = run.length;
    }
    run.push(i);
  }
  if (beforeGap === undefined) dropLabelsOfTheBody(run, page, step);
  const kept = swallowsPage(run.length, lines.length) && beforeGap !== undefined ? run.slice(0, beforeGap) : run;
  if (isFurnitureRun(kept, page)) return kept;
  return supportedEdgePrefix(kept, page);
};

/** The last line of a walked run that stands closer to the line after the run than to the line before it, repeats on fewer than
 *  `LABEL_SUPPORT_RATIO` of the pages the run's strongest line repeats on, is the first line of the
 *  body (a section label such as « Description », repeated at the page top where a page break fell), not the end of the header block: a header
 *  block is detached from the body by a gap larger than its own line spacing, and its lines repeat together. Dropped from the run one line at a
 *  time, never the edge line. The strongest support is capped at the number of text pages (a page counter counts as all of them).
 *  The gap and support tests are both needed: the gap alone drops the last line of a footer printed close to a table (2-page document).
 *  ACCEPTED BIAS (laid, pinned by a test): a header block's own subtitle that is close to the body and repeats on few pages (other text per
 *  chapter) is published once per page, visible, rather than removed. A size guard (never drop a line of the strongest line's size) was tried and
 *  measured 15/10/2026: it kept the subtitle but lost 3 of the 5 saved documents (198 footnote, 208 table cells, 188 cells, all body-sized).
 *  A next line on the same baseline is a neighbouring column, not the body: no drop. */
const dropLabelsOfTheBody = (run: number[], page: RunContext, step: 1 | -1): void => {
  const { lines, support } = page;
  const strongestLine = run.reduce((best, j) => (support[j]! > support[best]! ? j : best), run[0]!);
  const strongest = Math.min(support[strongestLine]!, page.textPages);
  while (run.length > 1) {
    const last = run[run.length - 1]!;
    const next = lines[last + step];
    if (next === undefined || Math.abs(lines[last]!.y - next.y) <= POSITION_TOLERANCE) return;
    const above = Math.abs(lines[run[run.length - 2]!]!.y - lines[last]!.y);
    if (above <= Math.abs(lines[last]!.y - next.y) || support[last]! >= strongest * LABEL_SUPPORT_RATIO) return;
    run.pop();
  }
};

/** See `dropLabelsOfTheBody`.
 *
 *  VALEUR DE DÉPART À CALIBRER. Measured 15/10/2026 on 02-jvmalin (16 pages): the running header repeats on 16 pages, the label « Description » on 3
 *  (ratio 0.19); a header block's lines repeat together (ratio 1). Measured activations on 6 of the 300 Word PDFs of the local corpus (six documents, the five
 *  and 063 named in the commit): the saved lines repeat on 2 to 3 pages against 5 to 26 for the strongest line. The gap rests on few documents. */
const LABEL_SUPPORT_RATIO = 0.5;

/** When a long run is refused only because part of it is a block repeated on too few pages (a footnote shared by two pages, 08 Ontario
 *  p5 and p8, right above « Page 5 of 13 »), the lines from the edge inward that repeat on enough pages by themselves are still
 *  furniture, provided they make a short run with an exact anchor. The refused block itself stays. A run that covers every line of
 *  its page (a template) gives nothing back. */
const supportedEdgePrefix = (run: readonly number[], page: RunContext): number[] => {
  if (run.length === page.lines.length || swallowsPage(run.length, page.lines.length)) return [];
  const prefix: number[] = [];
  for (const i of run) {
    if (!isEnoughSupported(i, page)) break;
    prefix.push(i);
  }
  return prefix.length > 0 && prefix.length < run.length && isFurnitureRun(prefix, page) ? prefix : [];
};

/** Does this line repeat on enough pages, by itself, to be furniture inside a long block (`LONG_BLOCK_PAGES_THRESHOLD`, or its parity)? */
const isEnoughSupported = (i: number, page: RunContext): boolean => {
  const pagesNeeded = Math.min(LONG_BLOCK_PAGES_THRESHOLD, page.textPages);
  return page.support[i]! >= pagesNeeded || (page.sameParityTextPages >= MIN_PAGES && page.paritySupport[i]! >= page.sameParityTextPages);
};

/** Does this walked run stand: it does not swallow its page, holds an exact anchor, and is not an under-supported block? */
const isFurnitureRun = (run: readonly number[], page: RunContext): boolean =>
  !swallowsPage(run.length, page.lines.length) && run.some((i) => page.exact[i] === true) && !isUnderSupportedBlock(run, page);

/** Is this run a BLOCK (`LONG_BLOCK_*_THRESHOLD`) that either covers every line of its page or repeats on too few pages? */
const isUnderSupportedBlock = (
  run: readonly number[],
  page: RunContext,
): boolean => {
  const words = run.reduce((sum, i) => sum + page.lines[i]!.text.replace(LETTER_SPACED, (spaced) => spaced.replace(/ /g, "")).split(/[^\p{L}\p{N}]+/u).filter((w) => w !== "").length, 0);
  if (run.length < LONG_BLOCK_LINES_THRESHOLD && words < LONG_BLOCK_WORDS_THRESHOLD) return false;
  // ACCEPTED COST (laid bias, pinned by a test): in a 3-4 page document a real block of 4 lines or more that opens pages 1 and 3 only
  // is indistinguishable from a mirrored odd-page header, and is removed.
  // Pages without text offer no evidence either way; an odd/even block (a mirrored layout) is judged on the pages of its parity.
  return run.length === page.lines.length || run.some((i) => !isEnoughSupported(i, page));
};

/** Is the line inside the top or bottom edge band of a page of this height, whose view starts at `pageBottom` in user space
 *  (a CropBox may start above 0)? Unknown height: never (the caller keeps the rule that needs no height). */
const atPageEdge = (line: PageLine, pageHeight: number | undefined, pageBottom = 0): boolean => {
  if (pageHeight === undefined || pageHeight <= 0) return false;
  const y = line.y - pageBottom;
  return y >= pageHeight * (1 - MAX_EDGE_BAND_FRACTION) || y <= pageHeight * MAX_EDGE_BAND_FRACTION;
};

/** What a line is compared on (see `detectPageFurniture`): the exact key, the digits-free key, the normalized text. */
interface LineKeys {
  exact: string;
  loose: string;
  text: string;
}

/**
 * The lines that carry a PAGE COUNTER written as a plain figure: one line per page, and across the pages exactly one of its
 * digit runs equals the page index plus a constant while every other run stays put (« …AWS Schweiz 2 »,
 * « file.docx 1 / 7 October 7, 2025 », « 1 | Glossaire »). Such a line repeats by its loose key and its figure follows the page,
 * which is what the exact repeat of a page number says. The text around the figure must be long enough
 * (`COUNTER_TEXT_WORDS_THRESHOLD`): the 15/09/2026 rule stands for short one-per-page titles.
 * A second reading, for the lines the first one cannot take (`EDGE_COUNTER_PAGES_THRESHOLD`): the position is compared without its
 * abscissa (a duplex layout swaps the margins page by page: « 388 - 1 » at x=509, « 388 - 2 » at x=72), a lower-case Roman numeral
 * counts as a figure (the front matter of a Word document: « September 2021 ii SY 2021-22 »), and neither the words nor the
 * place of the figure matter.
 */
const counterLinesOf = (
  pagesLines: readonly (readonly PageLine[])[],
  keys: (line: PageLine) => LineKeys,
  /** Is this line of this page inside the page's top or bottom edge band? (Never, when the heights are unknown.) */
  atEdge: (line: PageLine, page: number) => boolean,
): Set<PageLine> => {
  const bodySize = furnitureBodySizeOf(pagesLines);
  const groups = new Map<string, CounterEntry[]>();
  const relaxedGroups = new Map<string, CounterEntry[]>();
  pagesLines.forEach((lines, page) => {
    for (const line of lines) {
      const entry = counterEntryOf(line, keys(line), { page, pageCount: pagesLines.length, edge: atEdge(line, page), bodySize });
      if (entry === undefined) continue;
      if (entry.digits.length > 0) pushTo(groups, keys(line).loose, entry);
      pushTo(relaxedGroups, entry.relaxed.key, entry);
    }
  });
  const found = new Set<PageLine>();
  // Strict: enough words around the figure, and the figure at a place a counter stands.
  for (const group of groups.values()) {
    const texty = group.filter((e) => e.enoughText);
    if (risesWithPage(texty, (e) => ({ digits: e.digits, standalone: e.strict }))) for (const e of texty) found.add(e.line);
  }
  // Relaxed: a second, constant figure in the line, the same position inside the edge band, on enough pages.
  for (const group of relaxedGroups.values()) {
    if (group.length >= EDGE_COUNTER_PAGES_THRESHOLD && group.every((e) => e.edge && !e.oversize) && group[0]!.relaxed.digits.length >= 2 && risesWithPage(group, (e) => e.relaxed)) {
      for (const e of group) found.add(e.line);
    }
  }
  return found;
};

/** The document's body size: the font size that carries the most characters. */
const furnitureBodySizeOf = (pagesLines: readonly (readonly PageLine[])[]): number => {
  const chars = new Map<number, number>();
  for (const lines of pagesLines) for (const l of lines) {
    const b = bucket(l.size, SIZE_TOLERANCE);
    chars.set(b, (chars.get(b) ?? 0) + l.text.length);
  }
  let best = 0;
  let bestChars = -1;
  for (const [b, n] of chars) if (n > bestChars || (n === bestChars && b > best)) [best, bestChars] = [b, n];
  return best * SIZE_TOLERANCE;
};

const pushTo = <T>(map: Map<string, T[]>, key: string, value: T): void => {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
};

/** One line read for the page-counter rules (`counterLinesOf`). */
interface CounterEntry {
  line: PageLine;
  page: number;
  digits: number[];
  /** Per digit run: no letter or digit touches it. */
  standalone: boolean[];
  /** Per digit run: standalone AND at a place a counter may stand. */
  strict: boolean[];
  enoughText: boolean;
  edge: boolean;
  /** Larger than the document's body text: a title, never page furniture (relaxed rule only). */
  oversize: boolean;
  /** The Roman-aware reading of the line, for the relaxed rule. */
  relaxed: { key: string; digits: number[]; standalone: boolean[] };
}

const counterEntryOf = (
  line: PageLine,
  { text }: LineKeys,
  { page, pageCount, edge, bodySize }: { page: number; pageCount: number; edge: boolean; bodySize: number },
): CounterEntry | undefined => {
  const romanised = text.replace(ROMAN_FIGURE, (token) => String(romanValueOf(token)));
  const romanRuns = [...romanised.matchAll(/\d+/g)];
  if (romanRuns.length === 0) return undefined;
  const runs = [...text.matchAll(/\d+/g)];
  return {
    line,
    page,
    digits: runs.map((m) => Number(m[0])),
    // A figure glued to letters (« fr5/21 ») is not a page counter, whatever it does from page to page.
    standalone: runs.map((m) => isStandalone(text, m.index, m[0].length)),
    strict: runs.map((m) => isStandalone(text, m.index, m[0].length) && inCounterPlace(text, m.index, m[0].length, pageCount)),
    enoughText: hasCounterText(line.text.trim()),
    edge,
    oversize: line.size > bodySize * MAX_COUNTER_SIZE_RATIO,
    relaxed: {
      key: `${romanised.replace(/\d+/g, "#")}|${romanised === text}|${bucket(line.y, POSITION_TOLERANCE)}|${bucket(line.size, SIZE_TOLERANCE)}`,
      digits: romanRuns.map((m) => Number(m[0])),
      standalone: romanRuns.map((m) => isStandalone(romanised, m.index, m[0].length) || closesWithTotal(romanised, m.index, m[0].length)),
    },
  };
};

/** Is there a digit run that rises by one per page while every other run stays put, over one entry per page? */
const risesWithPage = (group: readonly CounterEntry[], read: (e: CounterEntry) => { digits: number[]; standalone: readonly boolean[] }): boolean => {
  if (new Set(group.map((e) => e.page)).size !== group.length || group.length < MIN_PAGES) return false;
  const first = read(group[0]!);
  const firstPage = group[0]!.page;
  const followsPage = (j: number): boolean =>
    group.every((e) => {
      const r = read(e);
      return r.standalone[j] === true && r.digits[j]! <= MAX_COUNTER_FIGURE && r.digits[j]! - e.page === first.digits[j]! - firstPage;
    });
  const othersStay = (j: number): boolean => first.digits.every((_, m) => m === j || group.every((e) => read(e).digits[m] === first.digits[m]));
  return first.digits.some((_, j) => followsPage(j) && othersStay(j));
};

/** A lower-case Roman numeral up to 39 standing alone (front matter page numbers); upper case is left alone (« I » is a pronoun). */
const ROMAN_FIGURE = /(?<![\p{L}\p{N}])(?=[ivx])x{0,3}(?:ix|iv|v?i{0,3})(?![\p{L}\p{N}])/gu;
const romanValueOf = (token: string): number => {
  const values: Record<string, number> = { i: 1, v: 5, x: 10 };
  let total = 0;
  for (let i = 0; i < token.length; i++) {
    const v = values[token[i]!]!;
    total += v < (values[token[i + 1] ?? ""] ?? 0) ? -v : v;
  }
  return total;
};

/** Where a page counter may stand: at the START or the END of the line, or followed by its total: « n / TOTAL » anywhere (063),
 *  « n of TOTAL » only when that closes the line (243, 240), TOTAL being the document's own page count. A rising figure anywhere else (« Article 2 : Dispositions
 *  generales », « Step 2 of 3 Choose your plan ») is a one-per-page title, and removing it would lose its words (review 14/10/2026). */
const inCounterPlace = (text: string, index: number | undefined, length: number, pageCount: number): boolean => {
  if (index === undefined) return false;
  const tail = text.slice(index + length);
  if (text.slice(0, index).trim() === "" || tail.trim() === "") return true;
  const total = /^\s*(\/|of|sur|von)\s*(\d+)(?!\d)(.*)$/isu.exec(tail);
  return total !== null && Number(total[2]) === pageCount && (total[1] === "/" || total[3]!.trim() === "");
};

/** A figure followed by « /total » closing the line is still a counter whatever touches it on its LEFT (the check ignores the left side; a printed web
 *  page's footer « …edge_no=…e997b9 1/3 » extracted without the space, 0000523): « N/M » at the end of a line is not an identifier.
 *  Only the relaxed rule reads it, which already demands the edge band, 3 pages, a constant figure and a rise of 1 per page.
 *
 *  VALEUR DE DÉPART À CALIBRER. Measured: the one document (0000523, 3 pages); the glued-figure case to keep apart (« fr5/21 », 047)
 *  is also a rising counter, so nothing measured is lost to this reading. */
const closesWithTotal = (text: string, index: number | undefined, length: number): boolean =>
  index !== undefined && /^\/\d+$/.test(text.slice(index + length));

/** Is the digit run at `index` a token of its own (no letter or digit touching it)? */
const isStandalone = (text: string, index: number | undefined, length: number): boolean =>
  index !== undefined && !/[\p{L}\p{N}]/u.test(text[index - 1] ?? " ") && !/[\p{L}\p{N}]/u.test(text[index + length] ?? " ");

/** Enough words of text around the figure(s) to be a running line and not a title (one letter counts as a word, as
 *  Word spaces out some footers). */
const hasCounterText = (text: string): boolean =>
  text.replace(/\d+/g, " ").split(/[^\p{L}]+/u).filter((w) => w !== "").length >= COUNTER_TEXT_WORDS_THRESHOLD;

/** For each key, the set of DISTINCT pages whose items carry it. */
const pagesByKeyOf = <T>(pages: readonly (readonly T[])[], key: (item: T) => string): Map<string, Set<number>> => {
  const pagesByKey = new Map<string, Set<number>>();
  pages.forEach((items, page) => {
    for (const item of items) {
      const k = key(item);
      const seen = pagesByKey.get(k) ?? new Set<number>();
      seen.add(page);
      pagesByKey.set(k, seen);
    }
  });
  return pagesByKey;
};

/** Is the height `y` inside the UPPER half of any band? PDF y grows upward, so `top` > `bottom`. */
const inUpperHalfOfBand = (y: number, bands: readonly TableBand[]): boolean =>
  bands.some((b) => y <= b.top && y >= b.bottom && y >= (b.top + b.bottom) / 2);

/**
 * Pour chaque page, quelles lignes sont de l'habillage.
 *
 * `furniture[page][i]` correspond à `pagesLines[page][i]`, dans le même ordre.
 *
 * ⚠️ **LE TEXTE NE LIT PAS `/Artifact`** — la conjonction codée puis arrêtée le
 * 23/09/2026. Les images ne le lisent plus non plus (détection retirée).
 *
 * ⚠️ **LE REGROUPEMENT SE FAIT PAR ARRONDI**, ce qui a un cas limite honnête :
 * deux positions distantes de moins que la tolérance mais de part et d'autre
 * d'une frontière d'arrondi tombent dans deux groupes. Un appariement deux à
 * deux le fermerait, au prix d'une comparaison quadratique sur toutes les lignes
 * du document. Le cas n'a pas été observé ; il est écrit ici plutôt que laissé à
 * découvrir.
 *
 * Pur : ni I/O, ni horloge, ni aléa. Ne mute jamais son entrée.
 */
export function detectPageFurniture(
  pagesLines: readonly (readonly PageLine[])[],
  tableBands: readonly (readonly TableBand[])[] = [],
  /** The page heights, when the caller knows them: they unlock the page-edge exception (a block repeated exactly at
   *  the page edge is furniture even inside a table band). Without them the band protects as before. */
  pageHeights: readonly number[] = [],
  /** The y of each page's bottom edge in user space (`view[1]`), 0 when absent. */
  pageBottoms: readonly number[] = [],
): boolean[][] {
  if (pagesLines.length < MIN_PAGES) return pagesLines.map((lines) => lines.map(() => false));

  const keysOf = new WeakMap<PageLine, LineKeys>();
  const keys = (line: PageLine): LineKeys => {
    let k = keysOf.get(line);
    if (k === undefined) {
      const text = normalizeText(line.text);
      const where = `|${bucket(line.y, POSITION_TOLERANCE)}|${bucket(line.x, POSITION_TOLERANCE)}|${bucket(line.size, SIZE_TOLERANCE)}`;
      // Loose key: every digit run of the normalized text becomes one placeholder.
      k = { exact: text + where, loose: text.replace(/\d+/g, "#") + where, text };
      keysOf.set(line, k);
    }
    return k;
  };

  /** On how many DISTINCT pages does each form appear? Two occurrences on the same
   *  page prove nothing: furniture repeats across pages, not within one. */
  const pagesByKey = pagesByKeyOf(pagesLines, (line) => keys(line).exact);
  const pagesByLooseKey = pagesByKeyOf(pagesLines, (line) => keys(line).loose);
  const placeKeysOf = new WeakMap<PageLine, string>();
  const placeKeyOf = (line: PageLine): string => {
    let k = placeKeysOf.get(line);
    if (k === undefined) {
      k = `${keys(line).text.replace(/\d+/g, "#")}|${bucket(line.y, POSITION_TOLERANCE)}|${bucket(line.size, SIZE_TOLERANCE)}`;
      placeKeysOf.set(line, k);
    }
    return k;
  };
  const pagesByPlaceKey = pagesByKeyOf(pagesLines, placeKeyOf);
  /** Per position key: how many pages [even, odd] (by index) carry it. */
  const parityCountsByPlaceKey = new Map<string, [number, number]>();
  for (const [key, pagesOfKey] of pagesByPlaceKey) {
    const counts: [number, number] = [0, 0];
    for (const p of pagesOfKey) counts[p % 2]!++;
    parityCountsByPlaceKey.set(key, counts);
  }
  const counterLines = counterLinesOf(pagesLines, keys, (line, page) => atPageEdge(line, pageHeights[page], pageBottoms[page] ?? 0));

  // A counter line proved itself by rising with the page: it counts for every page. The position is compared WITHOUT its abscissa:
  // a right-aligned counter moves with its digit count (« Page 9 sur 11 » at x=489, « Page 10 sur 11 » at x=485) and is still
  // the same line of the same block.
  const textPages = pagesLines.filter((l) => l.length > 0).length;
  const textPagesByParity = [0, 1].map((parity) => pagesLines.filter((l, p) => l.length > 0 && p % 2 === parity).length);
  const paritySupportOf = (line: PageLine, page: number): number =>
    counterLines.has(line) ? Infinity : (parityCountsByPlaceKey.get(placeKeyOf(line))?.[page % 2] ?? 0);
  const supportOf = (line: PageLine): number =>
    counterLines.has(line) ? Infinity : Math.max(pagesByKey.get(keys(line).exact)?.size ?? 0, pagesByPlaceKey.get(placeKeyOf(line))?.size ?? 0);

  return pagesLines.map((lines, page) => {
    const bands = tableBands[page] ?? [];
    const repeatsExactly = (line: PageLine): boolean =>
      (pagesByKey.get(keys(line).exact)?.size ?? 0) >= MIN_PAGES || counterLines.has(line);
    // Rule 2: only the upper half of a band is protected (a repeated table header sits at the top of its table) —
    // unless the line repeats exactly AT THE PAGE EDGE: a letterhead boxed in a one-row grid (074) is not a table header.
    // A band whose lines ALL repeat exactly at the page edge is a banner. A band with any other line is a real table, whose
    // repeated header stays: its words are content, and removing the header on every page loses them (review 14/10/2026).
    const edgeRepeat = (line: PageLine): boolean => repeatsExactly(line) && atPageEdge(line, pageHeights[page], pageBottoms[page] ?? 0);
    // A band that reaches the page edge is a page-wide frame (a cover's border), not a table: it never protects.
    const height = pageHeights[page];
    const bottom = pageBottoms[page] ?? 0;
    const frames = (b: TableBand): boolean => height !== undefined && (b.top - bottom >= height - 1 || b.bottom - bottom <= 1);
    const bannerBands = bands.filter((b) => frames(b) || lines.every((l) => !isInBand(l.y + l.size / 2, [b]) || edgeRepeat(l)));
    const protectedByTable = lines.map(
      (line) => inUpperHalfOfBand(line.y + line.size / 2, bands) && !(edgeRepeat(line) && isInBand(line.y + line.size / 2, bannerBands)),
    );
    const exact = lines.map((line, i) => !protectedByTable[i]! && repeatsExactly(line));
    // Inside a band (either half) only an EXACT repeat counts: amortisation rows at a fixed pitch repeat on every
    // page and differ only by their figures, so a loose-only row must stop the walk, not join a footer run.
    const loose = lines.map(
      (line, i) =>
        exact[i] === true ||
        (!protectedByTable[i]! &&
          !isInBand(line.y + line.size / 2, bands) &&
          (pagesByLooseKey.get(keys(line).loose)?.size ?? 0) >= MIN_PAGES),
    );

    // 🔴 REPETITION IS NOT ENOUGH: THE LINE MUST ALSO BE AT THE EDGE.
    //
    // « They are necessarily the first and the last element of every page » — the
    // second half of the definition. Without it, a document whose pages share the
    // SAME layout sees all its content repeat identically, hence all of it
    // classed as furniture and removed. Measured on 10/09/2026:
    // `fixtures/pdf/11-Brochure-Deux-Colonnes.pdf` has two pages of identical
    // geometry, and an existing test caught it.
    //
    // So we walk in from the TOP and from the BOTTOM while lines repeat, and stop
    // at the first that does not. A multi-line furniture block is still found; a
    // repeated line in the MIDDLE of the page never is.
    // The walk is bounded by GEOMETRY as much as by repetition: two lines more
    // than `MAX_RUN_GAP_RATIO` sizes apart are not one block. Without that bound,
    // a repeated body line is swallowed by the footer just because it precedes it.
    //
    // The walk accepts lines repeated under the LOOSE key (digits free), but the run
    // is furniture ONLY IF it holds at least one EXACT repeat (the anchor). Why: the
    // 15/09/2026 decision is that only a page number may change (fixture 19: « Annexe
    // N » titles, one per page, are content). Measured case, fixture 47, 13/10/2026:
    // « hauts-de-france@caissedesdepots.fr5/21 » (page number glued to an address)
    // stopped the exact walk at the first line, so the whole 4-line footer stayed.
    // Accepted cost: a line that changes only by its digits,
    // contiguous to an exactly repeated header/footer line at the same edge, is
    // removed with it.
    const furniture = lines.map(() => false);
    //
    // TWO BOUNDS on the walk, both measured on the local corpus (14/10/2026):
    // - ONE larger gap may be crossed (`MAX_BANNER_GAP_RATIO`) to reach a line that repeats EXACTLY, when the run
    //   below the gap is already anchored: a banner above a lone page number (094). A line that repeats only by its
    //   digits never lets the run cross.
    // - A run that would cover more than half of a long page (`MAX_FURNITURE_RUN_LINES`) is refused: it swallowed the
    //   page, not a block (024, two template pages of 23 lines whose only difference is a digit). If the run that
    //   crossed a gap is refused, the run before the gap stands.
    // A page whose lines MOSTLY repeat is a template (the same layout twice, fixture 11), not a body with a banner: no crossing.
    const mostlyRepeated = exact.filter(Boolean).length * 2 > lines.length;
    const support = lines.map(supportOf);
    const paritySupport = lines.map((line) => paritySupportOf(line, page));
    const mark = (from: number, step: 1 | -1): void => {
      for (const i of edgeRun({ lines, loose, exact, mostlyRepeated, support, paritySupport, textPages, sameParityTextPages: textPagesByParity[page % 2]! }, from, step)) furniture[i] = true;
    };
    mark(0, 1);
    mark(lines.length - 1, -1);
    return furniture;
  });
}

/**
 * LES REPRISES DE TÊTE DE PAGE — une seconde règle, plus risquée, et qui doit
 * rester distincte de la première (10/09/2026).
 *
 * **Le cas mesuré.** La page 2 d'un bulletin rouvre par quatre lignes qui
 * existent déjà sur la page 1 : « Année scolaire : 2023/2024 », « Bulletin du
 * 1er Trimestre », la classe, le nom de l'élève. Le générateur les redessine
 * en tête de la page de continuation. Elles ne sont PAS de l'habillage au sens
 * de `detectPageFurniture` : elles reviennent 17 pt plus à gauche, donc à une
 * autre position. Relâcher la position pour les attraper supprimerait le TITRE
 * du document sur la page 1 — mesuré, c'est le même texte.
 *
 * **La règle, posée par Mikolaj** : *un texte déjà vu plus haut dans le
 * document, réapparaissant en tête d'une page suivante, est une reprise.* On
 * garde la première occurrence, on jette les suivantes.
 *
 * **🔴 SON COÛT, ÉCRIT EN FACE PLUTÔT QU'À DÉCOUVRIR.** Une phrase légitimement
 * répétée en haut d'une page serait supprimée, et la suppression serait
 * invisible. C'est pour cela que la règle est bornée trois fois : jamais la
 * première page, jamais ailleurs qu'en TÊTE de page, et jamais au-delà de la
 * première ligne qui n'a pas déjà été vue. Le texte est comparé EXACTEMENT, sans
 * neutraliser les chiffres — sinon « 402 » coïnciderait avec n'importe quel
 * nombre.
 *
 * **« LE MÊME BLOC REDESSINÉ EN TÊTE » : SES DEUX CONDITIONS, VÉRIFIÉES DEPUIS LE
 * 15/09/2026.** La première version ne comparait que le texte. Mesuré sur la
 * fixture `20-Sommaire-Puis-Section` : une entrée de sommaire suffisait à jeter
 * le titre de section qui ouvrait une page plus loin. Ce ne sont pas des
 * conditions nouvelles, c'est ce que la définition sous-entendait :
 *  - **A** — la première occurrence est elle-même dans le BLOC DE TÊTE de sa page
 *    (`headBlockLength`, la même contiguïté et la même garde d'emprise qu'ici) ;
 *  - **B** — elle a la MÊME TAILLE, à `SIZE_TOLERANCE` près, comme l'habillage.
 * Aucune constante ajoutée. Mesuré sur le bulletin réel : ses quatre reprises
 * sont les 2e, 5e, 9e et 11e lignes de la page 1, toutes dans son bloc de tête,
 * et à la même taille (7,92 contre 8,04 tombent dans le même arrondi) ; l'app les
 * retire exactement comme avant. Sur `20`, A
 * seule ne suffit pas — le sommaire est collé au titre de la page 1, donc dans son
 * bloc de tête — et c'est B qui tranche (11 contre 14).
 *
 * **Le biais tombe du bon côté** : une vraie reprise redessinée à une autre taille
 * reste affichée en double, visible ; un titre n'est plus perdu sans trace.
 *
 * **LA BANDE DE BORD (14/10/2026).** Mesuré sur 76 PDF du corpus local (15 pages au plus), la règle retirait du TEXTE
 * réel repris en tête d'une page : une clause de 80 mots (054 p6, à 15,7 % du bord haut), un paragraphe (047 p5, 7,9 %),
 * un bloc d'adresse (120 p7, 12 %). Les reprises vraies (le bulletin : 5 % à 7 % du bord) sont dans la bande
 * `MAX_EDGE_BAND_FRACTION`. Quand l'appelant donne les hauteurs de page, une reprise hors de la bande n'est plus retirée et
 * arrête la descente. Sans hauteurs, la règle est celle d'avant. ESSAYÉ ET ÉCARTÉ : exiger en plus trois pages — le
 * bulletin n'en a que deux.
 *
 * Pur : ni I/O, ni horloge, ni aléa. Ne mute jamais son entrée.
 */
export function detectRepeatedHeadBlocks(
  pagesLines: readonly (readonly PageLine[])[],
  tableBands: readonly (readonly TableBand[])[] = [],
  /** The page heights, when the caller knows them: a repeat is then dropped only inside the page's edge band
   *  (a clause that reopens a page 130 pt under the top edge is text, not a redrawn header). */
  pageHeights: readonly number[] = [],
  /** The y of each page's bottom edge in user space (`view[1]`), 0 when absent. */
  pageBottoms: readonly number[] = [],
): boolean[][] {
  /** Texte exact → arrondis de taille sous lesquels il a paru en tête d'une page. */
  const seenInHead = new Map<string, Set<number>>();
  const sizeKey = (line: PageLine): number => bucket(line.size, SIZE_TOLERANCE);
  const out: boolean[][] = [];

  for (let page = 0; page < pagesLines.length; page++) {
    const lines = pagesLines[page] ?? [];
    const flags = lines.map(() => false);
    const head = headBlockLength(lines, tableBands[page] ?? []);

    // La première page n'a rien « au-dessus d'elle » : rien à y reprendre.
    if (page > 0) {
      const height = pageHeights[page];
      // The descent stops at the first line never seen at the head, and (heights known) at the first outside the edge band.
      const repeated = (line: PageLine): boolean =>
        seenInHead.get(line.text.trim())?.has(sizeKey(line)) === true && (height === undefined || atPageEdge(line, height, pageBottoms[page] ?? 0));
      for (let i = 0; i < head && repeated(lines[i]!); i++) flags[i] = true;
    }

    for (const line of lines.slice(0, head)) {
      const sizes = seenInHead.get(line.text.trim()) ?? new Set<number>();
      sizes.add(sizeKey(line));
      seenInHead.set(line.text.trim(), sizes);
    }
    out.push(flags);
  }
  return out;
}

/** Combien de lignes, depuis le haut, forment le bloc de tête d'une page : on
 *  descend tant que deux lignes voisines restent à moins de `MAX_RUN_GAP_RATIO`
 *  corps l'une de l'autre, et jamais dans l'emprise d'un tableau. */
function headBlockLength(lines: readonly PageLine[], bands: readonly TableBand[]): number {
  let length = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const previous = lines[i - 1];
    if (previous !== undefined && !contiguous(previous, line)) break;
    if (isInBand(line.y + line.size / 2, bands)) break;
    length = i + 1;
  }
  return length;
}
