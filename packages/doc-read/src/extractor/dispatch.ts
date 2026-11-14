/** The single door into extraction: bytes plus a format go in, one IR document
 *  comes out — one branch per supported path, no extraction logic of its own.
 *  Also wires each format's INDEPENDENT second reading
 *  (`pipeline/source-reading-{docx,pptx,xlsx,gsheet}.ts`) into
 *  `ExtractionResult.conservationSource` (a thunk taking the page language: read only when a page is
 *  about to be published, never here), for docx, google-doc, pptx, xlsx
 *  and google-sheet (MIKSUDOC « Spécification technique » T11) — never
 *  through the format's own extractor above, so a bug there cannot pass its
 *  own check.
 *  NOT here: any format's actual reading (`extractor/{docx,pptx,xlsx,pdf,image,google-doc,google-sheet}.ts`),
 *  the second readings themselves (`pipeline/source-reading-*.ts`), nor
 *  which files are eligible at all (`extractor/mime.ts`).
 *  Called by: `orchestrator/doc-processor.ts` through `extractor/index.ts`;
 *  `extractor/pdf-scanned.ts` re-enters it for the OCR half. */

/**
 * extractDocument — the single entry point the doc-processor calls once it
 * has bytes (or, for Sheets, already-fetched API responses) in hand and knows
 * which of the eight MIKSUDOC « Spécification technique » §5.4 paths applies (MIKSUDOC « Spécification technique » §5.4
 * table, mirrored 1:1 by `ExtractionInput`'s variants). Pure glue: every case
 * just calls the already-built, already-golden-verified per-format extractor
 * — no new extraction logic lives here. `pdf` always goes through
 * `extractPdfWithVision`, the superset that degrades to the pure-digital path
 * when nothing needs OCR, so the caller never has to pre-decide "digital or
 * scanned" itself.
 */

import { extractDocx } from "./docx";
import type { RawImage } from "doc-ir/extractor/raw-image";
import { extractXlsx } from "./xlsx";
import { extractPptx, type GoogleSlidesSource } from "./pptx";
import { extractPdfWithVision } from "./pdf-scanned";
import type { PdfDocumentFacts } from "./pdf-facts";
import type { GoogleDrawingSource } from "./docx-reader";
import { extractGoogleDoc } from "./google-doc";
import { extractGoogleSheet, type GoogleSheetMeta } from "./google-sheet";
import { extractImage } from "./image";
import type { IRDoc } from "doc-ir/lib/ir";
import type { ReaderLimits } from "doc-ir/lib/reader-limits";
import type { ExtractOptions } from "../lib/reader-options";
import type { DocumentNotice, PageLanguage } from "doc-ir/lib/reader-types";
import type { PdfTableDetection } from "doc-ir/layout/geometry";
import { readDocxConservationSource } from "../pipeline/source-reading-docx";
import { readPptxConservationSource } from "../pipeline/source-reading-pptx";
import { readXlsxConservationSourceUnder } from "../pipeline/source-reading-xlsx";
import { readGoogleSheetConservationSource } from "../pipeline/source-reading-gsheet";
import type { ConservationSource } from "../pipeline/conservation-source-union";
import type { VisionPort } from "doc-ir/lib/vision-port";

/** The one definition moved to `raw-image.ts` (recensement of 28/09/2026:
 *  a second copy lived in `image.ts`, kept apart by the dispatch↔image
 *  cycle); re-exported here for its many importers. */
export type { RawImage } from "doc-ir/extractor/raw-image";

