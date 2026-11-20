/** THE VISIBLE HYPHEN OF A CUT WORD GOES WHEN TWO READINGS CONCORD. The paper cut the word at a line's end, AND: the document writes it whole
 *  elsewhere (first reading), OR the cut is a LEGAL hyphenation point of the page's language (`./hyphenation.ts`,
 *  second reading — refused when either piece starts with a capital, « TWO-WAY », or when the document writes the
 *  hyphenated form elsewhere, which says the hyphen is the word's own). Otherwise the hyphen stays. */
import { describe, expect, it } from "vitest";

import { CUT_MARK, hyphenationLanguageOf, joinCutParagraphs, resolveCutHyphens } from "./cut-word";
import type { IRBlock } from "doc-ir";

const para = (text: string): IRBlock => ({ kind: "paragraph", inlines: [{ text }] });
const texts = (blocks: IRBlock[]): string[] =>
  blocks.map((b) => (b.kind === "paragraph" ? b.inlines.map((i) => i.text).join("") : ""));

describe("resolveCutHyphens", () => {
  it("🔴 the hyphen goes when the whole word is written elsewhere in the document, in any case", () => {
    expect(
      texts(
        resolveCutHyphens([
          [para(`éditorialiste au jour${CUT_MARK}nal Le Temps`)],
          [para("Le Journal du soir")],
        ]).flat(),
      ),
    ).toEqual(["éditorialiste au journal Le Temps", "Le Journal du soir"]);
  });

  it("🔴 the hyphen stays when the document never writes the whole word and no language is given", () => {
    expect(texts(resolveCutHyphens([[para(`a ministry${CUT_MARK}funded plan`)]]).flat())).toEqual([
      "a ministry-funded plan",
    ]);
  });

  it("🔴 the hyphen goes WITHOUT a whole witness when the cut is a legal hyphenation point of the page's language", () => {
    // « promo-tion » of the newspaper `sd-2479793`: written once, cut by the layout; the French table knows pro|mo|tion.
    expect(
      texts(
        resolveCutHyphens(
          [[para(`Nous soutenons la promo${CUT_MARK}tion d'un authentique plurilinguisme`)]],
          "fr",
        ).flat(),
      ),
    ).toEqual(["Nous soutenons la promotion d'un authentique plurilinguisme"]);
  });

  it("a capital at the start of either piece refuses the table reading: a compound name keeps its hyphen", () => {
    expect(texts(resolveCutHyphens([[para(`the Net${CUT_MARK}Zero plan`)]], "en").flat())).toEqual([
      "the Net-Zero plan",
    ]);
    expect(texts(resolveCutHyphens([[para(`the De${CUT_MARK}identification rule`)]], "en").flat())).toEqual([
      "the De-identification rule",
    ]);
  });

  it("🔴 the hyphenated form written elsewhere keeps the hyphen: the document says the hyphen is the word's own", () => {
    // « ministry-funded » is a legal English cut of the pseudo-word « ministryfunded » (probe of 05/11/2026): without
    // this reading the table would fabricate it. The document that writes « ministry-funded » mid-line keeps it.
    expect(
      texts(
        resolveCutHyphens(
          [[para(`a ministry${CUT_MARK}funded plan`), para("every ministry-funded body")]],
          "en",
        ).flat(),
      ),
    ).toEqual(["a ministry-funded plan", "every ministry-funded body"]);
  });

  it("the whole witness wins over everything: a capitalised cut word still joins by the first reading", () => {
    expect(
      texts(resolveCutHyphens([[para(`Dis${CUT_MARK}plays of affection`), para("such displays")]], "en").flat()),
    ).toEqual(["Displays of affection", "such displays"]);
  });

  it("🔴 a cut inside an address keeps its hyphen: « note-de- » + « methode.md »", () => {
    // `dgf-b5189db8e606` cuts « https://fonciris.fr/donnees/dpe-au-ras-du-seuil/note-de- » + « methode.md » : the bench
    // inventory of 05/11/2026 found « note-demethode.md », the address broken. ÉCHOUAIT AVEC : "…/note-demethode.md".
    expect(
      texts(resolveCutHyphens([[para(`voir https://fonciris.fr/note-de${CUT_MARK}methode.md ici`)]], "fr").flat()),
    ).toEqual(["voir https://fonciris.fr/note-de-methode.md ici"]);
    expect(texts(resolveCutHyphens([[para(`https://example.org/re${CUT_MARK}sources/x`)]], "en").flat())).toEqual([
      "https://example.org/re-sources/x",
    ]);
    // Sentence punctuation after the word is not an address: the cut still resolves.
    expect(texts(resolveCutHyphens([[para(`la promo${CUT_MARK}tion.`)]], "fr").flat())).toEqual(["la promotion."]);
  });

  it("🔴 an address is never touched, whatever sits beside the cut (05/11/2026 : « on ne coupe jamais une URL »)", () => {
    // A dot before the piece and nothing after it: the neighbour rule joined it. ÉCHOUAIT AVEC : "…/rapport.international".
    expect(
      texts(
        resolveCutHyphens(
          [[para(`voir https://exemple.org/rapport.inter${CUT_MARK}national ici`), para("international")]],
          "fr",
        ).flat(),
      ),
    ).toEqual(["voir https://exemple.org/rapport.inter-national ici", "international"]);
    expect(
      texts(resolveCutHyphens([[para(`voir www.inter${CUT_MARK}national.org`), para("international")]], "en").flat()),
    ).toEqual(["voir www.inter-national.org", "international"]);
    expect(texts(resolveCutHyphens([[para(`écrire à jean.du${CUT_MARK}pont@exemple.fr`)]], "fr").flat())).toEqual([
      "écrire à jean.du-pont@exemple.fr",
    ]);
  });

  // 🔴 THE RESIDUAL BIAS (05/11/2026), written: a NATIVE lowercase compound written ONCE, cut at its own hyphen, whose
  // pieces the document never writes alone, loses its hyphen when the table reads a legal cut. French typesetting cuts a
  // compound AT its hyphen by rule, so the position cannot discriminate. The capital refusal, the hyphenated witness and
  // the two-words refusal above keep every compound the bench and the two trial pages showed.
  it("a native lowercase compound written once, its pieces never alone, is joined: the residual bias", () => {
    expect(texts(resolveCutHyphens([[para(`le traditionnel jeu${CUT_MARK}concours du salon`)]], "fr").flat())).toEqual([
      "le traditionnel jeuconcours du salon",
    ]);
  });

  it("a hyphen the document writes mid-line is not the paper's: it is never touched", () => {
    expect(texts(resolveCutHyphens([[para("a two-way street"), para("twoway")]]).flat())).toEqual([
      "a two-way street",
      "twoway",
    ]);
  });

  it("no mark survives, in a nested table cell either", () => {
    const table: IRBlock = { kind: "table", rows: [{ cells: [{ blocks: [para(`géomé${CUT_MARK}trie variable`)] }] }] };
    const out = JSON.stringify(resolveCutHyphens([[table, para("une géométrie")]]));
    expect(out).toContain("géométrie variable");
    expect(out).not.toContain(CUT_MARK);
  });
});

