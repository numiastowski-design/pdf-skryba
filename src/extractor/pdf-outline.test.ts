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

describe("flattenOutline: the bounds and the normalisation of the former reading, carried over as they were", () => {
  it("drops a tree larger than the bound, counting every node (titled or not)", () => {
    const nodes = Array.from({ length: OUTLINE_READ_MAX_ENTRIES + 1 }, () => ({ title: undefined, items: [] }));
    expect(flattenOutline(nodes)).toBeUndefined();
    const ok = Array.from({ length: OUTLINE_READ_MAX_ENTRIES }, (_, i) => ({ title: `T${i}`, items: [] }));
    expect(flattenOutline(ok)).toHaveLength(OUTLINE_READ_MAX_ENTRIES);
  });

  it("leaves empty and blank titles aside, and keeps their children", () => {
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

  it("cuts each title to the allowed length", () => {
    const entries = flattenOutline([{ title: "x".repeat(1_000_000), items: [] }]);
    expect(entries![0]!.title).toHaveLength(OUTLINE_TITLE_MAX_CHARS);
  });

  it("normalises and trims BEFORE cutting", () => {
    const entries = flattenOutline([
      { title: "é".repeat(400), items: [] },
      { title: `${" ".repeat(500)}Real title${" ".repeat(500)}`, items: [] },
    ]);
    expect(entries![0]!.title).toBe("é".repeat(OUTLINE_TITLE_MAX_CHARS));
    expect(entries![1]!.title).toBe("Real title");
  });

  it("gives nothing for an absent or empty tree", () => {
    expect(flattenOutline(null)).toBeUndefined();
    expect(flattenOutline(undefined)).toBeUndefined();
    expect(flattenOutline([])).toBeUndefined();
  });
});

describe("outlineOfDocument: read from our dictionary", () => {
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

  it("flattens in reading order, with the depth", () => {
    const doc = openPdfObjects(pdfWith(outline));
    expect(outlineOfDocument(doc)).toStrictEqual([
      { title: "A", depth: 1 },
      { title: "A1", depth: 2 },
      { title: "A2", depth: 2 },
      { title: "B", depth: 1 },
    ]);
  });

  it("gives none to a document without bookmarks", () => {
    const doc = openPdfObjects(
      pdfWith({ 1: "<< /Type /Catalog /Pages 2 0 R >>", 2: "<< /Type /Pages /Kids [] /Count 0 >>" }),
    );
    expect(outlineOfDocument(doc)).toBeUndefined();
  });

  it("🔴 decodes the title per the standard: « D\\x90ACCUEIL » becomes « D’ACCUEIL », not a control character", () => {
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

  it("abstains on a /Next loop instead of looping forever", () => {
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

  it("drops an outline larger than the bound, read from the dictionary", () => {
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
