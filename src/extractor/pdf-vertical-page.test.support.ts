/** Builds PDFs whose chosen pages lose text to a REAL trigger, no mock (16/11/2026, 17/11/2026). Each page shows one
 *  horizontal line in Helvetica; a page in `vertical` also shows two letters in a Type0 font encoded `Identity-V`
 *  (vertical writing), which our glyph builder refuses to place, so the WHOLE page loses its text (`unsupported`); a page
 *  in `unreadFont` also shows two codes in a Type0 font on an Adobe predefined CMap our reader does not decode
 *  (`90ms-RKSJ-H`), so only those codes are lost and the horizontal line stays (`font`); a page in `textless` shows no
 *  text at all, only a drawing, which the reader counts as a scanned page. The vertical font has no
 *  program, only a `/ToUnicode`: our reader names its glyphs from it.
 *  NOT here: what the reader does with these pages (`pdf-source.ts`, `pdf.ts#pdfTextUnreadNotices`).
 *  A TWIN, on purpose: the application's private repository holds the same code
 *  (`src/readers/pdf-vertical-page.test.support.ts`), because a public repository cannot lend it a test support. A fix
 *  to one goes to the other; the application's repository holds the two equal by a test.
 *  Called by: `pdf-text-unread.test.ts`. */

import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, StandardFonts } from "@cantoo/pdf-lib";

const TO_UNICODE =
  "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Probe def 1 begincodespacerange <0000> <FFFF> endcodespacerange " +
  "2 beginbfchar <0001> <0041> <0002> <0042> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end";

/** `pageCount` pages, each with a horizontal line; the pages whose number (1-based) is in `vertical` also write vertically. */
export async function pdfWithVerticalPages(pageCount: number, vertical: readonly number[]): Promise<Uint8Array> {
  return pdfWithUnreadPages(pageCount, { vertical });
}

/** `pageCount` pages, each with a horizontal line; `vertical` pages also write vertically, `unreadFont` pages also paint
 *  in a font our reader cannot read; `textless` pages carry no text at all, only a drawing (all 1-based). */
export async function pdfWithUnreadPages(
  pageCount: number,
  chosen: { vertical?: readonly number[]; unreadFont?: readonly number[]; textless?: readonly number[] },
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  const toUnicode = doc.context.register(doc.context.flateStream(TO_UNICODE));
  const descriptor = doc.context.register(
    doc.context.obj({
      Type: "FontDescriptor",
      FontName: "Probe",
      Flags: 4,
      FontBBox: [0, 0, 1000, 1000],
      ItalicAngle: 0,
      Ascent: 800,
      Descent: -200,
      CapHeight: 700,
      StemV: 80,
    }),
  );
  const descendant = doc.context.register(
    doc.context.obj({
      Type: "Font",
      Subtype: "CIDFontType2",
      BaseFont: "Probe",
      CIDSystemInfo: {
        Registry: PDFHexString.fromText("Adobe"),
        Ordering: PDFHexString.fromText("Identity"),
        Supplement: PDFNumber.of(0),
      },
      DW: 1000,
      FontDescriptor: descriptor,
    }),
  );
  const verticalFont = doc.context.register(
    doc.context.obj({
      Type: "Font",
      Subtype: "Type0",
      BaseFont: "Probe",
      Encoding: "Identity-V",
      DescendantFonts: [descendant],
      ToUnicode: toUnicode,
    }),
  );
  const unreadFont = doc.context.register(
    doc.context.obj({
      Type: "Font",
      Subtype: "Type0",
      BaseFont: "MS-Mincho",
      Encoding: "90ms-RKSJ-H",
      DescendantFonts: [doc.context.obj({ Type: "Font", Subtype: "CIDFontType0", BaseFont: "MS-Mincho", DW: 1000 })],
    }),
  );
  for (let number = 1; number <= pageCount; number++) {
    const page = doc.addPage([612, 792]);
    if (chosen.textless?.includes(number) === true) {
      // No text at all, only a drawing: what the reader counts as a scanned page.
      page.drawRectangle({ x: 40, y: 400, width: 300, height: 200 });
      continue;
    }
    page.drawText(`Page ${number} horizontal words`, { x: 40, y: 740, size: 12, font: helvetica });
    const fonts = page.node.Resources()!.lookup(PDFName.of("Font"), PDFDict);
    if (chosen.vertical?.includes(number) === true) {
      fonts.set(PDFName.of("FV"), verticalFont);
      page.node.addContentStream(doc.context.register(doc.context.stream("BT /FV 12 Tf 300 600 Td <00010002> Tj ET")));
    }
    if (chosen.unreadFont?.includes(number) === true) {
      fonts.set(PDFName.of("FU"), unreadFont);
      page.node.addContentStream(doc.context.register(doc.context.stream("BT /FU 12 Tf 40 500 Td <8140> Tj ET")));
    }
  }
  return doc.save();
}
