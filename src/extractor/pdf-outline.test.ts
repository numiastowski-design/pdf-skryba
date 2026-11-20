/** The bookmarks read from our dictionary (`pdf-outline.ts`). The bounds and the normalisation are those of the former
 *  pdf.js reading, carried over as they were: same tests, on a given tree. The dictionary reading has its own. */
import { describe, expect, it } from "vitest";

import {
  flattenOutline,
  OUTLINE_READ_MAX_ENTRIES,
  OUTLINE_TITLE_MAX_CHARS,
  outlineOfDocument,
  type OutlineNode,
} from "./pdf-outline";
import { openPdfObjects } from "./pdf-objects/document";

const enc = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "latin1"));

/** A PDF whose bookmark list is `objects`: `{ num: body }`, root = 1 0 R. */
function pdfWith(objects: Record<number, string>): Uint8Array {
  const count = Math.max(...Object.keys(objects).map(Number));
  const bodies: string[] = [];
  for (let n = 1; n <= count; n += 1) bodies.push(objects[n] ?? "null");
  let file = "%PDF-1.4\n";
  const offsets: number[] = [];
  bodies.forEach((body, i) => {
    offsets.push(file.length);
    file += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = file.length;
  let table = `xref\n0 ${count + 1}\n0000000000 65535 f\r\n`;
  for (const offset of offsets) table += `${String(offset).padStart(10, "0")} 00000 n\r\n`;
  return enc(`${file}${table}trailer\n<< /Size ${count + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
}

describe("flattenOutline: les bornes et la normalisation de l'ancienne lecture, portées telles quelles", () => {
  it("abandonne un arbre de plus que la borne, en comptant chaque nœud (titrés ou non)", () => {
    const nodes = Array.from({ length: OUTLINE_READ_MAX_ENTRIES + 1 }, () => ({ title: undefined, items: [] }));
    expect(flattenOutline(nodes)).toBeUndefined();
    const ok = Array.from({ length: OUTLINE_READ_MAX_ENTRIES }, (_, i) => ({ title: `T${i}`, items: [] }));
    expect(flattenOutline(ok)).toHaveLength(OUTLINE_READ_MAX_ENTRIES);
  });

  it("laisse les titres vides et blancs de côté, et garde leurs enfants", () => {
    const tree: OutlineNode[] = [
      { title: "  ", items: [{ title: "Kid", items: [] }] },
      { items: [] },
      { title: "Real", items: [] },
    ];
    expect(flattenOutline(tree)).toStrictEqual([
      { title: "Kid", depth: 2 },
      { title: "Real", depth: 1 },
    ]);
  });

  it("coupe chaque titre à la longueur permise", () => {
    const entries = flattenOutline([{ title: "x".repeat(1_000_000), items: [] }]);
    expect(entries![0]!.title).toHaveLength(OUTLINE_TITLE_MAX_CHARS);
  });

  it("normalise et rogne AVANT de couper", () => {
    const entries = flattenOutline([
      { title: "é".repeat(400), items: [] },
      { title: `${" ".repeat(500)}Real title${" ".repeat(500)}`, items: [] },
    ]);
    expect(entries![0]!.title).toBe("é".repeat(OUTLINE_TITLE_MAX_CHARS));
    expect(entries![1]!.title).toBe("Real title");
  });

  it("ne donne rien pour un arbre absent ou vide", () => {
    expect(flattenOutline(null)).toBeUndefined();
    expect(flattenOutline(undefined)).toBeUndefined();
    expect(flattenOutline([])).toBeUndefined();
  });
});

describe("outlineOfDocument: lu de notre dictionnaire", () => {
  // Catalog 1, pages 2, bookmarks root 3: A (4) with two children A1 (5) and A2 (6), then B (7).
  const outline = {
    1: "<< /Type /Catalog /Pages 2 0 R /Outlines 3 0 R >>",
    2: "<< /Type /Pages /Kids [] /Count 0 >>",
    3: "<< /Type /Outlines /First 4 0 R /Last 7 0 R /Count 4 >>",
    4: "<< /Title (A) /Parent 3 0 R /First 5 0 R /Last 6 0 R /Next 7 0 R >>",
    5: "<< /Title (A1) /Parent 4 0 R /Next 6 0 R >>",
    6: "<< /Title (A2) /Parent 4 0 R >>",
    7: "<< /Title (B) /Parent 3 0 R /Prev 4 0 R >>",
  };

  it("aplatit dans l'ordre de lecture, avec la profondeur", () => {
    const doc = openPdfObjects(pdfWith(outline));
    expect(outlineOfDocument(doc)).toStrictEqual([
      { title: "A", depth: 1 },
      { title: "A1", depth: 2 },
      { title: "A2", depth: 2 },
      { title: "B", depth: 1 },
    ]);
  });

  it("n'en donne aucun à un document sans signets", () => {
    const doc = openPdfObjects(
      pdfWith({ 1: "<< /Type /Catalog /Pages 2 0 R >>", 2: "<< /Type /Pages /Kids [] /Count 0 >>" }),
    );
    expect(outlineOfDocument(doc)).toBeUndefined();
  });

  it("🔴 décode le titre selon la norme : « D\\x90ACCUEIL » devient « D’ACCUEIL », pas un caractère de contrôle", () => {
    const doc = openPdfObjects(
      pdfWith({
        1: "<< /Type /Catalog /Pages 2 0 R /Outlines 3 0 R >>",
        2: "<< /Type /Pages /Kids [] /Count 0 >>",
        3: "<< /Type /Outlines /First 4 0 R /Last 4 0 R /Count 1 >>",
        4: "<< /Title (D\x90ACCUEIL) /Parent 3 0 R >>",
      }),
    );
    expect(outlineOfDocument(doc)?.[0]?.title).toBe("D’ACCUEIL");
  });

  it("s'abstient sur une boucle de /Next au lieu de tourner sans fin", () => {
    const doc = openPdfObjects(
      pdfWith({
        1: "<< /Type /Catalog /Pages 2 0 R /Outlines 3 0 R >>",
        2: "<< /Type /Pages /Kids [] /Count 0 >>",
        3: "<< /Type /Outlines /First 4 0 R /Last 4 0 R /Count 1 >>",
        4: "<< /Title (A) /Parent 3 0 R /Next 4 0 R >>",
      }),
    );
    expect(outlineOfDocument(doc)).toStrictEqual([{ title: "A", depth: 1 }]);
  });

  it("abandonne un plan de plus de la borne, lu depuis le dictionnaire", () => {
    // A /Next chain of OUTLINE_READ_MAX_ENTRIES + 1 bookmarks: beyond the bound, the outline is ignored entirely.
    const n = OUTLINE_READ_MAX_ENTRIES + 1;
    const objects: Record<number, string> = {
      1: "<< /Type /Catalog /Pages 2 0 R /Outlines 3 0 R >>",
      2: "<< /Type /Pages /Kids [] /Count 0 >>",
      3: `<< /Type /Outlines /First 4 0 R /Last ${3 + n} 0 R /Count ${n} >>`,
    };
    for (let i = 0; i < n; i += 1) {
      const next = i + 1 < n ? ` /Next ${5 + i} 0 R` : "";
      objects[4 + i] = `<< /Title (T${i}) /Parent 3 0 R${next} >>`;
    }
    expect(outlineOfDocument(openPdfObjects(pdfWith(objects)))).toBeUndefined();
  });
});
