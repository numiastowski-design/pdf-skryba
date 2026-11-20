/**
 * A page whose glyphs cannot be built is still published without its text (the catch-all of `pdf-source.ts#readPageText`
 * stays, docs/CONCEPTION-AVIS-TEXTE-PDF.md), but the reading now SAYS it: one `pdf-text-unread` notice per closed reason,
 * pages folded into ranges, the error itself dropped. The failure is injected on chosen pages by the technique of
 * `pdf-source.degraded.test.ts`: the glyph filter throws when the page's own glyphs spell a marker.
 */
import { readFileSync } from "node:fs";

import { PDFDict, PDFDocument, PDFName, StandardFonts } from "@cantoo/pdf-lib";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ReaderError } from "doc-ir";
import { MAX_NOTICE_PAGE_RANGES } from "doc-ir/internal";
import type { DocumentNotice, PdfTextUnreadReason } from "doc-ir";
import type { VisionPort } from "doc-ir";

const state = vi.hoisted(() => ({
  /** The error thrown on a page whose glyphs spell `FAILME`, or none. */
  failure: undefined as (() => unknown) | undefined,
  maxFiltered: 100_000,
}));

vi.mock("./pdf-hidden-text", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pdf-hidden-text")>();
  return {
    ...actual,
    get MAX_FILTERED_GLYPHS() {
      return state.maxFiltered;
    },
  };
});

vi.mock("./glyph-positions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./glyph-positions")>();
  return {
    ...actual,
    filteredGlyphs: (...args: Parameters<typeof actual.filteredGlyphs>) => {
      if (
        state.failure !== undefined &&
        args[0]
          .map((glyph) => glyph.text)
          .join("")
          .includes("FAILME")
      )
        throw state.failure();
      return actual.filteredGlyphs(...args);
    },
  };
});

import { GlyphBuilderAbstention, readGlyphs } from "./glyph-positions";
import { PdfObjectsRefusal } from "./pdf-objects/refusal";
import { extractPdf, pdfTextUnreadNotices } from "./pdf";
import { textUnreadReasonOf } from "./pdf-source";
import { extractPdfWithVision } from "./pdf-scanned";
import { pdfWithUnreadPages, pdfWithVerticalPages } from "./pdf-vertical-page.test.support";

const CLIENT_MARKER = "uniqclientmarkerfromthefile";

/** Three pages; the pages whose number is in `failing` (1-based) carry the marker that makes their glyph build throw. */
const threePages = async (failing: readonly number[]): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const number of [1, 2, 3]) {
    const page = doc.addPage([612, 792]);
    page.drawText(`Page ${number} body text ${failing.includes(number) ? "FAILME" : "fine"}`, {
      x: 40,
      y: 740,
      size: 12,
      font,
    });
  }
  return doc.save();
};

const unreadOf = (notices: readonly DocumentNotice[] | undefined) =>
  (notices ?? []).filter((notice) => notice.kind === "pdf-text-unread");

