/** The "Symbol" verdict read from the dictionary (`pdf-symbol-verdict.ts`). Repaired on 31/10/2026: the product read the
 *  `name` field of pdf.js, always empty, so it NEVER triggered the translation of private-use points. */
import { describe, expect, it } from "vitest";

import { ourFontObject } from "./pdf-font-objects";
import { symbolVerdictOf } from "./pdf-symbol-verdict";
import { openPdfObjects } from "./pdf-objects/document";

/** A one-page PDF whose `/F1` is the given font. */
function fontOf(font: string) {
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
  const bytes = Uint8Array.from(
    Buffer.from(
      `${file}${table}trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`,
      "latin1",
    ),
  );
  const doc = openPdfObjects(bytes);
  const fonts = doc.dictOf(doc.pages()[0]?.resources?.get("Font"));
  const dict = doc.dictOf(fonts?.get("F1"));
  if (dict === undefined) throw new Error("police absente");
  return ourFontObject(doc, dict);
}

describe("symbolVerdictOf: the verdict comes from the dictionary", () => {
  it("🔴 recognises a subset SymbolMT — the one that was invisible to the product", () => {
    // 359 fonts of this type in the fixtures; the product detected zero before the repair.
    expect(symbolVerdictOf(fontOf("<< /Type /Font /Subtype /Type1 /BaseFont /BCDJEE+SymbolMT >>"))).toBe(true);
  });

  it("also recognises the style, as `isSymbolFont` does", () => {
    expect(symbolVerdictOf(fontOf("<< /Type /Font /Subtype /Type1 /BaseFont /Symbol,Bold >>"))).toBe(true);
  });

  it("does not take Helvetica for Symbol", () => {
    expect(symbolVerdictOf(fontOf("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>"))).toBe(false);
  });

  it("a font without /BaseFont is not Symbol: ignorance, nothing to translate", () => {
    expect(symbolVerdictOf(fontOf("<< /Type /Font /Subtype /Type1 >>"))).toBe(false);
  });

  it("an absent font is not Symbol", () => {
    expect(symbolVerdictOf(undefined)).toBe(false);
  });
});
