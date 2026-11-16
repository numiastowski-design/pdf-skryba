/** The order a page's tables, images and prose are read in — which lines come
 *  before a region, which after, and which region a line belongs to.
 *  NOT here: what a region contains (`extractor/pdf-table-render.ts`,
 *  `extractor/pdf-image-anchors.ts`), nor the prose itself, which the caller
 *  passes in as a function.
 *  Called by: `extractor/pdf-page-tables.ts`, `extractor/pdf-image-anchors.ts`. */

import { maxOf, minOf } from "doc-ir/lib/extent";
import type { IRBlock } from "doc-ir/lib/ir";
import { groupByBaseline } from "doc-ir/layout/baseline-lines";
import { isInBand } from "doc-ir/layout/grid-band";
import { imageFrontier as sharedImageFrontier } from "doc-ir/layout/image-frontier";
import type { PageRegion } from "./pdf-model";
import type { PdfTextRun } from "./pdf-source";

/** The text item nearest to `blank` along x (the leftmost on a tie); `text` is not empty. */
function nearestTextItem(blank: PdfTextRun, text: readonly PdfTextRun[]): PdfTextRun {
  const gap = (a: PdfTextRun, b: PdfTextRun): number => Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width));
  return text.reduce((best, t) => (gap(blank, t) < gap(blank, best) || (gap(blank, t) === gap(blank, best) && t.x < best.x) ? t : best));
}

/**
 * LE SEUL ENTRELACEMENT DE LA PAGE, tableaux et images (15/09/2026). Les deux
 * chemins l'appellent, donc une ligne au bord d'une image se traite pareil partout.
 *
 * ⚠️ `above` NE REMONTE JAMAIS. La boucle d'avant faisait `above = region.bottom` :
 * une image dont le haut (620) dépasse le bas d'un tableau (600) le faisait remonter,
 * et les lignes du tableau entre 600 et 620 sortaient une seconde fois en prose.
 *
 * Une ligne de bande de tableau est jetée (bornes comprises, comme avant).
 *
 * FOR AN IMAGE, THE FRONTIER IS ITS MEDIAN LINE (decision of 16/09/2026), and
 * one rule covers the six situations:
 *
 *   text entirely above                    → before
 *   text overlapping the image's TOP        → before
 *   text LYING on the upper half            → before
 *   text LYING on the lower half            → after
 *   text overlapping the BOTTOM             → after
 *   text to the left or to the right        → by its half
 *
 * THE ONE EXCEPTION, and it is not a special case of these six: an image whose
 * median would fall BETWEEN two lines it covers passes before the whole block
 * instead of into the middle of it (`imageFrontier`, 23/09/2026).
 *
 * The frontier was the TOP edge until 16/09/2026, which sent every label
 * painted on an image behind the whole image — measured on the MFA guide, whose
 * "Ecran PC" is 27 pt below the top edge of its screenshot and came out after
 * it. The choice made then — "ugly and visible rather than lost" — held because
 * no line was dropped; it still holds, the median drops none either.
 *
 * CE QUE LA RÈGLE NE SAIT PAS, et qu'on refuse de deviner : un texte posé sur une
 * image peut être une légende, un filigrane ou une annotation. Le document ne le
 * dit pas. On ordonne sur la géométrie, on n'interprète rien.
 */