describe("pdf-text-unread: the reading says which pages lost their text", () => {
  beforeEach(() => {
    state.failure = undefined;
    state.maxFiltered = 100_000;
  });

  it("witness: no page fails, no notice", async () => {
    expect(unreadOf((await extractPdf(await threePages([]))).notices)).toEqual([]);
  }, 60_000);

  it("pages 1 and 3 of 3 fail on an unexpected error: one notice, the exact pages, and nothing of the error's text", async () => {
    state.failure = () => new Error(`boom ${CLIENT_MARKER}`);
    const result = await extractPdf(await threePages([1, 3]));
    expect(unreadOf(result.notices)).toEqual([
      {
        kind: "pdf-text-unread",
        reason: "unexpected",
        count: 2,
        pages: [
          { from: 1, to: 1 },
          { from: 3, to: 3 },
        ],
        more: 0,
      },
    ]);
    expect(JSON.stringify(result.notices)).not.toContain(CLIENT_MARKER);
    expect(JSON.stringify(result.notices)).not.toContain("boom");
  }, 60_000);

  // The old code kept the message of an error of OURS (`ReaderError`) as the page's reason: the marker must not travel either.
  it.each([
    ["a ReaderError of ours", () => new ReaderError("EXTRACT_FAILED", `boom ${CLIENT_MARKER}`), "damaged"],
    ["a ReaderError bound of ours", () => new ReaderError("FILE_UNSAFE", `boom ${CLIENT_MARKER}`), "limit"],
  ] as [string, () => unknown, PdfTextUnreadReason][])(
    "%s carrying a marker in its message: classified, the message dropped",
    async (_name, make, reason) => {
      state.failure = make;
      const result = await extractPdf(await threePages([2]));
      expect(unreadOf(result.notices)).toEqual([
        { kind: "pdf-text-unread", reason, count: 1, pages: [{ from: 2, to: 2 }], more: 0 },
      ]);
      expect(JSON.stringify(result)).not.toContain(CLIENT_MARKER);
    },
    60_000,
  );

  it("the glyph bound that bites is `limit`, and three pages in a row fold into one range", async () => {
    state.maxFiltered = 3;
    const result = await extractPdf(await threePages([]));
    expect(unreadOf(result.notices)).toEqual([
      { kind: "pdf-text-unread", reason: "limit", count: 3, pages: [{ from: 1, to: 3 }], more: 0 },
    ]);
  }, 60_000);

  it("vertical writing, tagged at the throw site, is `unsupported`", async () => {
    state.failure = () => new GlyphBuilderAbstention("vertical-writing");
    const result = await extractPdf(await threePages([2]));
    expect(unreadOf(result.notices)).toEqual([
      { kind: "pdf-text-unread", reason: "unsupported", count: 1, pages: [{ from: 2, to: 2 }], more: 0 },
    ]);
  }, 60_000);

  it("a REAL trigger, no mock: pages 2 and 3 of 4 write vertically (`Identity-V`), lose all their text, and are named", async () => {
    const result = await extractPdf(await pdfWithVerticalPages(4, [2, 3]));
    expect(unreadOf(result.notices)).toEqual([
      { kind: "pdf-text-unread", reason: "unsupported", count: 2, pages: [{ from: 2, to: 3 }], more: 0 },
    ]);
    // The horizontal line of a vertical page is lost with it: the catch-all is not narrowed, the loss is said.
    expect(JSON.stringify(result.pages[1])).not.toContain("horizontal");
    expect(JSON.stringify(result.pages[0])).toContain("horizontal");
  }, 60_000);

  it("pages the AI reading replaced leave the notice; the others stay", async () => {
    state.failure = () => new Error("boom");
    // One page is sent (the page without text): one answer.
    const vision: VisionPort = {
      analyzeDocument: () => Promise.resolve([{ text: "Read by the model", confidence: 0.99 }]),
    };
    const withAi = await extractPdfWithVision(await threePages([2]), vision, { ocr: true });
    expect(unreadOf(withAi.notices)).toEqual([]);
    const without = await extractPdfWithVision(await threePages([2]), vision, { ocr: false });
    expect(unreadOf(without.notices)).toEqual([
      { kind: "pdf-text-unread", reason: "unexpected", count: 1, pages: [{ from: 2, to: 2 }], more: 0 },
    ]);
  }, 60_000);
});

