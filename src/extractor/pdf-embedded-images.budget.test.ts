/** What the embedded-image reader inflates is bounded in all, and a picture's size is judged as everywhere else (security review of
 *  02/11/2026, round 2, finding 9): `pictureSizeOk` (positive whole numbers, 25 million pixels at most), and a running total of
 *  inflated bytes capped at `MAX_DOCUMENT_BYTES` — one picture is capped by its declared size, but a file may hold thousands. */
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { documentCacheOf } from "./document-cache";
import { openEmbeddedImages } from "./pdf-embedded-images";
import { openPdfObjects } from "./pdf-objects/document";
import { MAX_DOCUMENT_BYTES } from "./pdf-objects/bounds";

/** A one-page PDF whose objects 5, 6, … are RGB Flate images of the given sizes, each holding `fill` bytes of zeros. */
function pdfOfImages(sizes: { width: number; height: number }[]): Uint8Array {
  const text = (s: string): Buffer => Buffer.from(s, "latin1");
  const bodies: Buffer[] = [
    text("<< /Type /Catalog /Pages 2 0 R >>"),
    text("<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>"),
    text("<< /Type /Page /Parent 2 0 R >>"),
    text("<< /Length 0 >>\nstream\n\nendstream"),
  ];
  for (const { width, height } of sizes) {
    const pixels = Math.abs(width * height) * 3;
    const data = Buffer.from(deflateSync(Buffer.alloc(pixels)));
    bodies.push(
      Buffer.concat([
        text(
          `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /BitsPerComponent 8 /ColorSpace /DeviceRGB /Filter /FlateDecode /Length ${data.length} >>\nstream\n`,
        ),
        data,
        text("\nendstream"),
      ]),
    );
  }
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

describe("openEmbeddedImages : la taille d'une image et le total décompressé", () => {
  it("une image ordinaire (4 x 4) est lue", async () => {
    const read = await openEmbeddedImages(pdfOfImages([{ width: 4, height: 4 }]));
    expect(read("5R")?.mimeType).toBe("image/png");
  });

  it("🔴 des dimensions négatives (-2 x -3) ne font pas une image", async () => {
    const read = await openEmbeddedImages(pdfOfImages([{ width: -2, height: -3 }]));
    expect(read("5R")).toBeUndefined();
  });

  it("🔴 le total décompressé du document est borné : trois images de 75 Mo (225 Mo) dépassent MAX_DOCUMENT_BYTES, la troisième n'est pas lue", async () => {
    expect(3 * 5000 * 5000 * 3).toBeGreaterThan(MAX_DOCUMENT_BYTES);
    expect(2 * 5000 * 5000 * 3).toBeLessThanOrEqual(MAX_DOCUMENT_BYTES);
    const read = await openEmbeddedImages(
      pdfOfImages([
        { width: 5000, height: 5000 },
        { width: 5000, height: 5000 },
        { width: 5000, height: 5000 },
      ]),
    );
    expect(read("5R")).toBeDefined();
    expect(read("6R")).toBeDefined();
    expect(read("7R")).toBeUndefined();
  }, 120_000);
});

describe("openEmbeddedImages : une image qui échoue est facturée à sa taille déclarée (revue de sécurité, tour 5)", () => {
  it("🔴 deux images tronquées de 75 Mo déclarés épuisent le budget : la troisième, saine, n'est plus lue", async () => {
    const bytes = pdfOfImages([
      { width: 5000, height: 5000 },
      { width: 5000, height: 5000 },
      { width: 5000, height: 5000 },
    ]);
    const text = Buffer.from(bytes).toString("latin1");
    // Truncate nothing: corrupt the zlib checksum of the first two images instead, so zlib inflates them whole and then throws.
    const read = await openEmbeddedImages(corruptFirstTwoChecksums(text));
    expect(read("5R")).toBeUndefined();
    expect(read("6R")).toBeUndefined();
    expect(read("7R")).toBeUndefined();
  }, 120_000);
});

/** The checksum (last four bytes of the zlib data, before `endstream`) of the first two image streams, flipped. */
function corruptFirstTwoChecksums(text: string): Uint8Array {
  const out = Buffer.from(text, "latin1");
  let from = 0;
  for (let i = 0; i < 2; i += 1) {
    const end = text.indexOf("endstream", text.indexOf("/Subtype /Image", from));
    out[end - 2] = out[end - 2]! ^ 0xff; // before the newline written ahead of endstream
    from = end + 1;
  }
  return new Uint8Array(out);
}

describe("openEmbeddedImages : une image placée sur beaucoup de pages est lue une fois (revue de performance du 02/11/2026)", () => {
  it("🔴 un logo de 3 Mo lu cent fois (300 Mo facturés sans mémo) l'est toujours à la centième lecture, et c'est le même objet", async () => {
    const read = await openEmbeddedImages(pdfOfImages([{ width: 1000, height: 1000 }]));
    const first = read("5R");
    expect(first).toBeDefined();
    for (let i = 0; i < 99; i += 1) expect(read("5R")).toBe(first);
  }, 120_000);

  it("une image qui ne se lit pas ne se relit pas non plus", async () => {
    const read = await openEmbeddedImages(pdfOfImages([{ width: -2, height: -3 }]));
    expect(read("5R")).toBeUndefined();
    expect(read("5R")).toBeUndefined();
  });
});

describe("openEmbeddedImages : une image nommée de deux façons est la même (5R et 5R0)", () => {
  it("🔴 5R et 5R0 rendent le même objet", async () => {
    const read = await openEmbeddedImages(pdfOfImages([{ width: 4, height: 4 }]));
    const first = read("5R");
    expect(first).toBeDefined();
    expect(read("5R0")).toBe(first);
  });
});

describe("openEmbeddedImages : la génération ne change pas l'objet (troisième contre-revue, 02/11/2026)", () => {
  it("🔴 5R1 est la même image que 5R, comme `resolve` la lit", async () => {
    const read = await openEmbeddedImages(pdfOfImages([{ width: 4, height: 4 }]));
    const first = read("5R");
    expect(first).toBeDefined();
    expect(read("5R1")).toBe(first);
  });
});

describe("openEmbeddedImages : une référence mal formée n'emprunte pas la clé d'un objet (dernier tour de revue, 02/11/2026)", () => {
  it("🔴 « 5 » ne rend pas l'image de « 5R », dans les deux ordres", async () => {
    const bytes = pdfOfImages([{ width: 4, height: 4 }]);
    const a = await openEmbeddedImages(bytes);
    expect(a("5R")).toBeDefined();
    expect(a("5")).toBeUndefined();
    const b = await openEmbeddedImages(bytes);
    expect(b("5")).toBeUndefined();
    expect(b("5R")).toBeDefined();
  });
});

/** A one-page PDF whose object 5 is a pass-through JPEG picture (`/DCTDecode`) of `size` bytes: the JPEG start marker, then zeros. */
function pdfWithJpeg(size: number): Uint8Array {
  const text = (s: string): Buffer => Buffer.from(s, "latin1");
  const data = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size)]);
  const bodies: Buffer[] = [
    text("<< /Type /Catalog /Pages 2 0 R >>"),
    text("<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>"),
    text("<< /Type /Page /Parent 2 0 R >>"),
    text("<< /Length 0 >>\nstream\n\nendstream"),
    Buffer.concat([
      text(
        `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /BitsPerComponent 8 /ColorSpace /DeviceRGB /Filter /DCTDecode /Length ${data.length} >>\nstream\n`,
      ),
      data,
      text("\nendstream"),
    ]),
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

describe("openEmbeddedImages : un JPEG transmis tel quel est une vue du fichier (contre-revue de performance, 02/11/2026)", () => {
  it("🔴 un JPEG de 2 Mo non chiffré ne coûte rien au cache du document", async () => {
    const doc = openPdfObjects(pdfWithJpeg(2_000_000));
    const read = await openEmbeddedImages(doc);
    expect(read("5R")?.mimeType).toBe("image/jpeg");
    expect(documentCacheOf(doc).size).toBe(0);
  });
});