export function interleaveRegions(
  items: readonly PdfTextRun[],
  regions: readonly PageRegion[],
  prose: (items: PdfTextRun[]) => IRBlock[],
): IRBlock[] {
  // A SPACE ITEM IS ORDERED WITH ITS WORD (21/09/2026). pdf.js gave space items
  // a zero height (measured with its runs), so their own centre sits on the baseline, half a line below
  // their words': an image median in between sent the words to one chunk and
  // their spaces to another, and the line came out glued — "LedépartementPaie
  // vousadresseraunlien" (fixture 26 p8). A blank takes the centre of the
  // nearest text item of its visual line, the same neighbour `splitAtGutters`
  // gives it.
  const blankCentre = new Map<PdfTextRun, number>();
  for (const line of visualLines(items)) {
    const text = line.filter((it) => it.text.trim() !== "");
    if (text.length === 0) continue;
    for (const it of line) {
      if (it.text.trim() !== "") continue;
      const word = nearestTextItem(it, text);
      blankCentre.set(it, word.y + word.height / 2);
    }
  }
  const centerOf = (it: PdfTextRun): number => blankCentre.get(it) ?? it.y + it.height / 2;
  const bands = regions.filter((r) => r.consumesBand);
  const kept = items.filter((it) => !isInBand(centerOf(it), bands));
  if (regions.length === 0) return prose(kept);

  const out: IRBlock[] = [];
  // The items already handed to `prose` inside a band, so that none is published twice and none is forgotten.
  const given = new Set<PdfTextRun>();
  const give = (list: PdfTextRun[]): PdfTextRun[] => {
    for (const it of list) given.add(it);
    return list;
  };
  let above = Number.POSITIVE_INFINITY;
  for (const bande of readingOrder(regions)) {
    let pending = kept.filter((it) => centerOf(it) < above);
    // ⚠️ PAIRING ONLY APPLIES INSIDE A BAND, and that is half of the rule.
    // Between two stacked bands the vertical sweep is already the right answer —
    // replacing it with "nearest region" would lift a line above an image it
    // follows, for lack of width to stop it. A single-region band therefore keeps,
    // word for word, the behaviour from before 16/09/2026.
    //
    // PROSE ENTIRELY ABOVE A MULTI-REGION BAND BELONGS TO NONE OF ITS REGIONS
    // (21/09/2026, "option A"). Pairing it anyway split a paragraph lying
    // above two phones of the MFA guide (fixture 24, pages 5 and 7) between them,
    // decided by a 1-pt difference in their tops. Such lines are read top to bottom
    // as plain prose BEFORE the band. No threshold: the boundary is the band's
    // highest top. Decided per visual line keyed on the BASELINE, not per item
    // centre — pdf.js returned space items of height 0 whose centre sat 5–6 pt
    // below the text's, and keyed on centres a line straddling the band top lost
    // its spaces to the other side (safedocs 0000754, page 2, "Abannerwill").
    // Accepted cost: these lines get their own `prose()` call, so a paragraph that
    // starts above the band and continues beside it (text wrapped around an image)
    // comes out as two paragraphs — in the right order. No document shows it yet.
    if (bande.length > 1) {
      const aboveBand = linesAbove(pending, maxOf(bande, (r) => r.top));
      out.push(...prose(pending.filter((it) => aboveBand.has(it))));
      pending = pending.filter((it) => !aboveBand.has(it));
    }
    const owner = bande.length === 1 ? (): PageRegion => bande[0]! : ownerByLine(pending, bande);
    const frontieres = new Map<PageRegion, number>(
      bande.map((r) => [r, imageFrontier(r, pending.filter((it) => owner(it) === r))]),
    );
    for (const region of bande) {
      const mediane = region.orderAt ?? region.top;
      const frontiere = frontieres.get(region)!;
      const mine = pending.filter((it) => owner(it) === region);
      const before = (it: PdfTextRun): boolean => (region.consumesBand ? centerOf(it) > frontiere : centerOf(it) >= frontiere);
      out.push(...prose(give(mine.filter(before))));
      out.push(...region.blocks);
      // ⚠️ AN IMAGE RAISED TO ITS TOP EDGE PUBLISHES RIGHT AFTER ITSELF the
      // block it stands beside — and that is not a comfort, it is the only
      // place those lines can go. The cursor below does NOT move with the
      // frontier (see there), so nothing downstream would ever publish them:
      // measured, they vanished from fixture 24 page 7 and fixture 26 page 8.
      if (frontiere !== mediane) out.push(...prose(give(mine.filter((it) => !before(it) && centerOf(it) >= mediane))));
    }
    // THE CURSOR GOES DOWN WITH THE WHOLE BAND. It marks what is left to
    // publish: moving it region by region would publish TWICE a line lying
    // between two frontiers of the same band. It stays on the MEDIAN even when
    // a frontier was raised, because raising one only changes WHERE a line goes
    // out — before the image or right after it — never whether it goes out.
    above = Math.min(above, ...bande.map((r) => (r.consumesBand ? r.bottom : (r.orderAt ?? r.top))));
    // ⚠️ A LINE OF A BAND OF SEVERAL IMAGES CAN BE LEFT ON NEITHER SIDE (16/10/2026, safedocs 0000154 page 1 in tab mode: eight letterhead
    // pictures, nine lines gone). It lies below its own image's median-or-frontier and above the cursor, which sits on the band's LOWEST
    // median: no region published it, and nothing downstream looks above the cursor. It goes out right after the band: ugly and visible
    // rather than lost.
    out.push(...prose(pending.filter((it) => !given.has(it) && centerOf(it) >= above)));
  }
  out.push(...prose(kept.filter((it) => centerOf(it) < above)));
  return out;
}

