/**
 * Point 13 — the three fixtures of lot 2, and what lot 3 does with them
 * (08/09/2026).
 *
 * ⚠️ THIS FILE LOCKS BOTH A FIX AND TWO OPEN DEFECTS.
 * Each is named; none is presented for the other.
 *
 * WHY THESE THREE FIXTURES
 * ========================
 *  - `15-Facture-Libelle-Valeur.pdf` — the most likely false positive. An
 *    invoice carries labels on the left and values on the right: the same
 *    geometric signature as two columns of prose. Partitioning it
 *    would publish all the labels, then all the values. **The discriminant
 *    does not partition it** — its second line-spacing rhythm, repeated 3 times,
 *    designates it as a table (stage 2). A SECOND guard backs it up since
 *    16/09/2026: it carries TWO gutters, hence a grid, and `columnCut`
 *    abstains. The three expectations of this file fell the day an
 *    intermediate version discarded the narrower of the two BEFORE the count —
 *    which left only one, hence "two columns". They did their
 *    job;
 *  - `16-Brochure-Dense.pdf` — 44 lines per column. **The only document of the
 *    corpus that the discriminant partitions**, and the only one dense enough for
 *    a threshold expressed as a fraction to mean something;
 *  - `17-Tableau-Sans-Bordure-Cellules-Longues.pdf` — the case where the
 *    discriminant would be wrong: a borderless table whose cells
 *    are sentences. Geometrically, two columns; semantically, a
 *    table. **Not partitioned** — its second rhythm (20 pt, seen 5 times)
 *    gives it away.
 *
 * WHAT REMAINS OPEN, AND IS TESTED HERE AS SUCH
 * =============================================
 * The invoice and the borderless table still come out interleaved. This is
 * not what point 13 fixes: it fixes the READING ORDER of a page in
 * columns. Rebuilding a borderless table is milestone 2 of
 * `ARBITRAGE-TABLEAUX-PDF.md` [purged 27/09/2026, git history], and its grid is today rejected by
 * the conservation invariant (33 ambiguous fragments out of 41 for the invoice,
 * 17 out of 26 for the table).
 *
 * This file belongs to the `pdf` batch of `vitest.config.ts` — it reads PDFs with our reader.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { IRBlock } from "doc-ir";
import { extractPdf } from "./pdf";

const here = dirname(fileURLToPath(import.meta.url));
/** 06/11/2026 : colonnes en tableau (option C). A band of columns is a one-row table, one cell per column: the blocks are read
 *  through the cells, left cell first, the order the flat reading had. */
const inReadingOrder = (blocks: readonly IRBlock[]): IRBlock[] =>
  blocks.flatMap((b) =>
    b.kind === "table" ? b.rows.flatMap((row) => row.cells.flatMap((cell) => inReadingOrder(cell.blocks))) : [b],
  );
const textes = async (nom: string): Promise<string[]> => {
  const { pages } = await extractPdf(new Uint8Array(readFileSync(join(here, `../../fixtures/pdf/${nom}`))));
  return inReadingOrder(pages.flat()).map((b) =>
    b.kind === "paragraph" || b.kind === "heading" ? b.inlines.map((i) => i.text).join("") : "",
  );
};

describe("15 — la facture est déjà mélangée aujourd'hui", () => {
  it("le bloc émetteur et le bloc client s'entrelacent", async () => {
    // The two blocks are placed at the same y coordinates, as on any invoice.
    const t = await textes("15-Facture-Libelle-Valeur.pdf");
    expect(t.some((x) => x.includes("14 rue des Archives") && x.includes("Cabinet Lenoir et Associes"))).toBe(true);
  });

  it("libellé et valeur restent collés sur une MÊME ligne — l'entrelacement, lui, demeure", async () => {
    // AMENDED ON 10/09/2026, and the nuance matters. This test asserted that two
    // neighbouring lines came out in the same paragraph. This is no longer true
    // since the next-word rule separates them, and it is PROGRESS: these
    // are indeed two distinct data items.
    //
    // The defect this file documents is not there: it is the HORIZONTAL
    // mixing of the label and its value, placed at the same y coordinates. It is
    // intact, and it is what the test must hold.
    const t = await textes("15-Facture-Libelle-Valeur.pdf");
    expect(t.some((x) => x.includes("Numero de facture F-2026-0147"))).toBe(true);
    expect(t.some((x) => x.includes("Date d'emission 12 mars 2026"))).toBe(true);
  });

  it("les totaux restent lisibles — c'est le témoin", async () => {
    // The totals block is alone on its y coordinates: nothing to interleave with.
    const t = await textes("15-Facture-Libelle-Valeur.pdf");
    expect(t.some((x) => x.includes("Total TTC 1 136,40"))).toBe(true);
  });
});

