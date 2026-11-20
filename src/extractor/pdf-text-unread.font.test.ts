/**
 * The `font` reason of `pdf-text-unread` (17/11/2026): a font whose table cannot be read gets NO stand-in table. The page
 * keeps the text of its other fonts, only the words of that font are missing, and the reading says on which pages. The
 * failure is injected where a font's table is read (`pdf-fonts/to-unicode.ts#readToUnicode` throws a NATIVE error when
 * the CMap carries a marker); the Adobe predefined CMap is a real trigger, no mock.
 */
import { PDFDict, PDFDocument, PDFHexString, PDFName, StandardFonts, type PDFPage, type PDFRef } from "@cantoo/pdf-lib";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DocumentNotice } from "doc-ir";
import type { PdfTextUnreadReason as PdfLightReason } from "../lib/pdf-light";
import type { VisionPort } from "doc-ir";

const CLIENT_MARKER = "uniqclientmarkerfromthefont";

const state = vi.hoisted(() => ({ armed: true }));

vi.mock("./pdf-fonts/to-unicode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pdf-fonts/to-unicode")>();
  return {
    ...actual,
    readToUnicode: (data: Uint8Array) => {
      if (state.armed && Buffer.from(data).toString("latin1").includes("FONTFAIL"))
        throw new TypeError("boom uniqclientmarkerfromthefont");
      return actual.readToUnicode(data);
    },
  };
});

import { extractPdf } from "./pdf";
import { extractPdfWithVision } from "./pdf-scanned";

/** A CMap that would map Q X Z J to themselves, and that carries the marker that makes its reading throw. */
const FAILING_CMAP =
  `/CIDInit /ProcSet findresource begin % FONTFAIL ${CLIENT_MARKER}\n12 dict begin begincmap 1 begincodespacerange <00> <FF> endcodespacerange ` +
  "4 beginbfchar <51> <0051> <58> <0058> <5A> <005A> <4A> <004A> endbfchar endcmap end end";

/** The letters only the unreadable font paints: none of them is in the text of the readable font. */
const LOST_LETTERS = ["Q", "X", "Z", "J"];
const KEPT_TEXT = "Kept words";

/** How the unreadable font (`/FX`) is painted on a font page. `FH` is a plain Helvetica the page also declares. */
const BODIES = {
  shown: "BT /FX 12 Tf 40 600 Td (QXZJ) Tj ET",
  "selected-only": "BT /FX 12 Tf ET",
  none: "",
  // Optional content switched OFF (ISO 32000-1 §8.11): `/MC0` names the layer the catalog turns off.
  "off-layer": "/OC /MC0 BDC BT /FX 12 Tf 40 600 Td (QXZJ) Tj ET EMC",
  // Text rendering mode 3: neither filled nor stroked.
  "invisible-mode": "BT 3 Tr /FX 12 Tf 40 600 Td (QXZJ) Tj ET",
  // EVERY glyph of the page in mode 3, readable words and unreadable ones alike: the reader keeps such a page's text
  // (`pdf-hidden-text.ts#dropsModeHidden`, the rule written for an OCR layer). No picture under it: not a scan.
  "all-invisible": "BT 3 Tr /FH 12 Tf 40 700 Td (Scanned words) Tj /FX 12 Tf 0 -40 Td (QXZJ) Tj ET",
  // The same unreadable font painted once invisible, once visible.
  "invisible-and-visible": "BT 3 Tr /FX 12 Tf 40 600 Td (QX) Tj 0 Tr 0 -40 Td (ZJ) Tj ET",
  // Filled white on the bare page.
  white: "1 1 1 rg BT /FX 12 Tf 40 600 Td (QXZJ) Tj ET 0 0 0 rg",
  // Below the smallest height a viewer shows.
  tiny: "BT /FX 0.1 Tf 40 600 Td (QXZJ) Tj ET",
  // Mode 7 (clip only) with nothing painted through it before its `Q`.
  "clip-unpainted": "q BT 7 Tr /FX 12 Tf 40 600 Td (QXZJ) Tj ET Q",
} as const;
type Shown = keyof typeof BODIES;

