/**
 * THE ORDER of the unicode layer (docs/POC-SANS-PDFJS.md, step 2): `/ToUnicode` first, then the name the
 * encoding gives, then nothing — and "nothing" is an abstention, never an invented character. ISO 32000-1:2008 §9.10.2.
 * Tests only, written before the code. The reader is a minimal double: this file only judges the order and the
 * reading of the dictionaries, not the tables (`names.test.ts`) nor the CMap (`to-unicode.test.ts`).
 */
import { describe, expect, it } from "vitest";

import type { PdfDict, PdfStream, PdfValue } from "../pdf-objects/objects";
import { PdfObjectsRefusal } from "../pdf-objects/refusal";
import { fontText, type FontReader } from "./font-text";

const name = (value: string): PdfValue => ({ kind: "name", value });
const number = (value: number): PdfValue => ({ kind: "number", value });
const dict = (entries: Record<string, PdfValue>): PdfValue => ({
  kind: "dict",
  entries: new Map(Object.entries(entries)),
});
const array = (items: PdfValue[]): PdfValue => ({ kind: "array", items });

/** A `/ToUnicode` that maps code 1 to "Z", returned by the double without going through a real stream. */
const CMAP = `begincmap\n1 beginbfchar\n<0001> <005A>\nendbfchar\nendcmap`;

const stream = (text: string): PdfStream => ({
  kind: "stream",
  dict: new Map(),
  start: 0,
  length: text.length,
});

/** The double: it returns the values as they are (nothing indirect here) and the bytes of the test's only CMap. */
const reader: FontReader = {
  resolve: (value) => value,
  dictOf: (value) => (value?.kind === "dict" ? value.entries : value?.kind === "stream" ? value.dict : undefined),
  streamBytes: () => Uint8Array.from(Buffer.from(CMAP, "latin1")),
};

const fontOf = (entries: Record<string, PdfValue>): PdfDict => new Map(Object.entries(entries));

describe("fontText: l'ordre de §9.10.2", () => {
  it("prend `/ToUnicode` avant tout", () => {
    const text = fontText(
      reader,
      fontOf({ Subtype: name("TrueType"), Encoding: name("WinAnsiEncoding"), ToUnicode: stream(CMAP) }),
    );
    expect(text(1)).toBe("Z");
  });

  it("retombe sur le nom de l'encodage quand `/ToUnicode` ne dit rien de ce code", () => {
    const text = fontText(
      reader,
      fontOf({ Subtype: name("TrueType"), Encoding: name("WinAnsiEncoding"), ToUnicode: stream(CMAP) }),
    );
    expect(text(0x41)).toBe("A");
  });

  it("lit l'encodage quand il n'y a pas de `/ToUnicode`", () => {
    const text = fontText(reader, fontOf({ Subtype: name("Type1"), Encoding: name("WinAnsiEncoding") }));
    expect([text(0x41), text(0xe9)]).toEqual(["A", "é"]);
  });

  it("lit un `/Encoding` dictionnaire : sa base ET ses `/Differences` (Table 114)", () => {
    const text = fontText(
      reader,
      fontOf({
        Subtype: name("Type1"),
        Encoding: dict({
          BaseEncoding: name("WinAnsiEncoding"),
          Differences: array([number(1), name("bullet"), name("eacute"), number(10), name("Alpha")]),
        }),
      }),
    );
    expect([text(1), text(2), text(10), text(0x41)]).toEqual(["•", "é", "Α", "A"]);
  });

  it("S'ABSTIENT sur une police composite sans `/ToUnicode` : ses codes sont des numéros de glyphes", () => {
    const text = fontText(reader, fontOf({ Subtype: name("Type0"), Encoding: name("Identity-H") }));
    expect(text(0x41)).toBeUndefined();
  });

  it("répond pour une police composite QUI a un `/ToUnicode`", () => {
    const text = fontText(
      reader,
      fontOf({ Subtype: name("Type0"), Encoding: name("Identity-H"), ToUnicode: stream(CMAP) }),
    );
    expect([text(1), text(2)]).toEqual(["Z", undefined]);
  });

  it("S'ABSTIENT sur une police SYMBOLIQUE sans encodage déclaré", () => {
    const text = fontText(reader, fontOf({ Subtype: name("TrueType"), FontDescriptor: dict({ Flags: number(4) }) }));
    expect(text(0x41)).toBeUndefined();
  });

  it("lit l'encodage standard d'une police NON symbolique sans `/Encoding` (9.6.6.2)", () => {
    const text = fontText(reader, fontOf({ Subtype: name("Type1"), FontDescriptor: dict({ Flags: number(32) }) }));
    expect(text(0x41)).toBe("A");
  });
});

