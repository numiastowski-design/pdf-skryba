/**
 * A PDF image that cannot be obtained is still left out of the page, but never silently (06/10/2026, option C): the page's
 * figures count every LOST PLACEMENT by cause — `slow` (pdf.js did not deliver the object in time; a case that went with pdf.js, removed 01/11/2026) or `unreadable` (every other way) —
 * and `extractPdf` turns the total into one `{ kind: "pdf-image-unread", slow, unreadable }` document notice.
 *
 * Interface assumed (to be implemented):
 *  - `PdfSourcePage.imageFailure(name): "slow" | "unreadable" | undefined` — why our reader has no pixels under that object name (`slow` is the pdf.js timeout, gone with it):
 *    "slow" when `awaitImageObject` resolved on its timer, "unreadable" when the object arrived but `readImage` still gives
 *    `undefined`, `undefined` when `readImage` works.
 *  - `PageFigures.lost(): { slow: number; unreadable: number }` — placements lost so far on this page, counted when a placed
 *    candidate's `read` returns `undefined` for good (both readers failed). A candidate pdf-lib OR our reader reads is never counted.
 * The end-to-end half (images with no `ref`, the document notice) lived in `pdf-image-unread.pdfjs.test.ts` (deleted, see git history) (gone with pdf.js).
 */
import { describe, expect, it } from "vitest";
import { MAX_NOTICE_IMAGE_PLACES } from "doc-ir/internal";
import type { PictureRefusal } from "doc-ir";
import type { LostPlace } from "./pdf-model";
import { emptyExtractionCost } from "./extraction-cost";
import { createImageStore } from "./pdf-image-store";
import { extractPdf, pdfImageUnreadNotices } from "./pdf";
import { pageFigures } from "./pdf-page-figures";
import { readPdfSource, type PdfSource, type PdfSourcePage, type PdfTextRun } from "./pdf-source";
import type { EmbeddedImageReader } from "./pdf-embedded-images";
import { detectPdfPageSignals, type BlockImage } from "./pdf-table-detector";

const box = (name: string, ref: string, xMin = 0): BlockImage => ({
  xMin,
  xMax: xMin + 100,
  yMin: 0,
  yMax: 100,
  ref,
  name,
  drawnWidth: 100,
  artifact: false,
});

type Pixels = { width: number; height: number; format: "gray-1" | "rgb-24" | "rgba-32"; data: ArrayLike<number> };

/** A page source reduced to what `pageFigures` asks of it. */
const sourceOf = (
  pixels: Record<string, Pixels | undefined>,
  failures: Record<string, "slow" | "unreadable" | undefined> = {},
  whys: Record<string, PictureRefusal | undefined> = {},
): PdfSourcePage =>
  ({
    readImage: (name: string) => pixels[name],
    imageRef: () => undefined,
    imageFailure: (name: string) => failures[name],
    imageRefusal: (name: string) => whys[name],
  }) as unknown as PdfSourcePage;

const figuresOf = (blockImages: BlockImage[], source: PdfSourcePage, readEmbedded?: EmbeddedImageReader) => {
  const store = createImageStore();
  const figures = pageFigures(store, emptyExtractionCost(), {
    source,
    blockImages,
    readEmbedded,
  });
  return { figures, store };
};
const readAll = (figures: ReturnType<typeof figuresOf>["figures"]) => figures.candidates.map((c) => c.read());
const lostOf = (figures: ReturnType<typeof figuresOf>["figures"]) => figures.lost();