export interface ExtractionResult {
  doc: IRDoc;
  images: RawImage[];
  /** docs/ARBITRAGE-TABLEAUX-PDF.md [purged 27/09/2026, git history] §8, jalon 1/2 — `pdf` only, present
   *  only when ≥1 page carries a table candidate. Sourced directly from
   *  `extractPdfWithVision`'s own return value (computed once, inside
   *  `pdf.ts`, best-effort — never a second separate detection pass over
   *  the same bytes just for this signal). */
  tableDetections?: PdfTableDetection[];
  /** Reads what the text-conservation check compares the render with
   *  (`pipeline/publish-conservation.ts`) — a THUNK, so a document whose
   *  publish turns out to be a no-op, or whose page the model rewrites, never
   *  pays for the second reading (the PDF's is already in hand: its thunk
   *  just hands it back). Set for `pdf`, `docx`,
   *  `google-doc` (lot A), `pptx` (§7 lot D — a Google Slides deck too, same
   *  exported bytes), `xlsx` and `google-sheet`
   *  (MIKSUDOC « Spécification technique » T11); absent for `image`
   *  (no text source: out of scope). In memory only — it holds the
   *  document's text; the thunk holds the file's bytes until it runs, so the
   *  caller drops it as soon as it has read. It takes the PAGE language (the document's, resolved at publication) so a
   *  unit label matches the page's (08/10/2026). */
  conservationSource?: (language: PageLanguage) => Promise<ConservationSource>;
  /** `docx`/`google-doc` only — see `docx-reader/index.ts#DocxReadResult`.
   *  Display-only (dashboard); never read by anything that decides what to
   *  publish. */
  drawingShapesNotDrawn?: number;
  /** `pptx` only (a Google Slides deck too): the tables the layout built for each published tab, in tab order (`extractor/pptx.ts`). Read by the
   *  structure control as an addition of the page (`pipeline/structure-conservation.ts`); never read by anything that decides what to publish. */
  layoutTables?: readonly number[];
  /** Class-1 remarks the extraction produced, off the page since lot A of
   *  docs/CONCEPTION-CARTE-ET-REMARQUES.md (29/09/2026) — `docx`/`google-doc`, `pptx`, `xlsx`, `google-sheet`
   *  and `pdf`, absent (never an empty array) when none. See
   *  `lib/reader-types.ts#DocumentNotice`. */
  notices?: DocumentNotice[];
  /** `pdf` only: how many pages have no text layer and need OCR (a scan), whether they were
   *  read or not. Absent when none. Display-only, like `notices`. */
  scannedPages?: number;
  /** `pdf` only: the document's page count, known on opening (the row says « 12 pages »). */
  pageCount?: number;
  /** `pdf` only: what the file says about itself, reduced to labels and numbers (`pdf-facts.ts`). */
  pdfFacts?: PdfDocumentFacts;
}

/** Google Slides isn't its own case: MIKSUDOC « Spécification technique » §5.4 has it export to
 *  `.pptx` and reuse the pptx path unchanged — the caller that fetches bytes
 *  performs that export and hands this a `{ kind: "pptx" }` input, same as a
 *  native PowerPoint file, plus `googleSlides` so that a diagram slide gets
 *  Google's own image (MIKSUDOC « Spécification fonctionnelle » §9.3.4). */
export type ExtractionInput =
  | { kind: "docx"; bytes: Uint8Array }
  | { kind: "xlsx"; bytes: Uint8Array }
  | { kind: "pptx"; bytes: Uint8Array; googleSlides?: GoogleSlidesSource }
  | { kind: "pdf"; bytes: Uint8Array }
  | { kind: "image"; bytes: Uint8Array; mimeType: string }
  /** `google`: where Google's own image of a drawing comes from (D2 voie A,
   *  MIKSUDOC « Spécification fonctionnelle » §9.5), absent when there is none. */
  | { kind: "google-doc"; bytes: Uint8Array; google?: GoogleDrawingSource }
  | { kind: "google-sheet"; meta: GoogleSheetMeta; valuesByTitle: Map<string, string[][]> };

/** What a caller may set on a reading (`lib/reader-options.ts`, la seule copie depuis la revue du 30/10/2026) :
 *  ré-exportée ici pour que les appelants de la porte n'aient pas à changer d'import. */
export type { ExtractOptions };

/** The `limits` option as an object to spread or to hand on: `{ limits }` when the caller gave some, `{}` when not. */
const withLimits = (opts: { limits?: ReaderLimits } | undefined): { limits?: ReaderLimits } => (opts?.limits === undefined ? {} : { limits: opts.limits });

/** The PDF reading's own options: each field is PRESENT only when the caller gave it, because the reader's signature
 *  distinguishes an absent field from an `undefined` one (`exactOptionalPropertyTypes`). Built here rather than at the call
 *  site: five conditional fields inside `extractDocument` cost it a quality-ratchet finding (30/10/2026). */