// 17/11/2026: « on doit bien distinguer illisible et scan, mais on ne publie pas un fichier illisible ». An unread page is
// never a scan; a PDF where, after the reading (the AI's included), NO page gave text and at least one page is unread is
// refused as a file that could not be read; a PDF partly unread is published with its notice; a scan alone keeps its rules.
describe("a PDF no page of which could be read is refused as unreadable, never as a scan", () => {
  const notAsked: VisionPort = { analyzeDocument: () => Promise.reject(new Error("not asked")) };
  const outcomeOf = (promise: Promise<unknown>) =>
    promise.then(
      () => ({ published: true }),
      (error: unknown) =>
        error instanceof ReaderError
          ? { code: error.code, scannedPageCount: error.scannedPageCount }
          : { thrown: String(error) },
    );

  it.each([
    ["the AI off (the sync, `pdf-skryba` by default)", { ocr: false }],
    ["the AI off and scans published as images (the upload)", { ocr: false, scanAsImages: true }],
  ] as const)(
    "🔴 every page unread, %s: refused EXTRACT_FAILED, never SCANNED_PDF_NEEDS_AI_OCR",
    async (_name, opts) => {
      // Failure values: `SCANNED_PDF_NEEDS_AI_OCR` with 0 scanned pages (AI off), or published as empty tabs (upload).
      expect(await outcomeOf(extractPdfWithVision(await pdfWithVerticalPages(3, [1, 2, 3]), notAsked, opts))).toEqual({
        code: "EXTRACT_FAILED",
      });
    },
    60_000,
  );

  it("🔴 pages without any text (scans) beside unread pages, no page read: refused EXTRACT_FAILED, not published as images", async () => {
    const bytes = await pdfWithUnreadPages(3, { vertical: [1], textless: [2, 3] });
    expect(await outcomeOf(extractPdfWithVision(bytes, notAsked, { ocr: false, scanAsImages: true }))).toEqual({
      code: "EXTRACT_FAILED",
    });
    expect(await outcomeOf(extractPdfWithVision(bytes, notAsked, { ocr: false }))).toEqual({ code: "EXTRACT_FAILED" });
  }, 60_000);

  it("witness: a scan alone keeps its rules — published as images by the upload, refused « needs the AI » by the sync", async () => {
    const bytes = await pdfWithUnreadPages(3, { textless: [1, 2, 3] });
    const asImages = await extractPdfWithVision(bytes, notAsked, { ocr: false, scanAsImages: true });
    expect(asImages.scannedPages).toBe(3);
    expect(await outcomeOf(extractPdfWithVision(bytes, notAsked, { ocr: false }))).toEqual({
      code: "SCANNED_PDF_NEEDS_AI_OCR",
      scannedPageCount: 3,
    });
  }, 60_000);

  it("witness: one page read beside unread pages is published, with the notice, and no page of it counts as scanned", async () => {
    const read = await extractPdfWithVision(await pdfWithVerticalPages(3, [1, 2]), notAsked, { ocr: false });
    expect(unreadOf(read.notices)).toEqual([
      { kind: "pdf-text-unread", reason: "unsupported", count: 2, pages: [{ from: 1, to: 2 }], more: 0 },
    ]);
    expect(read.scannedPages).toBeUndefined();
  }, 60_000);

  it("🔴 the facts the file gives about itself list no unread page among its scanned pages", async () => {
    // Failure value: [0, 1], the two unread pages called scans.
    const read = await extractPdf(await pdfWithVerticalPages(3, [1, 2]));
    expect(read.docFacts.scannedPageIndices ?? []).toEqual([]);
  }, 60_000);

  it("every page unread, the AI on and reading them: published, the AI's text counts as read", async () => {
    const vision: VisionPort = {
      analyzeDocument: () => Promise.resolve([1, 2, 3].map(() => ({ text: "Read by the model", confidence: 0.99 }))),
    };
    const read = await extractPdfWithVision(await pdfWithVerticalPages(3, [1, 2, 3]), vision, { ocr: true });
    expect(JSON.stringify(read.doc)).toContain("Read by the model");
    expect(unreadOf(read.notices)).toEqual([]);
  }, 60_000);
});