/** A page painting `KEPT_TEXT` in Helvetica; on `fontPages` (1-based) a second font is declared, and painted per `shown`. */
async function twoFonts(
  pageCount: number,
  fontPages: readonly number[],
  second: "failing-table" | "predefined-cmap",
  shown: Shown = "shown",
  keptOnFontPages = true,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  const plain = doc.context.register(
    doc.context.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" }),
  );
  const ocg = doc.context.register(doc.context.obj({ Type: "OCG", Name: PDFHexString.fromText("Layer") }));
  doc.catalog.set(PDFName.of("OCProperties"), doc.context.obj({ OCGs: [ocg], D: { BaseState: "ON", OFF: [ocg] } }));
  const font =
    second === "failing-table"
      ? doc.context.register(
          doc.context.obj({
            Type: "Font",
            Subtype: "Type1",
            BaseFont: "Helvetica-Bold",
            Encoding: "WinAnsiEncoding",
            ToUnicode: doc.context.register(doc.context.flateStream(FAILING_CMAP)),
          }),
        )
      : doc.context.register(
          doc.context.obj({
            Type: "Font",
            Subtype: "Type0",
            BaseFont: "MS-Mincho",
            Encoding: "90ms-RKSJ-H",
            DescendantFonts: [
              doc.context.obj({ Type: "Font", Subtype: "CIDFontType0", BaseFont: "MS-Mincho", DW: 1000 }),
            ],
          }),
        );
  for (let number = 1; number <= pageCount; number++) {
    const page = doc.addPage([612, 792]);
    const onFontPage = fontPages.includes(number);
    if (!onFontPage || keptOnFontPages)
      page.drawText(`${KEPT_TEXT} ${number}`, { x: 40, y: 740, size: 12, font: helvetica });
    if (!onFontPage) continue;
    declareFonts(page, { FX: font, FH: plain }, ocg);
    page.node.addContentStream(doc.context.register(doc.context.stream(BODIES[shown])));
  }
  return doc.save();
}

function declareFonts(page: PDFPage, fonts: Record<string, PDFRef>, layer: PDFRef): void {
  const resources = page.node.Resources() ?? page.doc.context.obj({});
  page.node.set(PDFName.of("Resources"), resources);
  const fontDict = resources.lookupMaybe(PDFName.of("Font"), PDFDict) ?? page.doc.context.obj({});
  resources.set(PDFName.of("Font"), fontDict);
  for (const [name, ref] of Object.entries(fonts)) fontDict.set(PDFName.of(name), ref);
  resources.set(PDFName.of("Properties"), page.doc.context.obj({ MC0: layer }));
}

const unreadOf = (notices: readonly DocumentNotice[] | undefined) =>
  (notices ?? []).filter((notice) => notice.kind === "pdf-text-unread");

/** The reason is published by both libraries' entry points, as `PictureRefusal` is (held by the type checker). */
const FONT_REASON: PdfLightReason = "font";