/** The encoding a Type1 font program declares: only its clear-text header is read, up to `eexec`, never the outlines.
 *  A symbolic Computer Modern font with no `/Encoding` has its text nowhere else. */
describe("fontText: l'encodage déclaré par le programme d'une police Type1", () => {
  const PROGRAM = [
    "%!PS-AdobeFont-1.0: CMR10",
    "/FontName /HEPYVW+CMR10 def",
    "/Encoding 256 array",
    "0 1 255 {1 index exch /.notdef put} for",
    "dup 19 /Z put",
    "readonly def",
    "currentfile eexec",
  ].join("\n");

  const readerOf = (program: string): FontReader => ({
    resolve: (value) => value,
    dictOf: (value) => (value?.kind === "dict" ? value.entries : value?.kind === "stream" ? value.dict : undefined),
    streamBytes: () => Uint8Array.from(Buffer.from(program, "latin1")),
  });

  /** A symbolic Type1 font with an embedded program and no `/Encoding` of its own: exactly the Computer Modern case. */
  const symbolicType1 = (extra: Record<string, PdfValue> = {}): PdfDict =>
    fontOf({ Subtype: name("Type1"), FontDescriptor: dict({ Flags: number(4), FontFile: stream(PROGRAM) }), ...extra });

  it("lit le texte d'un code que SEUL le programme nomme", () => {
    expect(fontText(readerOf(PROGRAM), symbolicType1())(19)).toBe("Z");
  });

  it("ne touche pas au programme quand la police DÉCLARE son encodage : la déclaration gagne", () => {
    // WinAnsi names no code 19: had the program won, this would read "Z".
    expect(fontText(readerOf(PROGRAM), symbolicType1({ Encoding: name("WinAnsiEncoding") }))(19)).toBeUndefined();
  });

  it("s'abstient encore quand le programme ne déclare aucun encodage", () => {
    expect(fontText(readerOf("%!PS-AdobeFont-1.0\ncurrentfile eexec"), symbolicType1())(19)).toBeUndefined();
  });

  it("s'abstient encore quand le descripteur ne porte aucun programme", () => {
    const font = fontOf({ Subtype: name("Type1"), FontDescriptor: dict({ Flags: number(4) }) });
    expect(fontText(readerOf(PROGRAM), font)(19)).toBeUndefined();
  });
});

// docs/CONCEPTION-AVIS-TEXTE-PDF.md, question 5 (16/11/2026): the two catch-alls are narrowed. A refusal of OURS keeps
// today's behaviour (the table says nothing, the encoding may answer); an UNEXPECTED error no longer falls back on the
// standard encoding, which can invent letters — it leaves the font, whose caller drops its glyphs (`pdf-glyph-source.ts`).
describe("the two catch-alls of the font text, narrowed to our refusals", () => {
  const failing = (error: () => unknown): FontReader => ({
    ...reader,
    streamBytes: () => {
      throw error();
    },
  });
  const withToUnicode = fontOf({
    Subtype: name("TrueType"),
    Encoding: name("WinAnsiEncoding"),
    ToUnicode: stream(CMAP),
  });
  const type1WithProgram = fontOf({
    Subtype: name("Type1"),
    FontDescriptor: dict({ FontFile: stream("program") }),
  });

  it("a `/ToUnicode` our reader refuses says nothing, and the encoding still answers (unchanged)", () => {
    expect(
      fontText(
        failing(() => new PdfObjectsRefusal("to-unicode")),
        withToUnicode,
      )(0x41),
    ).toBe("A");
    expect(
      fontText(
        failing(() => new PdfObjectsRefusal("stream-decode")),
        withToUnicode,
      )(0x41),
    ).toBe("A");
  });

  it("🔴 an unexpected error reading `/ToUnicode` is not turned into the encoding's letters: it leaves the font", () => {
    expect(() =>
      fontText(
        failing(() => new TypeError("boom")),
        withToUnicode,
      ),
    ).toThrow(TypeError);
  });

  it("a Type 1 program our reader refuses leaves the encoding undeclared, as today", () => {
    expect(() =>
      fontText(
        failing(() => new PdfObjectsRefusal("stream-decode")),
        type1WithProgram,
      ),
    ).not.toThrow();
  });

  it("🔴 an unexpected error reading a Type 1 program does not fall back on the standard encoding: it leaves the font", () => {
    expect(() =>
      fontText(
        failing(() => new RangeError("boom")),
        type1WithProgram,
      ),
    ).toThrow(RangeError);
  });
});
