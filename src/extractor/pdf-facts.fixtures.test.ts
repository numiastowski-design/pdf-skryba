/** The facts of a PDF read from REAL files: which tool wrote it
 *  (from OUR table, never the raw string), its PDF version, whether it is tagged. The
 *  Producer/Creator strings quoted below were read off each fixture once.
 *  NOT here: the same facts on the documents this package may not carry (Word, InDesign, Canva, Google Docs, Pages and
 *  PowerPoint exports, a Xerox scan). */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDict, PDFDocument, PDFName } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";
import { extractPdf } from "./pdf";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (path: string) => new Uint8Array(readFileSync(join(here, "../../fixtures", path)));

/** One extraction per file for the whole suite: the per-case tests, the pages test and the raw-string test all read the same
 *  PDFs, and a full extraction costs about a second each (the raw-string test alone re-ran them for 16 s). */
const extractions = new Map<string, ReturnType<typeof extractPdf>>();
const extracted = (path: string): ReturnType<typeof extractPdf> => {
  let result = extractions.get(path);
  if (result === undefined) {
    result = extractPdf(fixture(path));
    extractions.set(path, result);
  }
  return result;
};

const CASES: {
  path: string;
  strings: string;
  tool: string | undefined;
  toolVersion?: string;
  pdfVersion: string;
  tagged: boolean;
  linearized?: true;
  form?: true;
}[] = [
  {
    path: "pdf/31-Guide-Demarche-AAP-LibreOffice.pdf",
    strings: "LibreOffice 7.2 / Writer",
    tool: "libreoffice",
    toolVersion: "7.2",
    pdfVersion: "1.6",
    tagged: false,
  },
  {
    path: "pdf/05a-Rapport-Annuel-Digital.pdf",
    strings: "ReportLab PDF Library - (opensource)",
    tool: "reportlab",
    pdfVersion: "1.4",
    tagged: false,
  },
  // Outside our table: « another tool » (ugly and visible rather than wrong).
  { path: "pdf/05d-Dossier-Mixte.pdf", strings: "pypdf", tool: "other", pdfVersion: "1.4", tagged: false },
  // A Creator that is a file name of ours: classified, never carried.
  {
    path: "pdf/11-Brochure-Deux-Colonnes.pdf",
    strings: "d2c fixture generator / 11-Brochure-Deux-Colonnes.generator.mjs",
    tool: "other",
    pdfVersion: "1.7",
    tagged: false,
  },
  // No Producer, no Creator: nothing to say about the tool. (05b, the 40-page scan, is over the page cap and never reaches here.)
  {
    path: "pdf/22-Tableau-Balise-En-Tetes-Faux.pdf",
    strings: "none",
    tool: undefined,
    pdfVersion: "1.7",
    tagged: true,
  },
];

describe("the facts of a real PDF", () => {
  for (const c of CASES) {
    it(`${c.path} (${c.strings})`, async () => {
      const { docFacts } = await extracted(c.path);
      expect(docFacts, "extractPdf must hand the document's facts back").toBeDefined();
      expect(docFacts?.tool).toBe(c.tool);
      expect(docFacts?.toolVersion).toBe(c.toolVersion);
      expect(docFacts?.pdfVersion).toBe(c.pdfVersion);
      expect(docFacts?.tagged).toBe(c.tagged);
      expect(docFacts?.linearized).toBe(c.linearized);
      expect(docFacts?.form).toBe(c.form);
    });
  }

  it("tagged agrees with a second, independent reading: /StructTreeRoot WITH a /ParentTree (pdf-lib)", async () => {
    for (const c of CASES) {
      const doc = await PDFDocument.load(fixture(c.path), { ignoreEncryption: true });
      const root = doc.catalog.get(PDFName.of("StructTreeRoot"));
      const declared = root !== undefined && doc.context.lookup(root, PDFDict).has(PDFName.of("ParentTree"));
      expect(c.tagged, c.path).toBe(declared);
    }
  });

  it("counts the pages of the file", async () => {
    const { docFacts, pages } = await extracted("pdf/05d-Dossier-Mixte.pdf");
    expect(docFacts?.pages).toBe(3);
    expect(pages.length).toBe(3);
  });

  it("carries no producer when the file writes none", async () => {
    const { docFacts } = await extracted("pdf/22-Tableau-Balise-En-Tetes-Faux.pdf");
    expect(docFacts).toBeDefined();
    expect("producer" in (docFacts ?? {})).toBe(false);
  });

  it("names which pages are scans (no text), which carry an invisible text layer, in 0-based order", async () => {
    const mixed = await extracted("pdf/05d-Dossier-Mixte.pdf");
    expect(mixed.docFacts?.scannedPageIndices).toEqual([1, 2]);
    expect(mixed.docFacts?.invisibleTextPageIndices).toEqual([]);
    const layered = await extracted("pdf/12-Archive-OCR-Ancien.pdf");
    expect(layered.docFacts?.scannedPageIndices).toEqual([]);
    expect(layered.docFacts?.invisibleTextPageIndices).toEqual([0]);
  });
});

// Extension of 02/10/2026: the attached files and the digital signatures the file declares. Read by pdf.js 6.2.108 until its removal
// (`getAttachments()`: the /Names /EmbeddedFiles tree, ISO 32000-1 §7.11.4; `getSignatures()`: the /FT /Sig form fields that
// carry a signature dictionary /V, §12.7.4.5 and §12.8), now by our reader (`pdf-document-info.ts`). Real files of the pdf.js test corpus (`fixtures/pdf/pdfjs-tests/PROVENANCE.md`).
describe("attached files and digital signatures", () => {
  it("a PDF with one attached file counts it, and no signature", async () => {
    const { docFacts } = await extracted("pdf/pdfjs-tests/attachment.pdf");
    expect(docFacts?.attachedFiles).toBe(1);
    expect("signatures" in (docFacts ?? {})).toBe(false);
  });

  it("a signed PDF counts its signature, and no attached file", async () => {
    const { docFacts } = await extracted("pdf/pdfjs-tests/signed_verified.pdf");
    expect(docFacts?.signatures).toBe(1);
    expect("attachedFiles" in (docFacts ?? {})).toBe(false);
  });

  it("a plain PDF carries neither: nothing is said when it is zero", async () => {
    const { docFacts } = await extracted("pdf/05a-Rapport-Annuel-Digital.pdf");
    expect(docFacts).toBeDefined();
    expect("attachedFiles" in (docFacts ?? {})).toBe(false);
    expect("signatures" in (docFacts ?? {})).toBe(false);
  });
});