describe("resolveCutHyphens — cost and chains (review 06/11/2026, point 9)", () => {
  it("🔴 a very long run of letters before a mark is read in linear time", () => {
    const text = `${"a".repeat(60_000)}1 ${"b".repeat(5)}${CUT_MARK}cd`;
    const started = Date.now();
    const out = texts(resolveCutHyphens([[para(text)]]).flat());
    expect(Date.now() - started).toBeLessThan(1000);
    expect(out[0]!.endsWith("bbbbb-cd")).toBe(true);
  });

  it("a mark inside the right half of a previous match is not a second match: it comes back as a hyphen", () => {
    expect(texts(resolveCutHyphens([[para(`xx ab${CUT_MARK}cd${CUT_MARK}ef`), para("abcd")]]).flat())[0]).toBe(
      "xx abcd-ef",
    );
  });

  it("a mark with no letter on one side comes back as a hyphen", () => {
    expect(texts(resolveCutHyphens([[para(`ab${CUT_MARK} 12${CUT_MARK}cd 3${CUT_MARK}`)]]).flat())[0]).toBe(
      "ab- 12-cd 3-",
    );
  });
});

describe("resolveCutHyphens — a word cut twice (three lines, review 06/11/2026)", () => {
  it("🔴 each mark is judged on its own two pieces: both go when the document writes both joins", () => {
    const out = texts(resolveCutHyphens([[para(`xx ab${CUT_MARK}cd${CUT_MARK}ef`), para("abcd cdef")]]).flat());
    expect(out[0]).toBe("xx abcdef");
  });
});

