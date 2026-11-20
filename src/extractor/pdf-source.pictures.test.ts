/** A picture painted on every page is decoded ONCE for the document (performance review of 02/11/2026, finding 2).
 *  `ourImagesOf` decoded every painted picture on every page: a masked logo of 16 MB decoded, on 16 pages, charged 256 MB to the 200 MB
 *  document budget, so the last pages reported the picture as unreadable (and, past the budget, the whole document was refused). */
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { readPdfSource } from "./pdf-source";

/** A document of `pages` pages that each paint the same RGB Flate picture, which has a gray soft mask, both `side` x `side`. */
function pdfOfPagesWithLogo(pages: number, side: number): Uint8Array {
  const text = (s: string): Buffer => Buffer.from(s, "latin1");
  const stream = (dict: string, data: Buffer): Buffer =>
    Buffer.concat([text(`<< ${dict} /Length ${data.length} >>\nstream\n`), data, text("\nendstream")]);
  const content = "q 100 0 0 100 10 10 cm /Im0 Do Q";
  const imageNo = 3 + pages; // objects 3.. are the pages, then the picture and its mask
  const bodies: Buffer[] = [
    text("<< /Type /Catalog /Pages 2 0 R >>"),
    text(
      `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, p) => `${3 + p} 0 R`).join(" ")}] /Count ${pages} /MediaBox [0 0 612 792] >>`,
    ),
    ...Array.from({ length: pages }, () =>
      text(
        `<< /Type /Page /Parent 2 0 R /Contents ${imageNo + 2} 0 R /Resources << /XObject << /Im0 ${imageNo} 0 R >> >> >>`,
      ),
    ),
    stream(
      `/Type /XObject /Subtype /Image /Width ${side} /Height ${side} /BitsPerComponent 8 /ColorSpace /DeviceRGB /SMask ${imageNo + 1} 0 R /Filter /FlateDecode`,
      Buffer.from(deflateSync(Buffer.alloc(side * side * 3, 0x80))),
    ),
    stream(
      `/Type /XObject /Subtype /Image /Width ${side} /Height ${side} /BitsPerComponent 8 /ColorSpace /DeviceGray /Filter /FlateDecode`,
      Buffer.from(deflateSync(Buffer.alloc(side * side, 0xff))),
    ),
    stream("", text(content)),
  ];
  const chunks: Buffer[] = [text("%PDF-1.4\n")];
  const offsets: number[] = [];
  let length = chunks[0]!.length;
  bodies.forEach((body, i) => {
    offsets.push(length);
    const object = Buffer.concat([text(`${i + 1} 0 obj\n`), body, text("\nendobj\n")]);
    chunks.push(object);
    length += object.length;
  });
  let table = `xref\n0 ${bodies.length + 1}\n0000000000 65535 f\r\n`;
  for (const offset of offsets) table += `${String(offset).padStart(10, "0")} 00000 n\r\n`;
  chunks.push(text(`${table}trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(chunks));
}

describe("readPdfSource : une image peinte sur chaque page est décodée une fois", () => {
  it("🔴 un logo à masque de 16 Mo décodés sur 16 pages (256 Mo facturés sans mémo) reste lisible à la dernière page", async () => {
    const pages = 16;
    const source = await readPdfSource(pdfOfPagesWithLogo(pages, 2000), { wantOps: () => true });
    expect(source.pages).toHaveLength(pages);
    expect(source.pages[0]!.readImage("Im0"), "la première page lit l'image").toBeDefined();
    expect(source.pages[pages - 1]!.readImage("Im0"), "la dernière aussi").toBeDefined();
    expect(source.pages[pages - 1]!.imageFailure("Im0")).toBeUndefined();
  }, 120_000);
});
