/** The CMYK JPEG of a digital page, decoded by the vendored decoder (`vendor/jpeg-js-decoder.cjs`) and converted
 *  with our DeviceCMYK polynomial (`pdf-colour-ours.ts`). The fixture `fixtures/pdf/digital-cmyk-jpeg.pdf` is synthetic
 *  (a 64 × 48 gradient written by Pillow as a four-component Adobe JPEG). The two hashes are the output of pdf.js (since removed from the product) on the
 *  same stream: its raw components (`getData` for a PDF source) and its RGB (`forceRGB`), measured 1/11/2026: our raw
 *  components and our RGB are byte-for-byte equal to them. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { cmykHex } from "../pdf-colour-ours";
import { openPdfObjects } from "../pdf-objects/document";
import { decodeRaw } from "./vendor/jpeg-js-decoder.cjs";

const FILE = new Uint8Array(readFileSync(join(__dirname, "../../../fixtures/pdf/digital-cmyk-jpeg.pdf")));
const CMYK_SHA256 = "e00a2940bac03cbcc2f7bd5effda961d41a896bf7860e879dffe058376ad5d40";
const RGB_SHA256 = "38c1adcad450d11fafe2744d044ddcdbebc86eb9c1a25f4c27f5e57188341193";

/** The raw bytes of the page's image `Im1`, as the file holds them (a DCT stream, no further filter). */
function jpegOfFixture(): Uint8Array {
  const doc = openPdfObjects(FILE);
  const xobjects = doc.dictOf(doc.pages()[0]!.resources?.get("XObject"));
  const stream = doc.resolve(xobjects?.get("Im1"));
  if (stream?.kind !== "stream") throw new Error("fixture image missing");
  return FILE.subarray(stream.start, stream.start + stream.length);
}

describe("le JPEG CMJN : décodé par le décodeur vendoré, converti par notre polynôme", () => {
  it("les composantes brutes sont celles de pdf.js, octet pour octet", () => {
    const raw = decodeRaw(jpegOfFixture(), {});
    expect([raw.width, raw.height, raw.numComponents, raw.ycck]).toEqual([64, 48, 4, false]);
    expect(createHash("sha256").update(raw.data).digest("hex")).toBe(CMYK_SHA256);
  });

  it("la conversion en RVB est celle de pdf.js (forceRGB), octet pour octet", () => {
    const raw = decodeRaw(jpegOfFixture(), {});
    const rgb = new Uint8Array(raw.width * raw.height * 3);
    for (let p = 0; p < raw.width * raw.height; p += 1) {
      const hex = cmykHex(
        raw.data[p * 4]! / 255,
        raw.data[p * 4 + 1]! / 255,
        raw.data[p * 4 + 2]! / 255,
        raw.data[p * 4 + 3]! / 255,
      );
      rgb.set([parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)], p * 3);
    }
    expect(createHash("sha256").update(rgb).digest("hex")).toBe(RGB_SHA256);
  });
});
