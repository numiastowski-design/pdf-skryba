/**
 * A PDF's colour discs and panels are never published as pictures (07/10/2026). Colour carries nothing for Confluence
 * search or Rovo, and a word turned into an image kept its text only in the alt attribute: not searchable. Fixture 38 has an
 * orange panel behind its headings on 8 pages (49 words came out as `image/svg+xml` inlines); fixture 30 has legend and cell discs.
 * Every such word is published as plain text, in place. Pictures that ARE the document's own (the two 16x16 bitmap legend badges
 * of a real school report) are not colour discs and stay: that counter-proof needs the real document, which stays in the
 * publisher's private repository, and the application's tests hold it.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { IRBlock, Inline } from "doc-ir";
import { extractPdf } from "./pdf";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/pdf");
const extract = async (name: string): Promise<IRBlock[][]> =>
  (await extractPdf(new Uint8Array(readFileSync(join(fixturesDir, name))))).pages;

const inlinesOf = (blocks: readonly IRBlock[]): Inline[] =>
  blocks.flatMap((b): Inline[] => {
    if (b.kind === "table") return b.rows.flatMap((r) => r.cells.flatMap((c) => inlinesOf(c.blocks)));
    if ("inlines" in b) return b.inlines;
    if ("items" in b) return b.items.flatMap((i) => inlinesOf(i));
    return [];
  });

const svgInlines = (pages: IRBlock[][]): string[] =>
  pages.flatMap((blocks, p) =>
    inlinesOf(blocks)
      .filter((i) => i.image?.mimeType === "image/svg+xml")
      .map((i) => `p${p + 1} ${JSON.stringify(i.text)}`),
  );

describe("no colour disc is a picture", () => {
  it("38 (an orange panel behind headings, pages 1-8): no word is an image, and its words are text nodes", async () => {
    const pages = await extract("38-SOP-Video-Appraisals-Word365.pdf");
    expect(svgInlines(pages)).toEqual([]);
    const textNodes = inlinesOf(pages[0]!)
      .filter((i) => i.image === undefined)
      .map((i) => i.text)
      .join(" ");
    expect(textNodes).toContain("Audience:");
    expect(textNodes).toContain("to best practice.");
  });

  it("30 (legend discs and a disc-only column): no picture is an SVG, the legend digits stay text", async () => {
    const pages = await extract("30-Bulletin-Fusion-Et-Couleur.pdf");
    expect(svgInlines(pages)).toEqual([]);
    const text = inlinesOf(pages.flat())
      .filter((i) => i.image === undefined)
      .map((i) => i.text)
      .join(" ");
    expect(text).toContain("Tres bonne");
  });
});
