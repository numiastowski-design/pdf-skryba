import { describe, expect, it } from "vitest";

import { fontWeight } from "./font-weight";

describe("fontWeight", () => {
  it("returns `bold` when the font object's `bold` flag has ruled (substituted font)", () => {
    expect(fontWeight({ name: "Helvetica-Bold", bold: true, missingFile: true })).toBe("bold");
  });

  it("returns `normal` when the font object's `bold` flag has ruled against", () => {
    expect(fontWeight({ name: "Helvetica", bold: false, missingFile: true })).toBe("normal");
  });

  it("SECOND READING: EMBEDDED font, `bold` absent, but the name carries the weight", () => {
    // The case measured on `18-Composition-Reelle.pdf` — without this reading, all
    // the bold of a document with embedded fonts is silently lost.
    expect(fontWeight({ name: "AAAAAA+Arial-BoldMT", bold: undefined, missingFile: false })).toBe("bold");
  });

  it("ABSTENTION: embedded font whose name says nothing of its weight", () => {
    expect(fontWeight({ name: "BAAAAA+ArialMT", bold: undefined, missingFile: false })).toBe("unknown");
  });

  it("ABSTENTION: a weight the name rule cannot read", () => {
    // `/bold/i` catches Semibold and Extrabold, but not Black nor Heavy.
    expect(fontWeight({ name: "Foo-Black", bold: undefined, missingFile: false })).toBe("unknown");
    expect(fontWeight({ name: "Foo-Heavy", bold: undefined, missingFile: false })).toBe("unknown");
  });

  it("the name rule catches compound weights", () => {
    expect(fontWeight({ name: "Inter-SemiBold", bold: undefined, missingFile: false })).toBe("bold");
    expect(fontWeight({ name: "Foo-ExtraBold", bold: undefined, missingFile: false })).toBe("bold");
  });

  it("ABSTENTION: no font object at all", () => {
    expect(fontWeight(undefined)).toBe("unknown");
    expect(fontWeight({})).toBe("unknown");
  });

  it("NEVER trusts the name when the font object's `bold` flag has ruled", () => {
    // If the object says `false` on a substituted font, it applied its
    // own rule on the name AFTER matching with a standard
    // font (as pdf.js did, removed since). Re-reading it ourselves would be redundant, not safer.
    expect(fontWeight({ name: "Bold-Something", bold: false, missingFile: true })).toBe("normal");
  });
});