describe("pageFigures counts the placements it could not read, by cause", () => {
  it("both readers failing is one unreadable placement", () => {
    const { figures } = figuresOf([box("img_1", "5R")], sourceOf({}), () => undefined);
    expect(readAll(figures)).toEqual([undefined]);
    expect(lostOf(figures)).toEqual({ slow: 0, unreadable: 1, places: [{ id: "5R", why: "bytes" }] });
  });

  it("🔴 a placement with no PDF object is named by its order on the page, never by the resource name the file wrote (review 06/11/2026)", () => {
    const { figures } = figuresOf(
      [box("Logo_Client", ""), box("Other_Client_Name", "")],
      sourceOf({}),
      () => undefined,
    );
    readAll(figures);
    const { places } = lostOf(figures);
    expect(places.map((p) => p.id)).toEqual(["#1", "#2"]);
    expect(JSON.stringify(places)).not.toContain("Client");
  });

  it("pdf-lib abstaining while pdf.js timed out is one SLOW placement", () => {
    const { figures } = figuresOf([box("img_1", "5R")], sourceOf({}, { img_1: "slow" }), () => undefined);
    readAll(figures);
    expect(lostOf(figures)).toEqual({ slow: 1, unreadable: 0, places: [{ id: "5R", why: "bytes" }] });
  });

  it("the same object placed twice and lost counts twice", () => {
    const { figures } = figuresOf(
      [box("img_1", "5R", 0), box("img_1", "5R", 200)],
      sourceOf({}, { img_1: "slow" }),
      () => undefined,
    );
    readAll(figures);
    expect(lostOf(figures)).toEqual({
      slow: 2,
      unreadable: 0,
      places: [
        { id: "5R", why: "bytes" },
        { id: "5R", why: "bytes" },
      ],
    });
  });

  it("slow and unreadable in the same page, next to a readable image that stays on the page", () => {
    const readable = { bytes: new Uint8Array([9, 9, 9]), mimeType: "image/jpeg" as const, width: 1, height: 1 };
    const { figures, store } = figuresOf(
      [box("img_slow", "5R"), box("img_broken", "6R"), box("img_ok", "7R")],
      sourceOf({}, { img_slow: "slow", img_broken: "unreadable" }),
      (ref) => (ref === "7R" ? readable : undefined),
    );
    const blocks = readAll(figures);
    expect(blocks.map((b) => b?.length ?? 0)).toEqual([0, 0, 1]);
    figures.place(blocks.flatMap((b) => b ?? []));
    expect(store.images()).toHaveLength(1);
    expect(lostOf(figures)).toEqual({
      slow: 1,
      unreadable: 1,
      places: [
        { id: "5R", why: "bytes" },
        { id: "6R", why: "bytes" },
      ],
    });
  });

  it("🔴 the same pixels placed twice are encoded to PNG ONCE (review 06/11/2026: no cache, each placement recompressed)", () => {
    let reads = 0;
    const pixels = {
      width: 2,
      height: 2,
      format: "rgb-24" as const,
      get data() {
        reads += 1;
        return new Uint8Array(12);
      },
    };
    const { figures } = figuresOf(
      [box("img_1", "5R", 0), box("img_1", "5R", 200)],
      sourceOf({ img_1: pixels }),
      () => undefined,
    );
    const [first] = figures.candidates.map((c) => c.read());
    const afterFirst = reads;
    figures.candidates[1]!.read();
    expect(first).toHaveLength(1);
    expect(afterFirst).toBeGreaterThan(0);
    expect(reads).toBe(afterFirst);
  });

  it("a PNG that cannot be encoded (pixels do not fill the declared size) is unreadable", () => {
    const short: Pixels = { width: 2, height: 2, format: "rgb-24", data: [1, 2, 3] };
    const { figures } = figuresOf([box("img_1", "5R")], sourceOf({ img_1: short }), () => undefined);
    expect(readAll(figures)).toEqual([undefined]);
    expect(lostOf(figures)).toEqual({ slow: 0, unreadable: 1, places: [{ id: "5R", why: "bytes" }] });
  });

  it("pdf-lib succeeding while pdf.js was slow is NOT a loss", () => {
    const { figures } = figuresOf([box("img_1", "5R")], sourceOf({}, { img_1: "slow" }), () => ({
      bytes: new Uint8Array([1]),
      mimeType: "image/jpeg" as const,
      width: 1,
      height: 1,
    }));
    expect(readAll(figures)[0]).toHaveLength(1);
    expect(lostOf(figures)).toEqual({ slow: 0, unreadable: 0, places: [] });
  });

  it("with pdf-lib unavailable altogether, a pdf.js timeout is still counted slow", () => {
    const { figures } = figuresOf([box("img_1", "5R")], sourceOf({}, { img_1: "slow" }), undefined);
    readAll(figures);
    expect(lostOf(figures)).toEqual({ slow: 1, unreadable: 0, places: [{ id: "5R", why: "bytes" }] });
  });
});

