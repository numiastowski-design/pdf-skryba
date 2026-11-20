/**
 * Step 1 of the unicode layer (docs/POC-SANS-PDFJS.md): a font's `/ToUnicode` CMap, which says what TEXT
 * a glyph code paints. ISO 32000-1:2008 §9.10.3 (`/ToUnicode`) and §9.7.5-9.7.6 (the syntax of a CMap),
 * https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf
 * Tests only, written before the code. The contract fixed here:
 *   readCMap(bytes) -> { text, rejected }
 * `text` is what we PUBLISH (code → text, the decoded UTF-16BE); `rejected` is what the CMap DECLARES where the
 * filter refused to publish — the half-pair of an emoji, which a NEIGHBOURING painted code completes, and which only
 * `extractor/pdf-glyph-source.ts` can pair since it alone sees the sequence of codes.
 * A `bfrange` with an array gives one text per code; a `bfrange` with a single destination increments the LAST
 * UTF-16 unit, as the specification says. Every failure is a `PdfObjectsRefusal`, nothing else.
 */
import { describe, expect, it } from "vitest";

import { PdfObjectsRefusal } from "../pdf-objects/refusal";
import { MAX_CMAP_TOKEN_BYTES, MAX_TOUNICODE_ENTRIES, MAX_TOUNICODE_PLACED } from "./bounds";
import { readToUnicode as readCMap } from "./to-unicode";

/** The PUBLISHABLE table, which most of these cases look at. The refused table has its own block, further down. */
const readToUnicode = (data: Uint8Array): ReadonlyMap<number, string> => readCMap(data).text;

const enc = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "latin1"));

/** A complete `/ToUnicode` CMap, with the header that producers always write. */
const cmap = (body: string): Uint8Array =>
  enc(`/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
${body}
endcmap
CMapName currentdict /CMap defineresource pop
end
end`);

function refusalOf(fn: () => unknown): PdfObjectsRefusal {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PdfObjectsRefusal);
    return error as PdfObjectsRefusal;
  }
  throw new Error("expected a PdfObjectsRefusal, nothing was thrown");
}

describe("readToUnicode: bfchar (9.10.3)", () => {
  it("maps one code to one character", () => {
    const map = readToUnicode(cmap("1 beginbfchar\n<0041> <0061>\nendbfchar"));
    expect(map.get(0x41)).toBe("a");
  });

  it("maps a code to SEVERAL characters, as a ligature does", () => {
    const map = readToUnicode(cmap("1 beginbfchar\n<0001> <00660066>\nendbfchar"));
    expect(map.get(1)).toBe("ff");
  });

  it("reads a one-byte code", () => {
    const map = readToUnicode(cmap("1 beginbfchar\n<41> <0041>\nendbfchar"));
    expect(map.get(0x41)).toBe("A");
  });

  it("reads several blocks, and several pairs per block", () => {
    const map = readToUnicode(
      cmap("2 beginbfchar\n<0003> <0020>\n<0024> <0041>\nendbfchar\n1 beginbfchar\n<0025> <0042>\nendbfchar"),
    );
    expect([map.get(3), map.get(0x24), map.get(0x25)]).toEqual([" ", "A", "B"]);
  });

  it("keeps a surrogate pair as the one character it spells", () => {
    // U+1F600, written in UTF-16BE as two units: it is ONE character.
    const map = readToUnicode(cmap("1 beginbfchar\n<0001> <D83DDE00>\nendbfchar"));
    expect(map.get(1)).toBe("\u{1F600}");
    expect([...(map.get(1) as string)]).toHaveLength(1);
  });
});

describe("readToUnicode: bfrange (9.10.3)", () => {
  it("increments the LAST UTF-16 unit of the destination across the range", () => {
    const map = readToUnicode(cmap("1 beginbfrange\n<0010> <0012> <0041>\nendbfrange"));
    expect([map.get(0x10), map.get(0x11), map.get(0x12)]).toEqual(["A", "B", "C"]);
    expect(map.has(0x13)).toBe(false);
  });

  it("takes one destination per code from an array", () => {
    const map = readToUnicode(cmap("1 beginbfrange\n<0020> <0022> [<0058> <0059> <005A>]\nendbfrange"));
    expect([map.get(0x20), map.get(0x21), map.get(0x22)]).toEqual(["X", "Y", "Z"]);
  });

  it("increments only the last unit of a multi-unit destination", () => {
    const map = readToUnicode(cmap("1 beginbfrange\n<0030> <0031> <00660061>\nendbfrange"));
    expect([map.get(0x30), map.get(0x31)]).toEqual(["fa", "fb"]);
  });

  it("refuses a range whose end is before its start", () => {
    expect(refusalOf(() => readToUnicode(cmap("1 beginbfrange\n<0012> <0010> <0041>\nendbfrange"))).reason).toBe(
      "to-unicode",
    );
  });

  it("refuses an array shorter than its range", () => {
    expect(refusalOf(() => readToUnicode(cmap("1 beginbfrange\n<0020> <0022> [<0058>]\nendbfrange"))).reason).toBe(
      "to-unicode",
    );
  });
});