describe("hyphenationLanguageOf — the DOCUMENT's language, not the page's (10/11/2026)", () => {
  const FR =
    "Le conseil municipal a voté le budget de la ville pour l'année prochaine. Les élus ont discuté des écoles, des routes et des parcs, puis ils ont adopté le texte à une large majorité. Le maire a remercié les habitants pour leur participation aux réunions publiques et il a promis une nouvelle consultation avant la fin de l'été.";
  const DE =
    "Der Stadtrat hat den Haushalt für das nächste Jahr beschlossen. Die Abgeordneten haben über die Schulen, die Straßen und die Parks gesprochen, und sie haben den Text mit einer großen Mehrheit angenommen. Der Bürgermeister hat den Bürgern für ihre Teilnahme an den öffentlichen Sitzungen gedankt und eine neue Befragung vor dem Ende des Sommers versprochen.";

  it("🔴 a French document on an English page is judged with the French table", () => {
    expect(hyphenationLanguageOf([[para(FR)]], "en")).toBe("fr");
  });

  it("🔴 a document in a language without a table gets no table: the hyphen stays rather than a wrong table deciding", () => {
    expect(hyphenationLanguageOf([[para(DE)]], "en")).toBeUndefined();
  });

  it("a document too short to tell keeps the page's language, as before", () => {
    expect(hyphenationLanguageOf([[para("Budget 2026")]], "fr")).toBe("fr");
  });
});

describe("joinCutParagraphs — a word the paper cut never ends a paragraph (10/11/2026)", () => {
  const heading = (text: string, level: 1 | 2 = 2): IRBlock => ({ kind: "heading", level, inlines: [{ text }] });

  it("🔴 a paragraph ending on « letter- » and the next one starting lowercase become ONE paragraph, joined by the cut mark", () => {
    // Measured on 09/11: 300 of 393 blocks ending on a cut word had their continuation in the very next block.
    expect(texts(joinCutParagraphs([para("le conseil se réunit régu-"), para("lièrement le mardi")]))).toEqual([
      `le conseil se réunit régu${CUT_MARK}lièrement le mardi`,
    ]);
  });

  it("🔴 the joined word is then resolved like any cut word: two pieces of one style become one piece", () => {
    const out = resolveCutHyphens(
      [joinCutParagraphs([para("le conseil se réunit régu-"), para("lièrement le mardi")])],
      "fr",
    );
    expect(out[0]).toEqual([{ kind: "paragraph", inlines: [{ text: "le conseil se réunit régulièrement le mardi" }] }]);
  });

  it("the styles of both paragraphs survive: the inlines are kept, only the hyphen changes", () => {
    const out = joinCutParagraphs([
      para("a cut-"),
      { kind: "paragraph", inlines: [{ text: "ting", marks: ["strong"] }, { text: " edge" }] },
    ]);
    expect(out).toEqual([
      {
        kind: "paragraph",
        inlines: [{ text: `a cut${CUT_MARK}` }, { text: "ting", marks: ["strong"] }, { text: " edge" }],
      },
    ]);
  });

  it("a next paragraph starting with a capital, a digit or a blank stays apart: no discriminant, no join", () => {
    expect(joinCutParagraphs([para("Chapitre-"), para("Introduction")])).toHaveLength(2);
    expect(joinCutParagraphs([para("Total AG-"), para("002. reçu")])).toHaveLength(2);
    expect(joinCutParagraphs([para("régu- "), para("lièrement")])).toHaveLength(2);
  });

  it("a heading never swallows a paragraph; two headings of one level join like two paragraphs", () => {
    expect(joinCutParagraphs([heading("Non-"), para("monetised benefits")])).toHaveLength(2);
    expect(
      texts(
        joinCutParagraphs([heading("Non-"), heading("monetised benefits")]).map((b) =>
          b.kind === "heading" ? para(b.inlines[0]!.text + (b.inlines[1]?.text ?? "")) : b,
        ),
      ),
    ).toEqual([`Non${CUT_MARK}monetised benefits`]);
    expect(joinCutParagraphs([heading("Non-", 1), heading("monetised", 2)])).toHaveLength(2);
  });

  it("a word cut over three paragraphs joins all three", () => {
    expect(texts(joinCutParagraphs([para("in-"), para("compre-"), para("hensible")]))).toEqual([
      `in${CUT_MARK}compre${CUT_MARK}hensible`,
    ]);
  });

  it("paragraphs inside a table cell join too", () => {
    const table: IRBlock = { kind: "table", rows: [{ cells: [{ blocks: [para("des-"), para("ignated person")] }] }] };
    const [out] = joinCutParagraphs([table]);
    expect(out?.kind === "table" ? texts(out.rows[0]!.cells[0]!.blocks) : []).toEqual([`des${CUT_MARK}ignated person`]);
  });
});

