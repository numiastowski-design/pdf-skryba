/**
 * Fixtures 19 to 23 — Matterhorn conditions requiring HUMAN VERIFICATION,
 * transposed to our documents (15/09/2026). The full table of conditions
 * and their coverage lives in `docs/MATTERHORN-CIBLES.md` [purged 27/09/2026, git history].
 *
 * EACH EXPECTATION PINS THE REAL BEHAVIOUR, NOT THE DESIRED BEHAVIOUR.
 * `19` and `20` pinned defects, fixed on 15/09/2026; `21` pins an
 * accepted behaviour. Each expectation comes with a WITNESS, which shows
 * that the mechanism concerned works elsewhere: without it, the test would not
 * tell "the rule is wrong" from "the rule is not running".
 *
 * No client content: the four documents are synthetic, fabricated by
 * their generators in `fixtures/pdf/`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { IRBlock } from "doc-ir";
import { extractPdf } from "./pdf";
import { readPdfSource } from "./pdf-source";

const here = dirname(fileURLToPath(import.meta.url));
const bytesOf = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(join(here, `../../fixtures/pdf/${name}.pdf`)));

/** All the text of a block, sub-blocks included: lost content must not
 *  hide in a cell or a callout. */
function textOf(block: IRBlock): string {
  return JSON.stringify(block);
}

/** The BARE text of a top-level block, to say where the republished decoration lands. */
const plainText = (block: IRBlock): string => ("inlines" in block ? block.inlines.map((i) => i.text).join("") : "");

function pageText(blocks: IRBlock[]): string {
  return blocks.map(textOf).join("\n");
}

describe("19 — Matterhorn 01-002 : un titre numéroté au même point, qui n'est pas de l'habillage", () => {
  it("CORRIGÉ LE 15/09/2026 : « Annexe 1 », « Annexe 2 », « Annexe 3 » restent des titres", async () => {
    // Before, the decoration neutralised ALL numbers: the three titles
    // became the same "Annexe #" and disappeared. Only what has the shape
    // of a page number is neutralised now; "Annexe" is not a
    // page word, so the three lines stay different.
    const { pages } = await extractPdf(bytesOf("19-Annexes-Titre-Repete"));
    expect(pages).toHaveLength(3);
    pages.forEach((blocks, i) => {
      const titres = blocks.filter((b): b is Extract<IRBlock, { kind: "heading" }> => b.kind === "heading");
      expect(titres.map((h) => h.inlines.map((x) => x.text).join(""))).toEqual([`Annexe ${i + 1}`]);
    });
  });

  it("TÉMOIN : le pied « Document interne » reste dans l'onglet de chacune des trois pages", async () => {
    // 16/10/2026: no furniture removal in the tab layout; the footer stays on each page.
    const { pages } = await extractPdf(bytesOf("19-Annexes-Titre-Repete"));
    for (const blocks of pages) expect(pageText(blocks)).toContain("Cette annexe");
    expect(pages.flat().filter((b) => plainText(b).includes("Document interne"))).toHaveLength(3);
  });
});

describe("23 — Matterhorn 18-001 : de vrais numéros de page, seule variation admise d'un habillage", () => {
  it("l'en-tête « Rapport d'activite 2026 - p. N » et le pied « Document confidentiel / N/3 » restent dans l'onglet de chaque page", async () => {
    // 16/10/2026: no furniture removal in the tab layout; each page keeps its own header and footer.
    const { pages } = await extractPdf(bytesOf("23-Pages-Numerotees"));
    expect(pages).toHaveLength(3);
    pages.forEach((blocks, i) => {
      const texte = pageText(blocks);
      expect(texte).toContain("Rapport d'activite");
      expect(texte).toContain("Document confidentiel");
      expect(texte).toContain(`${i + 1}/3`);
    });
  });

  it("TÉMOIN : le titre de section et la prose de chaque page restent", async () => {
    const { pages } = await extractPdf(bytesOf("23-Pages-Numerotees"));
    const titres = pages.map((blocks) =>
      blocks
        .filter((b): b is Extract<IRBlock, { kind: "heading" }> => b.kind === "heading")
        .map((h) => h.inlines.map((x) => x.text).join("")),
    );
    expect(titres).toEqual([["Organisation"], ["Resultats"], ["Perspectives"]]);
    expect(pageText(pages[1]!)).toContain("Le nombre de demandes traitees");
  });
});

