/** The declared order and the notes of a page (`pdf-structure.ts`), read from our dictionary. The measurement that validates them:
 *  `tools/poc/structure-shadow.ts` (deleted, see git history), 6 904 pages out of 6 904 in agreement with pdf.js's `getStructTree()`. */
import { describe, expect, it } from "vitest";

import { declaredStructureOf } from "./pdf-structure";
import { openPdfObjects } from "./pdf-objects/document";

/** A one-page PDF (object 3, /StructParents 0) whose structure root is `root`, `/ParentTree` included if `tree`. */
function pdfWithStructure(
  root: string,
  options: { tree?: boolean; pageStructParents?: boolean; element?: string; extra?: readonly string[] } = {},
): Uint8Array {
  const tree = options.tree ?? true;
  const parents = options.pageStructParents ?? true;
  // The root carries /ParentTree (object 5): without it, pdf.js walked nothing (ISO 32000-1 Table 322). The element is in 6.
  const rootWithParents = tree ? root.replace(/>>\s*$/, " /ParentTree 5 0 R >>") : root;
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 4 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>",
    `<< /Type /Page /Parent 2 0 R ${parents ? "/StructParents 0 " : ""}>>`,
    rootWithParents,
    "<< /Nums [] >>",
    options.element ?? "null",
    ...(options.extra ?? []),
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

const readPage = (bytes: Uint8Array) => {
  const doc = openPdfObjects(bytes);
  return declaredStructureOf(doc, doc.pages()[0]!);
};

describe("declaredStructureOf: the declared order of a page, and its notes", () => {
  it("reads the marked contents in tree order, in the pNRmcN form pdf.js used", () => {
    // A P element (object 5) carrying MCIDs 1 then 0: the declared order is that of the tree, not that of the numbers.
    const bytes = pdfWithStructure("<< /Type /StructTreeRoot /K [6 0 R] >>", {
      element: "<< /Type /StructElem /S /P /Pg 3 0 R /K [1 0] >>",
    });
    expect(readPage(bytes)?.declaredOrder).toEqual(["p3R_mc1", "p3R_mc0"]);
  });

  it("a RoleMap maps Footnote to Note: its contents are notes", () => {
    // pdf.js translated the role before comparing it; without the table, the content of a Word note is not a note.
    const bytes = pdfWithStructure("<< /Type /StructTreeRoot /K [6 0 R] /RoleMap << /Footnote /Note >> >>", {
      element: "<< /Type /StructElem /S /Footnote /Pg 3 0 R /K [2] >>",
    });
    expect([...(readPage(bytes)?.noteIds ?? [])]).toEqual(["p3R_mc2"]);
  });

  it("🔴 a shared /K array is walked only once: 24 arrays of two references each do not cost 2^24 visits", () => {
    // Security review of 02/11/2026, finding 1: only dictionaries were remembered, so an array that lists the next
    // array twice made the walk double at every level (2^64 at the depth cap) from a file of a few hundred bytes.
    // Objects 6..29 are arrays `[n+1 n+1]`; object 30 is the one real element. 24 levels = 16 M visits (about a second) unguarded.
    const extra: string[] = [];
    for (let n = 7; n <= 29; n += 1) extra.push(`[${n + 1} 0 R ${n + 1} 0 R]`);
    extra.push("<< /Type /StructElem /S /P /Pg 3 0 R /K [4] >>");
    const bytes = pdfWithStructure("<< /Type /StructTreeRoot /K [6 0 R] >>", { element: "[7 0 R 7 0 R]", extra });
    const started = performance.now();
    const structure = readPage(bytes);
    expect(performance.now() - started, "le parcours se termine tout de suite").toBeLessThan(100);
    expect(structure?.declaredOrder).toEqual(["p3R_mc4"]);
  });

  it("reads nothing without /ParentTree: pdf.js did not walk a tree without a parent table either", () => {
    expect(readPage(pdfWithStructure("<< /Type /StructTreeRoot >>", { tree: false }))).toBeUndefined();
  });

  it("reads nothing for a page that has no /StructParents", () => {
    expect(readPage(pdfWithStructure("<< /Type /StructTreeRoot >>", { pageStructParents: false }))).toBeUndefined();
  });

  it("an empty root gives an empty order, not an absence", () => {
    expect(readPage(pdfWithStructure("<< /Type /StructTreeRoot >>"))).toEqual({
      declaredOrder: [],
      noteIds: new Set(),
    });
  });
});
