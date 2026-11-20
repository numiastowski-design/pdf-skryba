/**
 * The best-effort reads of `readPdfSource`: document metadata, attachment and form flags, the optional-content layers, the
 * structure tree, the weight of each run's font, the glyph and operator predicates. Every read comes from our document;
 * the glyph builder and the operator decoder are wrapped so a call can be made to throw or to add operators, per test.
 */
import { PDFDocument, PDFHexString, PDFName, PDFOperator, StandardFonts, endMarkedContent } from "@cantoo/pdf-lib";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ReaderError } from "doc-ir";
import { encodePng } from "doc-ir/internal";

const state = vi.hoisted(() => ({
  glyphFailure: undefined as string | undefined,
  maxFiltered: 100_000,
  extraOps: undefined as { op: string; args: unknown }[] | undefined,
}));

vi.mock("./pdf-ops", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pdf-ops")>();
  return {
    ...actual,
    decodeOps: (...args: Parameters<typeof actual.decodeOps>) => {
      const ops = actual.decodeOps(...args);
      return state.extraOps ? [...ops, ...state.extraOps] : ops;
    },
  };
});

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
    // `pdf-source.ts` reads the glyphs once (`readGlyphs`) then filters them: the filter is the step where the failure is injected.
    filteredGlyphs: (...args: Parameters<typeof actual.filteredGlyphs>) => {
      if (state.glyphFailure !== undefined) throw new Error(state.glyphFailure);
      return actual.filteredGlyphs(...args);
    },
  };
});

import { emptyExtractionCost } from "./extraction-cost";
import { readPdfSource } from "./pdf-source";

const HIDDEN = "uniqhiddenword";

/** Two pages: the first with a visible line and a layer that is OFF by default; the second with a visible line only. */
const layerPdf = async (): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Visible line uniqvisone", { x: 40, y: 740, size: 12, font });
  const ocg = doc.context.register(doc.context.obj({ Type: "OCG", Name: PDFHexString.fromText("Layer") }));
  doc.catalog.set(PDFName.of("OCProperties"), doc.context.obj({ OCGs: [ocg], D: { BaseState: "ON", OFF: [ocg] } }));
  page.node.Resources()!.set(PDFName.of("Properties"), doc.context.obj({ MC0: ocg }));
  page.pushOperators(PDFOperator.of("BDC" as never, [PDFName.of("OC"), PDFName.of("MC0")]));
  page.drawText(`Layer text ${HIDDEN}`, { x: 40, y: 600, size: 12, font });
  page.pushOperators(endMarkedContent());
  const second = doc.addPage([612, 792]);
  second.drawText("Second page uniqvistwo", { x: 40, y: 740, size: 12, font });
  doc.setProducer("Probe Producer");
  doc.setCreator("Probe Creator");
  return doc.save();
};

const texts = (page: { runs: readonly { text: string }[] }): string => page.runs.map((r) => r.text).join("|");