describe("16 — les deux colonnes se lisent dans l'ordre (lot 3)", () => {
  /**
   * The only document of the corpus that the discriminant partitions. Before lot 3,
   * its 88 lines of prose came out as ONE interleaved paragraph: the line-spacing
   * rhythm being perfectly regular, no break was ever
   * triggered.
   */
  it("la colonne de gauche se lit entière, sans un mot de la droite", async () => {
    const t = await textes("16-Brochure-Dense.pdf");
    const gauche = t.find((x) => x.startsWith("Le classement d'un fonds documentaire"));
    expect(gauche).toBeDefined();
    expect(gauche).toContain("Le classement d'un fonds documentaire commence par un inventaire physique.");
    expect(gauche).not.toContain("La numerisation vient apres le classement");
  });

  it("puis la colonne de droite, entière elle aussi", async () => {
    // AMENDED ON 10/09/2026. The column no longer comes out as ONE block: the next-word
    // rule finds breaks in it. On this fixture, these breaks
    // prove nothing — its lines are DRAWN one by one at y coordinates
    // chosen by hand, with the slack the generator's author wanted, so
    // they were never composed (git history §2).
    // A paragraph count has no probative value here.
    //
    // WHAT THIS LOT GUARANTEES, AND IS INTACT: the ORDER. The right band
    // is read entirely, from its first to its last sentence, without ever
    // interleaving with the left one.
    const t = await textes("16-Brochure-Dense.pdf");
    const debut = t.findIndex((x) => x.startsWith("La numerisation vient apres le classement"));
    expect(debut).toBeGreaterThanOrEqual(0);
    const droite = t.slice(debut).join(" ");
    expect(droite).not.toContain("Le classement d'un fonds documentaire");
    expect(droite).toContain("les cles remises contre recu");
  });

  it("et dans cet ordre — gauche avant droite", async () => {
    const t = await textes("16-Brochure-Dense.pdf");
    expect(t.findIndex((x) => x.startsWith("Le classement"))).toBeLessThan(
      t.findIndex((x) => x.startsWith("La numerisation")),
    );
  });

  it("le titre et le chapeau pleine largeur restent en tête, chacun d'un bloc", async () => {
    // The lead paragraph is the case that made a first version of the
    // partitioning fail: its LAST line is short, so it does not cross
    // the cut, and it came out as a separate paragraph. The column zone is
    // delimited by the text lines on both sides, not line by line.
    const t = await textes("16-Brochure-Dense.pdf");
    expect(t[0]).toBe("Conduite d'un chantier d'archivage");
    expect(t[1]).toContain("Ce guide resume la conduite d'un chantier");
    expect(t[1]).toContain("fait ses preuves sur des fonds de toutes tailles.");
  });

  it("les blocs de gauche précèdent TOUS ceux de droite — c'est ça, le lot 3", async () => {
    // AMENDED ON 10/09/2026: this test used to count four blocks. The count depended on
    // how the paragraphs were built, not on what lot 3
    // guarantees. What it guarantees is the order, and that is what is checked here.
    const t = await textes("16-Brochure-Dense.pdf");
    const dernierGauche = t
      .map((x) => x.includes("cote provisoire") || x.startsWith("Le classement"))
      .lastIndexOf(true);
    const premierDroite = t.findIndex((x) => x.startsWith("La numerisation vient apres le classement"));
    expect(dernierGauche).toBeGreaterThanOrEqual(0);
    expect(premierDroite).toBeGreaterThan(dernierGauche);
  });
});

describe("17 — les cellules du tableau sans bordure s'entrelacent rangée par rangée", () => {
  it("la cellule de gauche suit celle de droite, séparée par un espace", async () => {
    // Still interleaved row by row, but no longer glued: the 61.7 pt gap between
    // the two cells is a word break (`pdf-lines.ts#WORD_GAP_EM`, 21/09/2026).
    const t = await textes("17-Tableau-Sans-Bordure-Cellules-Longues.pdf");
    expect(t.some((x) => x.includes("Perte d'une unite entre le local de depot et la Cote provisoire portee"))).toBe(
      true,
    );
  });

  it("l'en-tête des deux colonnes fusionne aussi", async () => {
    const t = await textes("17-Tableau-Sans-Bordure-Cellules-Longues.pdf");
    expect(t).toContain("Risque identifie Mesure de mitigation");
  });

  it("une rangée dont la cellule droite tient sur une seule ligne survit", async () => {
    // "Perte du fichier maitre" faces a short measure: both
    // cells fit on the same number of lines, so nothing overflows onto
    // the next row. It is the only clean case of the document.
    const t = await textes("17-Tableau-Sans-Bordure-Cellules-Longues.pdf");
    expect(t.some((x) => x.startsWith("Perte du fichier maitre Conservation sans compression destructive"))).toBe(true);
  });
});
