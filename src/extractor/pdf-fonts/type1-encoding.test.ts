import { describe, expect, it } from "vitest";

import { TYPE1_CLEARTEXT_LIMIT } from "./bounds";
import { builtInType1Encoding } from "./type1-encoding";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** The shape every Type 1 program uses for a custom encoding (Adobe, *Adobe Type 1 Font Format*, 1990, §10 and §2.3):
 *  the array is built in the CLEARTEXT part, before `eexec`, which is where the outlines start being encrypted. */
const program = (body: string, after = ""): Uint8Array =>
  bytes(
    `%!PS-AdobeFont-1.0: CMR10\n/FontName /HEPYVW+CMR10 def\n${body}\ncurrentdict end\ncurrentfile eexec\n${after}`,
  );

describe("builtInType1Encoding", () => {
  // Measured on `sd-7133949.pdf` (04/11/2026), a LaTeX document publishing 214 words of 4 019: its Computer Modern
  // subsets are symbolic Type1 fonts with NO `/Encoding` dictionary, so their encoding lives here and nowhere else.
  it("reads the `dup <code> /<name> put` pairs of a custom encoding", () => {
    const enc = builtInType1Encoding(
      program(
        "/Encoding 256 array\n0 1 255 {1 index exch /.notdef put} for\ndup 67 /C put\ndup 19 /acute put\ndup 108 /l put\nreadonly def",
      ),
    );
    expect(enc?.[67]).toBe("C");
    expect(enc?.[19]).toBe("acute");
    expect(enc?.[108]).toBe("l");
    expect(enc?.[0]).toBe(".notdef");
    expect(enc).toHaveLength(256);
  });

  it("reads the named standard encoding", () => {
    const enc = builtInType1Encoding(program("/Encoding StandardEncoding def"));
    expect(enc?.[65]).toBe("A");
    expect(enc?.[97]).toBe("a");
    expect(enc).toHaveLength(256);
  });

  // 🔴 The whole point of the narrow rule: everything after `eexec` is ENCRYPTED and we never look at it. A pair
  // sitting there is not an encoding — it is ciphertext that happens to read like one.
  it("reads NOTHING after `eexec`", () => {
    const enc = builtInType1Encoding(program("/Encoding 256 array\ndup 67 /C put\nreadonly def", "dup 90 /Z put\n"));
    expect(enc?.[67]).toBe("C");
    expect(enc?.[90]).toBe(".notdef");
  });

  it("abstains — never guesses — when there is no encoding to read", () => {
    expect(builtInType1Encoding(program("/FontMatrix [0.001 0 0 0.001 0 0] readonly def"))).toBeUndefined();
    expect(builtInType1Encoding(bytes(""))).toBeUndefined();
    expect(builtInType1Encoding(bytes("not a font program at all"))).toBeUndefined();
    // An `/Encoding` that names something we do not know is an abstention, not a fallback to Standard.
    expect(builtInType1Encoding(program("/Encoding ExpertEncoding def"))).toBeUndefined();
  });

  it("ignores a code outside 0-255 instead of growing the array", () => {
    const enc = builtInType1Encoding(
      program("/Encoding 256 array\ndup 300 /A put\ndup -1 /B put\ndup 65 /C put\nreadonly def"),
    );
    expect(enc).toHaveLength(256);
    expect(enc?.[65]).toBe("C");
    expect(enc?.includes("A")).toBe(false);
    expect(enc?.includes("B")).toBe(false);
  });

  // A bound seen to BITE: this parser runs on a client's file, so it reads a fixed head and no more. Without the
  // limit, a program with no `eexec` would be scanned whole, however large.
  it("reads at most TYPE1_CLEARTEXT_LIMIT bytes, so a pair beyond it is not read", () => {
    const padding = "% ".repeat(TYPE1_CLEARTEXT_LIMIT);
    const enc = builtInType1Encoding(
      bytes(`/Encoding 256 array\ndup 67 /C put\n${padding}\ndup 90 /Z put\nreadonly def`),
    );
    expect(enc?.[67]).toBe("C");
    expect(enc?.[90]).toBe(".notdef");
  });
});
