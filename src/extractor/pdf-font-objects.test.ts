/**
 * The fields of a font object read from the DICTIONARY (`pdf-font-objects.ts`), and the Symbol detection that
 * follows from it. ISO 32000-1:2008 §9.6 (simple fonts), §9.6.5 (Type 3), §9.8 (descriptor).
 * The fact that motivates the repair, measured on 31/10/2026: pdf.js NEVER fills `name` with the `BaseFont`
 * (0 fonts out of 633 seen in the fixtures), so the product's Symbol detection never triggered —
 * whereas 359 Symbol fonts are present. Our dictionary, for its part, carries the name.
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

describe("ourFontObject: le nom vient de /BaseFont, jamais d'une valeur de pdf.js", () => {
  it("lit le nom du dictionnaire, sous-ensemble compris", () => {
    expect(fontOf("<< /Type /Font /Subtype /Type1 /BaseFont /BCDJEE+SymbolMT >>").name).toBe("BCDJEE+SymbolMT");
  });

  it("donne la graisse d'après le nom, quand le descripteur n'en dit rien", () => {
    expect(fontOf("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>").weight).toBe("bold");
    expect(fontOf("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>").weight).toBe("normal");
    expect(fontOf("<< /Type /Font /Subtype /Type1 /BaseFont /Calibri >>").weight).toBe("unknown");
  });

  it("n'invente aucun nom quand /BaseFont manque", () => {
    expect(fontOf("<< /Type /Font /Subtype /Type1 >>").name).toBeUndefined();
  });
});

describe("ourFontObject: une police Type 3 porte sa matrice", () => {
  it("reconnaît /Subtype /Type3 et rend /FontMatrix telle quelle", () => {
    const font = fontOf("<< /Type /Font /Subtype /Type3 /FontMatrix [0.001 0 0 0.001 0 0] >>");
    expect(font.isType3Font).toBe(true);
    expect(font.fontMatrix).toEqual([0.001, 0, 0, 0.001, 0, 0]);
  });

  it("n'a PAS de matrice pour une police simple", () => {
    expect(fontOf("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>").isType3Font).toBe(false);
  });

  it("s'abstient sur une matrice qui n'a pas six nombres", () => {
    expect(fontOf("<< /Type /Font /Subtype /Type3 /FontMatrix [0.001 0] >>").fontMatrix).toBeUndefined();
  });
});

describe("ourFontObject: un programme de police manquant", () => {
  it("dit absent quand le descripteur ne porte aucun /FontFile", () => {
    expect(fontOf("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>").missingFile).toBe(true);
  });
});

describe("la détection de Symbol, lue du dictionnaire (réparée le 31/10/2026)", () => {
  it("🔴 reconnaît une SymbolMT sous-ensemble, celle qui était invisible au produit", () => {
    // This is THE measured case: 359 fonts of this type in the fixtures, zero detected before the repair.
    expect(isSymbolFont(fontOf("<< /Type /Font /Subtype /Type1 /BaseFont /BCDJEE+SymbolMT >>").name)).toBe(true);
  });

  it("ne prend pas Helvetica pour Symbol", () => {
    expect(isSymbolFont(fontOf("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>").name)).toBe(false);
  });
});

describe("ourWeightOf: la graisse selon ISO 32000-1 Table 122, puis le nom", () => {
  it("🔴 /FontWeight du descripteur prime : 700 et 900 sont gras, 400 est régulier, même si le nom dit Bold", () => {
    expect(ourWeightOf(700, "Arial")).toBe("bold");
    expect(ourWeightOf(900, "Arial-Black")).toBe("bold");
    expect(ourWeightOf(400, "Arial-BoldMT")).toBe("normal");
  });

  it("sans /FontWeight, le nom décide : Bold, Black ou Heavy sont gras", () => {
    expect(ourWeightOf(undefined, "Arial-BoldMT")).toBe("bold");
    expect(ourWeightOf(undefined, "Impact-Heavy")).toBe("bold");
  });

  it("une police de base sans « Bold » dans son nom est régulière ; une autre au nom muet reste inconnue", () => {
    expect(ourWeightOf(undefined, "Helvetica")).toBe("normal");
    expect(ourWeightOf(undefined, "Calibri")).toBe("unknown");
  });

  it("n'utilise PAS le bit 19 de /Flags (ForceBold) : la norme le réserve au rendu des petits corps", () => {
    // ForceBold alone does not fix the weight: this module does not even receive /Flags.
    expect(ourWeightOf(400, "Arial")).toBe("normal");
  });

  it("ignore une valeur hors de 100 à 900 : la norme ne la permet pas", () => {
    expect(ourWeightOf(1000, "Calibri")).toBe("unknown");
  });
});

describe("l'italique d'une police, lu dans ce que le PDF déclare (05/11/2026 : « à faire oui »)", () => {
  // ISO 32000-1: bit 7 of `/Flags` (value 64, Table 123 "Italic"), a non-zero `/ItalicAngle` (Table 122), and the
  // font's name ("-Italic", "-Oblique"). A name that says nothing, without a descriptor: unknown.
  it("🔴 le drapeau Italic du descripteur suffit", () => {
    expect(
      fontOf(
        "<< /Type /Font /Subtype /TrueType /BaseFont /ABCDEF+Garamond /FontDescriptor << /Type /FontDescriptor /FontName /ABCDEF+Garamond /Flags 96 >> >>",
      ).italic,
    ).toBe(true);
  });

  it("🔴 un angle d'italique non nul suffit", () => {
    expect(
      fontOf(
        "<< /Type /Font /Subtype /TrueType /BaseFont /ABCDEF+Garamond /FontDescriptor << /Type /FontDescriptor /FontName /ABCDEF+Garamond /Flags 32 /ItalicAngle -12 >> >>",
      ).italic,
    ).toBe(true);
  });

  it("🔴 le nom le dit : Oblique, Italic ; une police de base droite ne l'est pas ; un nom muet sans descripteur ne dit rien", () => {
    expect(fontOf("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique >>").italic).toBe(true);
    expect(fontOf("<< /Type /Font /Subtype /Type1 /BaseFont /Times-BoldItalic >>").italic).toBe(true);
    expect(fontOf("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>").italic).toBe(false);
    expect(fontOf("<< /Type /Font /Subtype /TrueType /BaseFont /ABCDEF+Garamond >>").italic).toBeUndefined();
  });

  it("ourItalicOf : les trois lectures dans l'ordre", () => {
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
