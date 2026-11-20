/** THE LIANG TABLES SAY WHERE A CUT IS LEGAL IN A LANGUAGE (05/11/2026: typography rules help spot a hyphenation,
 *  hence remove it when the word no longer ends a line). The tables
 *  are the hyph-utf8 patterns of TeX, the same data Firefox and LibreOffice hyphenate with — deterministic, frozen
 *  in the repository, no service called. Run: npx vitest run --project=main src/layout/hyphenation.test.ts */
import { describe, expect, it } from "vitest";

import { legalCutOf } from "./hyphenation";

describe("legalCutOf — French (hyph-fr, MIT)", () => {
  const legal = legalCutOf("fr");
  it("🔴 « promo-tion » is a legal French cut: the newspaper's hyphen is the layout's", () => {
    expect(legal("promo", "tion")).toBe(true);
  });
  it("a cut inside the digram « gn » is illegal (ma-gnifique is not French)", () => {
    expect(legal("mag", "nifique")).toBe(false);
  });
  it("one letter before the hyphen is illegal (a-vion): the official French minima are 2/2", () => {
    expect(legal("a", "vion")).toBe(false);
  });
  it("one letter after the hyphen is illegal (unit-é)", () => {
    expect(legal("unit", "é")).toBe(false);
  });
  it("case does not matter: a sentence-initial word hyphenates like any other", () => {
    expect(legal("Promo", "tion")).toBe(true);
  });
});

describe("legalCutOf — American English (ushyphmax)", () => {
  const legal = legalCutOf("en");
  it("🔴 « ad-dress » is the legal English cut of « address »", () => {
    expect(legal("ad", "dress")).toBe(true);
  });
  it("« addr-ess » is not", () => {
    expect(legal("addr", "ess")).toBe(false);
  });
  it("two letters after the hyphen are illegal in English: the official minima are 2/3", () => {
    expect(legal("depend", "ed")).toBe(false);
  });
  it("an exception WITHOUT hyphens is never cut: « pre-sent » is refused by the exception list", () => {
    expect(legal("pre", "sent")).toBe(false);
  });
  it("an exception WITH hyphens allows exactly its cuts: « as-so-ciate »", () => {
    expect(legal("as", "sociate")).toBe(true);
    expect(legal("asso", "ciate")).toBe(true);
    expect(legal("ass", "ociate")).toBe(false);
  });
});