describe("20 — Matterhorn 01-002 : un titre de section déjà lu au sommaire, en tête de page", () => {
  it("CORRIGÉ LE 15/09/2026 : « Conditions de retour », titre en tête de la page 2, reste un titre", async () => {
    // Before, `detectRepeatedHeadBlocks` dropped it: its text had been seen in the
    // table of contents. The rule now checks what "the same block redrawn at the
    // head" implied — the earlier occurrence at the head of its page (A), at the
    // same size (B). Here the table of contents is at the head of page 1 but at 11 pt
    // against 14: it is B that decides.
    const { pages } = await extractPdf(bytesOf("20-Sommaire-Puis-Section"));
    const titres = pages[1]!.filter((b): b is Extract<IRBlock, { kind: "heading" }> => b.kind === "heading");
    expect(titres.map((h) => `h${h.level} ${h.inlines.map((i) => i.text).join("")}`)).toEqual([
      "h1 Conditions de retour",
      "h1 Resiliation",
    ]);
  });

  it("TÉMOIN : la prose de la section suit son titre, rien d'autre n'a bougé sur la page", async () => {
    const { pages } = await extractPdf(bytesOf("20-Sommaire-Puis-Section"));
    const texte = pageText(pages[1]!);
    expect(texte.indexOf("Conditions de retour")).toBeLessThan(texte.indexOf("Un materiel defectueux"));
    expect(texte).toContain("Resiliation");
  });
});

describe("21 — Matterhorn 15-004 : un encadré coloré déclaré tableau", () => {
  // Since lot « 33 » (22/09/2026) no background colour is published: the box that came
  // out as a `#dbebff` panel comes out flat, as its content. The test used to check the
  // panel and its colour; it now checks that no `bgColor` is written and nothing is lost.
  it("ACCEPTED BEHAVIOUR (22/09/2026): the box comes out flat, no panel and no one-cell table", async () => {
    // Not a defect for this product: the criterion is that Confluence search and Rovo find
    // the page, and "A retenir" is indexed whether it lives in a table or in a panel
    // (decision of 15/09/2026, STATUS). Both forms are accepted; the test pins the current
    // one so that it does not change unnoticed.
    //
    // Written for 09-002, a box label promoted to heading and nested in a panel. Until
    // 22/09/2026 the box never reached the panel: eight shapes tried on 15/09/2026 all came
    // out as a 1x1 table, and what set the real bulletin apart was not identified. It is
    // now: the borderless box is a LYING FILL of 470 x 78 pt, whose two short sides won
    // the grid vote. Since they no longer vote (`layout/vector-grid.ts`, step 2), no grid
    // is found.
    const { pages, tableDetections } = await extractPdf(bytesOf("21-Encadre-Avec-Intitule"));
    expect(tableDetections).toBeUndefined();
    const blocks = pages[0]!;
    expect(blocks.some((b) => b.kind === "table")).toBe(false);
    // The reader's half: the label is in the blocks handed over. That the PAGE writes no `bgColor` and carries the
    // label is held where the page is rendered.
    expect(pageText(blocks)).toContain("A retenir");
  });

  it("TÉMOIN : le titre de page, hors encadré, reste un titre de niveau 1", async () => {
    // « A retenir » was already an h2, inside the panel, where this top-level filter did
    // not see it. Since lot « 33 » the box is flat, so it shows up here: same heading.
    const { pages } = await extractPdf(bytesOf("21-Encadre-Avec-Intitule"));
    const titres = pages[0]!.filter((b): b is Extract<IRBlock, { kind: "heading" }> => b.kind === "heading");
    expect(titres.map((h) => `h${h.level} ${h.inlines.map((i) => i.text).join("")}`)).toEqual([
      "h1 Bilan du trimestre",
      "h2 A retenir",
    ]);
  });
});

describe("22 — tableau BALISÉ aux en-têtes faux : l'ORDRE se prend, le TYPE jamais", () => {
  // That pdf.js saw the structure tree here, and nowhere else, was
  // verified by the boundary oracle (`pdf-source.oracle.test.ts` (deleted, see git history), the only test allowed to open
  // pdf.js directly, removed with it).
  it("la frontière rend l'ORDRE déclaré de la page, et rien d'autre de l'arbre", async () => {
    const source = await readPdfSource(bytesOf("22-Tableau-Balise-En-Tetes-Faux"));
    const page = source.pages[0]!;
    expect(page.declaredOrder?.length).toBeGreaterThan(0);
    // Each cycle carries its marked-content identifier, and that is the ONLY
    // link with the tree: no role (`/TH`, `/TD`, `/H1`) crosses.
    expect(page.runs.every((run) => run.markedContentId !== undefined)).toBe(true);
  });

  it("lu par la géométrie, le tableau a des en-têtes JUSTES là où le balisage les donne faux", async () => {
    // 🔴 THE DECISIVE COUNTER-EXAMPLE, and it has been a NON-REGRESSION one since
    // 23/09/2026: this document passes `PASS ua1` at veraPDF and its markup
    // puts the header row in TD and the first column in TH. The
    // "declared reading order" lot reads its tree — for ORDER only.
    // The headers below remain those of the geometry.
    const { pages } = await extractPdf(bytesOf("22-Tableau-Balise-En-Tetes-Faux"));
    const tables = pages[0]!.filter((b): b is Extract<IRBlock, { kind: "table" }> => b.kind === "table");
    expect(tables).toHaveLength(1);
    expect(tables[0]!.rows.map((r) => r.cells.map((c) => (c.header ? "th" : "td")).join(" "))).toEqual([
      "th th th",
      "td td td",
      "td td td",
      "td td td",
    ]);
  });
});
