/** The producer table of `pdf-facts.ts`, one synthetic public Producer/Creator string per entry
 *  (the strings are the ones each tool documents; the real-file cases are in `pdf-facts.fixtures.test.ts`). */
import { describe, expect, it } from "vitest";
import { classifyPdfTool, declaredProducer, PDF_TOOL_VERSION_MAX_CHARS, PRODUCER_MAX_CHARS } from "./pdf-facts";

const CASES: { name: string; creator?: string; producer?: string; tool: string; toolVersion?: string }[] = [
  {
    name: "iText",
    producer: "iText® 5.5.13.2 ©2000-2020 iText Group NV (AGPL-version)",
    tool: "itext",
    toolVersion: "5.5.13.2",
  },
  { name: "iText without a version", producer: "iText", tool: "itext" },
  { name: "Microsoft Print To PDF", producer: "Microsoft: Print To PDF", tool: "msprint" },
  { name: "Skia/PDF (Chrome)", creator: "Chromium", producer: "Skia/PDF m120", tool: "skia", toolVersion: "m120" },
  {
    name: "wkhtmltopdf",
    creator: "wkhtmltopdf 0.12.6",
    producer: "Qt 4.8.7",
    tool: "wkhtmltopdf",
    toolVersion: "0.12.6",
  },
  { name: "Prince", producer: "Prince 12.5 (www.princexml.com)", tool: "prince", toolVersion: "12.5" },
  { name: "cairo", producer: "cairo 1.16.0 (https://cairographics.org)", tool: "cairo", toolVersion: "1.16.0" },
  { name: "Ghostscript", producer: "GPL Ghostscript 9.55.0", tool: "ghostscript", toolVersion: "9.55.0" },
  { name: "macOS Quartz PDFContext", producer: "macOS Version 13.4 (Build 22F66) Quartz PDFContext", tool: "quartz" },
  { name: "Adobe PDF Library", producer: "Adobe PDF Library 15.0", tool: "adobepdf" },
  { name: "Acrobat Distiller", producer: "Acrobat Distiller 9.0.0 (Windows)", tool: "adobepdf" },
  { name: "FPDF", producer: "FPDF 1.81", tool: "fpdf", toolVersion: "1.81" },
  { name: "TCPDF", producer: "TCPDF 6.3.2 (http://www.tcpdf.org)", tool: "tcpdf", toolVersion: "6.3.2" },
  { name: "mPDF", producer: "mPDF 6.1", tool: "mpdf", toolVersion: "6.1" },
  { name: "PDFsharp", producer: "PDFsharp 1.50.5147 (www.pdfsharp.com)", tool: "pdfsharp", toolVersion: "1.50.5147" },
  { name: "Apache FOP", producer: "Apache FOP Version 2.6", tool: "fop", toolVersion: "2.6" },
];

describe("the producer table", () => {
  for (const c of CASES) {
    it(`recognises ${c.name}`, () => {
      const { tool, toolVersion } = classifyPdfTool(c.creator, c.producer);
      expect(tool).toBe(c.tool);
      expect(toolVersion).toBe(c.toolVersion);
    });
  }

  it("keeps an authoring tool above its converter (Creator Word, Producer Ghostscript)", () => {
    expect(classifyPdfTool("Microsoft® Word 2019", "GPL Ghostscript 9.55.0")).toEqual({
      tool: "word",
      toolVersion: "2019",
    });
  });

  it("keeps Google Docs above its Skia/PDF renderer", () => {
    expect(classifyPdfTool(undefined, "Skia/PDF m95 Google Docs Renderer")).toEqual({ tool: "google" });
  });

  it("says « other » only for a producer outside the table", () => {
    expect(classifyPdfTool(undefined, "pypdf")).toEqual({ tool: "other" });
    expect(classifyPdfTool(undefined, undefined)).toEqual({});
  });
});

// « Fun facts », decision D (02/10/2026): the producer is shown ONLY when the file writes one — the Producer, else the
// Creator — as the file writes it (bounded: the facts keep to 1 KiB).
describe("the producer the file writes", () => {
  it("is the Producer, trimmed", () => {
    expect(declaredProducer("Microsoft Word", "Xerox PrimeLink(TM)")).toBe("Xerox PrimeLink(TM)");
    expect(declaredProducer(undefined, "  pypdf \n")).toBe("pypdf");
  });

  it("falls back to the Creator when there is no Producer", () => {
    expect(declaredProducer("Scanner X", undefined)).toBe("Scanner X");
    expect(declaredProducer("Scanner X", "   ")).toBe("Scanner X");
  });

  it("is absent when the file writes none — never a placeholder", () => {
    expect(declaredProducer(undefined, undefined)).toBeUndefined();
    expect(declaredProducer("", " \t")).toBeUndefined();
  });

  it("drops control characters and is cut at its bound", () => {
    expect(declaredProducer(undefined, "Acme\u0000 \u0007Writer")).toBe("Acme Writer");
    const cut = declaredProducer(undefined, "x".repeat(500));
    expect(cut).toHaveLength(PRODUCER_MAX_CHARS);
    expect(cut?.endsWith("…")).toBe(true);
  });
});

describe("a version the file writes is captured bounded (revue 02/10/2026, L9)", () => {
  const digits = "9".repeat(5000);
  for (const producer of [
    `Ghostscript ${digits}.1`,
    `iText ${digits}`,
    `Word ${digits}`,
    `LibreOffice ${digits}`,
    `Prince 1.${digits}`,
    `Skia/PDF m${digits}`,
    `InDesign CS${digits}`,
  ]) {
    it(`never lets ${producer.slice(0, 18)}… through as a long version`, () => {
      const { toolVersion } = classifyPdfTool(undefined, producer);
      expect((toolVersion ?? "").length).toBeLessThanOrEqual(PDF_TOOL_VERSION_MAX_CHARS);
    });
  }

  it("keeps a normal four-part version whole", () => {
    expect(classifyPdfTool(undefined, "iText® 5.5.13.2 ©2000").toolVersion).toBe("5.5.13.2");
  });
});

describe("declaredProducer : bidirectional and zero-width controls never reach the dashboard", () => {
  it("strips every bidi override/isolate/mark and zero-width character", () => {
    expect(declaredProducer(undefined, "Evil\u202Ename")).toBe("Evilname");
    const hidden = [
      "\u202A",
      "\u202B",
      "\u202C",
      "\u202D",
      "\u202E",
      "\u2066",
      "\u2067",
      "\u2068",
      "\u2069",
      "\u200E",
      "\u200F",
      "\u061C",
      "\u200B",
      "\u200C",
      "\u200D",
      "\u2060",
      "\uFEFF",
    ];
    for (const ch of hidden) expect(declaredProducer(undefined, `Ac${ch}me`)).toBe("Acme");
  });

  it("leaves a normal producer, accents and a plain space unchanged", () => {
    expect(declaredProducer(undefined, "Microsoft® Word 365 — éditeur")).toBe("Microsoft® Word 365 — éditeur");
  });
});
