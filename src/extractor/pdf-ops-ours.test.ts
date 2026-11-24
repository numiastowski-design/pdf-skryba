/** The operator stream read from our document (`pdf-ops-ours.ts`). The expected names and arguments are the ones pdf.js's
 *  operator list gave for the same content (before its removal): `q`→save, `cm`→transform, `Tf`→setFont with OUR font key, a form inlined
 *  between its begin and end, a group operand as `layerConfigOf` reads it. */
import { describe, expect, it } from "vitest";

import { ourOpsOfPage } from "./pdf-ops-ours";
import { openPdfObjects } from "./pdf-objects/document";

/** A PDF with one page, its content, a font, an optional-content group and a form that has its own font. */
function pdfWithForm(): Uint8Array {
  const stream = (body: string, extra = ""): string =>
    `<< /Length ${body.length}${extra} >>\nstream\n${body}\nendstream`;
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>",
    "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> /Properties << /L1 6 0 R >> /XObject << /Fm0 7 0 R >> >> /Contents 4 0 R >>",
    stream("q 1 0 0 1 5 5 cm BT /F1 12 Tf 10 20 Td (Hi) Tj ET Q 0 0 10 10 re f /OC /L1 BDC EMC /Fm0 Do"),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /OCG /Name (A) >>",
    stream(
      "BT /F2 9 Tf (x) Tj ET",
      " /Type /XObject /Subtype /Form /BBox [0 0 100 100] /Resources << /Font << /F2 5 0 R >> >>",
    ),
  ];
  let file = "%PDF-1.7\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(file.length);
    file += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = file.length;
  let table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f\r\n`;
  for (const offset of offsets) table += `${String(offset).padStart(10, "0")} 00000 n\r\n`;
  return Uint8Array.from(
    Buffer.from(
      `${file}${table}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`,
      "latin1",
    ),
  );
}

describe("ourOpsOfPage: the page's operator stream, read from our document", () => {
  const doc = openPdfObjects(pdfWithForm());
  const ops = ourOpsOfPage(doc, doc.pages()[0]!);
  const names = ops.map((o) => o.op);

  it("gives the operators pdf.js gave, in order, form included", () => {
    expect(names).toEqual([
      "save",
      "transform",
      "beginText",
      "setFont",
      "moveText",
      "showText",
      "endText",
      "restore",
      "constructPath",
      "beginMarkedContentProps",
      "endMarkedContent",
      "paintFormXObjectBegin",
      "beginText",
      "setFont",
      "showText",
      "endText",
      "paintFormXObjectEnd",
    ]);
  });

  it("names each font by OUR key: the page with its empty scope, the form with its own", () => {
    const fonts = ops.filter((o) => o.op === "setFont").map((o) => (o.args as unknown[])[0]);
    expect(fonts).toEqual(["\u0000F1", "form:Fm0\u0000F2"]);
  });

  it("gives the cm matrix and the font size", () => {
    expect(ops[1]!.args).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 5, f: 5 });
    expect((ops[3]!.args as unknown[])[1]).toBe(12);
  });

  it("reads the group of an /OC by its reference, as pdf.js returned it", () => {
    expect(ops[9]!.args).toEqual(["OC", { type: "OCG", id: "6R" }]);
  });
});

/** A one-page PDF whose content is `content`, with Helvetica as /F1. */
function pdfWithContent(content: string): Uint8Array {
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>",
    "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let file = "%PDF-1.7\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(file.length);
    file += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = file.length;
  let table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f\r\n`;
  for (const offset of offsets) table += `${String(offset).padStart(10, "0")} 00000 n\r\n`;
  return Uint8Array.from(
    Buffer.from(
      `${file}${table}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`,
      "latin1",
    ),
  );
}

describe("ourOpsOfPage: the show arguments carry our glyphs", () => {
  it("TJ: the glyphs of each string, and the kerning between them, in order", () => {
    const doc = openPdfObjects(pdfWithContent("BT /F1 12 Tf [(A) -100 (B)] TJ ET"));
    const shown = ourOpsOfPage(doc, doc.pages()[0]!).find((o) => o.op === "showSpacedText")!;
    const items = (shown.args as unknown[][])[0]!;
    expect(items).toHaveLength(3);
    expect((items[0] as { unicode: string }).unicode).toBe("A");
    expect(items[1]).toBe(-100);
    expect((items[2] as { unicode: string }).unicode).toBe("B");
  });

  it("': a line end, then the show", () => {
    const doc = openPdfObjects(pdfWithContent("BT /F1 12 Tf 14 TL (C) ' ET"));
    expect(ourOpsOfPage(doc, doc.pages()[0]!).map((o) => o.op)).toEqual([
      "beginText",
      "setFont",
      "setLeading",
      "nextLine",
      "showText",
      "endText",
    ]);
  });

  it("sh: the shading is stated (paintShading), it hosts the white text laid after it", () => {
    const doc = openPdfObjects(pdfWithContent("/Sh1 sh BT /F1 12 Tf (E) Tj ET"));
    expect(ourOpsOfPage(doc, doc.pages()[0]!).map((o) => o.op)).toEqual([
      "paintShading",
      "beginText",
      "setFont",
      "showText",
      "endText",
    ]);
  });

  it("Q restores the font from before the q (§8.4.1)", () => {
    const doc = openPdfObjects(pdfWithContent("BT /F1 12 Tf q /F1 9 Tf Q (D) Tj ET"));
    const shown = ourOpsOfPage(doc, doc.pages()[0]!).find((o) => o.op === "showText")!;
    expect(((shown.args as unknown[][])[0]![0] as { unicode: string }).unicode).toBe("D");
  });
});

/** A one-page PDF whose /F1 is a Type0 font written vertically (`Identity-V`), with the content given. */
function pdfWithVerticalFont(content: string): Uint8Array {
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>",
    "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 7 0 R >>",
    "<< /Type /Font /Subtype /Type0 /BaseFont /Vertical /Encoding /Identity-V /DescendantFonts [6 0 R] >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Vertical >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let file = "%PDF-1.7\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(file.length);
    file += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = file.length;
  let table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f\r\n`;
  for (const offset of offsets) table += `${String(offset).padStart(10, "0")} 00000 n\r\n`;
  return Uint8Array.from(
    Buffer.from(
      `${file}${table}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`,
      "latin1",
    ),
  );
}

describe("ourOpsOfPage: vertical writing is not read as horizontal", () => {
  it("a glyph of an Identity-V font carries the vertical mark, a horizontal glyph does not", () => {
    const doc = openPdfObjects(pdfWithVerticalFont("BT /F1 12 Tf (AB) Tj ET BT /F2 12 Tf (C) Tj ET"));
    const shows = ourOpsOfPage(doc, doc.pages()[0]!).filter((o) => o.op === "showText");
    const vertical = (shows[0]!.args as unknown[][])[0]!;
    const horizontal = (shows[1]!.args as unknown[][])[0]!;
    expect(vertical.every((g) => (g as { vmetric?: unknown }).vmetric === true)).toBe(true);
    expect(horizontal.some((g) => (g as { vmetric?: unknown }).vmetric === true)).toBe(false);
  });
});
