/** The CMYK JPEG of a digital page, as the image reader takes it (`pdf-jpeg-images.ts`). The RGB hash is the output of pdf.js (since removed)
 *  (`forceRGB`) on the same stream (1/11/2026): our conversion gives it byte for byte. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { jpegImageObjectOf } from "./pdf-jpeg-images";
import { openPdfObjects } from "./pdf-objects/document";

const RGB_24 = 3;
const KINDS = { rgb: RGB_24, rgba: 4 };
const RGB_SHA256 = "38c1adcad450d11fafe2744d044ddcdbebc86eb9c1a25f4c27f5e57188341193";
const FILE = new Uint8Array(readFileSync(join(__dirname, "../../fixtures/pdf/digital-cmyk-jpeg.pdf")));

describe("jpegImageObjectOf: a CMYK JPEG image read by our decoder", () => {
  it("gives the RGB pixels pdf.js gave (measured 1/11/2026), at the image's size, in 24-bit format", () => {
    const doc = openPdfObjects(FILE);
    const image = jpegImageObjectOf(doc, doc.pages()[0]!, "Im1", KINDS)!;
    expect([image.width, image.height, image.kind, image.data.length]).toEqual([64, 48, RGB_24, 64 * 48 * 3]);
    expect(createHash("sha256").update(image.data).digest("hex")).toBe(RGB_SHA256);
  });

  it("an image that is not a CMYK JPEG is not decoded here", () => {
    const ccitt = new Uint8Array(readFileSync(join(__dirname, "../../fixtures/pdf/60-Image-CCITT-Groupe4.pdf")));
    const doc = openPdfObjects(ccitt);
    expect(jpegImageObjectOf(doc, doc.pages()[0]!, "Im1", KINDS)).toBeUndefined();
  });
});

const RGB_GRAY_FILE = new Uint8Array(readFileSync(join(__dirname, "../../fixtures/pdf/digital-rgb-gray-jpeg.pdf")));

describe("jpegImageObjectOf: the RGB and grey JPEGs", () => {
  it("the grey one gives exactly the bytes pdf.js gave (forceRGB)", () => {
    const doc = openPdfObjects(RGB_GRAY_FILE);
    const image = jpegImageObjectOf(doc, doc.pages()[0]!, "Im2", KINDS)!;
    expect([image.width, image.height, image.kind]).toEqual([64, 48, RGB_24]);
    expect(createHash("sha256").update(image.data).digest("hex")).toBe(
      "33d60156e7bfa766719ffa3a9b940512f62904fcb30bc53ca99664d416f09678",
    );
  });

  it("the RGB one gives exactly the bytes pdf.js gave (forceRGB): pdf.js's YCbCr constants and rounding", () => {
    const doc = openPdfObjects(RGB_GRAY_FILE);
    const image = jpegImageObjectOf(doc, doc.pages()[0]!, "Im1", KINDS)!;
    expect(createHash("sha256").update(image.data).digest("hex")).toBe(
      "686f322e506e14970afa96958021a44c5575a906127aa439639b5feb87fdbb7b",
    );
  });
});

/** The RGB fixture's page, with the image `Im1`'s dictionary edited by `edit` (pdf-lib, in memory). */
async function fixtureWithImage(
  edit: (dict: import("@cantoo/pdf-lib").PDFDict, ctx: import("@cantoo/pdf-lib").PDFContext) => void,
): Promise<Uint8Array> {
  const { PDFDocument, PDFName } = await import("@cantoo/pdf-lib");
  const pdf = await PDFDocument.load(RGB_GRAY_FILE);
  const ctx = pdf.context;
  const page = pdf.getPage(0);
  const xobjects = page.node.Resources()!.lookup(PDFName.of("XObject")) as import("@cantoo/pdf-lib").PDFDict;
  const ref = xobjects.get(PDFName.of("Im1"))!;
  const stream = ctx.lookup(ref) as import("@cantoo/pdf-lib").PDFRawStream;
  const dict = stream.dict;
  edit(dict, ctx);
  return pdf.save();
}

describe("jpegImageObjectOf: the refused cases are not decoded here", () => {
  it("a soft mask: refused", async () => {
    const { PDFName } = await import("@cantoo/pdf-lib");
    const smask = await fixtureWithImage((dict, ctx) => dict.set(PDFName.of("SMask"), ctx.obj(1)));
    for (const file of [smask]) {
      const doc = openPdfObjects(file);
      expect(jpegImageObjectOf(doc, doc.pages()[0]!, "Im1", KINDS)).toBeUndefined();
    }
  });
});

const YCCK_FILE = new Uint8Array(readFileSync(join(__dirname, "../../fixtures/pdf/digital-ycck-jpeg.pdf")));

describe("jpegImageObjectOf: a YCCK JPEG (transform 2, four components)", () => {
  it("gives exactly the RGB bytes pdf.js gave (forceRGB), after pdf.js's YCCK -> CMYK conversion", () => {
    const doc = openPdfObjects(YCCK_FILE);
    const image = jpegImageObjectOf(doc, doc.pages()[0]!, "Im1", KINDS)!;
    expect([image.width, image.height, image.kind]).toEqual([64, 48, RGB_24]);
    expect(createHash("sha256").update(image.data).digest("hex")).toBe(
      "e4ba8ebba36222a0c94814375dab4fba59aec57ed23f933e2acc33834899b0b9",
    );
  });
});

const DECODE_FILE = new Uint8Array(readFileSync(join(__dirname, "../../fixtures/pdf/digital-decode-jpeg.pdf")));

