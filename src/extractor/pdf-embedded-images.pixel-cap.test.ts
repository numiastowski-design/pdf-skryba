/**
 * The embedded-image reader refuses a declared size above `MAX_EMBEDDED_IMAGE_PIXELS` BEFORE inflating (the same
 * width x height test pdf.js applied before its removal), so the largest buffer it can ever hold is that cap x channels.
 */

import { PDFDocument } from "@cantoo/pdf-lib";
import { afterEach, describe, expect, it, vi } from "vitest";

let inflateCalls = 0;
vi.mock("node:zlib", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:zlib")>();
  const inflateSync = (buf: Parameters<typeof actual.inflateSync>[0], options?: { maxOutputLength?: number }) => {
    inflateCalls++;
    return actual.inflateSync(buf, options);
  };
  return { ...actual, inflateSync, default: { ...actual, inflateSync } };
});

import { openEmbeddedImages } from "./pdf-embedded-images";

const registerRaw = (pdf: PDFDocument, inflated: number, dict: Record<string, unknown>) =>
  pdf.context.register(pdf.context.flateStream(new Uint8Array(inflated), dict as never));

afterEach(() => {
  inflateCalls = 0;
});

describe("pdf-embedded-images — pixel cap", () => {
  it("a 6000 x 6000 RGB image (36 M pixels, above the 25 M cap) is refused without inflating", async () => {
    const pdf = await PDFDocument.create();
    const ref = pdf.context.register(
      pdf.context.flateStream(new Uint8Array(10), {
        Type: "XObject",
        Subtype: "Image",
        Width: 6000,
        Height: 6000,
        BitsPerComponent: 8,
        ColorSpace: "DeviceRGB",
      }),
    );
    const read = await openEmbeddedImages(await pdf.save());
    inflateCalls = 0;
    expect(read(`${ref.objectNumber}R`)).toBeUndefined();
    expect(inflateCalls).toBe(0);
  });

  it("a 4000 x 4000 gray image (16 M pixels, under the cap) is still decoded to a PNG", async () => {
    const pdf = await PDFDocument.create();
    const ref = registerRaw(pdf, 4000 * 4000, {
      Type: "XObject",
      Subtype: "Image",
      Width: 4000,
      Height: 4000,
      BitsPerComponent: 8,
      ColorSpace: "DeviceGray",
    });
    const read = await openEmbeddedImages(await pdf.save());
    expect(read(`${ref.objectNumber}R`)?.mimeType).toBe("image/png");
  });
});