describe("readToUnicode: refusals and ceilings", () => {
  it("gives an empty map for a CMap that maps nothing", () => {
    expect(readToUnicode(cmap("")).size).toBe(0);
  });

  it("refuses a block that never ends", () => {
    expect(refusalOf(() => readToUnicode(cmap("1 beginbfchar\n<0041> <0061>"))).reason).toBe("to-unicode");
  });

  it("refuses a pair that is not two hexadecimal strings", () => {
    expect(refusalOf(() => readToUnicode(cmap("1 beginbfchar\n<0041> /Name\nendbfchar"))).reason).toBe("to-unicode");
  });

  it("refuses more entries than MAX_TOUNICODE_ENTRIES", () => {
    const body = `1 beginbfrange\n<0000> <${(MAX_TOUNICODE_ENTRIES + 1).toString(16).padStart(4, "0")}> <0041>\nendbfrange`;
    expect(refusalOf(() => readToUnicode(cmap(body))).reason).toBe("to-unicode");
  });

  it("refuses a CMap that places more codes than MAX_TOUNICODE_PLACED, ranges repeated", () => {
    // Security review of 31/10/2026: the per-range ceiling did not bound the NUMBER of ranges, and
    // `<0000> <FFFF> <0041>` fits in twenty bytes for 65 536 codes — 100 KB of CMap was worth 3 × 10⁸ iterations.
    const range = "<0000> <ffff> <0041>\n";
    const body = `1 beginbfrange\n${range.repeat(MAX_TOUNICODE_PLACED / 65_536 + 1)}endbfrange`;
    expect(refusalOf(() => readToUnicode(cmap(body))).reason).toBe("to-unicode");
  });

  it("refuses a code wider than four bytes", () => {
    expect(refusalOf(() => readToUnicode(cmap("1 beginbfchar\n<0000000041> <0061>\nendbfchar"))).reason).toBe(
      "to-unicode",
    );
  });

  it("refuses a WORD longer than MAX_CMAP_TOKEN_BYTES", () => {
    // 🔴 Security review of 31/10/2026: this scanner was the only one of the four without a word ceiling (`parse.ts` and
    // `content.ts` have one of 64 bytes, `xref.ts` of 32). A CMap decompressing 64 MB without a single blank,
    // `<` or `[` made ONE 64 MB copy and ONE 64 MB latin1 string — ~130 MB of peak for a 65 KB bomb
    // — only to be compared with "beginbfchar".
    const word = "A".repeat(MAX_CMAP_TOKEN_BYTES + 1);
    expect(refusalOf(() => readToUnicode(enc(`begincmap ${word}`))).reason).toBe("to-unicode");
  });
});

describe("readToUnicode: un caractère irréel ne voyage pas, même accompagné", () => {
  // 🔴 Security review of 31/10/2026: the guard added the same day only looked at ONE-unit destinations,
  // so a surrogate half-pair got through as soon as it counted two. `String.fromCharCode` then emitted
  // invalid UTF-16 up to the page — exactly what `names.ts` forbids. The criterion rests on the
  // PAIRING (high then low), not on the length.
  const textOf = (hex: string): string | undefined =>
    readToUnicode(cmap(`1 beginbfchar\n<0041> <${hex}>\nendbfchar`)).get(0x41);

  it("laisse passer une paire de substitution COMPLÈTE, qui épelle un vrai caractère", () => {
    // U+1D400 (mathematical letter A): D835 DC00.
    expect(textOf("D835DC00")).toBe("\u{1D400}");
  });

  it("s'abstient sur DEUX demi-paires hautes", () => {
    expect(textOf("D800D800")).toBe("");
  });

  it("s'abstient sur une lettre SUIVIE d'une demi-paire", () => {
    expect(textOf("0041D800")).toBe("");
  });

  it("s'abstient sur une demi-paire BASSE seule au milieu d'un texte", () => {
    expect(textOf("0041DC00")).toBe("");
  });
});

