/** A picture's size is bounded before a pixel is allocated, on every path of our image reader (security review of
 *  02/11/2026, findings 3, 4 and 5). The 25 M-pixel ceiling lived only on the pdf-lib path (`pdf-embedded-images.ts`);
 *  the Flate, CCITT and JPEG readers took `Width` and `Height` from the dictionary and sized their buffers from them, so a
 *  small file declaring a huge picture allocated gigabytes on a runtime that has 512 MB.
 *  The pictures here are just above the ceiling (26 M pixels or more), not gigabytes: unguarded they allocate tens of
 *  megabytes, which is enough to see them accepted and nowhere near enough to hurt the suite. */
import { deflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import jpeg from "jpeg-js";
import { describe, expect, it } from "vitest";

import { ccittImageObjectOf } from "./pdf-ccitt-images";
import { flateImageObjectOf } from "./pdf-flate-images";
import { MAX_EMBEDDED_IMAGE_PIXELS, pictureSizeOk } from "./pdf-image-pixels";
import { jpegImageObjectOf } from "./pdf-jpeg-images";
import { openPdfObjects } from "./pdf-objects/document";

interface PdfObject {
  readonly dict: string;
  readonly data?: Uint8Array;
}

/** A one-page PDF drawing the image object 5 as `Im`; `images` are objects 5, 6, ... (a soft mask is object 6). */
function pdfWithImages(images: readonly PdfObject[]): Uint8Array {
  const text = (s: string): Buffer => Buffer.from(s, "latin1");
  const bodies: Buffer[] = [
    text("<< /Type /Catalog /Pages 2 0 R >>"),
    text("<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>"),
    text("<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /XObject << /Im 5 0 R >> >> >>"),
    text("<< /Length 6 >>\nstream\n/Im Do\nendstream"),
    ...images.map((image) =>
      image.data === undefined
        ? text(`<< ${image.dict} >>`)
        : Buffer.concat([
            text(`<< ${image.dict} /Length ${image.data.length} >>\nstream\n`),
            Buffer.from(image.data),
            text("\nendstream"),
          ]),
    ),
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

const KINDS = { rgb: 1, rgba: 2 };
const sceneOf = (bytes: Uint8Array) => {
  const doc = openPdfObjects(bytes);
  return { doc, scope: { resources: doc.pages()[0]!.resources } };
};

/** 5 100 x 5 100 = 26.01 M pixels: just over the ceiling. */
const BIG = 5100;

describe("pictureSizeOk : la taille d'une image, avant tout tampon", () => {
  it("accepte une image réelle, refuse zéro, un non-entier, un énorme, et le dépassement du plafond de 25 M", () => {
    expect(MAX_EMBEDDED_IMAGE_PIXELS).toBe(25_000_000);
    expect(pictureSizeOk(2480, 3508)).toBe(true); // an A4 page at 300 dpi
    expect(pictureSizeOk(5000, 5000)).toBe(true); // exactly the ceiling
    expect(pictureSizeOk(5000, 5001)).toBe(false);
    expect(pictureSizeOk(0, 10)).toBe(false);
    expect(pictureSizeOk(10.5, 10)).toBe(false);
    expect(pictureSizeOk(Number.MAX_SAFE_INTEGER, 2)).toBe(false);
  });
});

describe("images Flate avec masque doux : taille bornée", () => {
  const maskOf = (width: number, height: number): PdfObject => ({
    dict: `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8`,
    data: Uint8Array.of(255),
  });
  const flateOf = (side: number): PdfObject => ({
    dict: `/Type /XObject /Subtype /Image /Width ${side} /Height ${side} /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /FlateDecode /SMask 6 0 R`,
    data: new Uint8Array(deflateSync(Buffer.alloc(Math.ceil(side / 8) * side))),
  });

  it("🔴 une image déclarée au-delà de 25 M de pixels n'est pas décodée (elle l'était : 100 Mo de RGBA pour 3 Ko de fichier)", () => {
    const { doc, scope } = sceneOf(pdfWithImages([flateOf(BIG), maskOf(1, 1)]));
    expect(flateImageObjectOf(doc, scope, "Im", KINDS)).toBeUndefined();
  });

  it("une image sous le plafond est décodée comme avant", () => {
    const { doc, scope } = sceneOf(pdfWithImages([flateOf(64), maskOf(1, 1)]));
    const image = flateImageObjectOf(doc, scope, "Im", KINDS);
    expect([image?.width, image?.height]).toEqual([64, 64]);
  });
});

describe("images CCITT : taille bornée", () => {
  const FIXTURE = new Uint8Array(readFileSync(join(__dirname, "../../fixtures/pdf/60-Image-CCITT-Groupe4.pdf")));
  const rawOfFixtureImage = (): Uint8Array => {
    const doc = openPdfObjects(FIXTURE);
    const stream = doc.resolve(doc.dictOf(doc.pages()[0]!.resources?.get("XObject"))?.get("Im1"));
    if (stream?.kind !== "stream") throw new Error("fixture has no Im1");
    return FIXTURE.slice(stream.start, stream.start + stream.length);
  };
  const ccittOf = (height: number): PdfObject => ({
    dict: `/Type /XObject /Subtype /Image /Width 24 /Height ${height} /BitsPerComponent 1 /ColorSpace /DeviceGray /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns 24 /Rows 20 /BlackIs1 false >>`,
    data: rawOfFixtureImage(),
  });

  it("🔴 une hauteur déclarée de 5 000 000 n'est pas suivie : le tampon ne se dimensionne pas sur le dictionnaire", () => {
    const bytes = pdfWithImages([ccittOf(5_000_000)]);
    const { doc, scope } = sceneOf(bytes);
    expect(ccittImageObjectOf(doc, bytes, scope, "Im", 1)).toBeUndefined();
  });

  it("la même image à sa vraie taille (24 x 20) est décodée", () => {
    const bytes = pdfWithImages([ccittOf(20)]);
    const { doc, scope } = sceneOf(bytes);
    expect(ccittImageObjectOf(doc, bytes, scope, "Im", 1)?.height).toBe(20);
  });
});

describe("images JPEG : taille bornée", () => {
  const SMALL = new Uint8Array(jpeg.encode({ data: Buffer.alloc(8 * 8 * 4, 128), width: 8, height: 8 }, 80).data);
  const jpegOf = (width: number, height: number): PdfObject => ({
    dict: `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`,
    data: SMALL,
  });

  it("🔴 une image déclarée à 6 000 x 6 000 pour un JPEG de 8 x 8 n'est pas rééchantillonnée à cette taille", () => {
    const { doc, scope } = sceneOf(pdfWithImages([jpegOf(6000, 6000)]));
    expect(jpegImageObjectOf(doc, scope, "Im", KINDS)).toBeUndefined();
  });

  it("la même image à sa vraie taille (8 x 8) est lue", () => {
    const { doc, scope } = sceneOf(pdfWithImages([jpegOf(8, 8)]));
    expect(jpegImageObjectOf(doc, scope, "Im", KINDS)?.width).toBe(8);
  });
});
