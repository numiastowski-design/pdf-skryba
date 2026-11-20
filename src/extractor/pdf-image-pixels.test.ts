/**
 * A null entry is no entry (`entryOf`), and the image readers must all say so: a null `/Decode` read as absent by one
 * and as a malformed array by another gave one dictionary two verdicts.
 * A free object (a reference to no object) and a null object are the two forms `dict.has` cannot tell from a value.
 */
import { describe, expect, it } from "vitest";

import { decodeArrayOf, entryOf } from "./pdf-image-pixels";
import type { PdfObjectsDocument } from "./pdf-objects/document";
import type { PdfValue } from "./pdf-objects/objects";

/** A document that only resolves a reference: object 12 is null, object 13 is free. */
const doc = {
  resolve: (value: PdfValue | undefined): PdfValue | undefined => {
    if (value?.kind !== "ref") return value;
    return value.num === 12 ? { kind: "null" } : undefined;
  },
} as unknown as PdfObjectsDocument;

const ref = (num: number): PdfValue => ({ kind: "ref", num, gen: 0 });

describe("entryOf : absent, libre ou nul, c'est la même chose", () => {
  it("rend undefined pour une clef absente, un renvoi mort et un objet nul, la valeur sinon", () => {
    const dict = new Map<string, PdfValue>([
      ["Nul", ref(12)],
      ["Libre", ref(13)],
      ["Vrai", { kind: "name", value: "DeviceRGB" }],
      ["NulSurPlace", { kind: "null" }],
    ]);
    expect(entryOf(doc, dict, "Absent")).toBeUndefined();
    expect(entryOf(doc, dict, "Nul")).toBeUndefined();
    expect(entryOf(doc, dict, "Libre")).toBeUndefined();
    expect(entryOf(doc, dict, "NulSurPlace")).toBeUndefined();
    expect(entryOf(doc, dict, "Vrai")).toEqual({ kind: "name", value: "DeviceRGB" });
  });
});

describe("decodeArrayOf : un /Decode nul est un /Decode ABSENT, et non un tableau malformé", () => {
  it("🔴 rend undefined (rien à décoder) là où il rendait null (image refusée)", () => {
    expect(decodeArrayOf(doc, new Map([["Decode", ref(12)]]), 3)).toBeUndefined();
    expect(decodeArrayOf(doc, new Map([["Decode", ref(13)]]), 3)).toBeUndefined();
    expect(decodeArrayOf(doc, new Map(), 3)).toBeUndefined();
  });

  it("un vrai tableau reste lu, et un tableau de la mauvaise taille reste un refus", () => {
    const inverted: PdfValue = {
      kind: "array",
      items: [1, 0, 1, 0, 1, 0].map((value) => ({ kind: "number", value })),
    };
    expect(decodeArrayOf(doc, new Map([["Decode", inverted]]), 3)).toEqual([
      [1, 0],
      [1, 0],
      [1, 0],
    ]);
    expect(decodeArrayOf(doc, new Map([["Decode", inverted]]), 1)).toBeNull();
  });
});
