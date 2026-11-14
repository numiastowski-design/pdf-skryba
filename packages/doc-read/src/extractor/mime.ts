/** Which MIME types the app accepts, and what an unsupported one is called on
 *  screen — decided before anything is downloaded.
 *  NOT here: reading any of those formats (`extractor/dispatch.ts`), nor what
 *  an unsupported document becomes (`orchestrator/out-of-scope.ts`).
 *  Called by: `orchestrator/{diff,document-summaries,exclusion-tree,preview}.ts`
 *  through `extractor/index.ts`. */

/**
 * MIME whitelist (MIKSUDOC « Spécification technique » §6.1: "Filtrage par liste blanche de MIME dès
 * la découverte"; MIKSUDOC « Spécification fonctionnelle » §3.1's format list, Q1). Pure classification,
 * no I/O — the orchestrator's diff/snapshot phase calls this to decide
 * `discovered` vs `unsupported` vs `shortcut` before any download happens.
 */

import { DOCX_MIME as DOCX, GOOGLE_DOC, GOOGLE_SHEET, GOOGLE_SHORTCUT, GOOGLE_SLIDES, PPTX_MIME as PPTX, XLSX_MIME as XLSX } from "../lib/mime-types";

const PDF = "application/pdf";
const PNG = "image/png";
const JPEG = "image/jpeg";

export type SupportedKind = "google-doc" | "google-sheet" | "google-slides" | "docx" | "xlsx" | "pptx" | "pdf" | "image";

/** What the dashboard says when a file is set aside as « unsupported format »
 *  (rules review, Mikolaj 18/09/2026) — one line per `SupportedKind` family,
 *  kept next to the whitelist it describes. */
export const ACCEPTED_FORMATS_TEXT =
  "Accepted formats: Google Docs, Sheets and Slides; Word (.docx), Excel (.xlsx) and PowerPoint (.pptx) files; PDF; PNG and JPEG images.";
export type MimeClassification = SupportedKind | "unsupported" | "shortcut";

/** Accepted at all: neither an unsupported type nor a shortcut. The ONE definition of « supported ». */
export const isSupportedKind = (kind: MimeClassification): kind is SupportedKind => kind !== "unsupported" && kind !== "shortcut";

/** Spreadsheets are never translated or harmonised: a workbook is an xlsx or a Google Sheet. The ONE definition. */
export const isWorkbookKind = (kind: MimeClassification): boolean => kind === "xlsx" || kind === "google-sheet";

/** A Drive folder (`application/vnd.google-apps.folder`) is never classified
 *  here — the orchestrator's snapshot phase branches on `isFolder`/`mimeType`
 *  before reaching this whitelist (MIKSUDOC « Spécification technique » §5.3), so folders never
 *  reach this function in practice; passed one anyway, it falls through to
 *  "unsupported" like any other `google-apps.*` type not on the list
 *  (Forms, Drawings, Jamboard, Sites, Vids…). */
export function classifyMimeType(mimeType: string): MimeClassification {
  switch (mimeType) {
    case GOOGLE_DOC:
      return "google-doc";
    case GOOGLE_SHEET:
      return "google-sheet";
    case GOOGLE_SLIDES:
      return "google-slides";
    case GOOGLE_SHORTCUT:
      return "shortcut";
    case DOCX:
      return "docx";
    case XLSX:
      return "xlsx";
    case PPTX:
      return "pptx";
    case PDF:
      return "pdf";
    case PNG:
    case JPEG:
      return "image";
    default:
      return "unsupported";
  }
}
