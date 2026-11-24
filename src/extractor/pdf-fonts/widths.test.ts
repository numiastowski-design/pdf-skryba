/**
 * Step 3 of the unicode layer (proof of concept of the reader without pdf.js): the ADVANCE of a glyph, in thousandths of an em — the last
 * service pdf.js rendered to the text path. ISO 32000-1:2008 §9.6.2.1 (`/Widths`, `/FirstChar`),
 * §9.8.1 (`/MissingWidth`), §9.7.4.3 (`/W` and `/DW` of a CID font).
 * Tests only, written before the code. The contract fixed here:
 *   fontWidths(reader, font) -> (code: number) => number | undefined
 * `undefined` is an ABSTENTION (nothing says the width), never a zero nor an average.
 */
import { describe, expect, it } from "vitest";

import type { PdfDict, PdfValue } from "../pdf-objects/objects";
import type { FontReader } from "./font-text";
import { fontWidths } from "./widths";

const name = (value: string): PdfValue => ({ kind: "name", value });
const number = (value: number): PdfValue => ({ kind: "number", value });
const array = (items: PdfValue[]): PdfValue => ({ kind: "array", items });
const dict = (entries: Record<string, PdfValue>): PdfValue => ({
  kind: "dict",
  entries: new Map(Object.entries(entries)),
});

const reader: FontReader = {
  resolve: (value) => value,
  dictOf: (value) => (value?.kind === "dict" ? value.entries : undefined),
  streamBytes: () => new Uint8Array(0),
};

const fontOf = (entries: Record<string, PdfValue>): PdfDict => new Map(Object.entries(entries));

describe("fontWidths: a simple font (9.6.2.1)", () => {
  it("reads `/Widths` from `/FirstChar`", () => {
    const width = fontWidths(
      reader,
      fontOf({ Subtype: name("TrueType"), FirstChar: number(65), Widths: array([500, 600, 700].map(number)) }),
    );
    expect([width(65), width(66), width(67)]).toEqual([500, 600, 700]);
  });

  it("falls back on `/MissingWidth` outside the range, and abstains without it", () => {
    const withMissing = fontWidths(
      reader,
      fontOf({
        Subtype: name("TrueType"),
        FirstChar: number(65),
        Widths: array([number(500)]),
        FontDescriptor: dict({ MissingWidth: number(250) }),
      }),
    );
    expect([withMissing(65), withMissing(200)]).toEqual([500, 250]);

    const without = fontWidths(
      reader,
      fontOf({ Subtype: name("TrueType"), FirstChar: number(65), Widths: array([number(500)]) }),
    );
    expect(without(200)).toBeUndefined();
  });

  it("reads the metrics of a STANDARD font, which has no `/Widths` (9.6.2.2)", () => {
    // Adobe's advances, by glyph NAME: `A` is 667 thousandths of an em in Helvetica, 722 in Helvetica-Bold.
    const helvetica = fontWidths(reader, fontOf({ Subtype: name("Type1"), BaseFont: name("Helvetica") }));
    expect([helvetica(65), helvetica(32)]).toEqual([667, 278]);
    expect(fontWidths(reader, fontOf({ Subtype: name("Type1"), BaseFont: name("Helvetica-Bold") }))(65)).toBe(722);
  });

  it("recognises a standard font under its subset prefix and under its alias (9.6.4)", () => {
    expect(fontWidths(reader, fontOf({ Subtype: name("TrueType"), BaseFont: name("ABCDEF+Helvetica") }))(65)).toBe(667);
    expect(fontWidths(reader, fontOf({ Subtype: name("TrueType"), BaseFont: name("Arial") }))(65)).toBe(667);
  });

  it("follows the internal encoding of Symbol, which is not Standard (9.6.6.1)", () => {
    // 0x61 is `alpha` in Symbol, and `a` in Standard: the width depends on it.
    expect(fontWidths(reader, fontOf({ Subtype: name("Type1"), BaseFont: name("Symbol") }))(0x61)).toBe(631);
  });

  it("ABSTAINS when a NON-standard font declares no width", () => {
    const width = fontWidths(reader, fontOf({ Subtype: name("TrueType"), BaseFont: name("MaPoliceMaison") }));
    expect(width(65)).toBeUndefined();
  });

  it("ignores a width that is not a number rather than reading it as zero", () => {
    const width = fontWidths(
      reader,
      fontOf({
        Subtype: name("TrueType"),
        FirstChar: number(65),
        Widths: array([number(500), name("x"), number(700)]),
      }),
    );
    expect([width(65), width(66), width(67)]).toEqual([500, undefined, 700]);
  });
});

