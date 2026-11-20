/** The Flate pictures with a soft mask (`pdf-flate-images.ts`). The prefixes are pdf.js's own output (`readImage`, RGBA),
 *  sha256 of its pixels, first 16 hex, measured on `fixtures/pdf/digital-flate-smask.pdf` (1/11/2026): ours are equal. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { flateImageObjectOf } from "./pdf-flate-images";
import { openPdfObjects } from "./pdf-objects/document";

const RGBA_32 = 4;
const KINDS = { rgb: 3, rgba: RGBA_32 };
const FILE = new Uint8Array(readFileSync(join(__dirname, "../../fixtures/pdf/digital-flate-smask.pdf")));

describe("flateImageObjectOf: une image Flate avec masque doux, en RVBA comme pdf.js", () => {
  it.each([
    ["Im1", "b73644e357bb40e4"],
    ["Im2", "d6084ec32145eec5"],
    ["Im3", "4a5f84049bb59100"],
  ])(
    "%s (RVB 8 × 6 avec un masque de 4 × 3 ; indexée ; indexée en 1 bit avec son masque 1 bit) donne les octets de pdf.js",
    (name, prefix) => {
      const doc = openPdfObjects(FILE);
      const image = flateImageObjectOf(doc, doc.pages()[0]!, name, KINDS)!;
      expect(image.kind).toBe(RGBA_32);
      expect(image.data.length).toBe(image.width * image.height * 4);
      expect(createHash("sha256").update(image.data).digest("hex").slice(0, 16)).toBe(prefix);
    },
  );
});

const RGB_24 = 3;

/** The `Im1` picture of the fixture, with one thing changed in the file: the mask's dictionary, or the picture's.
 *  Everything is done in memory, so the fixture on disk stays the one pdf.js was measured against. */
const withChange = async (change: (ctx: ChangeContext) => void): Promise<ReturnType<typeof flateImageObjectOf>> => {
  const { PDFDocument, PDFName, PDFRawStream } = await import("@cantoo/pdf-lib");
  const pdf = await PDFDocument.load(FILE);
  const xobjects = pdf.getPage(0).node.Resources()!.lookup(PDFName.of("XObject")) as import("@cantoo/pdf-lib").PDFDict;
  const pictureRef = xobjects.get(PDFName.of("Im1"))!;
  const picture = pdf.context.lookup(pictureRef) as import("@cantoo/pdf-lib").PDFRawStream;
  const maskRef = picture.dict.get(PDFName.of("SMask"))! as import("@cantoo/pdf-lib").PDFRef;
  const mask = pdf.context.lookup(maskRef) as import("@cantoo/pdf-lib").PDFRawStream;
  change({ pdf, PDFName, PDFRawStream, picture, mask, maskRef });
  const doc = openPdfObjects(await pdf.save());
  return flateImageObjectOf(doc, doc.pages()[0]!, "Im1", KINDS);
};

interface ChangeContext {
  pdf: import("@cantoo/pdf-lib").PDFDocument;
  PDFName: typeof import("@cantoo/pdf-lib").PDFName;
  PDFRawStream: typeof import("@cantoo/pdf-lib").PDFRawStream;
  picture: import("@cantoo/pdf-lib").PDFRawStream;
  mask: import("@cantoo/pdf-lib").PDFRawStream;
  maskRef: import("@cantoo/pdf-lib").PDFRef;
}

/** §7.4.5: literal runs only — a length byte of n - 1 followed by n bytes, and 128 to end. The simplest encoder that
 *  produces a stream a reader must undo; the point is the FILTER, not its compression. */
const runLengthEncode = (bytes: Uint8Array): Uint8Array => {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i += 128) {
    const chunk = bytes.subarray(i, Math.min(i + 128, bytes.length));
    out.push(chunk.length - 1, ...chunk);
  }
  out.push(128);
  return Uint8Array.from(out);
};

describe("flateImageObjectOf: une image sans masque doux est décodée en RVB (03/11/2026)", () => {
  it("la même image, son /SMask retiré, donne du RVB 24 bits et non plus rien", async () => {
    const image = (await withChange(({ picture, PDFName }) => picture.dict.delete(PDFName.of("SMask"))))!;
    expect(image.kind).toBe(RGB_24);
    expect(image.data.length).toBe(image.width * image.height * 3);
  });
});

