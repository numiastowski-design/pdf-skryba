/**
 * A PDF published as one tab per page, on real documents (docs/CONCEPTION-TECHNIQUE-PDF-ONGLETS.md §7.2): behaviours, not the
 * policy table. This file belongs to the `pdf` batch of `vitest.config.ts`: it reads PDFs with our reader.
 * NOT here: the rendered page of those tabs and its text check (one frame per page, one attachment for a repeated
 * logo), held where the page is rendered; only what the reader hands over.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PDFDocument } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";

import type { IRBlock, IRTab } from "doc-ir";
import { extractPdf } from "./pdf";
import { FakeVisionPort } from "./pdf-fake-vision.test.support";
import { extractPdfWithVision } from "./pdf-scanned";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(here, "../../fixtures", name)));
const JVMALIN = "docx-reel/02-jvmalin-guide-api-Word.pdf";
const MIXED = "pdf/05d-Dossier-Mixte.pdf";

const textOf = (b: IRBlock): string => {
  switch (b.kind) {
    case "paragraph":
    case "heading":
      return b.inlines.map((i) => i.text).join("");
    case "list":
      return b.items.flat().map(textOf).join(" ");
    case "table":
      return b.rows.flatMap((r) => r.cells.flatMap((c) => c.blocks.map(textOf))).join(" ");
    default:
      return "";
  }
};
const tabsOf = (blocks: readonly IRBlock[]): IRTab[] => {
  const only = blocks[0];
  return only?.kind === "tabs" ? only.tabs : [];
};

describe("02-jvmalin (first 15 pages) — the running header and footer stay in their tab", () => {
  it("tabs: « Guide d'intégration » and the page number are in the tab of pages 2 to 15; the furniture is not declared", async () => {
    const tabs = await extractPdf(fixture(JVMALIN), "en", { firstPages: 15 });
    expect(tabs.pages).toHaveLength(15);
    for (let page = 2; page <= 15; page++) {
      const lines = tabs.pages[page - 1]!.map((b) => textOf(b).trim());
      expect(lines, `page ${page}`).toContain("Guide d'intégration");
      expect(lines, `page ${page}`).toContain(String(page));
    }
    // The PDF path emits no table-of-contents block, so a page of tabs has none.
    expect(tabs.pages.flat().some((b) => b.kind === "toc")).toBe(false);
  });
});

describe("10-lpc-invitation-to-tender (first 15 pages) — a logo repeated on every page is one attachment, shown in every tab", () => {
  const LPC = "docx-reel/10-lpc-invitation-to-tender-Word.pdf";
  const imageRefs = (blocks: readonly IRBlock[]): string[] =>
    blocks.flatMap((b) => (b.kind === "image" ? [b.ref.sha256] : []));

  it("tabs: one stored image, referenced once in each of the 15 tabs", async () => {
    const { pages, images } = await extractPdf(fixture(LPC), "en", { firstPages: 15 });
    expect(images).toHaveLength(1);
    const sha = images![0]!.sha256;
    expect(pages.map((p) => imageRefs(p).filter((ref) => ref === sha).length)).toEqual(
      Array.from({ length: 15 }, () => 1),
    );
  });
});

describe("deliberate removals are kept per page (30-Bulletin-Fusion-Et-Couleur)", () => {
  it("each removal of the document sits in the list of ITS page", async () => {
    const bytes = fixture("pdf/30-Bulletin-Fusion-Et-Couleur.pdf");
    const tabs = await extractPdf(bytes, "en", { firstPages: 15 });
    const continuous = await extractPdf(bytes, "en", { firstPages: 15 });
    expect(tabs.textSource.deliberateRemovalsByPage).toHaveLength(tabs.pages.length);
    expect([...tabs.textSource.deliberateRemovalsByPage.flat()].sort()).toEqual(
      [...tabs.textSource.deliberateRemovals].sort(),
    );
    // Valid because this document has no removal ACROSS pages: both modes drop the same texts.
    expect(tabs.textSource.deliberateRemovals).toEqual(continuous.textSource.deliberateRemovals);
    expect(tabs.textSource.deliberateRemovals.length).toBeGreaterThan(0);
  });
});

describe("05d-Dossier-Mixte — a scanned page not read has its own tab, holding the page image", () => {
  it("AI off: tab 1 has the text, tabs 2 and 3 are one image each", async () => {
    const vision = new FakeVisionPort();
    const { doc } = await extractPdfWithVision(fixture(MIXED), vision, { ocr: false });
    const tabs = tabsOf(doc.blocks);
    expect(tabs.map((t) => t.pageNumber)).toEqual([1, 2, 3]);
    expect(tabs[0]!.blocks.some((b) => b.kind === "paragraph" || b.kind === "heading")).toBe(true);
    expect(tabs[1]!.blocks.map((b) => b.kind)).toEqual(["image"]);
    expect(tabs[2]!.blocks.map((b) => b.kind)).toEqual(["image"]);
    expect(vision.documentCallCount).toBe(0);
  });

  it("AI on: the text read lands in the tab of its page, numbering unchanged", async () => {
    const vision = new FakeVisionPort();
    vision.analyzeDocument = async (doc) =>
      Array.from({ length: (await PDFDocument.load(doc.bytes)).getPageCount() }, (_, i) => ({
        text: `ocr page ${i}`,
        confidence: 0.95,
      }));
    const { doc } = await extractPdfWithVision(fixture(MIXED), vision);
    const tabs = tabsOf(doc.blocks);
    expect(tabs.map((t) => t.pageNumber)).toEqual([1, 2, 3]);
    expect(tabs[1]!.blocks.map(textOf)).toEqual(["ocr page 0"]);
    expect(tabs[2]!.blocks.map(textOf)).toEqual(["ocr page 1"]);
  });
});

describe("a blank page with the AI on — today's behaviour, frozen", () => {
  it("fails the whole document with OCR_LOW_CONFIDENCE", async () => {
    const source = await PDFDocument.load(fixture(MIXED));
    const out = await PDFDocument.create();
    const [first] = await out.copyPages(source, [0]);
    out.addPage(first);
    out.addPage();
    const vision = new FakeVisionPort();
    vision.analyzeDocument = async () => [{ text: "", confidence: 0.95 }];
    await expect(extractPdfWithVision(await out.save(), vision)).rejects.toMatchObject({ code: "OCR_LOW_CONFIDENCE" });
  });
});
