/** What a PDF says about ITSELF, reduced to what the « Fun facts » card may keep: the tool that wrote it
 *  (from OUR table), its version, its PDF version, whether it is tagged, linearized, a form, its page count.
 *  NOT here: the reading of the raw strings (`extractor/pdf-source.ts`), how the card is
 *  composed and stored (`orchestrator/document-facts.ts`).
 *  Called by: `extractor/pdf.ts`. */

import { collapseBlanks } from "doc-ir/lib/blanks";
import type { PdfToolLabel } from "doc-ir/lib/reader-types";
import type { PdfDocumentInfo, PdfSource } from "./pdf-source";

/** The facts of one PDF. No title, author or date of the file; the Producer/Creator string only as `producer` (decision D). */
export interface PdfDocumentFacts {
  pages: number;
  /** What the file WRITES as its producer (its Producer, else its Creator), as written — « Xerox PrimeLink(TM) ». Absent when it
   *  writes none: never a placeholder (Mikolaj, 02/10/2026). The tool LABEL below stays ours. */
  producer?: string;
  /** Files attached to the document, and digital signatures it carries (counted, never read nor verified). Absent at zero. */
  attachedFiles?: number;
  signatures?: number;
  /** 0-based pages with NO text at all (a scan), ascending. */
  scannedPageIndices?: number[];
  /** 0-based pages whose text is an invisible OCR layer under a full-page scan, ascending: digital pages, named for the card. */
  invisibleTextPageIndices?: number[];
  pdfVersion?: string;
  /** Absent when the file names no tool at all (nothing to say); `other` when it names one we do not know. */
  tool?: PdfToolLabel;
  toolVersion?: string;
  /** The file declares a structure that carries content (our reader finds a content leaf on some page). */
  tagged: boolean;
  linearized?: true;
  form?: true;
}

interface ToolRule {
  label: Exclude<PdfToolLabel, "other">;
  /** Tested against the Creator, then the Producer: the first rule that matches decides. */
  matches: RegExp;
  /** Captures the version when the string carries one; each number is bounded to 4 digits and `PDF_TOOL_VERSION_MAX_CHARS` cuts the whole, so a hostile string cannot widen the facts. */
  version?: RegExp;
}

/** `prefix` followed by a captured version of 1 to `extraGroups + 1` dotted numbers (each bounded to 4 digits, not followed by a digit). */
const dottedVersion = (prefix: string, extraGroups: number): RegExp =>
  new RegExp(String.raw`${prefix}(\d{1,4}(?:\.\d{1,4}){0,${extraGroups}})(?!\d)`, "i");

/** THE TABLE WE HOLD. The upstream string is read here to CLASSIFY and is then dropped
 *  (CLAUDE.md, provenance rule): only a label and a captured version leave. A string outside the
 *  table is « another tool » — ugly and visible rather than wrong. Patterns come from the real
 *  fixtures (`pdf-facts.fixtures.test.ts` quotes each string). The Creator is tried first: it names
 *  the authoring tool, the Producer often only the converter (Ghostscript, Distiller). */
export const TOOL_TABLE: readonly ToolRule[] = [
  { label: "powerpoint", matches: /PowerPoint/i, version: /PowerPoint\W+(365|\d{4})\b/i },
  { label: "word", matches: /\bWord\b/i, version: /Word\W+(?:(?:for|pour)\W+Microsoft\W+)?(365|\d{4})\b/i },
  { label: "libreoffice", matches: /LibreOffice/i, version: /LibreOffice\s+(\d{1,2}(?:\.\d{1,2})?)/i },
  { label: "google", matches: /Google Docs/i },
  { label: "canva", matches: /^Canva\b/i },
  { label: "reportlab", matches: /ReportLab/i },
  { label: "pages", matches: /^Pages$/i },
  { label: "indesign", matches: /InDesign/i, version: /InDesign\s+(CS\d{1,2}|\d{4})(?!\d)/i },
  { label: "pdflib", matches: /^pdf-lib\b/i },
  // After the authoring tools above: a converter or a library only names the tool when nothing authored the file.
  { label: "itext", matches: /iText/i, version: dottedVersion(String.raw`iText\W*(?:Sharp\W*|Core\W*)?`, 3) },
  { label: "msprint", matches: /Microsoft\W+Print To PDF/i },
  { label: "skia", matches: /Skia\/PDF/i, version: /Skia\/PDF\s+(m\d{1,4})(?!\d)/i },
  { label: "wkhtmltopdf", matches: /wkhtmltopdf/i, version: dottedVersion(String.raw`wkhtmltopdf\s+`, 2) },
  { label: "prince", matches: /^Prince\b/i, version: /^Prince\s+(\d{1,4}(?:\.\d{1,4})?)(?!\d)/i },
  { label: "cairo", matches: /^cairo\b/i, version: dottedVersion(String.raw`^cairo\s+`, 2) },
  { label: "ghostscript", matches: /Ghostscript/i, version: dottedVersion(String.raw`Ghostscript\s+`, 2) },
  { label: "quartz", matches: /Quartz PDFContext/i },
  { label: "adobepdf", matches: /Adobe PDF Library|Acrobat Distiller/i },
  { label: "fpdf", matches: /^FPDF\b/i, version: dottedVersion(String.raw`^FPDF\s+`, 2) },
  { label: "tcpdf", matches: /^TCPDF\b/i, version: dottedVersion(String.raw`^TCPDF\s+`, 2) },
  { label: "mpdf", matches: /^mPDF\b/i, version: dottedVersion(String.raw`^mPDF\s+`, 2) },
  { label: "pdfsharp", matches: /PDFsharp/i, version: dottedVersion(String.raw`PDFsharp\s+`, 2) },
  { label: "fop", matches: /Apache FOP/i, version: dottedVersion(String.raw`FOP\s+(?:Version\s+)?`, 2) },
];

