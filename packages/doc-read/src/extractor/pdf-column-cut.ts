/** Which of the two cuts a page is read on: the painted one, or the
 *  document's gutter — decided on whether it actually separates the text.
 *  NOT here: where either cut comes from (`extractor/pdf-table-detector.ts`
 *  paints, `layout/gutter.ts` infers), nor the band reading that uses it
 *  (`extractor/pdf-bands.ts`).
 *  Called by: `extractor/pdf.ts`. */

import type { PdfTextRun } from "./pdf-source";

/** Une coupe de colonnes : son abscisse, et la borne au-dessus de laquelle
 *  elle vaut. */
export interface ColumnCut {
  cut: number;
  above?: number;
  /** 🔴 TOUTES les coupes du document, croissantes, quand il en porte plus d'une — `cut` est l'une d'elles
   *  (04/11/2026). Seule la lecture en bandes les emploie (`pdf-bands.ts#readingSegments`, qui se récurse dessus) ;
   *  les décisions qui ne connaissent que deux bandes — le bloc `columns` d'un tableau, le conteneur centré — lisent
   *  `cut` et ne voient aucune différence. Absente sur une coupe PEINTE : un bord de cellule parle de sa cellule, et
   *  rien n'autorise à lui adjoindre les gouttières du reste du document. */
  all?: readonly number[];
}

export const pageColumnCut = (
  pageItems: readonly PdfTextRun[],
  painted: ColumnCut | undefined,
  gutter: { cut: number; all: readonly number[] } | undefined,
): ColumnCut | undefined => {
  // ⚠️ L'ARBITRAGE ENTRE LES DEUX COUPES, et il ne se joue pas sur leur origine.
  //
  // Une coupe PEINTE vient d'un bord tracé ; une coupe de GOUTTIÈRE vient d'un
  // blanc que personne ne traverse. On pourrait croire que l'observation bat
  // l'inférence et que la peinte gagne toujours — c'est ce que la première
  // version faisait, et elle ratait la moitié du témoin : la page 0 de
  // `11-Brochure-Deux-Colonnes` porte un petit graphique, donc une grille,
  // donc un trait peint, à une abscisse qui n'a RIEN à voir avec ses deux
  // colonnes de texte. Ce trait gagnait et ne séparait rien.
  //
  // LA QUESTION JUSTE N'EST PAS « d'où vient la coupe » MAIS « sépare-t-elle
  // vraiment le texte ». Une coupe qu'un fragment TRAVERSE ne sépare rien,
  // quelle que soit son origine. On garde donc la peinte quand elle se
  // comporte en gouttière — et c'est le cas du cartouche d'un bulletin, où le
  // bord peint épouse justement le blanc — et on passe à celle du document
  // sinon.
  const crossesText = (x: number, above: number | undefined): boolean =>
    pageItems.some(
      // ⚠️ AU-DESSUS de la borne, pas en dessous : `bandedSplit` n'examine que
      // les lignes situées au-dessus, et en PDF l'ordonnée croît vers le haut.
      (it) => it.text.trim().length > 0 && (above === undefined || it.y >= above) && it.x < x && it.x + it.width > x,
    );
  const paintedSeparates = painted !== undefined && !crossesText(painted.cut, painted.above);
  const pageCut: ColumnCut | undefined = paintedSeparates
    ? painted
    : gutter !== undefined
      ? { cut: gutter.cut, ...(gutter.all.length > 1 ? { all: gutter.all } : {}) }
      : painted;

  return pageCut;
};
