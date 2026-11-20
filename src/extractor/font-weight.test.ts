import { describe, expect, it } from "vitest";

import { fontWeight } from "./font-weight";

describe("fontWeight", () => {
  it("rend `bold` quand pdf.js s'est prononcé (police substituée)", () => {
    expect(fontWeight({ name: "Helvetica-Bold", bold: true, missingFile: true })).toBe("bold");
  });

  it("rend `normal` quand pdf.js s'est prononcé négativement", () => {
    expect(fontWeight({ name: "Helvetica", bold: false, missingFile: true })).toBe("normal");
  });

  it("SECONDE LECTURE : police EMBARQUÉE, `bold` absent, mais le nom porte la graisse", () => {
    // The case measured on `18-Composition-Reelle.pdf` — without this reading, all
    // the bold of a document with embedded fonts is silently lost.
    expect(fontWeight({ name: "AAAAAA+Arial-BoldMT", bold: undefined, missingFile: false })).toBe("bold");
  });

  it("ABSTENTION : police embarquée dont le nom ne dit rien de sa graisse", () => {
    expect(fontWeight({ name: "BAAAAA+ArialMT", bold: undefined, missingFile: false })).toBe("unknown");
  });

  it("ABSTENTION : une graisse que la règle de nom ne sait pas lire", () => {
    // `/bold/i` catches Semibold and Extrabold, but not Black nor Heavy.
    expect(fontWeight({ name: "Foo-Black", bold: undefined, missingFile: false })).toBe("unknown");
    expect(fontWeight({ name: "Foo-Heavy", bold: undefined, missingFile: false })).toBe("unknown");
  });

  it("la règle de nom attrape les graisses composées", () => {
    expect(fontWeight({ name: "Inter-SemiBold", bold: undefined, missingFile: false })).toBe("bold");
    expect(fontWeight({ name: "Foo-ExtraBold", bold: undefined, missingFile: false })).toBe("bold");
  });

  it("ABSTENTION : aucun objet de police du tout", () => {
    expect(fontWeight(undefined)).toBe("unknown");
    expect(fontWeight({})).toBe("unknown");
  });

  it("ne se fie JAMAIS au nom quand pdf.js s'est prononcé", () => {
    // If the object says `false` on a substituted font, it applied its
    // own rule on the name AFTER matching with a standard
    // font (as pdf.js did, removed since). Re-reading it ourselves would be redundant, not safer.
    expect(fontWeight({ name: "Bold-Something", bold: false, missingFile: true })).toBe("normal");
  });
});