/** The tool a Producer/Creator pair names. Pure; both strings are read to classify and dropped. */
export function classifyPdfTool(creator: string | undefined, producer: string | undefined): { tool?: PdfToolLabel; toolVersion?: string } {
  const strings = [creator, producer].map((s) => (typeof s === "string" ? s.trim() : "")).filter((s) => s.length > 0);
  if (strings.length === 0) return {};
  for (const rule of TOOL_TABLE) {
    const hit = strings.find((s) => rule.matches.test(s));
    if (hit === undefined) continue;
    // The version may sit in the other string (Creator « Microsoft Word », Producer « Microsoft Word 2016 »).
    const version = rule.version === undefined ? undefined : strings.map((s) => rule.version!.exec(s)?.[1]).find((v) => v !== undefined);
    return { tool: rule.label, ...(version !== undefined && version.length <= PDF_TOOL_VERSION_MAX_CHARS ? { toolVersion: version } : {}) };
  }
  return { tool: "other" };
}

/** The longest tool version the card keeps (« 5.5.13.2 », « CS6 », « m120 »): the facts stay under their 1 KiB.
 *  Starting value to calibrate: the longest version the table captures in the fixtures is 9 characters. */
export const PDF_TOOL_VERSION_MAX_CHARS = 16;

const PDF_VERSION = /^\d\.\d$/;

/** The longest producer the card keeps, « … » included: the facts stay under their 1 KiB (`DOCUMENT_FACTS_MAX_BYTES`).
 *  Starting value to calibrate: the longest producers read in the fixtures run to about 60 characters. */
export const PRODUCER_MAX_CHARS = 80;

/** Control characters, bidirectional controls (U+202A-202E, U+2066-2069, U+200E/F, U+061C) and zero-width ones
 *  (U+200B-200D, U+2060, U+FEFF): the file writes the producer, the dashboard shows it, so none may reorder or hide text. */
const HIDDEN_CONTROLS = /[\p{Cc}\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C\u200B-\u200D\u2060\uFEFF]/gu;

/** The producer the file writes: its Producer, else its Creator, read to be shown and only bounded (control, bidirectional and zero-width characters
 *  out, blanks folded, cut at `PRODUCER_MAX_CHARS`). Undefined when the file writes none. */
export function declaredProducer(creator: string | undefined, producer: string | undefined): string | undefined {
  for (const raw of [producer, creator]) {
    if (typeof raw !== "string") continue;
    const text = collapseBlanks(raw.replace(HIDDEN_CONTROLS, ""));
    if (text.length === 0) continue;
    return text.length > PRODUCER_MAX_CHARS ? `${text.slice(0, PRODUCER_MAX_CHARS - 1)}…` : text;
  }
  return undefined;
}

/** The facts of a document read once: the info `readPdfSource` kept, the tagging of its pages, and which pages the layout
 *  found to be scans or invisible text (known only after the pages are laid out: `pdf.ts` passes them). */
export function describePdf(source: PdfSource, kinds: { scanned: readonly number[]; invisibleText: readonly number[] } = { scanned: [], invisibleText: [] }): PdfDocumentFacts {
  const info: PdfDocumentInfo = source.info ?? {};
  const { tool, toolVersion } = source.info === undefined ? {} : classifyPdfTool(info.creator, info.producer);
  const producer = declaredProducer(info.creator, info.producer);
  return {
    pages: source.pages.length,
    ...(producer !== undefined ? { producer } : {}),
    ...(info.attachedFiles !== undefined ? { attachedFiles: info.attachedFiles } : {}),
    ...(info.signatures !== undefined ? { signatures: info.signatures } : {}),
    scannedPageIndices: [...kinds.scanned],
    invisibleTextPageIndices: [...kinds.invisibleText],
    ...(info.pdfVersion !== undefined && PDF_VERSION.test(info.pdfVersion) ? { pdfVersion: info.pdfVersion } : {}),
    ...(tool !== undefined ? { tool } : {}),
    ...(toolVersion !== undefined ? { toolVersion } : {}),
    tagged: source.pages.some((page) => page.declaredOrder !== undefined),
    ...(info.linearized === true ? { linearized: true as const } : {}),
    ...(info.form === true ? { form: true as const } : {}),
  };
}
