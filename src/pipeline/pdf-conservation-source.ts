/** THE CONSERVATION-SOURCE SHAPE OF A PDF, apart from the other two (09/11/2026).
 *
 *  WHY ITS OWN FILE. The three shapes used to live together in `conservation-source.ts`, which imports the `ChartShape`
 *  type of the chart reading — and that one reads an OOXML package. A PDF reader naming the union therefore pulled the
 *  declarations of `extractor/ooxml/` and `extractor/zip/` into the PUBLISHED package: eight type files for a reader
 *  that never opens an archive (measured on the artefact; the code bundle already erased them).
 *  Decides: nothing. It is a shape — the one the PDF reader hands back.
 *  NOT here: the declared formats' shapes (`conservation-source.ts`), the union of all three
 *  (the app's `conservation-source-union.ts`, which belongs to neither family), nor any comparison (`text-conservation.ts`).
 *  Called by: `extractor/pdf-scanned.ts` (produces it), and `lib/pdf-first-party.ts`, the entry through which the app
 *  takes both shapes. */

import type { ConservationRun } from "doc-ir";

/** One text cycle of a page, in content-stream order (the second reading, design §2). */
export interface ReferenceCycle {
  text: string;
  /** `/Artifact` marked content: its letters are counted, it has no place in the order. */
  artifact?: boolean;
  /** Vertical centre (`y + height / 2`, y goes up), the stage's own rule to give a line to a table band or to the prose. */
  middle?: number;
  /** Marked-content id, to sort a page published in the structure tree's order. */
  markedContentId?: string;
  /** Rotated text: a pool of letters the page may publish (outside the upright count and the order); counted in `rotatedLetters` when not published. */
  rotated?: boolean;
  /** Invisible text (render mode 3, hidden layer): left out of the reference. The extractor already filters such cycles, so it sets none. */
  hidden?: boolean;
  /** Marked content under a `Note` node of the structure tree (a footnote): read at the end of the page when it sits below everything else
   *  (`notesLast`). Moves the reference ORDER only, never the counts. */
  note?: true;
}

/**
 * THE SHAPE EVERY FORMAT'S SECOND READING PRODUCES (MIKSUDOC « Spécification technique » T11), moved here from
 * `publish-conservation.ts` on 09/11/2026: that module reads and writes a RENDER, so it became app code, and a
 * LIBRARY file may not name an app file. The PDF reader (`extractor/pdf-scanned.ts`) and the app's dispatch hand this
 * type back, so it belongs with the two shapes it unions.
 * The PDF keeps its own geometry-based shape; Word, Google Doc, pptx, xlsx and Google Sheet produce the declared one.
 */
export interface PdfConservationSource {
  runs: readonly (readonly ConservationRun[])[];
  deliberateRemovals: readonly string[];
  /** 0-based pages whose runs are not document text we can check (scanned pages, invisible OCR layers). */
  excludedPages: ReadonlySet<number>;
  /** Present for a PDF published as one tab per page: the removals by page. Then each tab is checked against its page
   *  alone (`pipeline/tab-conservation.ts`). Absent: the whole page is checked. */
  deliberateRemovalsByPage?: readonly (readonly string[])[] | undefined;
  /** The second reading of the letters control: it runs beside the word verdict and decides nothing. */
  letters?:
    | {
        pages: readonly (readonly ReferenceCycle[])[];
        structureOrderByPage?: ReadonlyMap<number, readonly string[]>;
        singleReadingPages?: ReadonlySet<number>;
        tableBandsByPage?: ReadonlyMap<number, readonly { top: number; bottom: number }[]>;
      }
    | undefined;
}