// 🔴 A STENCIL MASK (`/ImageMask true`) IS A PICTURE WITH NO COLOUR OF ITS OWN (03/11/2026: « branche-le »).
// It says « paint the current fill colour here, leave the page showing there », one bit per dot — a monochrome logo, a
// stamp, a rule. Until that day it left the page in SILENCE: no decoder read one and no path even looked at
// `paintImageMaskXObject`, so the stamp was neither published nor counted. pdf.js did not publish them either (it named
// the operator, which is how we knew the case exists, but our box recording never took it — verified in the history).
// The documents are built here because the census found ZERO stencil over the 57 fixtures and the 251 documents of the
// corpus, and a census that never saw a positive case cannot tell « there are none » from « the probe is blind ».
describe("a stencil mask is published in the colour the page paints it with", () => {
  /** An 8 × 8 chequerboard stencil drawn at 64 × 64 points under a paragraph. `colour` is the fill colour set before
   *  the painting, `"unconvertible"` one set in a space we do not read (`scn`), and `undefined` none at all. */
  const stencilPdf = async (
    colour: readonly [number, number, number] | "unconvertible" | undefined,
    second?: readonly [number, number, number],
  ): Promise<Uint8Array> => {
    const lib = await import("@cantoo/pdf-lib");
    const { PDFDocument, PDFName, PDFNumber, PDFOperator, PDFOperatorNames, PDFRawStream, StandardFonts } = lib;
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText("A paragraph above the stamp, long enough to be read as a paragraph.", {
      x: 20,
      y: 260,
      size: 11,
      font,
    });
    const rows = Uint8Array.from([
      0b10101010, 0b01010101, 0b10101010, 0b01010101, 0b10101010, 0b01010101, 0b10101010, 0b01010101,
    ]);
    const dict = doc.context.obj({
      Type: "XObject",
      Subtype: "Image",
      Width: 8,
      Height: 8,
      BitsPerComponent: 1,
      ImageMask: true,
      Length: rows.length,
    });
    page.node.setXObject(PDFName.of("Stamp"), doc.context.register(PDFRawStream.of(dict, rows)));
    const setColour =
      colour === undefined
        ? []
        : colour === "unconvertible"
          ? [PDFOperator.of(PDFOperatorNames.NonStrokingColorN, [PDFNumber.of(0.5)])]
          : [lib.setFillingRgbColor(...colour)];
    page.pushOperators(
      lib.pushGraphicsState(),
      ...setColour,
      lib.concatTransformationMatrix(64, 0, 0, 64, 40, 120),
      lib.drawObject("Stamp"),
      lib.popGraphicsState(),
    );
    if (second !== undefined) {
      page.pushOperators(
        lib.pushGraphicsState(),
        lib.setFillingRgbColor(...second),
        lib.concatTransformationMatrix(64, 0, 0, 64, 160, 120),
        lib.drawObject("Stamp"),
        lib.popGraphicsState(),
      );
    }
    return doc.save();
  };

  /** The stencil's pixels as the boundary gives them: RGBA, the colour where it paints, transparent elsewhere. */
  const stencilPixels = async (bytes: Uint8Array) =>
    (await readPdfSource(bytes, { wantOps: () => true })).pages[0]!.readImage("Stamp") as
      { width: number; height: number; format: string; data: ArrayLike<number> } | undefined;

  it("painted in red, it is published, and its pixels carry THAT red — a point on two, the others transparent", async () => {
    const bytes = await stencilPdf([0.8, 0.1, 0.1]);
    const pixels = (await stencilPixels(bytes))!;
    expect({ width: pixels.width, height: pixels.height, format: pixels.format }).toEqual({
      width: 8,
      height: 8,
      format: "rgba-32",
    });
    // `/Decode [0 1]` is the default (§8.9.5.2): a sample of 0 PAINTS. The first row is 0b10101010, so the odd dots paint.
    expect([0, 1, 2, 3].map((i) => [...Array.from({ length: 4 }, (_, c) => pixels.data[i * 4 + c])])).toEqual([
      [0, 0, 0, 0],
      [204, 26, 26, 255],
      [0, 0, 0, 0],
      [204, 26, 26, 255],
    ]);
    let painted = 0;
    for (let i = 0; i < 64; i += 1) if (pixels.data[i * 4 + 3] === 255) painted += 1;
    expect(painted).toBe(32);
    const result = await extractPdf(bytes);
    expect(result.images ?? []).toHaveLength(1);
    expect(result.notices).toBeUndefined();
    expect(result.pages[0]?.map((block) => block.kind)).toEqual(["paragraph", "image"]);
  });

  it("🔴 the same stencil painted twice in two colours comes out twice, each in ITS colour (review 06/11/2026)", async () => {
    const result = await extractPdf(await stencilPdf([1, 0, 0], [0, 0, 1]));
    const images = result.images ?? [];
    expect(images).toHaveLength(2);
    const sources = images.map((image) => Buffer.from((image as { bytes: Uint8Array }).bytes).toString("hex"));
    expect(new Set(sources).size).toBe(2);
  });

  it("painted with NO colour operator at all, it is BLACK: §8.6.8, the initial colour of a page", async () => {
    const pixels = (await stencilPixels(await stencilPdf(undefined)))!;
    expect(Array.from({ length: 4 }, (_, c) => pixels.data[4 + c])).toEqual([0, 0, 0, 255]);
  });

  it("painted in a colour we do not convert (`scn`), it is NOT published: counted and named instead, cause `mask`", async () => {
    // Ugly and visible rather than wrong and invisible: keeping the last colour we understood would publish a stamp in
    // a colour the document never asked for.
    const result = await extractPdf(await stencilPdf("unconvertible"));
    expect(result.images ?? []).toEqual([]);
    expect(result.notices).toEqual([
      { kind: "pdf-image-unread", slow: 0, unreadable: 1, places: [{ page: 1, id: "#1", why: "mask" }], more: 0 },
    ]);
    // The resource name is written by the file: it is client content, and no notice carries it (review 06/11/2026).
    expect(JSON.stringify(result.notices)).not.toContain("Stamp");
  });
});

