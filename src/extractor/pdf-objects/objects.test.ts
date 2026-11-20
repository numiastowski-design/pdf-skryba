import { describe, expect, it } from "vitest";
import { refKey } from "./objects";

describe("refKey: the one text form of an object reference", () => {
  it("is `<num>R` when the generation is 0", () => {
    expect(refKey({ num: 12, gen: 0 })).toBe("12R");
  });
  it("is `<num>R<gen>` when the generation is not 0", () => {
    expect(refKey({ num: 12, gen: 3 })).toBe("12R3");
  });
});
