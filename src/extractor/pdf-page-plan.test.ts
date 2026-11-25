/**
 * The page plan invents nothing: it is the one entry to a page's geometry, and it gives what `readingBands` (or
 * `segmentsInDeclaredOrder` on a tagged page) gives when called directly, seated drop caps apart.
 *
 * This file belongs to the `pdf` batch of `vitest.config.ts` — it reads PDFs with our reader.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { documentColumnCuts } from "../layout/gutter";
import { readingBands, type ReadSegment } from "./pdf-bands";
import { pagePlanOf, pagePlanReader, type PagePlan } from "./pdf-page-plan";
import { readPdfSource, type PdfTextRun } from "./pdf-source";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(here, `../../fixtures/pdf/${name}`)));

/** The bands of a plan that holds a single slice. */
const onlyBands = (plan: PagePlan): readonly ReadSegment<PdfTextRun>[] | undefined => {
  expect(plan.slices).toHaveLength(1);
  return plan.slices[0]!.bands;
};

describe("le plan de page ne décide rien de neuf (étape 1)", () => {
  it("une page sans texte ne lève pas, et le plan n'invente pas de filtrage", () => {
    // `readingBands([], [])` gives one empty segment; the plan gives the same and does not filter it out, which
    // would be a rule of its own.
    const plan = pagePlanOf([], undefined);
    expect(plan.cuts).toEqual([]);
    expect(onlyBands(plan)).toEqual(readingBands([], []));
    expect(plan.slices[0]!.bands).toEqual([{ lines: [], column: false }]);
    expect(plan.slices[0]!.top).toBeUndefined();
    expect(plan.slices[0]!.bottom).toBeUndefined();
  });

  it("les runs tournés n'entrent pas dans une colonne — brochure 11", async () => {
    // Rotated runs share the baseline of no horizontal text: the plan must not take them for one more band.
    const src = await readPdfSource(fixture("11-Brochure-Deux-Colonnes.pdf"));
    const all = src.pages[0]!.runs;
    const cuts = documentColumnCuts(src.pages.map((_, i) => src.pages[i]!.runs.filter((r) => r.rotated !== true)));
    const plan = pagePlanOf(all, cuts.length === 0 ? undefined : { cut: cuts[0]!, all: cuts });
    expect(onlyBands(plan)).toEqual(readingBands(all, cuts));
  });

  it("au-delà de MAX_BAND_ZONES_PER_PAGE le plan rend le même verdict que readingBands", () => {
    // A made-up page of 65 zones: the plan must not recurse once more than the banded reading does.
    const items: PdfTextRun[] = [];
    for (let zone = 0; zone < 65; zone += 1) {
      const y = 1000 - zone * 15;
      items.push({ text: `gauche ${zone}`, x: 50, y, width: 60, fontSize: 9 } as PdfTextRun);
      items.push({ text: `droite ${zone}`, x: 300, y, width: 60, fontSize: 9 } as PdfTextRun);
      items.push({ text: `titre pleine largeur ${zone}`, x: 50, y: y - 7, width: 320, fontSize: 9 } as PdfTextRun);
    }
    expect(onlyBands(pagePlanOf(items, { cut: 200, all: [200] }))).toEqual(readingBands(items, [200]));
  });
});

describe("le plan porte les TRANCHES, dans l'ordre où la page est lue (tâche 3 bis)", () => {
  it("une image ILLISIBLE garde sa place au plan (tâche 5)", () => {
    // The place is taken though the pixels are missing: dropped, the columns would be decided on a page without a
    // picture that still takes height on it.
    const reader = pagePlanReader({ cut: 200, all: [200] });
    const [lisible, illisible] = reader.watchPictures([
      { top: 700, bottom: 600, xMin: 50, xMax: 180, read: () => [{ kind: "paragraph", inlines: [{ text: "photo" }] }] },
      { top: 500, bottom: 400, xMin: 220, xMax: 380, read: () => undefined },
    ]);
    expect(reader.plan.pictures.map((p) => p.readable)).toEqual([undefined, undefined]);
    expect(lisible!.read()).toHaveLength(1);
    expect(illisible!.read()).toBeUndefined();
    expect(reader.plan.pictures.map((p) => p.readable)).toEqual([true, false]);
    // The first lies left of the cut, the second right of it, neither crosses it.
    expect(reader.plan.pictures.map((p) => p.band)).toEqual([0, 1]);
  });

  it("une image qui TRAVERSE une coupe n'est dans aucune bande, et une page sans coupe n'en a pas", () => {
    const traverse = pagePlanReader({ cut: 200, all: [200] });
    traverse.watchPictures([{ top: 700, bottom: 600, xMin: 50, xMax: 380, read: () => [] }]);
    expect(traverse.plan.pictures[0]!.band).toBeUndefined();
    const sansCoupe = pagePlanReader(undefined);
    sansCoupe.watchPictures([{ top: 700, bottom: 600, xMin: 50, xMax: 380, read: () => [] }]);
    expect(sansCoupe.plan.pictures[0]!.band).toBeUndefined();
  });

  it("l'étendue se mesure sur le texte ENCRÉ, pas sur les blancs de remplissage", () => {
    // A filler item spans from one column to the next: counted, it would make each column look full width.
    const reader = pagePlanReader({ cut: 200, all: [200] });
    reader.bands([
      { text: "gauche", x: 50, y: 700, width: 60, height: 9, fontSize: 9 },
      { text: "   ", x: 110, y: 700, width: 180, height: 9, fontSize: 9 },
    ] as PdfTextRun[]);
    const extent = reader.plan.slices[0]!.extents[0]!;
    expect([extent.left, extent.right]).toEqual([50, 110]);
  });
});
