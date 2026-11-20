/**
 * WHY a picture is refused, one cause at a time (`pdf-image-refusal.ts`, 03/11/2026). Each case is a dictionary built
 * here, because a cause must be nameable for a picture NOBODY decoded — no bytes are read.
 * 🔴 WHAT THESE TESTS GUARD, AND IT IS NOT COSMETIC: the classifier calls the very predicates the decoders decide on
 * (`imageFilterOf`, `chainRefusal`, `pictureSizeOk`, `maskSupported`, `componentsOfSpace`, `decodeArrayOf`), so a
 * declaration the decoders start to handle stops being a cause here on the same day. The order is asserted too (the
 * most specific first), since a JPX picture that is also too large must say `codec`: that is the fact that decides it.
 * `bytes` is the residue and it is tested as such: everything declared is ours to read.
 */
import { describe, expect, it } from "vitest";

import { pictureRefusalOf } from "./pdf-image-refusal";
import type { PdfObjectsDocument } from "./pdf-objects/document";
import type { PdfDict, PdfValue } from "./pdf-objects/objects";
import { MAX_EMBEDDED_IMAGE_PIXELS } from "./pdf-image-pixels";

const name = (value: string): PdfValue => ({ kind: "name", value });
const num = (value: number): PdfValue => ({ kind: "number", value });

/** A document reduced to what the classifier asks of it: direct values only, which is what these dictionaries hold. */
const doc = {
  resolve: (value: PdfValue | undefined) => value,
  dictOf: (value: PdfValue | undefined) =>
    value?.kind === "dict" ? value.entries : value?.kind === "stream" ? value.dict : undefined,
} as unknown as PdfObjectsDocument;

/** A sound 8-bit RGB picture of 10 × 10, Flate-coded: the shape every case below starts from. */
const sound = (extra: [string, PdfValue][] = []): PdfDict =>
  new Map<string, PdfValue>([
    ["Subtype", name("Image")],
    ["Width", num(10)],
    ["Height", num(10)],
    ["BitsPerComponent", num(8)],
    ["ColorSpace", name("DeviceRGB")],
    ["Filter", name("FlateDecode")],
    ...extra,
  ]);

const stream = (dict: PdfDict): PdfValue => ({ kind: "stream", dict, start: 0, length: 0 }) as unknown as PdfValue;

describe("pictureRefusalOf names one cause per picture", () => {
  it("a sound picture whose reading failed all the same is `bytes` — the residue, and the one worth looking at", () => {
    expect(pictureRefusalOf(doc, sound())).toBe("bytes");
  });

  it("JPEG 2000 and JBIG2 are `codec`: the written limit of the 05/10/2026, nothing to do about them", () => {
    expect(pictureRefusalOf(doc, sound([["Filter", name("JPXDecode")]]))).toBe("codec");
    expect(pictureRefusalOf(doc, sound([["Filter", name("JBIG2Decode")]]))).toBe("codec");
  });

  it("CCITT is NOT a codec cause: we decode it ourselves", () => {
    expect(pictureRefusalOf(doc, sound([["Filter", name("CCITTFaxDecode")]]))).toBe("bytes");
  });

  it("a chain we refuse is `filters` — here an image filter that is not the last", () => {
    expect(
      pictureRefusalOf(doc, sound([["Filter", { kind: "array", items: [name("DCTDecode"), name("FlateDecode")] }]])),
    ).toBe("filters");
  });

  it("a chain we DO undo is not a cause at all: Flate then DCT reads", () => {
    expect(
      pictureRefusalOf(doc, sound([["Filter", { kind: "array", items: [name("FlateDecode"), name("DCTDecode")] }]])),
    ).toBe("bytes");
  });

  it("past the pixel bound it is `too-large`", () => {
    const side = Math.ceil(Math.sqrt(MAX_EMBEDDED_IMAGE_PIXELS)) + 1;
    expect(
      pictureRefusalOf(
        doc,
        sound([
          ["Width", num(side)],
          ["Height", num(side)],
        ]),
      ),
    ).toBe("too-large");
  });

  it("a stencil `/Mask`, or an `/SMask` we cannot read, is `mask`", () => {
    expect(pictureRefusalOf(doc, sound([["Mask", num(1)]]))).toBe("mask");
    expect(pictureRefusalOf(doc, sound([["ImageMask", { kind: "bool", value: true }]]))).toBe("mask");
    // A soft mask in JPEG 2000: a stream, and one `maskSupported` refuses.
    const badMask = stream(
      new Map<string, PdfValue>([
        ["ColorSpace", name("DeviceGray")],
        ["BitsPerComponent", num(8)],
        ["Filter", name("JPXDecode")],
      ]),
    );
    expect(pictureRefusalOf(doc, sound([["SMask", badMask]]))).toBe("mask");
  });

  it("an `/SMask` we DO read is not a cause", () => {
    const goodMask = stream(
      new Map<string, PdfValue>([
        ["ColorSpace", name("DeviceGray")],
        ["BitsPerComponent", num(8)],
        ["Filter", name("FlateDecode")],
      ]),
    );
    expect(pictureRefusalOf(doc, sound([["SMask", goodMask]]))).toBe("bytes");
  });

  it("a size that is MISSING is `shape`, not `too-large`: nothing was measured", () => {
    const noSize = new Map([...sound()].filter(([key]) => key !== "Width"));
    expect(pictureRefusalOf(doc, noSize)).toBe("shape");
  });

  it("a colour space, a depth or a `/Decode` we do not handle is `shape`", () => {
    expect(pictureRefusalOf(doc, sound([["ColorSpace", name("DeviceCMYK")]]))).toBe("shape");
    expect(pictureRefusalOf(doc, sound([["BitsPerComponent", num(16)]]))).toBe("shape");
    expect(pictureRefusalOf(doc, sound([["Decode", { kind: "array", items: [num(0), num(1), num(0)] }]]))).toBe(
      "shape",
    );
  });

  it("the most specific cause wins: a JPX picture that is ALSO too large says `codec`", () => {
    const side = Math.ceil(Math.sqrt(MAX_EMBEDDED_IMAGE_PIXELS)) + 1;
    const dict = sound([
      ["Filter", name("JPXDecode")],
      ["Width", num(side)],
      ["Height", num(side)],
    ]);
    expect(pictureRefusalOf(doc, dict)).toBe("codec");
  });
});