/**
 * AN IMAGE THAT COVERS SEVERAL LINES IS NOT INSERTED BETWEEN THEM: IT PASSES
 * BEFORE THE BLOCK IT OVERLAPS (23/09/2026). Its median then decides
 * nothing.
 *
 * THE CASE that raised it is the CEO message of booklet 26 page 3, published as
 * one cell, so the rule BITES in the cell path — the case, the measurements and
 * what the rule refuses to do are written at
 * `pdf-table-render.ts#imageFrontier`, including the horizontal condition tried
 * and refused the same day. It is repeated here because the two paths must not
 * drift: a line an image covers is ordered the same way whether its page
 * renders a grid or not.
 *
 * THE TEST IS AN OVERLAP, NOT A THRESHOLD, and it adds no constant: of the
 * lines this region is ordering, take those whose whole height lies inside the
 * image's vertical extent. If the median would put some of them before the
 * image and the others after, the image would be inserted BETWEEN two lines it
 * covers, and its frontier becomes the box's TOP EDGE instead. Cover nothing,
 * or cover lines that all fall on the same side, and the median still decides —
 * which is why every screenshot of the MFA guide keeps its place, labels
 * included.
 */
const imageFrontier = (region: PageRegion, mine: readonly PdfTextRun[]): number => {
  const mediane = region.orderAt ?? region.top;
  const box = region.box;
  // A table swallows the lines of its band, so it covers none of its own.
  if (region.consumesBand || box === undefined) return mediane;
  const covered = visualLines(mine)
    .flatMap((line) => {
      // A blank item has height 0 and its own baseline: it carries no extent,
      // and it follows its word anyway (see `interleaveRegions`).
      const text = line.filter((it) => it.text.trim() !== "");
      if (text.length === 0) return [];
      const top = maxOf(text, (it) => it.y + it.height);
      const bottom = minOf(text, (it) => it.y);
      return [{ middle: maxOf(text, (it) => it.y + it.height / 2), top, bottom }];
    })
    .filter((l) => l.bottom >= box.bottom && l.top <= box.top);
  return sharedImageFrontier(mediane, box.top, covered);
};

/**
 * LES ÉLÉMENTS CÔTE À CÔTE SE LISENT DE GAUCHE À DROITE, TOUT LE TEMPS
 * (décision de 16/09/2026).
 *
 * L'ordre se décidait sur le seul bord HAUT. Mesuré sur la page 3 du guide MFA :
 * deux codes QU côte à côte, bords hauts à 771 et 776 — **cinq points**
 * décidaient que le QR de droite se lisait en premier, et son lien sortait sous
 * l'étiquette de l'autre. Ce n'est pas une approximation, c'est un ordre de
 * lecture qu'un bruit de coordonnées retourne.
 *
 * Two regions whose VERTICAL extents cross form a band; a band reads left to
 * right. The bands themselves read top to bottom. A region without an extent
 * (no `box`) has zero height: it never joins a band, so nothing changes for it.
 */
export const readingOrder = (regions: readonly PageRegion[]): PageRegion[][] => {
  const bas = (r: PageRegion): number => r.box?.bottom ?? r.top;
  const sorted = [...regions].sort((a, b) => b.top - a.top || a.xMin - b.xMin);
  const out: PageRegion[][] = [];
  let bande: PageRegion[] = [];
  let bandeBas = Number.POSITIVE_INFINITY;
  const fermer = (): void => {
    out.push([...bande].sort((a, b) => a.xMin - b.xMin));
    bande = [];
    bandeBas = Number.POSITIVE_INFINITY;
  };
  for (const region of sorted) {
    if (bande.length > 0 && region.top < bandeBas) fermer();
    bande.push(region);
    bandeBas = Math.min(bandeBas, bas(region));
  }
  if (bande.length > 0) fermer();
  return out;
};

