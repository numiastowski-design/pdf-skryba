/** Opening a document for its embedded images does not inflate what no image needs (security review of 02/11/2026, finding 9).
 *  The reader used to open the WHOLE file with `pdf-lib`, which inflates and parses every object stream with none of our bounds:
 *  an object stream that decompresses to a hundred megabytes, from a hundred kilobytes of file, was paid in full before the first
 *  image was looked at, and an out-of-memory kill cannot be caught. Our object reader is lazy and bounded: it reads the objects an
 *  image names and nothing else. */
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { openEmbeddedImages } from "./pdf-embedded-images";

/** A one-page PDF that also carries an object stream no page uses, decompressing to `inflatedBytes` of spaces. */
function pdfWithObjectStreamBomb(inflatedBytes: number): Uint8Array {
  const text = (s: string): Buffer => Buffer.from(s, "latin1");
  const bomb = Buffer.from(deflateSync(Buffer.concat([text("1 0 "), Buffer.alloc(inflatedBytes, 0x20)])));
  const bodies: Buffer[] = [
    text("<< /Type /Catalog /Pages 2 0 R >>"),
    text("<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>"),
    text("<< /Type /Page /Parent 2 0 R >>"),
    Buffer.concat([
      text(`<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${bomb.length} >>\nstream\n`),
      bomb,
      text("\nendstream"),
    ]),
  ];
  const chunks: Buffer[] = [text("%PDF-1.5\n")];
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

describe("openEmbeddedImages : un flux d'objets que nulle image ne demande n'est pas décompressé", () => {
  it("🔴 une bombe de 100 Mo (100 Ko de fichier) ne coûte rien à l'ouverture", async () => {
    const bomb = pdfWithObjectStreamBomb(100_000_000);
    expect(bomb.length, "le fichier reste petit").toBeLessThan(500_000);
    const started = performance.now();
    const read = await openEmbeddedImages(bomb);
    expect(performance.now() - started, "l'ouverture se termine tout de suite").toBeLessThan(500);
    expect(read("99R")).toBeUndefined();
  });
});