describe("textUnreadReasonOf: the error is classified, then dropped", () => {
  it.each([
    [
      "the page's glyph bound (ours)",
      () => new ReaderError("FILE_UNSAFE", "the page has too many shown glyphs to be read"),
      "limit",
    ],
    ["another refusal of ours", () => new ReaderError("EXTRACT_FAILED", "x"), "damaged"],
    ["a vertical font", () => new GlyphBuilderAbstention("vertical-writing"), "unsupported"],
    ["an uncovered text operator", () => new GlyphBuilderAbstention("text-operator"), "unsupported"],
    ["a damaged object", () => new PdfObjectsRefusal("syntax"), "damaged"],
    ["a glyph budget of the object reader", () => new PdfObjectsRefusal("glyphs-too-many"), "limit"],
    ["anything native", () => new TypeError("x"), "unexpected"],
    ["a thrown string", () => "x", "unexpected"],
  ] as [string, () => unknown, PdfTextUnreadReason][])("%s", (_name, make, reason) => {
    expect(textUnreadReasonOf(make())).toBe(reason);
  });

  it("a broken INTERNAL contract of the glyph builder (a matrix not decoded upstream) is `unexpected`, never `damaged`", () => {
    // Failure value: `damaged`, what an `EXTRACT_FAILED` thrown there gave — the file is not at fault, our boundary is.
    let thrown: unknown;
    try {
      readGlyphs([{ op: "transform", args: [1, 0, 0, 1, 0, 0] }]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect(textUnreadReasonOf(thrown)).toBe("unexpected");
  });
});

describe("pdfTextUnreadNotices: the folding, a pure unit", () => {
  const unread = (pages: readonly number[], reason: PdfTextUnreadReason = "unexpected") =>
    new Map(pages.map((page) => [page, reason] as const));

  it("2 000 alternating pages: MAX_NOTICE_PAGE_RANGES ranges, the rest counted in pages", () => {
    const pages = Array.from({ length: 2_000 }, (_, i) => i * 2);
    const [notice] = pdfTextUnreadNotices(unread(pages), new Set()) ?? [];
    expect(notice).toEqual({
      kind: "pdf-text-unread",
      reason: "unexpected",
      count: 2_000,
      pages: Array.from({ length: MAX_NOTICE_PAGE_RANGES }, (_, i) => ({ from: i * 2 + 1, to: i * 2 + 1 })),
      more: 2_000 - MAX_NOTICE_PAGE_RANGES,
    });
  });

  it("2 000 pages in a row are one range", () => {
    expect(pdfTextUnreadNotices(unread(Array.from({ length: 2_000 }, (_, i) => i)), new Set())).toEqual([
      { kind: "pdf-text-unread", reason: "unexpected", count: 2_000, pages: [{ from: 1, to: 2_000 }], more: 0 },
    ]);
  });

  it("one entry per reason, in the closed order, pages in page order whatever the map's order", () => {
    const map = new Map<number, PdfTextUnreadReason>([
      [9, "unexpected"],
      [4, "limit"],
      [2, "unexpected"],
      [3, "unexpected"],
      [0, "damaged"],
    ]);
    expect(pdfTextUnreadNotices(map, new Set())).toEqual([
      { kind: "pdf-text-unread", reason: "limit", count: 1, pages: [{ from: 5, to: 5 }], more: 0 },
      { kind: "pdf-text-unread", reason: "damaged", count: 1, pages: [{ from: 1, to: 1 }], more: 0 },
      {
        kind: "pdf-text-unread",
        reason: "unexpected",
        count: 3,
        pages: [
          { from: 3, to: 4 },
          { from: 10, to: 10 },
        ],
        more: 0,
      },
    ]);
  });

  it("the replaced pages are left out, and nothing left is no notice", () => {
    expect(pdfTextUnreadNotices(unread([1, 2, 3]), new Set([2]))).toEqual([
      {
        kind: "pdf-text-unread",
        reason: "unexpected",
        count: 2,
        pages: [
          { from: 2, to: 2 },
          { from: 4, to: 4 },
        ],
        more: 0,
      },
    ]);
    expect(pdfTextUnreadNotices(unread([1]), new Set([1]))).toBeUndefined();
  });
});

// 17/11/2026: a PDF carrying an invisible OCR layer (a scan) — its unread pages are no scanned pages, and its layer, never
// published, raises no `font` notice. The layer page is the real fixture `12-Archive-OCR-Ancien.pdf` (one page).
describe("a scan with an OCR layer: unread pages are not scans, its never-published layer says no font", () => {
  const archive = () => new Uint8Array(readFileSync("fixtures/pdf/12-Archive-OCR-Ancien.pdf"));
  const notAsked: VisionPort = { analyzeDocument: () => Promise.reject(new Error("not asked")) };
  /** The PDF `first`'s pages, then `rest`'s. */
  const joined = async (first: Uint8Array, rest: Uint8Array): Promise<Uint8Array> => {
    const doc = await PDFDocument.load(first);
    const other = await PDFDocument.load(rest);
    for (const page of await doc.copyPages(other, other.getPageIndices())) doc.addPage(page);
    return doc.save();
  };
  /** The archive's layer page, also painting in mode 3 two codes of a font our reader cannot read (`90ms-RKSJ-H`). */
  const archiveWithUnreadFontInLayer = async (): Promise<Uint8Array> => {
    const doc = await PDFDocument.load(archive());
    const font = doc.context.register(
      doc.context.obj({
        Type: "Font",
        Subtype: "Type0",
        BaseFont: "MS-Mincho",
        Encoding: "90ms-RKSJ-H",
        DescendantFonts: [doc.context.obj({ Type: "Font", Subtype: "CIDFontType0", BaseFont: "MS-Mincho", DW: 1000 })],
      }),
    );
    const page = doc.getPage(0);
    const resources = page.node.Resources() ?? doc.context.obj({});
    page.node.set(PDFName.of("Resources"), resources);
    const fonts = resources.lookupMaybe(PDFName.of("Font"), PDFDict) ?? doc.context.obj({});
    resources.set(PDFName.of("Font"), fonts);
    fonts.set(PDFName.of("FU"), font);
    page.node.addContentStream(doc.context.register(doc.context.stream("BT 3 Tr /FU 12 Tf 40 300 Td <8140> Tj ET")));
    return doc.save();
  };

  it("witness: the archive is a scan by its OCR layer, one page scanned", async () => {
    expect((await extractPdf(archive())).ocrLayerPageIndices).toEqual([0]);
  }, 60_000);

  it("🔴 its unread pages count in no scanned figure: not in the refusal, not in the row", async () => {
    // Failure value: 3, every page of the scan, the two unread ones included.
    const bytes = await joined(archive(), await pdfWithVerticalPages(2, [1, 2]));
    await expect(extractPdfWithVision(bytes, notAsked, { ocr: false })).rejects.toMatchObject({
      code: "SCANNED_PDF_NEEDS_AI_OCR",
      scannedPageCount: 1,
    });
    expect((await extractPdfWithVision(bytes, notAsked, { ocr: false, scanAsImages: true })).scannedPages).toBe(1);
  }, 60_000);

  it("🔴 an unreadable font in the OCR layer of a scan raises no `font` notice: that layer is never published", async () => {
    // Failure value: the notice `font` on page 1.
    const bytes = await archiveWithUnreadFontInLayer();
    expect((await extractPdf(bytes)).ocrLayerPageIndices).toEqual([0]);
    expect(unreadOf((await extractPdf(bytes)).notices)).toEqual([]);
  }, 60_000);

  it("witness: the same unreadable font on a page of ordinary text still raises the notice", async () => {
    const result = await extractPdf(await pdfWithUnreadPages(2, { unreadFont: [2] }));
    expect(unreadOf(result.notices)).toEqual([
      { kind: "pdf-text-unread", reason: "font", count: 1, pages: [{ from: 2, to: 2 }], more: 0 },
    ]);
  }, 60_000);
});
