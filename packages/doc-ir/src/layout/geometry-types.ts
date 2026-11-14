/** The shapes the geometry modules pass to one another: a text fragment, a
 *  grid and its merged cells, a painted line, a 2D matrix.
 *  NOT here: every decision taken on them — the grid read from painted lines
 *  (`layout/vector-grid.ts`) or from aligned columns (`layout/aligned-grid.ts`),
 *  the placement of fragments (`layout/fragment-cells.ts`), the column
 *  discriminant (`layout/column-discriminant.ts`).
 *  Called by: every other `layout/` geometry module, `core/entities.ts` (for
 *  `PdfTableOrigin` and `PdfTableDetection` alone), and the
 *  `extractor/pdf-*.ts` files through the `layout/geometry.ts` façade. */

/** Origine d'une detection de tableau — la valeur que le detecteur PRODUIT et
 *  que `core/entities` se contente de persister (`SyncedDocument.
 *  pdfTableDetections`). Definie ici, pas la-bas : le sens de la dependance a
 *  ete retourne le 09/09/2026, un module pur ne remonte pas vers les entites. */
export type PdfTableOrigin = "vector-borders" | "alignment-no-borders" | "no-grid";

/** One table candidate of a PDF page: which page, and which detection stage found it. The detectors PRODUCE it; `core/entities.ts` re-exports it
 *  because `SyncedDocument.pdfTableDetections` persists it. */
export interface PdfTableDetection {
  pageIndex: number;
  origin: PdfTableOrigin;
}

export interface LineSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Épaisseur du TRAIT dont ce segment est issu — voir `ClassifiedLine`. */
  thickness?: number;
}

export type ClassifiedLine =
  | { orientation: "horizontal"; y: number; xMin: number; xMax: number; thickness?: number }
  | { orientation: "vertical"; x: number; yMin: number; yMax: number; thickness?: number };

export interface Fragment {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface TableGrid {
  /** y positions, descending (top row first). N boundaries ⇒ N−1 rows. */
  rowBoundaries: number[];
  /** x positions, ascending (left column first). N boundaries ⇒ N−1 columns. */
  colBoundaries: number[];
}

/** Une cellule RÉELLE de la grille : la case où elle commence, et son étendue
 *  sur les deux axes. `colspan`/`rowspan` valent 1 pour une cellule ordinaire. */
export interface MergedCell {
  row: number;
  col: number;
  colspan: number;
  rowspan: number;
}

/**
 * LA CARTE DES FUSIONS D'UNE GRILLE — une structure, pas deux tableaux
 * parallèles (10/09/2026).
 *
 * **Ce qu'elle remplace, et pourquoi il fallait la remplacer.** Le contrat
 * précédent était `number[][]` : les `colspan` ligne par ligne, avec un
 * invariant explicite — leur somme vaut le nombre de colonnes. Cet invariant
 * devient FAUX dès qu'une cellule est fusionnée verticalement, puisqu'une ligne
 * couverte émet alors moins de cellules. Ajouter un second tableau à côté, de
 * forme différente et devant s'accorder avec le premier, aurait été un nid à
 * défauts : l'interaction avec le contrôle d'ambiguïté le montre déjà.
 *
 * **L'invariant qui reste vrai sur les deux axes** : chaque case de la grille
 * est occupée par EXACTEMENT UNE cellule. C'est `ownerAt` qui l'exprime, et
 * c'est ce qui rend le contrôle d'ambiguïté symétrique — un fragment qui
 * déborde sur une case voisine ne traverse rien si les deux cases ont le même
 * propriétaire, quel que soit l'axe du débordement.
 */
export interface MergeMap {
  /** Les cellules réelles, dans l'ordre de lecture — ligne puis colonne. */
  cells: readonly MergedCell[];
  /** `ownerAt[row][col]` : l'indice dans `cells` de la cellule qui occupe cette
   *  case. Une case par entrée, jamais de trou. */
  ownerAt: readonly (readonly number[])[];
}

export interface CellAssignment<T extends Fragment = Fragment> {
  /** `cells[row][col]` — every in-bounds fragment lands in exactly one
   *  cell here (its CENTER-based one — see `ambiguous` below for the
   *  fragments where that rule is uncertain), reading order preserved.
   *  "Rien n'est perdu" (§8): a fragment is never dropped just for being
   *  ambiguous, only flagged as such IN ADDITION to being placed. */
  cells: T[][][];
  /** §8 Q7's real concern ("assigner sans ambiguïté... les fragments à
   *  cheval sur une frontière") — a fragment whose bounding box crosses a
   *  row or column boundary its OWN center-assigned cell doesn't own is
   *  flagged here: a merged cell, a multi-line entry spanning into the
   *  next row band, or a mis-detected boundary would all show up this
   *  way. The "lightweight conservation invariant" jalon 1 needs — not
   *  "was anything lost" (nothing ever is), but "does this grid explain
   *  every fragment WITHOUT ambiguity". A non-empty result downgrades
   *  confidence in the detected grid; jalon 2 is where that becomes an
   *  actual régime-1/régime-2 decision. */
  ambiguous: T[];
  /** Fragments entirely outside the grid's bounding box — ordinary
   *  surrounding prose (a caption, a paragraph before/after the table),
   *  expected and not part of this grid's own accounting at all. */
  outside: T[];
}

/** Une cellule trouvée par intersections : ses quatre bords sont RÉELLEMENT
 *  peints, pas déduits. `yBottom` < `yTop` (l'ordonnée PDF croît vers le haut). */
export interface CellRect {
  xLeft: number;
  xRight: number;
  yBottom: number;
  yTop: number;
}

export interface Matrix2D {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}
