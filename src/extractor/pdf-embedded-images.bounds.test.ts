/**
 * A Flate image stream is inflated with a ceiling derived from its DECLARED size
 * (width x height x channels, plus one filter byte per row under a PNG predictor), like `png-decode.ts`.
 * Without it a few kilobytes of zeros inflate to gigabytes before the length check can refuse them.
 */

import { PDFDocument } from "@cantoo/pdf-lib";
import { afterEach, describe, expect, it, vi } from "vitest";

const inflateOptions: Array<{ maxOutputLength?: number } | undefined> = [];
vi.mock("node:zlib", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:zlib")>();
  const inflateSync = (buf: Parameters<typeof actual.inflateSync>[0], options?: { maxOutputLength?: number }) => {
    inflateOptions.push(options);
    return actual.inflateSync(buf, options);
  };
  return { ...actual, inflateSync, default: { ...actual, inflateSync } };
});

import { openEmbeddedImages } from "./pdf-embedded-images";

const BOMB_BYTES = 5_000_000;
const rgbDict = {
  Type: "XObject",
  Subtype: "Image",
  Width: 10,
  Height: 10,
  BitsPerComponent: 8,
  ColorSpace: "DeviceRGB",
};

/** Raw zlib stream (no pdf-lib re-compression), so `inflated` bytes of zeros cost ~5 KB on disk. */
const registerRaw = (pdf: PDFDocument, inflated: number, dict: Record<string, unknown>) =>
  pdf.context.register(pdf.context.flateStream(new Uint8Array(inflated), dict as never));

afterEach(() => {
  inflateOptions.length = 0;
});

describe("pdf-embedded-images — inflate ceiling", () => {
  it("refuses a 10x10 RGB image whose stream inflates to 5 MB, and asks zlib for a ceiling", async () => {
    const pdf = await PDFDocument.create();
    const ref = registerRaw(pdf, BOMB_BYTES, rgbDict);
    const read = await openEmbeddedImages(await pdf.save());
    inflateOptions.length = 0;
    expect(read(`${ref.objectNumber}R`)).toBeUndefined();
    expect(inflateOptions.length).toBeGreaterThan(0);
    for (const o of inflateOptions) {
      expect(o?.maxOutputLength, "inflateSync called without maxOutputLength").toBeDefined();
      expect(o!.maxOutputLength!).toBeLessThan(10_000);
    }
  });

  it("a stream of exactly width x height x channels bytes still decodes to a PNG", async () => {
    const pdf = await PDFDocument.create();
    const ref = registerRaw(pdf, 10 * 10 * 3, rgbDict);
    const read = await openEmbeddedImages(await pdf.save());
    expect(read(`${ref.objectNumber}R`)?.mimeType).toBe("image/png");
  });

  it("a PNG-predictor stream of exactly height x (stride + 1) bytes still decodes (the ceiling counts the filter bytes)", async () => {
    const pdf = await PDFDocument.create();
    const ref = registerRaw(pdf, 10 * (10 * 3 + 1), {
      ...rgbDict,
      DecodeParms: { Predictor: 15, Colors: 3, BitsPerComponent: 8, Columns: 10 },
    });
    const read = await openEmbeddedImages(await pdf.save());
    expect(read(`${ref.objectNumber}R`)?.mimeType).toBe("image/png");
  });

  it("the SMask (alpha) path is bounded too: a 5 MB mask on a legitimate 10x10 image is refused, with a ceiling", async () => {
    const pdf = await PDFDocument.create();
    const mask = registerRaw(pdf, BOMB_BYTES, {
      Type: "XObject",
      Subtype: "Image",
      Width: 10,
      Height: 10,
      BitsPerComponent: 8,
      ColorSpace: "DeviceGray",
    });
    const ref = registerRaw(pdf, 10 * 10 * 3, { ...rgbDict, SMask: mask });
    const read = await openEmbeddedImages(await pdf.save());
    inflateOptions.length = 0;
    expect(read(`${ref.objectNumber}R`)).toBeUndefined();
    expect(inflateOptions.length).toBe(2);
    for (const o of inflateOptions)
      expect(o?.maxOutputLength, "inflateSync called without maxOutputLength").toBeDefined();
    expect(inflateOptions[1]!.maxOutputLength!).toBeLessThan(10_000);
  });

  it("a legitimate image with its mask still decodes to a 4-channel PNG", async () => {
    const pdf = await PDFDocument.create();
    const mask = registerRaw(pdf, 10 * 10, {
      Type: "XObject",
      Subtype: "Image",
      Width: 10,
      Height: 10,
      BitsPerComponent: 8,
      ColorSpace: "DeviceGray",
    });
    const ref = registerRaw(pdf, 10 * 10 * 3, { ...rgbDict, SMask: mask });
    const read = await openEmbeddedImages(await pdf.save());
    expect(read(`${ref.objectNumber}R`)?.mimeType).toBe("image/png");
  });
});
