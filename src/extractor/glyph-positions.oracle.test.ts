/**
 * THE ORACLE — does the subdivision recompose into what the page's runs return?
 *
 * (Before the removal of pdf.js, on 01/11/2026, the reference was pdf.js's `getTextContent()`: same stream, same document,
 * rebuilt by code that we did not touch. Today the items come from the runs of our reader.) For each item, a glyph must be found at ITS exact origin, carrying its first
 * character. This is the central test of `glyph-positions.ts`, and it would
 * have caught immediately the two errors that made the naive reconstructions
 * of 09/09/2026 return `NaN`: the CTM ignored, then `Td` not followed.
 *
 * ⚠️ **WHAT THIS ORACLE IS, AND WHAT IT IS NOT.** It validates our
 * subdivision **against the page's runs** (formerly against `getTextContent`). It therefore can NOT catch an
 * error that the runs also make: if a run placed a cycle in the
 * wrong place, we would place it in the same wrong place and this test
 * would be green. **It is not an absolute truth, it is a CONSISTENCY** between
 * two readings of the same stream — one aggregated, the other not. It guarantees that we
 * neither lose nor invent anything WHILE SUBDIVIDING; it does not guarantee that the runs are
 * right. An absolute truth would require an external reference — coordinates
 * taken by hand from a rendering, or a second independent PDF
 * engine. Neither exists here, and this is stated rather than
 * implied.
 *
 * WHY THIS FILE NEARLY STAYED INERT, AND WHAT THAT TAUGHT. At the
 * first pass, `T*` was not covered, and the measurement showed that the
 * two populations of documents are DISJOINT on this operator:
 *
 *   the five PDF fixtures of the repo   ->  nextLine, setLeading, NEVER moveText
 *   the real document measured          ->  moveText, NEVER nextLine
 *
 * The oracle therefore had no subject inside the repo. `T*` was covered
 * for this reason — a central test in motivated `skip` is not a central
 * test — and because it is entirely determined (`T*` ≡ `Td 0 −TL`).
 *
 * The real document that motivated this work is NOT here and will not be:
 * it is a minor's school report card, neither the PDF nor its operator stream
 * belong in a repo. The validation on it took place outside the repo —
 * 95 items out of 95, zero `NaN` over 2 990 glyphs. This file covers the same
 * property on the documents that can live here.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { buildGlyphFragments, type GlyphFragment, type NamedOp } from "./glyph-positions";
import { readPdfSource } from "./pdf-source";

interface TextItem {
  str: string;
  width: number;
  transform: number[];
}

/** Two different layouts: prose with a table (05a) and a
 *  label/value invoice (15), whose columns are tight. */
const FIXTURES = ["fixtures/pdf/05a-Rapport-Annuel-Digital.pdf", "fixtures/pdf/15-Facture-Libelle-Valeur.pdf"];

async function readPage(path: string, pageIndex: number): Promise<{ ops: NamedOp[]; items: TextItem[] }> {
  // Goes through the BOUNDARY since 14/09/2026. The oracle compares the
  // glyph reconstruction to the text of the page's runs; it must therefore READ
  // as production reads, otherwise it validates a configuration that is not
  // its own.
  const source = await readPdfSource(new Uint8Array(readFileSync(path)), { wantGlyphs: (i) => i === pageIndex });
  const page = source.pages[pageIndex]!;
  return {
    ops: page.ops,
    items: page.runs
      .filter((r) => r.text.trim().length > 0)
      .map((r) => ({
        str: r.text,
        width: r.width,
        transform: [r.matrix.a, r.matrix.b, r.matrix.c, r.matrix.d, r.matrix.e, r.matrix.f],
      })),
  };
}

/** Matched by POSITION, never by text. Matching by text is wrong
 *  as soon as a character repeats on the page — a first version of this
 *  probe thus announced 6 matches out of 95 and gaps of 465 pt, whereas
 *  the reconstruction was right and only the matching lied. */
const glyphAt = (glyphs: readonly GlyphFragment[], x: number, y: number): GlyphFragment | undefined =>
  glyphs.find((g) => Math.abs(g.x - x) < 0.05 && Math.abs(g.y - y) < 0.05);

describe("oracle — each run of the page is found in our glyphs (formerly each getTextContent cycle)", () => {
  for (const fixture of FIXTURES) {
    it(`origin and first character of each item — ${fixture.split("/").pop()}`, async () => {
      const { ops, items } = await readPage(fixture, 0);
      const glyphs = buildGlyphFragments(ops);

      // Entry guards: an oracle that compares nothing would pass silently,
      // and that is exactly the failure mode we refuse elsewhere.
      expect(glyphs.length).toBeGreaterThan(0);
      expect(items.length).toBeGreaterThan(0);
      expect(glyphs.length).toBeGreaterThan(items.length);

      const missing = items.filter((item) => {
        const hit = glyphAt(glyphs, item.transform[4]!, item.transform[5]!);
        return hit === undefined || !item.str.startsWith(hit.text);
      });
      expect(
        missing.map((m) => `"${m.str.slice(0, 20)}"@(${m.transform[4]!.toFixed(1)},${m.transform[5]!.toFixed(1)})`),
      ).toEqual([]);
    });

    it(`no NaN, and the whole text of the page is found — ${fixture.split("/").pop()}`, async () => {
      const { ops, items } = await readPage(fixture, 0);
      const glyphs = buildGlyphFragments(ops);

      for (const g of glyphs) {
        expect(
          Number.isFinite(g.x) && Number.isFinite(g.y) && Number.isFinite(g.width) && Number.isFinite(g.height),
        ).toBe(true);
      }

      // Nothing lost by subdividing: each item, stripped of its spaces,
      // is an ordered subset of the page's glyphs.
      const pageText = glyphs
        .map((g) => g.text)
        .join("")
        .replace(/\s+/g, "");
      for (const item of items) {
        expect(pageText).toContain(item.str.replace(/\s+/g, ""));
      }
    });
  }

  it("really subdivides: an item of several characters makes several glyphs", async () => {
    const { ops, items } = await readPage(FIXTURES[0]!, 0);
    const glyphs = buildGlyphFragments(ops);
    const longest = items.reduce((a, b) => (b.str.length > a.str.length ? b : a));
    expect(longest.str.length).toBeGreaterThan(3);

    const start = glyphAt(glyphs, longest.transform[4]!, longest.transform[5]!);
    expect(start).toBeDefined();
    // The glyphs of this run are contiguous and cover the width announced
    // by the run — this is the "width" half of the consistency, the other being
    // the origin verified above.
    const from = glyphs.indexOf(start!);
    // Spaces ARE glyphs here — they carry an advance, hence a
    // position. They are marked (`isSpace`) rather than dropped, precisely
    // so that the assignment can ignore them without the text losing them.
    const run = glyphs.slice(from, from + longest.str.length);
    expect(run.map((g) => g.text).join("")).toBe(longest.str);
    const spanned = run[run.length - 1]!.x + run[run.length - 1]!.width - run[0]!.x;
    expect(spanned).toBeGreaterThan(longest.width * 0.9);
  });
});
