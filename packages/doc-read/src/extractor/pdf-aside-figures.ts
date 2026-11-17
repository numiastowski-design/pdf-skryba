/** The lines that run BESIDE a picture, and the one-row table that publishes the two side by side.
 *  NOT here: where a picture stands among the lines it COVERS (`layout/image-frontier.ts`), which picture a line
 *  is ordered against (`extractor/pdf-region-order.ts`), nor the reading of the picture itself
 *  (`extractor/pdf-image-anchors.ts`).
 *  Called by: `extractor/pdf-image-anchors.ts`. */

import { maxOf, minOf } from "doc-ir/lib/extent";
import type { IRBlock } from "doc-ir/lib/ir";

import type { ImageAnchor, PageRegion } from "./pdf-model";
import { visualLines } from "./pdf-region-order";
import type { PdfTextRun } from "./pdf-source";

/** A picture, the lines that run beside it, and the table that holds both. */
export interface AsideFigure {
  readonly anchor: ImageAnchor;
  readonly lines: readonly PdfTextRun[][];
  readonly region: PageRegion;
}

const inkOf = (line: readonly PdfTextRun[]): PdfTextRun[] => line.filter((it) => it.text.trim() !== "");

/**
 * 🔴 LA TABLE PREND TOUT CE DONT LE TEXTE EST PLUS COURT QUE CELUI DU DESSUS ET/OU DU DESSOUS (
 * 13/11/2026).
 *
 * Mesuré sur la page 5 du livret 26 : l'image va de x 363,9 à 573,2, les lignes qui la longent s'arrêtent toutes à
 * 362,3, et celles du dessus et du dessous vont à 554,3 et 551,4. Le raccourcissement est donc le signal, et il
 * n'a pas besoin de seuil : une ligne longe l'image quand elle FINIT avant son bord gauche — la même relation que
 * `pdf-paragraphs.ts#asidePictureReader`, validée le 12/11.
 *
 * LA SUITE S'ÉTEND AU-DELÀ DE L'EMPRISE DE L'IMAGE, et c'est ce qui garde les phrases entières : « Être la
 * référence européenne en hôtellerie abordable, » commence à y 513,4, donc AU-DESSUS du bord haut de l'image
 * (508,6), et elle est déjà raccourcie. Bornée à l'emprise, la table l'aurait laissée dehors et la phrase serait
 * restée coupée — le défaut qu'on corrige.
 *
 * ⚠️ MAIS « PLUS COURTE » NE SUFFIT PAS, IL FAUT « JUSTIFIÉE CONTRE L'IMAGE » (mesuré le 13/11/2026 : la première
 * version avalait TREIZE blocs, jusqu'à « Objectifs stratégiques »). Sur cette page presque toutes les lignes sont
 * plus courtes que le bord gauche de l'image : « 👁 Vision » finit à 103,3, « demain. » à 114,8 — elles sont
 * courtes pour une autre raison. Les lignes que l'image RACCOURCIT, elles, butent contre elle : elles finissent
 * toutes à 362,3 pour un bord d'image à 363,9, soit 1,6 pt. La suite va donc de la PREMIÈRE à la DERNIÈRE ligne
 * qui bute, les lignes courtes du milieu comprises — ce sont les fins de paragraphe du bloc. Pas de constante
 * inventée : « buter » veut dire finir à moins d'un cadratin du bord, et le cadratin est celui de la ligne.
 */
const besideRun = (anchor: ImageAnchor, lines: readonly PdfTextRun[][]): PdfTextRun[][] => {
  if (anchor.bottom === undefined || anchor.xMax === undefined) return [];
  const [top, bottom, left] = [anchor.top, anchor.bottom, anchor.xMin];
  const inks = lines.map(inkOf);
  /** The line ends against the picture: left of it, and within one em of its edge. */
  const butts = (i: number): boolean => {
    const ink = inks[i]!;
    if (ink.length === 0) return false;
    const right = maxOf(ink, (it) => it.x + it.width);
    return right <= left && left - right <= maxOf(ink, (it) => it.fontSize);
  };
  /** The line meets the picture's height: the run has to hold at least one, or it is beside nothing. */
  const meets = (i: number): boolean => {
    const ink = inks[i]!;
    return ink.length > 0 && maxOf(ink, (it) => it.y + it.height) >= bottom && minOf(ink, (it) => it.y) <= top;
  };
  const anchored = lines.map((_, i) => i).filter((i) => butts(i));
  if (!anchored.some((i) => meets(i))) return [];
  return lines.slice(anchored[0], anchored[anchored.length - 1]! + 1);
};

/**
 * THE PICTURE BECOMES A CELL, NOT AN INSERTION POINT.
 *
 * ⚠️ The region does NOT consume its band, although its lines are published inside it. Consuming would drop every
 * line whose centre falls in [bottom, top] — including text standing to the RIGHT of the picture, which belongs to
 * nobody here and would be silently lost. The caller removes the run's own items instead, which loses nothing.
 */
const figureOf = (
  anchor: ImageAnchor,
  lines: readonly PdfTextRun[][],
  toBlocks: (segment: PdfTextRun[][]) => IRBlock[],
): AsideFigure | undefined => {
  const ink = lines.flatMap(inkOf);
  if (ink.length === 0) return undefined;
  const beside = toBlocks(lines.map((line) => [...line]));
  if (beside.length === 0) return undefined;
  const table: IRBlock = { kind: "table", rows: [{ cells: [{ blocks: beside }, { blocks: anchor.blocks }] }] };
  // The table is read where the run STARTS: everything above it comes before, everything below comes after.
  const top = Math.max(
    maxOf(ink, (it) => it.y + it.height),
    anchor.top,
  );
  return {
    anchor,
    lines,
    region: { top, bottom: top, orderAt: top, xMin: minOf(ink, (it) => it.x), blocks: [table], consumesBand: false },
  };
};

/**
 * Every picture of this page that has text running beside it, with the table that publishes the two side by side.
 * A picture with no such text is left alone: it keeps its place in the flow.
 *
 * ⚠️ ONE PICTURE AT MOST PER RUN OF LINES: the runs are taken highest first, and a line already taken by one
 * picture is not offered to the next — two pictures at the same height would otherwise publish the same text
 * twice.
 */
export const asideFigures = (
  items: readonly PdfTextRun[],
  anchors: readonly ImageAnchor[],
  toBlocks: (segment: PdfTextRun[][]) => IRBlock[],
): { figures: AsideFigure[]; taken: Set<PdfTextRun> } => {
  const lines = visualLines(items);
  const taken = new Set<PdfTextRun>();
  const figures: AsideFigure[] = [];
  for (const anchor of [...anchors].sort((p, q) => q.top - p.top)) {
    const free = lines.filter((line) => line.every((it) => !taken.has(it)));
    const run = besideRun(anchor, free);
    if (run.length === 0) continue;
    const figure = figureOf(anchor, run, toBlocks);
    if (figure === undefined) continue;
    for (const it of run.flat()) taken.add(it);
    figures.push(figure);
  }
  return { figures, taken };
};
