/**
 * Reading an IMAGE object of the store (formerly pdf.js's), and its translation into a neutral
 * pixel format. Step 4c of the boundary (14/09/2026).
 *
 * `ImageKind` is INJECTED, as `OPS` is for `decodeOps`. (Before the removal of pdf.js, on 01/11/2026,
 * `pdf-images.pdfjs.test.ts` (deleted, see git history) checked that our three names matched those that `pdfjs-dist` published;
 * that file no longer exists.)
 */

import { describe, expect, it } from "vitest";

import { readImageObject } from "./pdf-images";

/** The real values of `pdfjs-dist` 6.2.108, reread from the objects of the
 *  corpus on 11/09/2026: `kind: 2` for the two badges of a report card. */
const ImageKind = { GRAYSCALE_1BPP: 1, RGB_24BPP: 2, RGBA_32BPP: 3 };

/** A minimal `objs`: `get` is synchronous and THROWS when the object is not
 *  ready — that is not an error, it is how this API says
 *  "not available". */
const objs = (entries: Record<string, unknown>): { get: (n: string) => unknown } => ({
  get: (n: string) => {
    if (!(n in entries)) throw new Error("not resolved yet");
    return entries[n];
  },
});

const image = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  width: 2,
  height: 2,
  kind: ImageKind.RGB_24BPP,
  data: new Uint8Array(2 * 2 * 3),
  ...over,
});

describe("readImageObject — trois formats de pixels, traduits en noms", () => {
  it("RGB 24 bits", () => {
    const read = readImageObject(objs({ img1: image() }), "img1", ImageKind);
    expect(read?.format).toBe("rgb-24");
    expect({ width: read?.width, height: read?.height }).toEqual({ width: 2, height: 2 });
  });

  it("RGBA 32 bits", () => {
    const data = new Uint8Array(2 * 2 * 4);
    const read = readImageObject(objs({ i: image({ kind: ImageKind.RGBA_32BPP, data }) }), "i", ImageKind);
    expect(read?.format).toBe("rgba-32");
  });

  it("gris sur un bit", () => {
    const read = readImageObject(objs({ i: image({ kind: ImageKind.GRAYSCALE_1BPP }) }), "i", ImageKind);
    expect(read?.format).toBe("gray-1");
  });
});

describe("readImageObject — ABSTENTION plutôt qu'image à moitié lue", () => {
  // A half-read image would be published AS an image: plausible and
  // wrong, exactly what we refuse everywhere else.

  it("objet pas encore résolu : `get` lève, on rend `undefined`", () => {
    expect(readImageObject(objs({}), "absent", ImageKind)).toBeUndefined();
  });

  it("objet nul ou pas un objet", () => {
    expect(readImageObject(objs({ i: null }), "i", ImageKind)).toBeUndefined();
    expect(readImageObject(objs({ i: 42 }), "i", ImageKind)).toBeUndefined();
  });

  it("dimensions absentes ou non numériques", () => {
    expect(readImageObject(objs({ i: image({ width: undefined }) }), "i", ImageKind)).toBeUndefined();
    expect(readImageObject(objs({ i: image({ height: "2" }) }), "i", ImageKind)).toBeUndefined();
  });

  it("données absentes", () => {
    expect(readImageObject(objs({ i: image({ data: undefined }) }), "i", ImageKind)).toBeUndefined();
  });

  it("UN `kind` INCONNU S'ABSTIENT, il ne devine pas", () => {
    // This is the case that matters for a version upgrade: if the store added
    // or renumbered a format (pdf.js could), we publish nothing rather than an image whose
    // channels would be interpreted wrongly.
    expect(readImageObject(objs({ i: image({ kind: 99 }) }), "i", ImageKind)).toBeUndefined();
    expect(readImageObject(objs({ i: image({ kind: undefined }) }), "i", ImageKind)).toBeUndefined();
  });
});