describe("fontWidths: a CID font (9.7.4.3)", () => {
  /** `/W` has two forms: `c [w w w]` and `cFirst cLast w`, mixed in the same array. */
  const cidFont = (w: PdfValue, extra: Record<string, PdfValue> = {}): PdfDict =>
    fontOf({
      Subtype: name("Type0"),
      Encoding: name("Identity-H"),
      DescendantFonts: array([dict({ Subtype: name("CIDFontType2"), W: w, ...extra })]),
    });

  it("reads the form `c [w w w]`", () => {
    const width = fontWidths(reader, cidFont(array([number(10), array([500, 600].map(number))])));
    expect([width(10), width(11)]).toEqual([500, 600]);
  });

  it("reads the form `cFirst cLast w`", () => {
    const width = fontWidths(reader, cidFont(array([number(20), number(22), number(750)])));
    expect([width(20), width(21), width(22)]).toEqual([750, 750, 750]);
  });

  it("mixes the two forms in the same array", () => {
    const width = fontWidths(
      reader,
      cidFont(array([number(1), array([number(100)]), number(5), number(6), number(900)])),
    );
    expect([width(1), width(5), width(6)]).toEqual([100, 900, 900]);
  });

  it("does not loop a hundred million times on a NEGATIVE range start", () => {
    // Security review of 31/10/2026: `-100000000 0 1` fits in twenty bytes and caused a hundred million writes
    // up to `RangeError: Map maximum size exceeded` — an error that is not a refusal, after ~450 MB of heap.
    const width = fontWidths(reader, cidFont(array([number(-100_000_000), number(0), number(500)])));
    expect(width(0)).toBe(500);
    expect(width(-1)).toBe(1000);
  });

  it("bounds the advances placed by the WHOLE array, not per range", () => {
    // The per-range ceiling did not bound the number of ranges: each fourteen-byte `0 65535 500` placed
    // 65,536 advances. Here, two full ranges: the second places nothing anymore, and nothing loops for long.
    const full = [number(0), number(65_535), number(500), number(0), number(65_535), number(700)];
    const width = fontWidths(reader, cidFont(array(full)));
    expect(width(0)).toBe(500);
    expect(width(65_535)).toBe(500);
  });

  it("takes `/DW` for a CID that `/W` does not name, and 1000 by default (9.7.4.3)", () => {
    const withDw = fontWidths(reader, cidFont(array([]), { DW: number(333) }));
    expect(withDw(42)).toBe(333);
    expect(fontWidths(reader, cidFont(array([])))(42)).toBe(1000);
  });
});

/** The budget of a font with a predefined CMap. Such a font reads its `/W`, hence charges it to the document's table
 *  budget: `/W [0 65535 1000]` fits in fourteen bytes and sets 65,536 advances, so a few such fonts would refuse the
 *  document (`font-tables-too-many`). Those entries are dead: the CIDs asked for come from the embedded CMap table,
 *  which yields none past the last of its collection. */
describe("fontWidths: the /W of a predefined CMap pays only for the CIDs the collection holds", () => {
  const cjkFont = (W: PdfValue): PdfDict =>
    fontOf({
      Subtype: name("Type0"),
      Encoding: name("UniCNS-UCS2-H"),
      DescendantFonts: array([dict({ Subtype: name("CIDFontType0"), DW: number(1000), W })]),
    });

  it("🔴 a range of all sixteen-bit CIDs charges only the collection, not 65 536 entries", () => {
    // Failure value: budget.entries === 65536 (sixteen such fonts refuse the document).
    const budget = { entries: 0 };
    const width = fontWidths(reader, cjkFont(array([number(0), number(65_535), number(1234)])), budget);
    expect(budget.entries).toBeGreaterThan(1000);
    expect(budget.entries).toBeLessThan(40_000);
    // The width is still read: 'A' (U+0041) is CID 34 in Adobe-CNS1.
    expect(width(0x41)).toBe(1234);
  });

  it("an entry for a CID the collection does not have is ignored, and changes no width", () => {
    const budget = { entries: 0 };
    const width = fontWidths(reader, cjkFont(array([number(65_000), array([number(777)])])), budget);
    expect(budget.entries).toBe(0);
    expect(width(0x41)).toBe(1000);
  });
});
