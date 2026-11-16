/** The conservation-source contract every declared format's independent reading
 *  produces (MIKSUDOC « Spécification technique » T11): units in reading
 *  order, each already carrying its source words; texts the page removes ON
 *  PURPOSE and says so; units left out of the check entirely; for xlsx, the
 *  numeric/date cells checked by position; each word's cause, and the
 *  missing words grouped by cause; the named read failure. Producers: Word
 *  and Google Doc (lot A), pptx (lot D), xlsx and Google Sheet (lot E).
 *  The `ConservationSource` union that adds the PDF shape lives in `pipeline/conservation-source-union.ts`: a union
 *  belongs to none of its members, and naming the PDF shape here sent its declaration out with the package of the
 *  declared formats (found on the built artefact, 09/11/2026).
 *  NOT here: reading any one format into this shape
 *  (`pipeline/source-reading-docx.ts`, `pipeline/source-reading-pptx.ts`,
 *  `pipeline/source-reading-xlsx.ts`, `pipeline/source-reading-gsheet.ts`),
 *  comparing it with the published page (`pipeline/declared-format-conservation.ts`,
 *  `pipeline/xlsx-page-cells.ts`).
 *  Called by: each `pipeline/source-reading-*.ts` (produces it),
 *  `pipeline/conservation-source-union.ts` (the union of the three shapes),
 *  `pipeline/declared-format-conservation.ts` and `pipeline/xlsx-page-cells.ts`
 *  (consume it). */

import type { MissingWordCause, StructureCounts } from "doc-ir/lib/reader-types";
import type { ChartShape } from "./source-reading-chart";
import { wordsOf } from "../lib/words";
import { emptyCounts } from "./structure-counts";

interface SourceToken {
  text: string;
  /** The source element this word came from (MIKSUDOC « Spécification technique » T11,
   *  lot C addendum, 29/09/2026) — `lib/reader-types.ts#MissingWordCause`'s own
   *  doc names every value. Optional so an older producer (a fixture, a
   *  future format's first cut) still type-checks; every reader treats an
   *  absent cause as `"text"` (`declared-format-conservation.ts`). */
  cause?: MissingWordCause;
}

/** The missing words themselves, grouped by cause, in first-seen order —
 *  transient and UNBOUNDED, carried from
 *  `pipeline/declared-format-conservation.ts#missingWordGroups` /
 *  `pipeline/publish-conservation.ts` to the dev-only log line
 *  (`adapters/conservation-log.ts`, `orchestrator/doc-processor.ts`). What a
 *  `DocumentConservation` persists is only their counts per cause in
 *  `causeCounts` (`declared-format-conservation.ts#conservationFromMissingWordGroups`),
 *  never a word (owner decision, 09/10/2026). */
export interface MissingWordCauseGroup {
  cause: MissingWordCause;
  words: readonly string[];
}

export interface ConservationUnit {
  /** Our own label for this unit (« Slide 3 », a sheet's name); empty for a
   *  Word or Google Doc, which never has more than one unit to distinguish. */
  label: string;
  /** Source words, in reading order, already tokenised (letters/digits runs,
   *  NFKC lower case — the same rule the published page is read by,
   *  `declared-format-conservation.ts#pageWords`). */
  tokens: readonly SourceToken[];
}

/** ONE numeric or date source cell (xlsx only, lot E addendum
 *  29/09/2026, MIKSUDOC « Spécification technique » T11): checked by
 *  POSITION against the published table, never by word match —
 *  `pipeline/xlsx-page-cells.ts` locates `row`/`col` in the SAME
 *  kept-grid, 0-based positions `pipeline/source-reading-xlsx.ts`'s
 *  independent recompute already produces, within the `unit`'s own
 *  published table. */
export interface ConservationNumericCell {
  /** Index into `units` — this cell's sheet, whether or not that unit is
   *  itself excluded (never the case here: an excluded sheet's cells are
   *  never read, `source-reading-xlsx.ts`'s own rule). */
  unit: number;
  /** The cell reference shown as the missing « word » instead of a value —
   *  a technical position, never client content (owner's own distinction,
   *  29/09/2026): e.g. « Budget!D5 ». */
  ref: string;
  /** 0-based row/col within `unit`'s KEPT grid (hidden/empty lines already
   *  out) — the same order the published table's rows and cells occupy. */
  row: number;
  col: number;
  cause: Extract<MissingWordCause, "number" | "date">;
}

/** The format a structure reading is of: it decides which counts the structure control compares (`pipeline/structure-conservation.ts#COMPARED_COUNTS`).
 *  A Google Doc reads as `docx` and a Google Slides deck as `pptx` (same exported bytes, same reader). */
export type StructureFormat = "docx" | "pptx" | "xlsx" | "gsheet";

