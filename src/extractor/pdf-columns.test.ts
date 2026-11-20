/**
 * Point 13 of the former ideas tracker (git history) v0.6 — multiple columns and rotated text
 * (08/09/2026). Batch 1: the sort by ordinate.
 *
 * ⚠️ THIS FILE LOCKED A DEFECT FOR EIGHT DAYS; IT NOW LOCKS
 * ITS CLOSURE. The interleaving has been closed since 16/09/2026 — see
 * below — and the header was put straight the same day: it still announced
 * "an open defect" that its own body contradicted.
 *
 * WHAT BATCH 1 CLOSES — the signed gap
 * =====================================
 * `paragraphsFromLines` computes a SIGNED gap (`prev.y - line.y`). Any
 * emission that does not go down the page produced a NEGATIVE gap, hence never
 * a paragraph break, hence a silent merge. Two forms measured
 * on 08/09/2026, and the entry of point 13 only described one:
 *
 *  - a COLUMN change glued the last line of the left column to the
 *    first of the right one (`"Etape 4 : archiver le tout Regle A : ..."`);
 *  - two chart LABELS emitted out of order — « 2023 » at y=320 then
 *    « Volume archive » at y=440, gap −120 — merged into the same
 *    paragraph, with no relation to columns.
 *
 * The sort by decreasing ordinate closes both: the gap is now
 * always ≥ 0.
 *
 * WHAT BATCH 1 DID NOT CLOSE, AND WHAT CLOSED IT LATER
 * =========================================================
 * Two columns placed at the same ordinates remained a single visual line,
 * hence a single mixed paragraph. `layout/gutter.ts` closes it on 16/09/2026 by
 * providing a cut when no painted rule gives one.
 *
 * THE PRICE THAT BATCH 1 PAID IN THE MEANTIME, and why it had to be paid:
 * before the sort, page 1 (emitted column by column) came out ALMOST in the
 * right order, and the sort made it as interleaved as page 2 — hence less
 * good, for eight days. It was deliberate: the two pages have the SAME
 * geometry and returned two different readings depending on the emission order
 * alone. A defect that depends on the generating software does not reproduce
 * where we observe it. Making them uniform is what allowed fixing it ONCE
 * for both pages.
 *
 * This file belongs to the `pdf` batch of `vitest.config.ts` — it reads PDFs with our reader.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { IRBlock } from "doc-ir";
import { extractPdf } from "./pdf";
import { groupFragmentsIntoVisualLines, hasWeakTabularitySignal, type Fragment } from "../layout/geometry";

const here = dirname(fileURLToPath(import.meta.url));
const bytes = () => new Uint8Array(readFileSync(join(here, "../../fixtures/pdf/11-Brochure-Deux-Colonnes.pdf")));

/** 06/11/2026 : colonnes en tableau (option C). A band of columns is a one-row table, one cell per column: the blocks are read
 *  through the cells, left cell first, the order the flat reading had. */
const inReadingOrder = (blocks: readonly IRBlock[]): IRBlock[] =>
  blocks.flatMap((b) =>
    b.kind === "table" ? b.rows.flatMap((row) => row.cells.flatMap((cell) => inReadingOrder(cell.blocks))) : [b],
  );

const textesDeLaPage = async (index: number): Promise<string[]> => {
  const { pages } = await extractPdf(bytes());
  return inReadingOrder(pages[index] ?? []).map((b) =>
    b.kind === "paragraph" || b.kind === "heading" ? b.inlines.map((i) => i.text).join("") : "",
  );
};

describe("l'écart signé est fermé : plus aucune fusion due à une remontée", () => {
  it("les étiquettes d'axe ne fusionnent plus avec le titre d'axe", async () => {
    // This was the second form of the defect, and the most surprising: « 2023 »
    // (y=320) emitted BEFORE « Volume archive » (y=440) gave a gap of −120,
    // hence no break. Two labels 120 points apart in the
    // same paragraph. They are now two paragraphs.
    const textes = await textesDeLaPage(0);
    expect(textes).toContain("Volume archive");
    expect(textes).toContain("2023 2024 2025");
    expect(textes.some((t) => t.includes("2023 2024 2025") && t.includes("Volume archive"))).toBe(false);
  });

  it("la dernière ligne de gauche ne fusionne plus avec la première de droite", async () => {
    const textes = await textesDeLaPage(0);
    expect(textes).not.toContain("Etape 4 : archiver le tout Regle A : jamais de doublon");
  });
});