describe("jpegImageObjectOf: a /Decode, applied as pdf.js applied it (sample decoding)", () => {
  // The prefixes are pdf.js's own (sha256 of its pixels, first 16 hex), measured on this fixture (1/11/2026).
  it.each([
    ["DecodeInv", "f75a7a101d02c2aa"],
    ["DecodeHalf", "64496ba077a22126"],
    ["GrayDecode", "2f88d8f029a657c8"],
  ])("%s gives the bytes pdf.js gave", (name, prefix) => {
    const doc = openPdfObjects(DECODE_FILE);
    const image = jpegImageObjectOf(doc, doc.pages()[0]!, name, KINDS)!;
    expect(createHash("sha256").update(image.data).digest("hex").slice(0, 16)).toBe(prefix);
  });
});

describe("jpegImageObjectOf: a JPEG in an encrypted PDF (decrypted stream, filter as an array)", () => {
  // Fixture 59 is a made-up ENCRYPTED document (its generator, through qpdf) whose image `Im1` is the file
  // `fixtures/jpeg/ours-420-64x48.jpg`, its filter the one-element array [/DCTDecode]. The same file put in a CLEAR PDF
  // built here gives the pixels to expect. The equality with pdf.js's pixels on a real encrypted document (measured
  // 1/11/2026) is held by the application's tests, which carry that document.
  it("Im1 of the encrypted document gives the pixels of the same JPEG read in the clear", async () => {
    const jpeg = new Uint8Array(readFileSync(join(__dirname, "../../fixtures/jpeg/ours-420-64x48.jpg")));
    const { PDFDocument, PDFName } = await import("@cantoo/pdf-lib");
    const clearPdf = await PDFDocument.create();
    const ref = clearPdf.context.register(
      clearPdf.context.stream(jpeg, {
        Type: "XObject",
        Subtype: "Image",
        Width: 64,
        Height: 48,
        ColorSpace: "DeviceRGB",
        BitsPerComponent: 8,
        Filter: "DCTDecode",
      }),
    );
    clearPdf.addPage([200, 200]).node.normalizedEntries().XObject.set(PDFName.of("Im1"), ref);
    const clearDoc = openPdfObjects(await clearPdf.save());
    const clear = jpegImageObjectOf(clearDoc, clearDoc.pages()[0]!, "Im1", KINDS)!;
    expect([clear.width, clear.height, clear.data.length]).toEqual([64, 48, 64 * 48 * 3]);

    const file = new Uint8Array(readFileSync(join(__dirname, "../../fixtures/pdf/59-Document-Chiffre-RC4.pdf")));
    // The stream is NOT the JPEG in the file as written: an unencrypted fixture would make this test say nothing.
    expect(Buffer.from(file).includes(Buffer.from(jpeg.subarray(0, 64)))).toBe(false);
    const doc = openPdfObjects(file);
    const image = jpegImageObjectOf(doc, doc.pages()[0]!, "Im1", KINDS)!;
    expect([image.width, image.height]).toEqual([64, 48]);
    expect(createHash("sha256").update(image.data).digest("hex")).toBe(
      createHash("sha256").update(clear.data).digest("hex"),
    );
  });
});

describe("jpegImageObjectOf: a size that differs from the JPEG's: resampled to the drawn size, as pdf.js did", () => {
  // The fixture draws a 64 × 48 JPEG at 10 × 10. pdf.js resampled it to the drawn size: its pixels, first 16 hex of sha256
  // (measured 1/11/2026, byte-identical to ours).
  it("SizeMismatch gives the bytes pdf.js gave", () => {
    const doc = openPdfObjects(DECODE_FILE);
    const image = jpegImageObjectOf(doc, doc.pages()[0]!, "SizeMismatch", KINDS)!;
    expect([image.width, image.height]).toEqual([10, 10]);
    expect(createHash("sha256").update(image.data).digest("hex").slice(0, 16)).toBe("3bb50ebc62f0a7b0");
  });
});

describe("jpegImageObjectOf: a CMYK JPEG whose size differs, resampled as pdf.js did", () => {
  // The fixture declares a 64 × 48 CMYK JPEG as 10 × 10. pdf.js drew it resampled, as RGB 10 × 10 (measured 1/11/2026).
  it("gives the RGB bytes pdf.js gave", () => {
    const file = new Uint8Array(readFileSync(join(__dirname, "../../fixtures/pdf/digital-cmyk-size-jpeg.pdf")));
    const doc = openPdfObjects(file);
    const image = jpegImageObjectOf(doc, doc.pages()[0]!, "Im1", KINDS)!;
    expect([image.width, image.height]).toEqual([10, 10]);
    expect(createHash("sha256").update(image.data).digest("hex").slice(0, 16)).toBe("ec45c9c367c5e427");
  });
});

/** What the object holds, not what it would show. Its `data` is a lazy accessor: a JPEG the page republishes byte for
 *  byte is never decoded, and the object then holds its compressed bytes only. Charged at the price of its pixels
 *  alone, it evicted from the document cache the entries really held (page content, forms). */
describe("jpegImageObjectOf: the bytes the object may hold", () => {
  it("🔴 declares its compressed bytes PLUS the pixels a decoding would materialise, before and after", () => {
    // Failed with `heldBytes` absent (pixels alone, without the `raw` the closure keeps), then with `raw.length`
    // alone before decoding (far less than what is held once the byte-for-byte path abstains). A ceiling is held
    // by excess.
    const doc = openPdfObjects(FILE);
    const image = jpegImageObjectOf(doc, doc.pages()[0]!, "Im1", KINDS)!;
    const pixels = image.width * image.height * RGB_24;
    const declared = image.heldBytes!;
    expect(declared).toBeGreaterThan(pixels);
    expect(image.data.length).toBe(pixels);
    expect(image.heldBytes).toBe(declared);
  });
});