/** What ONE unit declares for the structure control (`docs/CONCEPTION-CONTROLE-STRUCTURE.md` section 3.4): `declared` by the file, `withheld` and
 *  `flattened` out of it by decision of the page, `added` to it by the page (a chart's table, a note's items). Expected = declared - withheld -
 *  flattened + added. All zeros for an excluded unit. */
export interface UnitStructure {
  declared: StructureCounts;
  withheld: StructureCounts;
  flattened: StructureCounts;
  added: StructureCounts;
}

/** The structure the second reading declares, one entry per `units` entry (same index). `format` absent: every count is compared. */
export interface SourceStructure {
  units: readonly UnitStructure[];
  format?: StructureFormat;
  /** The structure could not be read (a bound crossed) though the words could: the structure control abstains (`check-failed`), the words control runs. */
  unreadable?: true;
}

/** A unit that declares nothing: a fresh value, its owner may increment it. */
export const emptyUnitStructure = (): UnitStructure => ({ declared: emptyCounts(), withheld: emptyCounts(), flattened: emptyCounts(), added: emptyCounts() });

/** One more table the page adds for a chart it publishes: the table, its header row and its rows, its cells. */
export const addChartTable = (unit: UnitStructure, shape: ChartShape): void => {
  unit.added.tables++;
  unit.added.rows += shape.rows;
  unit.added.cells += shape.rows * shape.columns;
};

export interface DeclaredFormatConservationSource {
  units: readonly ConservationUnit[];
  /** Texts the page removes ON PURPOSE and SAYS, via a `core/page-messages.ts`
   *  line (a capped tab, a withheld sheet…) — never a silent tolerance.
   *  Always empty for Word/Google Doc: a single unit is never capped or
   *  withheld. */
  deliberateRemovals: readonly string[];
  /** Indexes into `units` left out of the check entirely (a retained sheet, a
   *  scanned page). Always empty for Word/Google Doc. */
  excludedUnits: ReadonlySet<number>;
  /** xlsx only: its numeric/date source cells, checked separately
   *  (`pipeline/xlsx-page-cells.ts`) from the word-bag match above. Absent
   *  or empty for every other producer, and for a workbook with none. */
  numericCells?: readonly ConservationNumericCell[];
  /** What the file declares of its structure (headings, tables, items, rows, cells), read in the same walk as the words and independently of the
   *  extractor; compared with the page by `pipeline/structure-conservation.ts`. Absent: no structure control. */
  structure?: SourceStructure;
}

/** The second, independent reading could not be trusted — a corrupt part, a
 *  size limit crossed — so the check abstains (`check-failed`) rather than
 *  compare against a reading it cannot stand behind. Never a reason to
 *  refuse the publish (21/09/2026). */
export interface ConservationSourceReadFailure {
  readFailed: true;
}

/** A unit whose tokens are `text`'s words, all of cause « text ». */
export const unitOf = (label: string, text: string): ConservationUnit => ({
  label,
  tokens: wordsOf(text).map((w) => ({ text: w, cause: "text" as const })),
});

/** The indexes of `items` the check leaves out entirely, in order. */
export const excludedUnitsOf = <T>(items: readonly T[], isExcluded: (item: T) => boolean): Set<number> => {
  const excluded = new Set<number>();
  items.forEach((item, i) => {
    if (isExcluded(item)) excluded.add(i);
  });
  return excluded;
};

/** Runs a synchronous reading; a throw (a corrupt part, a size limit) becomes the named
 *  read failure instead of propagating — never a reason not to publish. */
export const guardedSource = (
  read: () => DeclaredFormatConservationSource,
): DeclaredFormatConservationSource | ConservationSourceReadFailure => {
  try {
    return read();
  } catch {
    return { readFailed: true };
  }
};

/** `guardedSource` for an asynchronous reading. */
export const guardedSourceAsync = async (
  read: () => Promise<DeclaredFormatConservationSource>,
): Promise<DeclaredFormatConservationSource | ConservationSourceReadFailure> => {
  try {
    return await read();
  } catch {
    return { readFailed: true };
  }
};

export function isDeclaredFormatSource(source: object): source is DeclaredFormatConservationSource {
  return "units" in source;
}

export function isReadFailure(source: object): source is ConservationSourceReadFailure {
  return "readFailed" in source;
}

/* `ReferenceCycle` a quitté `letter-conservation.ts` le 09/11/2026 : elle décrit ce que le LECTEUR PDF produit,
 * donc une forme de SOURCE, et ce fichier-là lit un rendu (code d'app). */


/* L'union des trois formes a quitté ce fichier le 09/11/2026 pour `conservation-source-union.ts` : la NOMMER ici
 * faisait partir la déclaration du lecteur PDF avec le paquet des formats déclarés — trouvé par le garde du paquet,
 * sur l'artefact, le jour où ce paquet est né. Une union n'appartient à aucun de ses membres. */