describe("le regroupement en lignes ne dépend plus du générateur", () => {
  /**
   * The two pages have the SAME layout and two different emission
   * orders. Before the sort, they returned 8 lines and 6 lines. This is
   * what this block locks: the geometry decides, not the software that wrote
   * the file.
   */
  it("les deux pages produisent la même structure de paragraphes", async () => {
    const [p0, p1] = [await textesDeLaPage(0), await textesDeLaPage(1)];
    // The title differs (« Procedures… » / « Meme page… ») and page 1 additionally carries
    // the chart; what is compared is the body of the columns.
    // Comparison INSENSITIVE to blanks: the separator between the two
    // columns, for its part, still depends on the emission order (bottom block). What
    // is compared here is the structure, not `unpdf`'s punctuation.
    const corps = (t: string[]) => t.filter((x) => x.startsWith("Etape")).map((x) => x.replace(/\s+/g, ""));
    expect(corps(p0)).toEqual(corps(p1));
    expect(corps(p0)).toHaveLength(4);
  });

  it("`hasWeakTabularitySignal` rend le même verdict sur les deux pages", async () => {
    // The predicate returned `false` on page 1 and `true` on page 2. It
    // measures gaps between fragments of the same line: if the line is
    // not the same depending on the generator, neither is the verdict.
    const { pages } = await extractPdf(bytes());
    expect(pages).toHaveLength(2);
    const verdicts = await Promise.all([0, 1].map(async (i) => verdictTabularite(i)));
    expect(verdicts).toEqual([true, true]);
  });
});

/** Rereads the raw fragments of a page and applies the predicate — the detector's
 *  path, not that of paragraph extraction. */
const verdictTabularite = async (pageIndex: number): Promise<boolean> => {
  // Goes through the BOUNDARY since 14/09/2026: this test used to open the
  // document itself with a bare `getDocument`, hence WITHOUT the options that
  // `getDocumentProxy` adds (`disableFontFace`, `standardFontDataUrl`,
  // `cMapUrl`, `cMapPacked`). It measured a configuration that production
  // does not use.
  const { readPdfSource } = await import("./pdf-source");
  const source = await readPdfSource(bytes());
  const frags: Fragment[] = (source.pages[pageIndex]?.runs ?? []).map((r) => ({
    text: r.text,
    x: r.x,
    y: r.y,
    width: r.width,
    height: r.height,
  }));
  return hasWeakTabularitySignal(groupFragmentsIntoVisualLines(frags));
};

describe("l'entrelacement est FERMÉ (16/09/2026) — la gouttière donne la coupe", () => {
  // Until now the cut only came from a PAINTED edge, and this brochure has none:
  // its two columns came out glued in a single line. This block
  // pinned the defect; it now pins its closure.
  //
  // What made it possible: `layout/gutter.ts` provides a cut when no rule
  // gives one, it is decided at the scale of the DOCUMENT, and the columns zone
  // tightens onto a CONTIGUOUS run — without which the chart at the bottom of
  // page 0 stretched the zone until it enclosed the full-width paragraph.
  it.each([0, 1])("page %i : les deux colonnes ne se mélangent plus", async (index) => {
    const sansBlancs = (await textesDeLaPage(index)).map((t) => t.replace(/\s+/g, ""));
    expect(sansBlancs).not.toContain("Etape1:ouvrirledossierRegleA:jamaisdedoublon");
  });

  it.each([0, 1])("page %i : chaque étape vit dans son propre paragraphe", async (index) => {
    const sansBlancs = (await textesDeLaPage(index)).map((t) => t.replace(/\s+/g, ""));
    expect(sansBlancs).toContain("Etape1:ouvrirledossier");
    expect(sansBlancs).toContain("RegleA:jamaisdedoublon");
  });

  it("le paragraphe pleine largeur, lui, reste intact — c'est le témoin", async () => {
    const textes = await textesDeLaPage(0);
    expect(textes).toContain("Ce paragraphe occupe toute la largeur et ne doit jamais etre entrelace.");
  });
});

describe("ce qui reste ouvert, et qu'il ne faut pas croire fermé", () => {
  // REMOVED ON 16/09/2026 — "the separator between the two columns". It
  // pinned an `unpdf` artefact: a filler item inserted between two
  // ADJACENT runs in the stream, hence a space on one page and not on the
  // other. The columns now being separated, the question no longer arises,
  // and its assertion repeated word for word that of the block above. A
  // duplicate that no longer measures anything costs the time it takes and gives
  // a coverage that we do not have.

  it("les étiquettes pivotées restent sur une ligne, séparées par un espace", async () => {
    // Rotated labels are still read as one horizontal line — rotation is a
    // separate work item. Since 21/09/2026 the 98 pt gaps between them are word
    // breaks (`pdf-lines.ts#WORD_GAP_EM`), so they are no longer glued.
    const textes = await textesDeLaPage(0);
    expect(textes).toContain("2023 2024 2025");
  });
});
