/**
 * `readImageRef`: the object number of a store image, or nothing. Characterisation (12/10/2026) of the branches shared
 * with `readImageObject` ("the store's object or nothing"): `get` throws, a non-object, a missing or malformed `ref`.
 */
import { describe, expect, it } from "vitest";

import { readImageRef } from "./pdf-images";

const store = (entries: Record<string, unknown>): { get: (n: string) => unknown } => ({
  get: (n: string) => {
    if (!(n in entries)) throw new Error("not resolved yet");
    return entries[n];
  },
});

describe("readImageRef", () => {
  it("answers the ref of a stored object, with or without a generation", () => {
    expect(readImageRef(store({ a: { ref: "53R" } }), "a")).toBe("53R");
    expect(readImageRef(store({ a: { ref: "53R2" } }), "a")).toBe("53R2");
  });

  it("answers nothing when the store throws (not resolved yet)", () => {
    expect(readImageRef(store({}), "a")).toBeUndefined();
  });

  it("answers nothing for a non-object entry", () => {
    expect(readImageRef(store({ a: null }), "a")).toBeUndefined();
    expect(readImageRef(store({ a: "53R" }), "a")).toBeUndefined();
    expect(readImageRef(store({ a: 7 }), "a")).toBeUndefined();
  });

  it("answers nothing for a missing or malformed ref", () => {
    expect(readImageRef(store({ a: {} }), "a")).toBeUndefined();
    expect(readImageRef(store({ a: { ref: 53 } }), "a")).toBeUndefined();
    expect(readImageRef(store({ a: { ref: "R53" } }), "a")).toBeUndefined();
    expect(readImageRef(store({ a: { ref: "53" } }), "a")).toBeUndefined();
  });
});