// Review of 06/10/2026: on a scan read by the AI, a page whose digital blocks the AI's text replaced loses nothing:
// its images were never going to be published. Only the pages kept as digital count.
describe("pdfImageUnreadNotices: one notice, from the pages kept as digital only", () => {
  const lossByPage = new Map<number, { slow: number; unreadable: number; places: LostPlace[] }>([
    [0, { slow: 1, unreadable: 0, places: [{ id: "5R", why: "codec" }] }],
    [
      1,
      {
        slow: 0,
        unreadable: 2,
        places: [
          { id: "7R", why: "mask" },
          { id: "Im3", why: "bytes" },
        ],
      },
    ],
    [2, { slow: 0, unreadable: 0, places: [] }],
  ]);

  // A count alone (« 1 unreadable ») gives nowhere to look. A PLACE is a page number and a technical id (the PDF object, else the resource name): no
  // client content at all, the same rule as a lost word, which is named with its place or not reported.
  it("sums every page when none was replaced by the AI, and NAMES each lost placement with its page", () => {
    expect(pdfImageUnreadNotices(lossByPage, new Set())).toEqual([
      {
        kind: "pdf-image-unread",
        slow: 1,
        unreadable: 2,
        places: [
          { page: 1, id: "5R", why: "codec" },
          { page: 2, id: "7R", why: "mask" },
          { page: 2, id: "Im3", why: "bytes" },
        ],
        more: 0,
      },
    ]);
  });

  it("names at most MAX_NOTICE_IMAGE_PLACES places and counts the rest in `more`", () => {
    const places = Array.from({ length: MAX_NOTICE_IMAGE_PLACES + 2 }, (_, i) => ({
      id: `${i}R`,
      why: "bytes" as const,
    }));
    const many = new Map([[3, { slow: 0, unreadable: places.length, places }]]);
    const notice = pdfImageUnreadNotices(many, new Set())![0]! as { places: readonly unknown[]; more: number };
    expect(notice.places).toHaveLength(MAX_NOTICE_IMAGE_PLACES);
    expect(notice.more).toBe(2);
  });

  it("leaves out the pages the AI's text replaced", () => {
    expect(pdfImageUnreadNotices(lossByPage, new Set([1]))).toEqual([
      { kind: "pdf-image-unread", slow: 1, unreadable: 0, places: [{ page: 1, id: "5R", why: "codec" }], more: 0 },
    ]);
  });

  it("carries no notice when every page with a loss was replaced", () => {
    expect(pdfImageUnreadNotices(lossByPage, new Set([0, 1]))).toBeUndefined();
  });
});