describe("readToUnicode: une plage dont la destination COMMENCE à U+0000 (régression du 31/10/2026)", () => {
  // 🔴 THE DEFECT I INTRODUCED MYSELF, WHICH COST 98.7 % OF THE TEXT OF A REAL FILE.
  // The `isRealCharacter` guard added at the 5th review makes U+0000 return "" — an abstention that is right in itself.
  // But `readBfRange` computed the text of each code by INCREMENTING the string returned for the first one:
  // starting from "", it stayed "" for the 256 codes of the range. Yet an identity `/ToUnicode` written in ranges
  // of 256 (`<0000> <00ff> <0000>`, `<0100> <01ff> <0100>`…) is what a DejaVuSans export produces, and it is the
  // case of safedocs 0000846, a third-party PDF of the measurement corpus: 1 140 glyphs out of 1 158 returned empty on its page 1.
  // THE FIX: the arithmetic is done on the UNITS, and the filter applies to the FINAL value of each
  // code — never to the text already returned for the first one.
  const identityRange = (): ReadonlyMap<number, string> =>
    readToUnicode(cmap("1 beginbfrange\n<0000> <00ff> <0000>\nendbfrange"));

  it("rend « e » pour le code 0x65, et non la chaîne vide", () => {
    expect(identityRange().get(0x65)).toBe("e");
  });

  it("rend bien tout le reste de la plage", () => {
    const table = identityRange();
    expect([0x41, 0x42, 0x7a, 0x20, 0xe9].map((code) => table.get(code))).toEqual(["A", "B", "z", " ", "é"]);
  });

  it("et s'abstient TOUJOURS sur le code dont la destination EST U+0000", () => {
    expect(identityRange().get(0x00)).toBe("");
  });

  it("une plage qui TOMBE sur une demi-paire s'abstient sur ce code-là seulement", () => {
    // The range starts at U+D7FF: the first code stays a real character, the next two are halves.
    const table = readToUnicode(cmap("1 beginbfrange\n<0010> <0012> <D7FF>\nendbfrange"));
    expect(table.get(0x10)).toBe(String.fromCharCode(0xd7ff));
    expect(table.get(0x11)).toBe("");
    expect(table.get(0x12)).toBe("");
  });
});

describe("readToUnicode: ce que la CMap DÉCLARE là où on refuse de publier", () => {
  // 🔴 31/10/2026: "we have to do it ourselves", for emojis. A producer may write the UTF-16
  // units as CIDs (FreeMono and DejaVuSans by LibreOffice do): an emoji then occupies TWO neighbouring
  // painted codes, each carrying a lone half-pair. Taken alone, each is rightly refused; together,
  // they spell a real character. This table keeps the refused part so that `pdf-glyph-source.ts`
  // pairs it — it is the SAME reading of the CMap, of which we expose what it set aside, not a second reading.
  const high = String.fromCharCode(0xd83d);
  const low = String.fromCharCode(0xdc00);

  it("garde la demi-paire HAUTE qu'un code voisin complétera", () => {
    const read = readCMap(cmap("1 beginbfrange\n<d800> <d8ff> <d800>\nendbfrange"));
    expect(read.text.get(0xd83d)).toBe("");
    expect(read.rejected.get(0xd83d)).toBe(high);
  });

  it("garde la demi-paire BASSE de la même façon", () => {
    const read = readCMap(cmap("1 beginbfchar\n<0001> <DC00>\nendbfchar"));
    expect(read.text.get(0x01)).toBe("");
    expect(read.rejected.get(0x01)).toBe(low);
  });

  it("ne garde RIEN pour un code qu'on publie : la table refusée reste petite", () => {
    const read = readCMap(cmap("1 beginbfchar\n<0041> <0061>\nendbfchar"));
    expect(read.text.get(0x41)).toBe("a");
    expect(read.rejected.size).toBe(0);
  });

  it("garde aussi U+0000, qui n'est pas une demi-paire mais que l'appariement devra écarter", () => {
    const read = readCMap(cmap("1 beginbfchar\n<0041> <0000>\nendbfchar"));
    expect(read.text.get(0x41)).toBe("");
    expect(read.rejected.get(0x41)).toBe("\u0000");
  });
});