/**
 * PAIRING IS DONE PER LINE, NEVER PER FRAGMENT (16/09/2026).
 *
 * ⚠️ The wiring showed it at once, and the symptom did not look like its cause: two
 * paragraphs "ce lien :" and "informations" appeared between a screenshot and the next
 * one's label. They were the TAILS of two sentences. A line is made of several
 * fragments — a link opens one — and its last fragment, lying to the right, fell inside
 * the RIGHT screenshot's box while the rest of the line went to the left one. The
 * sentence was cut in two places of the page. So the WHOLE line is measured, and all its
 * fragments follow.
 *
 * ...EXCEPT WHERE THE LINE CROSSES A GUTTER WITH NO TEXT OVER IT (21/09/2026, the maintainer's
 * "option B"). On fixture 24 page 7, the label "GSM" (boxed, right of the phone) and
 * "Ecran PC" (boxed, on the PC screenshot) share a baseline within one point. As one line
 * they spanned both images, lay inside the phone's box, and both went to it: the render
 * read "GSM Ecran PC" before the phone. Measured alone, "Ecran PC" is 3.5 pt from its
 * screenshot and 86 pt from the phone.
 *
 * The rule: a line is split only where the gap between two consecutive fragments
 * CONTAINS THE WHOLE GUTTER — the empty x interval between two side-by-side regions (here
 * 307.9 → 354.3, while the gap between the labels runs 268 → 487). Each piece is then
 * paired on its own. No threshold: a word gap is a few points, a gutter is the distance
 * between two images, and the test is containment, not size. The 16/09 case is untouched
 * because a sentence crossing the gutter has text over it — each of its word gaps sits
 * on one side of the gutter or inside it, never around it. Blank fragments do not count:
 * they neither close a gap nor form a piece, they follow the nearest text fragment.
 */
const ownerByLine = (items: readonly PdfTextRun[], regions: readonly PageRegion[]): ((it: PdfTextRun) => PageRegion) => {
  const gutters = guttersOf(regions);
  const owners = new Map<PdfTextRun, PageRegion>();
  for (const line of visualLines(items)) {
    for (const piece of splitAtGutters(line, gutters)) {
      const region = nearestRegion(piece, regions);
      for (const it of piece) owners.set(it, region);
    }
  }
  return (it) => owners.get(it) ?? regions[0]!;
};

/**
 * The page's visual lines, grouped on the BASELINE by the one rule of `layout/baseline-lines.ts`.
 * Never on the item centre: pdf.js returned space items of height 0, whose centre sat
 * 5–6 pt below their word's — keyed on centres, a line loses its spaces to another line.
 * Space items are kept (no empty-text filter, no superscript reseating).
 */
export const visualLines = (items: readonly PdfTextRun[]): PdfTextRun[][] => groupByBaseline(items);

/** The empty x intervals between the band's boxes, left to right. Overlapping boxes leave none. */
const guttersOf = (regions: readonly PageRegion[]): { left: number; right: number }[] => {
  const boxes = regions.flatMap((r) => (r.box === undefined ? [] : [r.box])).sort((a, b) => a.xMin - b.xMin);
  const gutters: { left: number; right: number }[] = [];
  let reach = Number.NEGATIVE_INFINITY;
  for (const b of boxes) {
    if (reach !== Number.NEGATIVE_INFINITY && b.xMin > reach) gutters.push({ left: reach, right: b.xMin });
    reach = Math.max(reach, b.xMax);
  }
  return gutters;
};

/**
 * One visual line cut where a gap between consecutive non-blank fragments contains a
 * whole gutter (see `ownerByLine`). Each piece keeps the line's own item order.
 */
