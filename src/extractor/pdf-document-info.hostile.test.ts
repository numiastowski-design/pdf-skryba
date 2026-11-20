/** The walks of `pdf-document-info.ts` over the form fields and the attachment tree are bounded on hostile files (security
 *  review of 02/11/2026, finding 8). `onlyInvisibleSignatures` remembered nothing, so a field listing the next one five
 *  times over nine levels made 5^9 visits (and a hundred times over, 10^18); `fieldsOf` and `attachmentCount` had no depth
 *  limit, so a long chain of `/Kids` overflowed the stack with a bare `RangeError` that is not a refusal. */
import { describe, expect, it } from "vitest";

import { documentInfoOf } from "./pdf-document-info";
import { openPdfObjects } from "./pdf-objects/document";

/** A one-page PDF whose catalog carries `catalogExtras` and whose objects 6.. are `more`. */
function pdfWith(catalogExtras: string, more: readonly string[]): Uint8Array {
  const objects: string[] = [
    `<< /Type /Catalog /Pages 2 0 R ${catalogExtras} >>`,
    "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>",
    "<< /Type /Page /Parent 2 0 R >>",
    "null",
    "null",
    ...more,
  ];
  let file = "%PDF-1.4\n";
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

describe("documentInfoOf : un formulaire hostile ne fait ni boucler ni déborder", () => {
  it("🔴 neuf niveaux de champs qui listent chacun cinq fois le suivant : chaque objet n'est visité qu'une fois", () => {
    // Objects 6..14 are fields `/Kids [n+1 x5]`; object 15 is an invisible signature. Unguarded: 5^9 = 1.9 M visits.
    const more: string[] = [];
    for (let n = 6; n <= 14; n += 1)
      more.push(`<< /Kids [${Array.from({ length: 5 }, () => `${n + 1} 0 R`).join(" ")}] >>`);
    more.push("<< /FT /Sig /Rect [0 0 0 0] >>");
    const doc = openPdfObjects(pdfWith("/AcroForm << /Fields [6 0 R] /SigFlags 1 >>", more));
    const started = performance.now();
    documentInfoOf(doc);
    expect(performance.now() - started, "la lecture se termine tout de suite").toBeLessThan(100);
  });

  it("🔴 une chaîne de 12 000 champs imbriqués ne déborde pas la pile", () => {
    // Objects 6..12005: field n has `/Kids [n+1]`; the last has none. Unbounded, `fieldsOf` recurses 12 000 deep.
    const more: string[] = [];
    for (let n = 6; n < 12_006; n += 1) more.push(`<< /FT /Sig /V << >> /Kids [${n + 1} 0 R] >>`);
    more.push("<< /FT /Sig >>");
    const doc = openPdfObjects(pdfWith("/AcroForm << /Fields [6 0 R] >>", more));
    expect(() => documentInfoOf(doc)).not.toThrow();
  });

  it("🔴 une chaîne de 12 000 nœuds de l'arbre des pièces jointes ne déborde pas la pile", () => {
    const more: string[] = [];
    for (let n = 6; n < 12_006; n += 1) more.push(`<< /Kids [${n + 1} 0 R] >>`);
    more.push("<< /Names [(a) 1 0 R] >>");
    const doc = openPdfObjects(pdfWith("/Names << /EmbeddedFiles 6 0 R >>", more));
    expect(() => documentInfoOf(doc)).not.toThrow();
  });

  it("un formulaire réel (deux niveaux, une signature signée) est lu comme avant", () => {
    const doc = openPdfObjects(
      pdfWith("/AcroForm << /Fields [6 0 R] >>", [
        "<< /Kids [7 0 R] >>",
        "<< /FT /Sig /V << /Type /Sig >> /Rect [10 10 100 40] >>",
      ]),
    );
    expect(documentInfoOf(doc).form).toBe(true);
    expect(documentInfoOf(doc).signatures).toBe(1);
  });
});
