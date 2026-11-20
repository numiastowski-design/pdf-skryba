/**
 * Four names of the published light door (`pdf-skryba/light`) that no other test of the package takes:
 * `conservationKey`, `wordKeysOf`, `lostWords` and `MAX_PAYLOAD_BYTES`. They are defined in the base package, which
 * holds their rules with its own tests; this is what a client of THIS door gets, on inputs written by hand and
 * expected values written here.
 * NOT here: `textConservation` and the three repairs of the door (`pipeline/*-repair.test.ts` take them through it).
 */
import { describe, expect, it } from "vitest";

import {
  conservationKey,
  lostWords,
  MAX_PAYLOAD_BYTES,
  textConservation,
  wordKeysOf,
  type ConservationRun,
} from "./pdf-light";

describe("conservationKey — the form two words are compared in", () => {
  it("keeps letters and digits only, in lower case", () => {
    expect(conservationKey("L'École,")).toBe("lécole");
    expect(conservationKey("2026-11")).toBe("202611");
    expect(conservationKey("« … »")).toBe("");
  });

  it("unfolds a ligature (NFKC): « ﬁn » and « fin » are one word", () => {
    expect(conservationKey("ﬁn")).toBe("fin");
    expect(conservationKey("ﬁn")).toBe(conservationKey("FIN"));
  });
});

describe("wordKeysOf — the keys of the words of a text", () => {
  it("splits on white space and drops a word that holds no letter or digit", () => {
    expect(wordKeysOf("Le chat — dort,\n\tdéjà !")).toEqual(["le", "chat", "dort", "déjà"]);
    expect(wordKeysOf("")).toEqual([]);
    expect(wordKeysOf("  …  ")).toEqual([]);
  });

  it("does NOT split inside a word: an apostrophe or a hyphen is dropped, the letters stay together", () => {
    expect(wordKeysOf("aujourd'hui porte-monnaie")).toEqual(["aujourdhui", "portemonnaie"]);
  });
});

describe("lostWords — the lost source words of a verdict, as keys", () => {
  it("lists the source words of every lost passage, in order, the words without a letter left out", () => {
    const passage = (sourceWords: string[]): Parameters<typeof lostWords>[0]["lostPassages"][number] =>
      ({ sourceWords }) as Parameters<typeof lostWords>[0]["lostPassages"][number];
    expect(lostWords({ lostPassages: [passage(["Montant", "dû,"]), passage(["—", "1 250"])] })).toEqual([
      "montant",
      "dû",
      "1250",
    ]);
    expect(lostWords({ lostPassages: [] })).toEqual([]);
  });

  it("on a real verdict: a word of the source the page does not carry is the one listed", () => {
    // One page of two lines as a PDF gives them; the published page carries the first line only.
    const line = (text: string, y: number): ConservationRun => ({
      text,
      x: 72,
      y,
      width: text.length * 6,
      fontSize: 11,
      hasEOL: true,
    });
    const verdict = textConservation([[line("Le chat dort.", 700), line("Profondément, vraiment.", 684)]], {
      blocks: ["Le chat dort."],
    });
    expect(lostWords(verdict)).toEqual(["profondément", "vraiment"]);
  });
});

describe("MAX_PAYLOAD_BYTES — the byte ceiling of a payload", () => {
  it("is fifty million bytes", () => {
    expect(MAX_PAYLOAD_BYTES).toBe(50_000_000);
  });
});
