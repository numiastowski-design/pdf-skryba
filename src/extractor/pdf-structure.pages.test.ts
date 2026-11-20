/** The structure tree is walked ONCE per document, not once per page (performance review of 02/11/2026, finding 1).
 *  `declaredStructureOf` used to walk the whole tree from `/StructTreeRoot` for each page and keep only that page's elements: pages
 *  times elements visits (9 million for 300 pages and 30 000 elements). */
import { describe, expect, it } from "vitest";

import { openPdfObjects } from "./pdf-objects/document";
import { declaredStructureOf } from "./pdf-structure";

/** A document of `pages` pages, each with `/StructParents` and ONE structure element (`/Pg` its page, MCIDs 0 and 1), under one root. */
function pdfOfTaggedPages(pages: number): Uint8Array {
  const pageNo = (p: number): number => 5 + p; // objects 5.. are the pages; the elements follow
  const elementNo = (p: number): number => 5 + pages + p;
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 4 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, p) => `${pageNo(p)} 0 R`).join(" ")}] /Count ${pages} /MediaBox [0 0 612 792] >>`,
    "<< /Nums [] >>",
    `<< /Type /StructTreeRoot /K [${Array.from({ length: pages }, (_, p) => `${elementNo(p)} 0 R`).join(" ")}] /ParentTree 3 0 R >>`,
    ...Array.from({ length: pages }, () => "<< /Type /Page /Parent 2 0 R /StructParents 0 >>"),
    ...Array.from({ length: pages }, (_, p) => `<< /Type /StructElem /S /P /Pg ${pageNo(p)} 0 R /K [0 1] >>`),
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

describe("declaredStructureOf : l'arbre de structure est parcouru une fois par document", () => {
  const PAGES = 60;

  it("chaque page reçoit ses contenus, dans l'ordre de l'arbre", () => {
    const doc = openPdfObjects(pdfOfTaggedPages(PAGES));
    const pages = doc.pages();
    expect(declaredStructureOf(doc, pages[0]!)?.declaredOrder).toEqual(["p5R_mc0", "p5R_mc1"]);
    expect(declaredStructureOf(doc, pages[PAGES - 1]!)?.declaredOrder).toEqual([
      `p${5 + PAGES - 1}R_mc0`,
      `p${5 + PAGES - 1}R_mc1`,
    ]);
  });

  it("🔴 soixante pages : le nombre de résolutions croît avec les éléments, pas avec les pages × éléments", () => {
    const doc = openPdfObjects(pdfOfTaggedPages(PAGES));
    let resolves = 0;
    const counting = {
      ...doc,
      resolve: (value: Parameters<typeof doc.resolve>[0]) => ((resolves += 1), doc.resolve(value)),
    };
    for (const page of doc.pages()) declaredStructureOf(counting, page);
    expect(resolves, "un parcours par page ferait des dizaines de milliers de résolutions").toBeLessThan(PAGES * 40);
  });
});
