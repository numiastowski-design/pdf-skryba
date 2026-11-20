/**
 * The PREDEFINED Adobe CMaps that a composite font can name in `/Encoding` (ISO 32000-1:2008 §9.7.5.2,
 * Table 118), and those whose text WE can read without embedding any table.
 * The deciding fact, checked on 31/10/2026 in Adobe's official repository (`adobe-type-tools/cmap-resources`,
 * BSD-3-Clause): for a `UniXXX-UCS2-[HV]` CMap, the code space is `0x0000–0xD7FF & 0xE000–0xFFFF` — the
 * basic multilingual plane minus the surrogate block — and the CODE is therefore the Unicode code point itself.
 * Tests only, written before the code.
 */
import { describe, expect, it } from "vitest";

import { cidTableOf, codeIsUnicodeScalar, unicodeCodeForm } from "./predefined-cmaps";

describe("unicodeCodeForm: la FORME des codes, qui décide du découpage", () => {
  it("les UCS2 sont à deux octets fixes", () => {
    expect(["UniCNS-UCS2-H", "UniJIS-UCS2-V", "UniGB-UCS2-H", "UniKS-UCS2-H"].map(unicodeCodeForm)).toEqual([
      "ucs2",
      "ucs2",
      "ucs2",
      "ucs2",
    ]);
  });

  it("la variante demi-largeur du japonais aussi : son code reste de l'Unicode", () => {
    expect(["UniJIS-UCS2-HW-H", "UniJIS-UCS2-HW-V"].map(unicodeCodeForm)).toEqual(["ucs2", "ucs2"]);
  });

  it("🔴 les UTF16 sont à longueur VARIABLE : deux octets, quatre pour une paire de substitution", () => {
    // Their code space says so: `<0000> <D7FF>`, `<D800DC00> <DBFFDFFF>`, `<E000> <FFFF>`.
    // A character outside the BMP is therefore ONE four-byte code there, and that is all that distinguishes them from UCS2.
    expect(["UniCNS-UTF16-H", "UniJIS-UTF16-V", "UniGB-UTF16-H", "UniKS-UTF16-H"].map(unicodeCodeForm)).toEqual([
      "utf16",
      "utf16",
      "utf16",
      "utf16",
    ]);
  });

  it("et rien d'autre n'a de forme : les héritées demandent une vraie table", () => {
    expect(["90ms-RKSJ-H", "B5pc-H", "GBK-EUC-H", "Identity-H", "UniCNS-UTF8-H"].map(unicodeCodeForm)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe("codeIsUnicodeScalar: les CMaps dont le code EST le caractère", () => {
  it("accepte les quatre collections en UCS2, horizontales", () => {
    expect(["UniCNS-UCS2-H", "UniGB-UCS2-H", "UniJIS-UCS2-H", "UniKS-UCS2-H"].map(codeIsUnicodeScalar)).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });

  it("accepte leurs variantes VERTICALES : l'écriture change, le code non", () => {
    expect(["UniCNS-UCS2-V", "UniJIS-UCS2-V"].map(codeIsUnicodeScalar)).toEqual([true, true]);
  });

  it("accepte les UTF16, dont le code est de l'UTF-16 et donc aussi de l'Unicode", () => {
    // ⚠️ This case claimed the OPPOSITE until the evening of 31/10/2026, and it was a limit of OUR splitting, not
    // of the format: their code space carries a FOUR-byte range (`<D800DC00> <DBFFDFFF>`), which we did not
    // know how to read. We read it now (`unicodeCodeForm` returns "utf16"), so the limit is gone.
    expect(["UniCNS-UTF16-H", "UniJIS-UTF16-H", "UniGB-UTF16-V"].map(codeIsUnicodeScalar)).toEqual([true, true, true]);
  });

  it("refuse les encodages hérités, qui demandent une vraie table de correspondance", () => {
    expect(["90ms-RKSJ-H", "B5pc-H", "GBK-EUC-H", "ETen-B5-H", "Identity-H"].map(codeIsUnicodeScalar)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("refuse un nom qui RESSEMBLE sans en être un", () => {
    expect(
      ["UniCNS-UCS2", "UniCNS-UCS2-X", "XUniCNS-UCS2-H", "UniXXX-UCS2-H", "UniCNS-UTF8-H"].map(codeIsUnicodeScalar),
    ).toEqual([false, false, false, false, false]);
  });
});

// Pins three things at once: the table is read, it is the right one per collection, and both sides of the base64 read
// the byte pairs in the same order (little-endian, by hand: an inversion on one side breaks this test).
describe("cidTableOf : le CID vient de la table d'Adobe, et de la bonne", () => {
  it("les latins ont les mêmes CID dans les deux collections, l'idéogramme NON", () => {
    // 一 (U+4E00) is the discriminant: its CID differs between Adobe-CNS1 and Adobe-Japan1.
    expect([0x41, 0x61, 0x30, 0x20, 0x4e00].map((code) => cidTableOf("UniCNS-UCS2-H")!.of(code))).toEqual([
      34, 66, 17, 1, 595,
    ]);
    expect([0x41, 0x61, 0x30, 0x20, 0x4e00].map((code) => cidTableOf("UniJIS-UCS2-H")!.of(code))).toEqual([
      34, 66, 17, 1, 1200,
    ]);
  });

  it("la variante verticale partage la table horizontale : une CMap verticale change l'écriture, pas le CID", () => {
    expect(cidTableOf("UniCNS-UCS2-V")!.of(0x41)).toBe(34);
  });

  it("une collection dont nous n'avons PAS la table s'abstient, et le dit", () => {
    expect(cidTableOf("UniKS-UCS2-H")).toBeUndefined();
    expect(cidTableOf("UniCNS-UCS2-H")).toBeTypeOf("object");
  });

  it("dit le dernier CID de sa collection : au-delà, aucun code ne peut rien demander", () => {
    // What these two CMaps reach, not the size of the Adobe collections: a `UCS2` CMap covers only part of one.
    expect(cidTableOf("UniCNS-UCS2-H")!.highest).toBe(18_845);
    expect(cidTableOf("UniJIS-UCS2-H")!.highest).toBe(15_442);
  });

  it("hors de toute plage, aucune invention : les contrôles C0 et les demi-paires sont sans CID", () => {
    // The resource's `notdefrange` (<0000>–<001F> → CID 1) is not embedded: these codes are never published.
    expect(cidTableOf("UniCNS-UCS2-H")!.of(0x0001)).toBeUndefined();
    expect(cidTableOf("UniCNS-UCS2-H")!.of(0xd800)).toBeUndefined();
  });
});