describe("pdf-text-unread, reason `font`: a font that cannot be read loses its words, and says on which pages", () => {
  beforeEach(() => {
    state.armed = true;
  });

  it("witness: the same file whose table reads is published whole, with no notice", async () => {
    state.armed = false;
    const result = await extractPdf(await twoFonts(3, [2], "failing-table"));
    expect(unreadOf(result.notices)).toEqual([]);
    expect(JSON.stringify(result.pages[1])).toContain("QXZJ");
  }, 60_000);

  it("🔴 a native error reading the table of one of two fonts: the other font's text is published, the notice says `font` on page 2", async () => {
    const result = await extractPdf(await twoFonts(3, [2], "failing-table"));
    expect(unreadOf(result.notices)).toEqual([
      { kind: "pdf-text-unread", reason: FONT_REASON, count: 1, pages: [{ from: 2, to: 2 }], more: 0 },
    ]);
    const page2 = JSON.stringify(result.pages[1]);
    expect(page2).toContain(`${KEPT_TEXT} 2`);
    // No stand-in table: not one letter of the unreadable font is published, nor invented.
    for (const letter of LOST_LETTERS) expect(page2).not.toContain(letter);
  }, 60_000);

  it("🔴 the marker in the error's message reaches no notice and no published text", async () => {
    const result = await extractPdf(await twoFonts(3, [2], "failing-table"));
    expect(unreadOf(result.notices)).toHaveLength(1);
    expect(JSON.stringify(result.notices ?? [])).not.toContain(CLIENT_MARKER);
    expect(JSON.stringify(result.notices ?? [])).not.toContain("boom");
    expect(JSON.stringify(result.pages)).not.toContain(CLIENT_MARKER);
  }, 60_000);

  it("🔴 a Type0 font on an Adobe predefined CMap we do not read (`90ms-RKSJ-H`, no mock) is `font` too", async () => {
    state.armed = false;
    const result = await extractPdf(await twoFonts(3, [1, 3], "predefined-cmap"));
    expect(unreadOf(result.notices)).toEqual([
      {
        kind: "pdf-text-unread",
        reason: "font",
        count: 2,
        pages: [
          { from: 1, to: 1 },
          { from: 3, to: 3 },
        ],
        more: 0,
      },
    ]);
    expect(JSON.stringify(result.pages[0])).toContain(`${KEPT_TEXT} 1`);
  }, 60_000);

  it.each([
    ["selected by `Tf` but never painted", "selected-only"],
    ["declared in the resources only", "none"],
  ] as [string, Shown][])(
    "a page where that font is %s: no glyph of it shown, no notice",
    async (_name, shown) => {
      const result = await extractPdf(await twoFonts(3, [2], "failing-table", shown));
      expect(unreadOf(result.notices)).toEqual([]);
    },
    60_000,
  );

  // 17/11/2026: nothing invisible in the source is published NOR expected. The `font` notice counts a glyph of the unreadable
  // font only when the reader's own filter for the published text would have kept it.
  const INVISIBLE: [string, Shown][] = [
    ["on an optional-content layer switched OFF", "off-layer"],
    ["in text rendering mode 3, beside visible text", "invisible-mode"],
    ["filled white on the bare page", "white"],
    ["below the smallest visible height, beside visible text", "tiny"],
    ["in mode 7 with nothing painted through it", "clip-unpainted"],
  ];

  it.each(INVISIBLE)(
    "witness: a READABLE font painted %s is not published (the fixture exercises the filter)",
    async (_name, shown) => {
      state.armed = false;
      const result = await extractPdf(await twoFonts(3, [2], "failing-table", shown));
      expect(JSON.stringify(result.pages[1])).toContain(`${KEPT_TEXT} 2`);
      expect(JSON.stringify(result.pages[1])).not.toContain("QXZJ");
    },
    60_000,
  );

  it.each(INVISIBLE)(
    "🔴 the unreadable font painted %s raises no notice: it would not have been published",
    async (_name, shown) => {
      // Failure value: the notice `font` on page 2, what the reading of the raw operators gave.
      const result = await extractPdf(await twoFonts(3, [2], "failing-table", shown));
      expect(unreadOf(result.notices)).toEqual([]);
    },
    60_000,
  );

  it("a page whose EVERY glyph is in mode 3 keeps its text, so the unreadable font there raises the notice", async () => {
    state.armed = false;
    const readable = await extractPdf(await twoFonts(3, [2], "failing-table", "all-invisible", false));
    // Witness: with a readable font, these mode 3 words ARE published.
    expect(JSON.stringify(readable.pages[1])).toContain("QXZJ");
    state.armed = true;
    const result = await extractPdf(await twoFonts(3, [2], "failing-table", "all-invisible", false));
    expect(unreadOf(result.notices)).toEqual([
      { kind: "pdf-text-unread", reason: "font", count: 1, pages: [{ from: 2, to: 2 }], more: 0 },
    ]);
  }, 60_000);

  it("the unreadable font painted once invisible and once visible on a page: the notice", async () => {
    const result = await extractPdf(await twoFonts(3, [2], "failing-table", "invisible-and-visible"));
    expect(unreadOf(result.notices)).toEqual([
      { kind: "pdf-text-unread", reason: "font", count: 1, pages: [{ from: 2, to: 2 }], more: 0 },
    ]);
  }, 60_000);

  it("a page whose only text is in that font, read by the AI, leaves the notice; without the AI it stays", async () => {
    const vision: VisionPort = {
      analyzeDocument: () => Promise.resolve([{ text: "Read by the model", confidence: 0.99 }]),
    };
    const bytes = await twoFonts(3, [2], "failing-table", "shown", false);
    expect(unreadOf((await extractPdfWithVision(bytes, vision, { ocr: true })).notices)).toEqual([]);
    expect(unreadOf((await extractPdfWithVision(bytes, vision, { ocr: false })).notices)).toEqual([
      { kind: "pdf-text-unread", reason: "font", count: 1, pages: [{ from: 2, to: 2 }], more: 0 },
    ]);
  }, 60_000);
});
