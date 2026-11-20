/**
 * Characterisation (12/10/2026): the exact source of every version pattern of the tool table. The ten patterns that
 * capture a dotted number share one fragment; this pins their text, so that building them from a factory changes nothing.
 */
import { describe, expect, it } from "vitest";
import { TOOL_TABLE } from "./pdf-facts";

const EXPECTED: readonly (readonly [string, string | undefined])[] = [
  ["powerpoint", "PowerPoint\\W+(365|\\d{4})\\b"],
  ["word", "Word\\W+(?:(?:for|pour)\\W+Microsoft\\W+)?(365|\\d{4})\\b"],
  ["libreoffice", "LibreOffice\\s+(\\d{1,2}(?:\\.\\d{1,2})?)"],
  ["google", undefined],
  ["canva", undefined],
  ["reportlab", undefined],
  ["pages", undefined],
  ["indesign", "InDesign\\s+(CS\\d{1,2}|\\d{4})(?!\\d)"],
  ["pdflib", undefined],
  ["itext", "iText\\W*(?:Sharp\\W*|Core\\W*)?(\\d{1,4}(?:\\.\\d{1,4}){0,3})(?!\\d)"],
  ["msprint", undefined],
  ["skia", "Skia\\/PDF\\s+(m\\d{1,4})(?!\\d)"],
  ["wkhtmltopdf", "wkhtmltopdf\\s+(\\d{1,4}(?:\\.\\d{1,4}){0,2})(?!\\d)"],
  ["prince", "^Prince\\s+(\\d{1,4}(?:\\.\\d{1,4})?)(?!\\d)"],
  ["cairo", "^cairo\\s+(\\d{1,4}(?:\\.\\d{1,4}){0,2})(?!\\d)"],
  ["ghostscript", "Ghostscript\\s+(\\d{1,4}(?:\\.\\d{1,4}){0,2})(?!\\d)"],
  ["quartz", undefined],
  ["adobepdf", undefined],
  ["fpdf", "^FPDF\\s+(\\d{1,4}(?:\\.\\d{1,4}){0,2})(?!\\d)"],
  ["tcpdf", "^TCPDF\\s+(\\d{1,4}(?:\\.\\d{1,4}){0,2})(?!\\d)"],
  ["mpdf", "^mPDF\\s+(\\d{1,4}(?:\\.\\d{1,4}){0,2})(?!\\d)"],
  ["pdfsharp", "PDFsharp\\s+(\\d{1,4}(?:\\.\\d{1,4}){0,2})(?!\\d)"],
  ["fop", "FOP\\s+(?:Version\\s+)?(\\d{1,4}(?:\\.\\d{1,4}){0,2})(?!\\d)"],
];

describe("TOOL_TABLE version patterns", () => {
  it("lists the same tools in the same order, each version pattern with the same source and the `i` flag", () => {
    expect(TOOL_TABLE.map((r) => [r.label, r.version?.source])).toEqual(
      EXPECTED.map(([label, source]) => [label, source]),
    );
    for (const rule of TOOL_TABLE) if (rule.version !== undefined) expect(rule.version.flags, rule.label).toBe("i");
  });
});