const pdfOptions = (pageLanguage: PageLanguage, opts: ExtractOptions | undefined) => ({
  pageLanguage,
  ...(opts?.languages !== undefined ? { languages: opts.languages } : {}),
  ...(opts?.ocr !== undefined ? { ocr: opts.ocr } : {}),
  ...(opts?.readAll === true ? { readAll: true } : {}),
  ...(opts?.scanAsImages === true ? { scanAsImages: true } : {}),
  ...(opts?.labels !== undefined ? { labels: opts.labels } : {}),
  ...withLimits(opts),
});

export async function extractDocument(input: ExtractionInput, vision: VisionPort, opts?: ExtractOptions): Promise<ExtractionResult> {
  // The language the page labels and spreadsheet numbers are written in
  // (the connection's setting); English when absent.
  const pageLanguage = opts?.pageLanguage ?? "en";
  switch (input.kind) {
    case "docx": {
      const result = await extractDocx(input.bytes, opts?.limits, opts?.labels);
      // The independent second reading (lot A, MIKSUDOC « Spécification technique » T11):
      // never through this same `extractDocx` call above, so a bug in it
      // cannot pass its own check.
      return { ...result, conservationSource: () => readDocxConservationSource(input.bytes, withLimits(opts)) };
    }
    case "xlsx": {
      const result = await extractXlsx(input.bytes, pageLanguage, opts?.limits);
      // The independent second reading (lot E, MIKSUDOC « Spécification technique » T11):
      // never through this same `extractXlsx` call above, so a bug in it
      // cannot pass its own check.
      return { ...result, conservationSource: () => readXlsxConservationSourceUnder(input.bytes, opts?.limits) };
    }
    case "pptx": {
      const result = await extractPptx(input.bytes, input.googleSlides, pageLanguage, opts?.limits, opts?.labels);
      // The independent second reading (lot D, MIKSUDOC « Spécification technique » T11):
      // never through this same `extractPptx` call above, so a bug in it
      // cannot pass its own check. A Google Slides deck reaches here as the
      // same exported .pptx bytes — same reader.
      return { ...result, conservationSource: (language) => readPptxConservationSource(input.bytes, language, opts?.limits, opts?.labels) };
    }
    case "pdf": {
      // `ocr: false` (the sync): the pages with no text layer are counted, never read.
      const { doc, images, tableDetections, notices, scannedPages, pageCount, docFacts, conservationSource } = await extractPdfWithVision(input.bytes, vision, pdfOptions(pageLanguage, opts));
      // `images` porte les APLATS DE COULEUR rendus en SVG (écart 15) — le PDF
      // n'en produisait aucune jusqu'au 11/09/2026.
      return { doc, images: images ?? [], ...(tableDetections ? { tableDetections } : {}), ...(notices ? { notices } : {}), ...(scannedPages !== undefined ? { scannedPages } : {}), pageCount, pdfFacts: docFacts, conservationSource: async () => conservationSource };
    }
    case "image":
      return extractImage(input.bytes, input.mimeType);
    case "google-doc": {
      const result = await extractGoogleDoc(input.bytes, input.google, opts?.limits, opts?.labels);
      // Drive exports a Google Doc to .docx before extraction — same bytes,
      // same independent reader as a native Word file (lot A).
      return { ...result, conservationSource: () => readDocxConservationSource(input.bytes, withLimits(opts)) };
    }
    case "google-sheet": {
      // The independent second reading (lot E, MIKSUDOC « Spécification technique » T11):
      // the SAME API response, never through `extractGoogleSheet`'s
      // own fold into an `IRTab` above, so a bug in it cannot pass its own check.
      const { doc, notices } = await extractGoogleSheet(input.meta, input.valuesByTitle, opts?.limits);
      return {
        doc,
        images: [],
        ...(notices.length > 0 ? { notices } : {}),
        conservationSource: async () => readGoogleSheetConservationSource(input.meta, input.valuesByTitle, opts?.limits),
      };
    }
  }
}
