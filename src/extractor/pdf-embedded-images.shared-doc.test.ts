/** The embedded-image reader takes the document of the reading instead of opening the file again (performance review of 02/11/2026): a
 *  second `openPdfObjects` parsed the cross-reference table and every object stream a second time, with a second 200 MB budget. */
import { describe, expect, it, vi } from "vitest";

const opens = vi.hoisted(() => ({ count: 0 }));
vi.mock("./pdf-objects/document", async (importActual) => {
  const actual = await importActual<typeof import("./pdf-objects/document")>();
  return {
    ...actual,
    openPdfObjects: (...args: Parameters<typeof actual.openPdfObjects>) => (
      (opens.count += 1),
      actual.openPdfObjects(...args)
    ),
  };
});

import { openEmbeddedImages } from "./pdf-embedded-images";
import { readPdfSource } from "./pdf-source";

/** A one-page PDF with a classic cross-reference table. */
function onePagePdf(): Uint8Array {
  const bodies = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>",
    "<< /Type /Page /Parent 2 0 R >>",
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
  return new Uint8Array(
    Buffer.from(
      `${file}${table}trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`,
      "latin1",
    ),
  );
}

const PDF = onePagePdf();

describe("openEmbeddedImages : le document de la lecture n'est pas rouvert", () => {
  it("🔴 avec le document déjà ouvert, le fichier n'est pas parsé une seconde fois", async () => {
    const source = await readPdfSource(PDF);
    const opened = opens.count;
    await openEmbeddedImages(source.document);
    expect(opens.count, "aucune ouverture de plus").toBe(opened);
  });

  it("avec des octets, il ouvre (les appelants de test et d'outils)", async () => {
    const before = opens.count;
    await openEmbeddedImages(PDF);
    expect(opens.count).toBe(before + 1);
  });
});
