/**
 * Characterisation (12/10/2026) of how `openEmbeddedImages` reads a FlateDecode image's `DecodeParms`: absent, not a
 * dictionary, `Predictor` 1, below 10, and the PNG predictor's three checks. A 2x1 RGB image: 6 raw bytes.
 */
import { PDFDocument } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";
import { openEmbeddedImages } from "./pdf-embedded-images";

async function readFlate(data: number[], decodeParms: unknown): Promise<string | undefined> {
  const pdf = await PDFDocument.create();
  const dict: Record<string, unknown> = {
    Type: "XObject",
    Subtype: "Image",
    Width: 2,
    Height: 1,
    BitsPerComponent: 8,
    ColorSpace: "DeviceRGB",
  };
  if (decodeParms !== undefined) dict.DecodeParms = decodeParms;
  const ref = pdf.context.register(pdf.context.flateStream(Uint8Array.from(data), dict as never));
  const read = await openEmbeddedImages(await pdf.save());
  return read(`${ref.objectNumber}R`)?.mimeType;
}

const SIX = [1, 2, 3, 4, 5, 6];
const png = { Predictor: 15, Colors: 3, BitsPerComponent: 8, Columns: 2 };

describe("DecodeParms of an embedded FlateDecode image", () => {
  it("none: the raw bytes must be exactly width x height x channels", async () => {
    expect(await readFlate(SIX, undefined)).toBe("image/png");
    expect(await readFlate(SIX.slice(0, 5), undefined)).toBeUndefined();
  });

  it("Predictor 1 (or absent from the dictionary): same length test", async () => {
    expect(await readFlate(SIX, { Predictor: 1 })).toBe("image/png");
    expect(await readFlate(SIX.slice(0, 5), { Predictor: 1 })).toBeUndefined();
    expect(await readFlate(SIX, {})).toBe("image/png");
    expect(await readFlate(SIX.slice(0, 5), {})).toBeUndefined();
  });

  it("a predictor between 2 and 9 (TIFF) is refused", async () => {
    expect(await readFlate(SIX, { Predictor: 2 })).toBeUndefined();
  });

  it("DecodeParms that is not a dictionary is refused", async () => {
    expect(await readFlate(SIX, 5)).toBeUndefined();
  });

  it("a PNG predictor is undone only when Colors, BitsPerComponent and Columns agree with the image", async () => {
    const filtered = [1, 10, 20, 30, 5, 5, 5];
    expect(await readFlate(filtered, png)).toBe("image/png");
    expect(await readFlate(filtered, { ...png, Colors: 1 })).toBeUndefined();
    expect(await readFlate(filtered, { ...png, BitsPerComponent: 4 })).toBeUndefined();
    expect(await readFlate(filtered, { ...png, Columns: 3 })).toBeUndefined();
  });
});