describe("resolveCutHyphens — both halves are words of the document: a compound keeps its hyphen (10/11/2026)", () => {
  it("🔴 « self- / addressed » keeps its hyphen when the document writes « self » and « addressed » on their own", () => {
    // Measured on 09/11 over 155 real PDFs: of 175 cut words whose two halves are words of the document and with no whole
    // witness, about 165 are compounds (« above-average », « elle-même », « time-consuming »); the English table finds
    // « self|addressed » legal and joined it into a word nowhere written.
    expect(
      texts(
        resolveCutHyphens(
          [[para(`send a self${CUT_MARK}addressed envelope`), para("the self and the letter addressed to you")]],
          "en",
        ).flat(),
      )[0],
    ).toBe("send a self-addressed envelope");
  });

  it("the whole witness still wins: « every- / body » joins when the document writes « everybody »", () => {
    expect(
      texts(resolveCutHyphens([[para(`every${CUT_MARK}body came`), para("every body, everybody")]], "en").flat())[0],
    ).toBe("everybody came");
  });

  it("a cut word whose halves are not words keeps joining by the table", () => {
    expect(texts(resolveCutHyphens([[para(`se réunit régu${CUT_MARK}lièrement`)]], "fr").flat())[0]).toBe(
      "se réunit régulièrement",
    );
  });
});

describe("resolveCutHyphens — the French contracted relatives are always written as one word (10/11/2026)", () => {
  it("🔴 « aux- / quelles » joins although « aux » and « quelles » are both words of the document", () => {
    // The two-words refusal turned « auxquelles » into « aux-quelles » in two documents (measure of 10/11/2026). The
    // contracted relatives are a CLOSED set of French grammar, never hyphenated: a rule, not a dictionary.
    expect(
      texts(
        resolveCutHyphens(
          [[para(`les règles aux${CUT_MARK}quelles il obéit`), para("aux élèves : quelles règles ?")]],
          "fr",
        ).flat(),
      )[0],
    ).toBe("les règles auxquelles il obéit");
    expect(
      texts(
        resolveCutHyphens([[para(`les${CUT_MARK}quels choisir`), para("les élèves, quels choix")]], "fr").flat(),
      )[0],
    ).toBe("lesquels choisir");
  });

  it("the list is French: an English page of the same pieces keeps the two-words refusal", () => {
    expect(texts(resolveCutHyphens([[para(`aux${CUT_MARK}quelles`), para("aux quelles")]], "en").flat())[0]).toBe(
      "aux-quelles",
    );
  });
});

describe("joinCutParagraphs — cost (review 10/11/2026)", () => {
  it("🔴 a hostile chain of 40 000 cut paragraphs joins in linear time", () => {
    // Each merge used to rebuild the whole text and inlines of the growing block: quadratic on « a- » + « b- » + … .
    // Two styles per paragraph, so the pieces never fuse and the inlines of the growing block pile up.
    const piece = (): IRBlock => ({ kind: "paragraph", inlines: [{ text: "a" }, { text: "b-", marks: ["strong"] }] });
    const chain = Array.from({ length: 40_000 }, piece);
    const started = Date.now();
    const out = joinCutParagraphs([...chain, para("end")]);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind === "paragraph" ? out[0].inlines.map((i) => i.text).join("").length : 0).toBe(40_000 * 3 + 3);
  });
});