// A page with no text in a document with text is published with its pictures (05/10/2026; defect of 07/10/2026): the
// detector sorts them against the DOCUMENT's body size (the page has none) and counts the ones our reader gave no object for (pdf.js, formerly), by
// cause, as on any page. No real fixture has such a page with an unreadable picture (Dominion-Saw-Works carries an OCR layer: a
// scan), hence a stub source here: operators as `walkPage` reads them, no PDF.
describe("detectPdfPageSignals on a page with no text", () => {
  const run = (text: string, fontSize: number): PdfTextRun => ({
    text,
    x: 50,
    y: 700,
    width: 100,
    height: fontSize,
    fontSize,
    matrix: { a: 1, b: 0, c: 0, d: 1, e: 50, f: 700 },
    fontId: "f1",
    weight: "normal",
    rotated: false,
    hasEOL: false,
    dir: "ltr",
    markedContentId: undefined,
    artifact: false,
  });
  /** A picture of `height` points, drawn at (50, 100) through its matrix. */
  const picture = (name: string, height: number) => [
    { op: "save", args: null },
    { op: "transform", args: { a: 400, b: 0, c: 0, d: height, e: 50, f: 100 } },
    { op: "paintImageXObject", args: [name] },
    { op: "restore", args: null },
  ];
  const page = (
    runs: PdfTextRun[],
    ops: { op: string; args: unknown }[],
    refs: Record<string, string | undefined>,
    failures: Record<string, "slow" | "unreadable" | undefined> = {},
  ): PdfSourcePage =>
    ({
      width: 595,
      height: 842,
      runs,
      hasText: runs.some((r) => r.text.trim() !== ""),
      ops,
      glyphs: [],
      readImage: () => undefined,
      imageRef: (name: string) => refs[name],
      imageFailure: (name: string) => failures[name],
      imageRefusal: (name: string) => (refs[name] === undefined ? ("absent" as const) : undefined),
    }) as unknown as PdfSourcePage;
  const sourceOf = (...pages: PdfSourcePage[]): PdfSource => ({ pages, document: {} as PdfSource["document"] });
  const textPage = page([run("Body text of the document", 11)], [], {});

  it("its tall picture is a block image, keyed by its PDF object", async () => {
    const signals = await detectPdfPageSignals(
      new Uint8Array(),
      sourceOf(textPage, page([], picture("img_1", 300), { img_1: "40R" })),
    );
    expect(signals.blockImagesByPage.get(1)?.map((b) => [b.name, b.ref, b.yMax - b.yMin])).toEqual([
      ["img_1", "40R", 300],
    ]);
    expect(signals.droppedImagesByPage.get(1)).toBeUndefined();
  });

  it("a picture our reader gave no object for is counted dropped, by cause, AND named by its order on the page, never by its resource name (client content)", async () => {
    const signals = await detectPdfPageSignals(
      new Uint8Array(),
      sourceOf(
        textPage,
        page([], [...picture("img_1", 300), ...picture("img_2", 300)], {}, { img_1: "unreadable", img_2: "slow" }),
      ),
    );
    expect(signals.blockImagesByPage.get(1)).toBeUndefined();
    // The order and not an object: no object is precisely why these two are dropped.
    expect(signals.droppedImagesByPage.get(1)).toEqual({
      slow: 1,
      unreadable: 1,
      places: [
        { id: "#1", why: "absent" },
        { id: "#2", why: "absent" },
      ],
    });
  });

  // A marker is placed before a word of its line (`pdf-page-markers.ts#markerBefore`): this page has none, so a small picture
  // sorted as a marker was neither published nor counted. Ugly and visible rather than wrong and invisible: every picture of
  // a page without text is a block, however small (07/10/2026).
  it("a picture no taller than twice the document's body size is still a block, never a marker", async () => {
    const signals = await detectPdfPageSignals(
      new Uint8Array(),
      sourceOf(textPage, page([], picture("rule", 1), { rule: "41R" })),
    );
    expect(signals.blockImagesByPage.get(1)?.map((b) => [b.name, b.ref])).toEqual([["rule", "41R"]]);
    expect(signals.inlineImagesByPage.get(1)).toBeUndefined();
    expect(signals.droppedImagesByPage.get(1)).toBeUndefined();
  });

  // The same « no text » as the scanned-page stage and `pdf-open.ts` (counter-review, 07/10/2026): a page whose only run is a
  // space (common from Word) has no body size, and its pictures used to be skipped uncounted.
  it("a page whose only text is a space is a page without text: its picture is a block", async () => {
    const signals = await detectPdfPageSignals(
      new Uint8Array(),
      sourceOf(textPage, page([run(" ", 11)], picture("img_1", 300), { img_1: "40R" })),
    );
    expect(signals.blockImagesByPage.get(1)?.map((b) => [b.name, b.ref])).toEqual([["img_1", "40R"]]);
  });

  it("a page whose operators were not named (a scan) gives nothing and counts nothing", async () => {
    const signals = await detectPdfPageSignals(new Uint8Array(), sourceOf(page([], [], {}), page([], [], {})));
    expect([...signals.blockImagesByPage.keys(), ...signals.droppedImagesByPage.keys()]).toEqual([]);
  });
});