describe("readPdfSource: the best-effort reads", () => {
  let bytes: Uint8Array;
  beforeEach(async () => {
    state.glyphFailure = undefined;
    state.maxFiltered = 100_000;
    state.extraOps = undefined;
    bytes = await layerPdf();
  });

  it("witness: the real document gives its card and drops the layer that is off", async () => {
    const source = await readPdfSource(bytes);
    expect(source.info).toMatchObject({ producer: "Probe Producer", creator: "Probe Creator" });
    expect(texts(source.pages[0]!)).not.toContain(HIDDEN);
    expect(texts(source.pages[0]!)).toContain("uniqvisone");
    expect(source.pages[0]!.isLayerVisible).toBeTypeOf("function");
    expect(source.pages[1]!.isLayerVisible).toBeUndefined();
  }, 60_000);

  describe("the runs come from our glyphs, page by page", () => {
    it("witness: built from glyphs, and a run carries the font name the glyphs read", async () => {
      const source = await readPdfSource(bytes);
      expect(texts(source.pages[1]!)).toBe("Second page uniqvistwo");
      expect(source.pages[1]!.runs[0]!.fontId).toContain("Helvetica");
      expect(source.pages[1]!.runs[0]!.weight).toBe("normal");
    }, 60_000);

    it("a glyph the layer hides makes no run, ", async () => {
      const source = await readPdfSource(bytes);
      expect(texts(source.pages[0]!)).toBe("Visible line uniqvisone");
    }, 60_000);
  });

  it("the card keeps only its six fields, and the two flags only when they are true", async () => {
    // The metadata record is read from OUR document since 31/10/2026 (`pdf-document-info.ts`): we pin it on a PDF written here.
    const made = await PDFDocument.create();
    made.addPage([612, 792]);
    made.setProducer("P");
    made.setCreator("C");
    const source = await readPdfSource(await made.save());
    expect(source.info).toEqual({ producer: "P", creator: "C", pdfVersion: "1.7" });
    expect(source.info && "linearized" in source.info).toBe(false);
    expect(source.info && "form" in source.info).toBe(false);
  }, 60_000);

  it("a file our reader refuses is refused whole: there is no second reader", async () => {
    // A `startxref` that leads nowhere.
    const made = await PDFDocument.create();
    made.addPage([612, 792]);
    made.getPage(0).drawText("uniqvistwo");
    const text = Buffer.from(await made.save())
      .toString("latin1")
      .replace(/startxref\s+\d+/, "startxref\n9");
    const error = await readPdfSource(Uint8Array.from(Buffer.from(text, "latin1"))).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ReaderError);
    expect((error as ReaderError).code).toBe("EXTRACT_FAILED");
  }, 60_000);

  it("the form flag is kept when the document has a form field, and left out otherwise", async () => {
    const withForm = await PDFDocument.create();
    withForm.addPage([612, 792]);
    withForm.getForm().createTextField("name");
    expect((await readPdfSource(await withForm.save())).info).toMatchObject({ form: true });
    const plain = await PDFDocument.create();
    plain.addPage([612, 792]);
    expect((await readPdfSource(await plain.save())).info).not.toHaveProperty("form");
  }, 60_000);

  it("the attachment count: kept when positive, left out at zero", async () => {
    const attached = await PDFDocument.create();
    attached.addPage([612, 792]);
    await attached.attach(new Uint8Array([1, 2, 3]), "a.txt");
    await attached.attach(new Uint8Array([4, 5]), "b.txt");
    expect((await readPdfSource(await attached.save())).info).toMatchObject({ attachedFiles: 2 });
    const none = await PDFDocument.create();
    none.addPage([612, 792]);
    expect((await readPdfSource(await none.save())).info).not.toHaveProperty("attachedFiles");
  }, 60_000);

  it("links come from our document, on pages with text only; a page without text has none and keeps no cost", async () => {
    // Links are read from OUR document since 31/10/2026 (`pdf-links-ours.ts`): pdf.js is no longer called for
    // them. A document that our reader refuses therefore has no links, and its text is published all the same.
    const cost = emptyExtractionCost();
    const source = await readPdfSource(bytes, { cost });
    expect(texts(source.pages[1]!)).toContain("uniqvistwo");
    expect(cost).not.toHaveProperty("getAnnotations");

    const empty = await PDFDocument.create();
    empty.addPage([612, 792]);
    const noText = emptyExtractionCost();
    const emptySource = await readPdfSource(await empty.save(), { cost: noText });
    expect(emptySource.pages[0]!.links).toEqual([]);
  }, 60_000);

  it("the structure is read from our document: a page with no tree declares no order; a tagged page declares its content", async () => {
    // The tree is read from OUR document since 31/10/2026 (`pdf-structure.ts`): pdf.js is no longer called for it.
    const plain = await readPdfSource(bytes);
    expect(plain.pages.every((p) => p.declaredOrder === undefined || p.declaredOrder.length === 0)).toBe(true);
    const made = await PDFDocument.create();
    made.addPage([612, 792]);
    made.getPage(0).drawText("balisé");
    const tagged = await readPdfSource(await made.save());
    expect(tagged.pages[0]!.declaredOrder ?? []).toEqual([]);
  }, 60_000);

  it("glyphs are rebuilt only where the caller asks; a page whose rebuild fails has no glyphs and no runs, and says why", async () => {
    const plain = await readPdfSource(bytes);
    expect(plain.pages.every((p) => p.glyphs.length === 0 && !("glyphsUnavailable" in p))).toBe(true);

    const cost = emptyExtractionCost();
    const asked = await readPdfSource(bytes, { cost, wantGlyphs: () => true });
    expect(asked.pages.every((p) => p.glyphs.length > 0 && !("glyphsUnavailable" in p))).toBe(true);
    expect(cost.glyphFragments).toBe(asked.pages.reduce((n, p) => n + p.glyphs.length, 0));

    // Security review of 02/11/2026, finding 10: the reason is ours, a word of a closed list (16/11/2026). The text of a native error can carry what the
    // file chose (a property name read off a malformed dictionary), so it is read to classify and never stored.
    state.glyphFailure = "boom with a title from the client's file";
    const failedCost = emptyExtractionCost();
    const failed = await readPdfSource(bytes, { cost: failedCost, wantGlyphs: () => true });
    expect(failed.pages.map((p) => p.glyphsUnavailable)).toEqual(["unexpected", "unexpected"]);
    expect(failed.pages.every((p) => p.glyphs.length === 0 && p.runs.length === 0)).toBe(true);
    expect(failedCost.glyphFragments).toBe(0);
  }, 60_000);

  it("operators are kept where a predicate asks, and every page's are counted (our reader names them all); a predicate for glyphs implies operators", async () => {
    const cost = emptyExtractionCost();
    const none = await readPdfSource(bytes, { cost });
    expect(none.pages.every((p) => p.ops.length === 0)).toBe(true);
    expect(cost.operatorsWalked).toBeGreaterThan(0);

    const ops = emptyExtractionCost();
    const second = await readPdfSource(bytes, { cost: ops, wantOps: (i) => i === 1 });
    expect(second.pages[0]!.ops).toEqual([]);
    expect(second.pages[1]!.ops.length).toBeGreaterThan(0);
    expect(ops.operatorsWalked).toBe(cost.operatorsWalked);

    const viaGlyphs = await readPdfSource(bytes, { wantGlyphs: (i) => i === 0 });
    expect(viaGlyphs.pages[0]!.ops.length).toBeGreaterThan(0);
    expect(viaGlyphs.pages[1]!.ops).toEqual([]);
  }, 60_000);

  it("the predicates see the page index, its runs, and the runs and text flags of the whole document", async () => {
    const seen: [number, string, number, boolean[]][] = [];
    await readPdfSource(bytes, {
      wantOps: (i, runs, all, hasText) => {
        seen.push([i, runs.map((r) => r.text).join("|"), all.length, [...hasText]]);
        return false;
      },
    });
    expect(seen.map(([i, , n, flags]) => [i, n, flags])).toEqual([
      [0, 2, [true, true]],
      [1, 2, [true, true]],
    ]);
    expect(seen[1]![1]).toContain("uniqvistwo");
  }, 60_000);

  it("the opening hook sees the page count before any page is read", async () => {
    const counts: number[] = [];
    await readPdfSource(bytes, { onOpen: (n) => counts.push(n) });
    expect(counts).toEqual([2]);
  }, 60_000);

  it("the weight of each run comes from our font object: regular, bold, and a run whose font we cannot name is unknown", async () => {
    // The weight comes from OUR dictionary since 31/10/2026 (ISO 32000-1 Table 122, then the name): pdf.js no longer
    // answers. A base font without "Bold" is regular, a font with a bold name is bold.
    state.glyphFailure = undefined;
    state.extraOps = undefined;
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const regular = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    page.drawText("regular one", { x: 40, y: 700, size: 12, font: regular });
    page.drawText("bold one", { x: 40, y: 680, size: 12, font: bold });
    page.drawText("regular two", { x: 40, y: 660, size: 12, font: regular });
    const own = await doc.save();
    const resolved = (await readPdfSource(own)).pages[0]!.runs.filter((r) => r.text !== "");
    expect(resolved.map((r) => [r.text, r.weight])).toEqual([
      ["regular one", "normal"],
      ["bold one", "bold"],
      ["regular two", "normal"],
    ]);
  }, 60_000);

  it("a page past the glyph cap builds no glyphs; exactly at the cap the hidden-text filter still runs", async () => {
    const { countShownGlyphs } = await import("./pdf-hidden-text");
    const open = await readPdfSource(bytes, { wantOps: () => true });
    const shownGlyphs = countShownGlyphs(open.pages[0]!.ops);
    expect(shownGlyphs).toBeGreaterThan(10);
    state.maxFiltered = shownGlyphs;
    const atCap = await readPdfSource(bytes);
    expect(texts(atCap.pages[0]!)).not.toContain(HIDDEN);
    state.maxFiltered = shownGlyphs - 1;
    const pastCap = await readPdfSource(bytes);
    // Past the cap our reader builds no glyph at all: the page has no runs and says why.
    expect(pastCap.pages[0]!.runs).toEqual([]);
    expect(pastCap.pages[0]!.glyphsUnavailable).toBe("limit");
    expect(pastCap.pages[0]!.isLayerVisible).toBeUndefined();
  }, 60_000);

  const imagePdf = async (): Promise<Uint8Array> => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText("Pictures below", { x: 40, y: 740, size: 12, font });
    const first = await doc.embedPng(encodePng(8, 8, "rgb-24", new Uint8Array(8 * 8 * 3).fill(100))!);
    const second = await doc.embedPng(encodePng(8, 8, "rgb-24", new Uint8Array(8 * 8 * 3).fill(200))!);
    page.drawImage(first, { x: 40, y: 500, width: 100, height: 100 });
    page.drawImage(first, { x: 200, y: 500, width: 100, height: 100 });
    page.drawImage(second, { x: 40, y: 300, width: 100, height: 100 });
    return doc.save();
  };
  const imageNames = (ops: readonly { op: string; args: unknown }[]): string[] =>
    ops.filter((o) => o.op === "paintImageXObject").map((o) => String((o.args as unknown[])[0]));

  it("each paint of an image is one named operator", async () => {
    const pictures = await imagePdf();
    const read = await readPdfSource(pictures, { wantOps: () => true });
    expect(imageNames(read.pages[0]!.ops)).toHaveLength(3);
  }, 60_000);

  it("an image nobody painted is not a failure and reads as nothing", async () => {
    const pictures = await imagePdf();
    const [page] = (await readPdfSource(pictures, { wantOps: () => true })).pages;
    expect(imageNames(page!.ops)).toHaveLength(3);
    expect(page!.imageFailure("never_painted")).toBeUndefined();
    expect(page!.readImage("never_painted")).toBeUndefined();
  }, 60_000);
});
