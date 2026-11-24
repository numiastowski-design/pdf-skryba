/**
 * The fields of a font object read from the DICTIONARY (`pdf-font-objects.ts`), and the Symbol detection that
 * follows from it. ISO 32000-1:2008 §9.6 (simple fonts), §9.6.5 (Type 3), §9.8 (descriptor).
 * The fact that motivated the repair, measured on 31/10/2026: pdf.js NEVER filled `name` with the `BaseFont`
 * (0 fonts out of 633 seen in the fixtures), so the product's Symbol detection never triggered —
 * whereas 359 Symbol fonts were present. Our dictionary, for its part, carries the name.
 */
import { describe, expect, it } from "vitest";

import { ourFontObject, ourItalicOf, ourWeightOf } from "./pdf-font-objects";
import { openPdfObjects } from "./pdf-objects/document";
import { isSymbolFont } from "doc-ir/internal";

/** A minimal one-page PDF whose font `/F1` is given. */
function pdfWithFont(font: string): Uint8Array {
  const bodies = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>",
    "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream",
    font,
  ];
  let file = "%PDF-1.4\n";
  const offsets: number[] = [];
  bodies.forEach((body, i) => {
    offsets.push(file.length);
    file += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = file.length;
  let table = `xref\n0 ${bodies.length + 1}\n0000000000 65535 f\r\n`;
  for (const offset of offsets) table += `${String(offset).padStart(10, "0")} 00000 n\r\n`;
  return Uint8Array.from(
    Buffer.from(
      `${file}${table}trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`,
      "latin1",
    ),
  );
}

const fontOf = (font: string) => {
  const doc = openPdfObjects(pdfWithFont(font));
  const fonts = doc.dictOf(doc.pages()[0]?.resources?.get("Font"));
  const dict = doc.dictOf(fonts?.get("F1"));
  if (dict === undefined) throw new Error("police absente du fixture");
  return ourFontObject(doc, dict);
};

describe("ourFontObject: the name comes from /BaseFont, never from a pdf.js value", () => {
  it("reads the name from the dictionary, subset prefix included", () => {
    expect(fontOf("<< /Type /Font /Subtype /Type1 /BaseFont /BCDJEE+SymbolMT >>").name).toBe("BCDJEE+SymbolMT");
  });

  it("gives the weight from the name when the descriptor says nothing of it", () => {
    expect(fontOf("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>").weight).toBe("bold");
    expect(fontOf("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>").weight).toBe("normal");
    expect(fontOf("<< /Type /Font /Subtype /Type1 /BaseFont /Calibri >>").weight).toBe("unknown");
  });

  it("invents no name when /BaseFont is missing", () => {
    expect(fontOf("<< /Type /Font /Subtype /Type1 >>").name).toBeUndefined();
  });
});

describe("ourFontObject: a Type 3 font carries its matrix", () => {
  it("recognises /Subtype /Type3 and returns /FontMatrix as is", () => {
    const font = fontOf("<< /Type /Font /Subtype /Type3 /FontMatrix [0.001 0 0 0.001 0 0] >>");
    expect(font.isType3Font).toBe(true);
    expect(font.fontMatrix).toEqual([0.001, 0, 0, 0.001, 0, 0]);
  });

  it("has NO matrix for a simple font", () => {
    expect(fontOf("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>").isType3Font).toBe(false);
  });

  it("abstains on a matrix that does not have six numbers", () => {
    expect(fontOf("<< /Type /Font /Subtype /Type3 /FontMatrix [0.001 0] >>").fontMatrix).toBeUndefined();
  });
});

describe("ourFontObject: a missing font program", () => {
  it("says missing when the descriptor carries no /FontFile", () => {
    expect(fontOf("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>").missingFile).toBe(true);
  });
});

describe("Symbol detection, read from the dictionary (repaired on 31/10/2026)", () => {
  it("🔴 recognises a subset SymbolMT, the one that was invisible to the product", () => {
    // This is THE measured case: 359 fonts of this type in the fixtures, zero detected before the repair.
    expect(isSymbolFont(fontOf("<< /Type /Font /Subtype /Type1 /BaseFont /BCDJEE+SymbolMT >>").name)).toBe(true);
  });

  it("does not take Helvetica for Symbol", () => {
    expect(isSymbolFont(fontOf("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>").name)).toBe(false);
  });
});

describe("ourWeightOf: the weight per ISO 32000-1 Table 122, then the name", () => {
  it("🔴 the descriptor's /FontWeight prevails: 700 and 900 are bold, 400 is regular, even if the name says Bold", () => {
    expect(ourWeightOf(700, "Arial")).toBe("bold");
    expect(ourWeightOf(900, "Arial-Black")).toBe("bold");
    expect(ourWeightOf(400, "Arial-BoldMT")).toBe("normal");
  });

  it("without /FontWeight, the name decides: Bold, Black or Heavy are bold", () => {
    expect(ourWeightOf(undefined, "Arial-BoldMT")).toBe("bold");
    expect(ourWeightOf(undefined, "Impact-Heavy")).toBe("bold");
  });

  it("a base font without « Bold » in its name is regular; another with a mute name stays unknown", () => {
    expect(ourWeightOf(undefined, "Helvetica")).toBe("normal");
    expect(ourWeightOf(undefined, "Calibri")).toBe("unknown");
  });

  it("does NOT use bit 19 of /Flags (ForceBold): the standard reserves it for rendering small sizes", () => {
    // ForceBold alone does not fix the weight: this module does not even receive /Flags.
    expect(ourWeightOf(400, "Arial")).toBe("normal");
  });

  it("ignores a value outside 100 to 900: the standard does not allow it", () => {
    expect(ourWeightOf(1000, "Calibri")).toBe("unknown");
  });
});

describe("the italic of a font, read from what the PDF declares (05/11/2026)", () => {
  // ISO 32000-1: bit 7 of `/Flags` (value 64, Table 123 "Italic"), a non-zero `/ItalicAngle` (Table 122), and the
  // font's name ("-Italic", "-Oblique"). A name that says nothing, without a descriptor: unknown.
  it("🔴 the descriptor's Italic flag is enough", () => {
    expect(
      fontOf(
        "<< /Type /Font /Subtype /TrueType /BaseFont /ABCDEF+Garamond /FontDescriptor << /Type /FontDescriptor /FontName /ABCDEF+Garamond /Flags 96 >> >>",
      ).italic,
    ).toBe(true);
  });

  it("🔴 a non-zero italic angle is enough", () => {
    expect(
      fontOf(
        "<< /Type /Font /Subtype /TrueType /BaseFont /ABCDEF+Garamond /FontDescriptor << /Type /FontDescriptor /FontName /ABCDEF+Garamond /Flags 32 /ItalicAngle -12 >> >>",
      ).italic,
    ).toBe(true);
  });

  it("🔴 the name says it: Oblique, Italic; an upright base font is not; a mute name without a descriptor says nothing", () => {
    expect(fontOf("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique >>").italic).toBe(true);
    expect(fontOf("<< /Type /Font /Subtype /Type1 /BaseFont /Times-BoldItalic >>").italic).toBe(true);
    expect(fontOf("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>").italic).toBe(false);
    expect(fontOf("<< /Type /Font /Subtype /TrueType /BaseFont /ABCDEF+Garamond >>").italic).toBeUndefined();
  });

  it("ourItalicOf: the three readings in order", () => {
    expect(ourItalicOf(64, undefined, "ABCDEF+Garamond")).toBe(true);
    expect(ourItalicOf(32, -12, "ABCDEF+Garamond")).toBe(true);
    expect(ourItalicOf(32, 0, "Garamond-Italic")).toBe(true);
    expect(ourItalicOf(32, 0, "Courier")).toBe(false);
    // A descriptor whose flags say nothing of italic is an upright font: the document has spoken. Without a descriptor,
    // a mute name says nothing.
    expect(ourItalicOf(32, 0, "ABCDEF+Garamond")).toBe(false);
    expect(ourItalicOf(undefined, undefined, "ABCDEF+Garamond")).toBeUndefined();
    expect(ourItalicOf(undefined, undefined, undefined)).toBeUndefined();
  });
});
