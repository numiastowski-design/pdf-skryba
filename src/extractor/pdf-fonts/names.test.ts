/**
 * Step 2 of the unicode layer (docs/POC-SANS-PDFJS.md): from a glyph NAME to the text it paints, and from
 * the `/Encoding` of a simple font to its 256 names. ISO 32000-1:2008 §9.6.6 (encodings), Annex D (the tables),
 * §9.10.2 (how a name gives a unicode), plus Adobe's `uniXXXX` / `uXXXXXX` conventions.
 * Tests only, written before the code. The contract fixed here:
 *   textOfGlyphName(name) -> string | undefined      (`undefined` = we abstain, never an invention)
 *   encodingNames({ base, differences, symbolic }) -> readonly string[]   (256 names, "" = unnamed)
 */
import { describe, expect, it } from "vitest";

import { encodingNames, textOfGlyphName } from "./names";

describe("textOfGlyphName: la liste d'Adobe et les conventions", () => {
  it("lit la liste d'Adobe", () => {
    expect(textOfGlyphName("A")).toBe("A");
    expect(textOfGlyphName("eacute")).toBe("é");
    expect(textOfGlyphName("bullet")).toBe("•");
    expect(textOfGlyphName("fi")).toBe("ﬁ");
  });

  it("lit `uniXXXX`, y compris plusieurs groupes", () => {
    expect(textOfGlyphName("uni0041")).toBe("A");
    expect(textOfGlyphName("uni00410042")).toBe("AB");
  });

  it("lit `uXXXX` à `uXXXXXX`", () => {
    expect(textOfGlyphName("u0041")).toBe("A");
    expect(textOfGlyphName("u1F600")).toBe("\u{1F600}");
  });

  it("ignore le suffixe d'une variante (§9.10.2 : `a.sc` est un `a`)", () => {
    expect(textOfGlyphName("a.sc")).toBe("a");
    expect(textOfGlyphName("one.oldstyle")).toBe("1");
  });

  it("S'ABSTIENT sur un nom qui ne dit rien du texte", () => {
    // A glyph number is not a character: inventing here would fabricate words.
    expect(textOfGlyphName("g42")).toBeUndefined();
    expect(textOfGlyphName("cid1234")).toBeUndefined();
    expect(textOfGlyphName("glyph7")).toBeUndefined();
    expect(textOfGlyphName("index12")).toBeUndefined();
    expect(textOfGlyphName("Mystere")).toBeUndefined();
    expect(textOfGlyphName("")).toBeUndefined();
  });

  it("s'abstient sur un `uni` ou `u` mal formé plutôt que de deviner", () => {
    expect(textOfGlyphName("uni00")).toBeUndefined();
    expect(textOfGlyphName("uniZZZZ")).toBeUndefined();
    expect(textOfGlyphName("u12")).toBeUndefined();
    expect(textOfGlyphName("u110000")).toBeUndefined(); // beyond the Unicode plane
  });
});

describe("encodingNames: la table d'une police simple (9.6.6)", () => {
  it("donne WinAnsi quand la police la nomme", () => {
    const names = encodingNames({ base: "WinAnsiEncoding", differences: undefined, symbolic: false });
    expect(names[0x41]).toBe("A");
    expect(names[0xe9]).toBe("eacute");
    expect(names).toHaveLength(256);
  });

  it("donne MacRoman et Standard quand elles sont nommées", () => {
    expect(encodingNames({ base: "MacRomanEncoding", differences: undefined, symbolic: false })[0x8e]).toBe("eacute");
    // Annex D: in StandardEncoding, 0350 is `Lslash` and 0351 `Oslash` — written from memory the wrong way round the
    // first time, and it is the table that was right (31/10/2026).
    const standard = encodingNames({ base: "StandardEncoding", differences: undefined, symbolic: false });
    expect([standard[0xe8], standard[0xe9]]).toEqual(["Lslash", "Oslash"]);
  });

  it("applique les `/Differences` par-dessus la base (Table 114)", () => {
    const names = encodingNames({
      base: "WinAnsiEncoding",
      differences: [{ code: 1, names: ["alpha", "beta"] }],
      symbolic: false,
    });
    expect([names[1], names[2], names[0x41]]).toEqual(["alpha", "beta", "A"]);
  });

  it("prend Standard par défaut pour une police NON symbolique sans `/Encoding` (9.6.6.2)", () => {
    expect(encodingNames({ base: undefined, differences: undefined, symbolic: false })[0x41]).toBe("A");
  });

  it("S'ABSTIENT sur une police SYMBOLIQUE sans `/Encoding` : son encodage est dans son programme", () => {
    const names = encodingNames({ base: undefined, differences: undefined, symbolic: true });
    expect(names.every((name) => name === "")).toBe(true);
  });

  it("garde les `/Differences` d'une police symbolique, qui sont déclarées et non devinées", () => {
    const names = encodingNames({ base: undefined, differences: [{ code: 5, names: ["bullet"] }], symbolic: true });
    expect(names[5]).toBe("bullet");
    expect(names[0x41]).toBe("");
  });
});
