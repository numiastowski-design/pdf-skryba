/**
 * TWO READINGS OF THE SAME RULE, HELD AGAINST EACH OTHER (03/11/2026). `decodeToImageFilter` decides a picture's filter
 * chain while DECODING it; `chainRefusal` decides the same thing from the NAMES alone, without touching a byte, so that
 * a cause can be named for a picture nobody decoded (`pdf-image-refusal.ts`). Two readings that may disagree are worth
 * nothing: this file is the test that holds them equal, chain by chain.
 *
 * What `chainRefusal` cannot see is deliberate and written: a refusal only the BYTES give — a truncated stream, a wrong
 * checksum, the decoded ceiling. Those cases are listed apart below, and the asymmetry is asserted, not hidden.
 */
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { chainRefusal, decodeToImageFilter } from "./streams";
import { PdfObjectsRefusal } from "./refusal";
import type { PdfDict, PdfValue } from "./objects";

const name = (value: string): PdfValue => ({ kind: "name", value });
const array = (items: PdfValue[]): PdfValue => ({ kind: "array", items });
const dictOf = (filter?: PdfValue): PdfDict => new Map(filter === undefined ? [] : [["Filter", filter]]);

/** Does the decoding refuse this chain? `undefined` when it goes through, "filters" when it refuses it as a chain. */
const decodingRefusal = (dict: PdfDict, data: Uint8Array): "filters" | undefined => {
  try {
    decodeToImageFilter(data, dict);
    return undefined;
  } catch (error) {
    if (error instanceof PdfObjectsRefusal && error.reason === "filter-unsupported") return "filters";
    throw error;
  }
};

const flated = new Uint8Array(deflateSync(Buffer.from("x")));

describe("chainRefusal says exactly what decodeToImageFilter refuses, from the names alone", () => {
  it.each([
    ["no filter at all", undefined, flated],
    ["one Flate", name("FlateDecode"), flated],
    ["a one-element array", array([name("FlateDecode")]), flated],
    ["Flate then DCT: the image filter is last", array([name("FlateDecode"), name("DCTDecode")]), flated],
    ["DCT alone", name("DCTDecode"), flated],
    ["JPX alone", name("JPXDecode"), flated],
    ["RunLength", name("RunLengthDecode"), Uint8Array.from([0, 120, 128])],
    ["a filter we do not know", name("CryptDecode"), flated],
    ["DCT then Flate: an image filter that is NOT last", array([name("DCTDecode"), name("FlateDecode")]), flated],
    ["two image filters", array([name("DCTDecode"), name("JPXDecode")]), flated],
    // MAX_FILTER_CHAIN is 8, so NINE: the bound is checked before any byte is touched, on both sides.
    ["a chain longer than the bound", array(Array.from({ length: 9 }, () => name("FlateDecode"))), flated],
    ["a filter that is not a name", array([{ kind: "number", value: 1 }]), flated],
    ["/Filter holding a number", { kind: "number", value: 1 } satisfies PdfValue, flated],
  ])("%s", (_case, filter, data) => {
    const dict = dictOf(filter);
    expect(chainRefusal(dict)).toBe(decodingRefusal(dict, data));
  });
});

describe("what only the BYTES can refuse, and the names cannot", () => {
  it("a Flate stream that is not Flate: the names say nothing, the decoding refuses", () => {
    const dict = dictOf(name("FlateDecode"));
    expect(chainRefusal(dict)).toBeUndefined();
    expect(() => decodeToImageFilter(Uint8Array.from([1, 2, 3]), dict)).toThrow(PdfObjectsRefusal);
  });
});