describe("flateImageObjectOf: les deux refus de masque levés le 03/11/2026", () => {
  it("un masque gris déclaré ICCBased (N 1) est lu, et donne les mêmes octets que le même masque en DeviceGray", async () => {
    const reference = (await withChange(() => undefined))!;
    const image = (await withChange(({ pdf, PDFName, PDFRawStream, mask }) => {
      // An ICC profile our code never reads: `componentsOfSpace` reads /N and nothing else.
      const profile = new Uint8Array([0, 1, 2, 3]);
      const ref = pdf.context.register(PDFRawStream.of(pdf.context.obj({ N: 1, Length: profile.length }), profile));
      mask.dict.set(PDFName.of("ColorSpace"), pdf.context.obj([PDFName.of("ICCBased"), ref]));
    }))!;
    expect(image.kind).toBe(RGBA_32);
    expect(createHash("sha256").update(image.data).digest("hex")).toBe(
      createHash("sha256").update(reference.data).digest("hex"),
    );
  });

  it("un masque codé RunLength est lu, et donne les mêmes octets que le même masque en Flate", async () => {
    const reference = (await withChange(() => undefined))!;
    const image = (await withChange(({ pdf, PDFName, PDFRawStream, mask, maskRef }) => {
      const samples = inflateSync(mask.getContents());
      const dict = mask.dict;
      const coded = runLengthEncode(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
      dict.set(PDFName.of("Filter"), PDFName.of("RunLengthDecode"));
      dict.set(PDFName.of("Length"), pdf.context.obj(coded.length));
      dict.delete(PDFName.of("DecodeParms"));
      pdf.context.assign(maskRef, PDFRawStream.of(dict, coded));
    }))!;
    expect(image.kind).toBe(RGBA_32);
    expect(createHash("sha256").update(image.data).digest("hex")).toBe(
      createHash("sha256").update(reference.data).digest("hex"),
    );
  });
});

describe("flateImageObjectOf: un masque qu'on ne sait PAS lire refuse l'image entière", () => {
  // The product rule decides this, not caution: nothing invisible in the source is published. A picture published
  // opaque would SHOW what its mask hides, so the picture is left out and counted unreadable instead.
  // 🔴 THESE TWO ARE NOT GUARDS ON `maskSupported`, AND IT WAS MEASURED (03/11/2026): with `JPXDecode` added to its
  // filters and 16 bits added to its depths, both tests still pass. What refuses these masks is the stream reader's
  // own filter table (an image codec is never a stream filter) and `unpackSamples` (it unpacks 1, 2, 4 and 8 bits).
  // They assert the OUTCOME, which two layers hold, not the list in `maskSupported`.
  it("un /SMask en JPEG 2000 (jamais décodé) laisse l'image refusée", async () => {
    const image = await withChange(({ PDFName, mask }) => mask.dict.set(PDFName.of("Filter"), PDFName.of("JPXDecode")));
    expect(image).toBeUndefined();
  });

  it("un /SMask en 16 bits par composante laisse l'image refusée", async () => {
    const image = await withChange(({ pdf, PDFName, mask }) =>
      mask.dict.set(PDFName.of("BitsPerComponent"), pdf.context.obj(16)),
    );
    expect(image).toBeUndefined();
  });
});

/** `/Mask` and `/Decode` are read by their value, never by their presence: `/Mask 12 0 R` whose object 12 is free or
 *  null still makes `dict.has("Mask")` true, and an incrementally updated PDF whose mask object was deleted lost
 *  its image. */
describe("flateImageObjectOf: un renvoi mort n'est pas un masque", () => {
  it("🔴 une image dont le /Mask renvoie à un objet libre est lue, au lieu d'être perdue", async () => {
    const { PDFRef } = await import("@cantoo/pdf-lib");
    const image = await withChange(({ picture, PDFName }) => {
      picture.dict.delete(PDFName.of("SMask"));
      picture.dict.set(PDFName.of("Mask"), PDFRef.of(9999, 0));
    });
    expect(image?.kind).toBe(RGB_24);
  });

  it("🔴 et un /Decode mort non plus", async () => {
    const { PDFRef } = await import("@cantoo/pdf-lib");
    const image = await withChange(({ picture, PDFName }) => {
      picture.dict.delete(PDFName.of("SMask"));
      picture.dict.set(PDFName.of("Decode"), PDFRef.of(9998, 0));
    });
    expect(image?.kind).toBe(RGB_24);
  });
});