const splitAtGutters = (line: readonly PdfTextRun[], gutters: readonly { left: number; right: number }[]): PdfTextRun[][] => {
  const isBlank = (it: PdfTextRun): boolean => it.text.trim() === "";
  const text = line.filter((it) => !isBlank(it)).sort((a, b) => a.x - b.x);
  if (gutters.length === 0 || text.length < 2) return [[...line]];
  const pieceOf = new Map<PdfTextRun, number>();
  let piece = 0;
  let reach = Number.NEGATIVE_INFINITY;
  for (const it of text) {
    if (reach !== Number.NEGATIVE_INFINITY && gutters.some((g) => reach <= g.left && it.x >= g.right)) piece += 1;
    pieceOf.set(it, piece);
    reach = Math.max(reach, it.x + it.width);
  }
  if (piece === 0) return [[...line]];
  // A blank follows the nearest text fragment in x (the leftmost on a tie).
  const pieceOfBlank = (it: PdfTextRun): number => pieceOf.get(nearestTextItem(it, text))!;
  const pieces: PdfTextRun[][] = Array.from({ length: piece + 1 }, () => []);
  for (const it of line) pieces[pieceOf.get(it) ?? pieceOfBlank(it)]!.push(it);
  return pieces;
};

/**
 * The items of every visual line whose baseline lies strictly above `top`, each line
 * decided whole by its lowest baseline: a zero-height space shares its word's baseline.
 */
const linesAbove = (items: readonly PdfTextRun[], top: number): Set<PdfTextRun> => {
  const above = new Set<PdfTextRun>();
  for (const line of visualLines(items)) if (minOf(line, (it) => it.y) > top) for (const it of line) above.add(it);
  return above;
};

/**
 * LA RÉGION DONT UNE LIGNE EST LA PLUS PROCHE, SUR LES DEUX AXES.
 *
 * ⚠️ **CE N'EST PAS « CETTE LIGNE EST UNE LÉGENDE »**, et la nuance est tout le
 * sujet. On ne cherche pas à reconnaître une étiquette — ni GROBID ni
 * pdffigures2 n'y arrivent sans le marqueur « Figure 1 », que nos documents
 * n'ont pas. On répond seulement à « par rapport à QUELLE image j'ordonne cette
 * ligne », question qui a toujours une réponse. D'où l'absence de seuil : un
 * plafond de distance répondrait à l'autre question, et la mesure du 16/09/2026
 * le réfute — une fin de phrase ordinaire est à 42 pt de son image, l'étiquette
 * « Android » à 47.
 *
 * LA DISTANCE EST CELLE À LA BOÎTE, pas aux centres, et elle est NULLE quand la
 * ligne est dedans. Deux raisons mesurées sur le guide MFA :
 *
 *   · « Ecran PC » est POSÉE sur sa capture — la boîte rend 0 sans règle
 *     spéciale, là où la distance entre centres rendait 106 ;
 *   · une grande image est pénalisée par une distance aux centres, puisque son
 *     propre bord est loin de son centre.
 *
 * Le témoin, posé avant la mesure (`tools/image-proximity.ts`) : quatre
 * étiquettes du guide MFA dont on connaît la bonne image en regardant la page.
 * Quatre sur quatre, et le deuxième candidat est 2 à 20 fois plus loin —
 * « Ecran PC » 0 contre 192, « SMS reçu » 8 contre 104, « Android » 47 contre
 * 103, « iPhone » 44 contre 110.
 */
const nearestRegion = (ligne: readonly PdfTextRun[], regions: readonly PageRegion[]): PageRegion => {
  const x = minOf(ligne, (it) => it.x);
  const xEnd = maxOf(ligne, (it) => it.x + it.width);
  const y = (ligne[0]!.y + ligne[0]!.height / 2 + (ligne[ligne.length - 1]!.y + ligne[ligne.length - 1]!.height / 2)) / 2;
  const distance = (r: PageRegion): number => {
    const b = r.box;
    if (b === undefined) return Number.POSITIVE_INFINITY;
    const dx = Math.max(0, b.xMin - xEnd, x - b.xMax);
    const dy = Math.max(0, b.bottom - y, y - b.top);
    return Math.hypot(dx, dy);
  };
  // À ÉGALITÉ, LA PLUS À GAUCHE — la bande arrive déjà rangée de gauche à
  // droite, et un départage doit être déterministe. Une bande dont aucune région
  // ne porte d'emprise rend donc la première : tout son texte s'ordonne contre
  // elle, comme avant.
  return regions.reduce((best, r) => (distance(r) < distance(best) ? r : best));
};
