import { describe, expect, it } from "vitest";

import { endsWithPageLeader } from "./pdf-line-breaks";

describe("endsWithPageLeader: roman page numbers", () => {
  it.each(["Preface ........ iv", "Annex ...... XII", "Chapter 1 ........ 12", "Intro …… ix"])(
    "%s ends a contents line",
    (t) => {
      expect(endsWithPageLeader(t)).toBe(true);
    },
  );

  it.each([
    "Name ........ civil",
    "Name …… civil",
    "Date ......... mix",
    "Total ..... mill",
    "Name . . . . . civil",
    "Name ........ Iv",
    "Name ........ vvv",
    "Name ........ ic",
  ])("🔴 %s is prose, not a contents line", (t) => {
    expect(endsWithPageLeader(t)).toBe(false);
  });

  it("fewer than 4 leader dots is an ellipsis, not a leader", () => {
    expect(endsWithPageLeader("Wait ... iv")).toBe(false);
  });
});

describe("endsWithPageLeader: hostile input", () => {
  it("🔴 a 20,000-dot line that does not end in a page number is answered at once", () => {
    const line = `${".".repeat(20_000)}zz`;
    const start = performance.now();
    expect(endsWithPageLeader(line)).toBe(false);
    // The quadratic version took 1 118 ms here (14/10/2026); the fixed one well under 1 ms. 500 ms leaves room for a loaded CI.
    expect(performance.now() - start).toBeLessThan(500);
  });

  it("a 20,000-dot line ending in a page number is still a contents line", () => {
    expect(endsWithPageLeader(`${".".repeat(20_000)} 7`)).toBe(true);
  });
});
