/**
 * Two readings of real Word PDFs (fixtures/docx-heading-reel, 25 documents exported by Word; measured 14/10/2026):
 *  - a contents line ending in leader dots and a page number ends its paragraph (13 of 25 documents merged their contents into
 *    blobs of up to 3,602 characters; 37 blobs over 200 characters, 0 after);
 *  - numbered lines in bold stay paragraphs, cells included: the size alone makes a heading.
 * Each test holds a WITNESS so that « nothing found » cannot pass by the document being empty.
 * NOT here: the rules themselves (`pdf-paragraphs.test.ts`).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PDFDocument } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";

import type { IRBlock } from "doc-ir";
import { extractPdf } from "./pdf";

const here = dirname(fileURLToPath(import.meta.url));

/** The file itself when it has at most `cap` pages, else its first `cap` pages copied into a file of their own: these
 *  tests were measured on documents cut that way, so they keep cutting that way. */
const firstPages = async (bytes: Uint8Array, cap: number): Promise<Uint8Array> => {
  const source = await PDFDocument.load(bytes);
  if (source.getPageCount() <= cap) return bytes;
  const out = await PDFDocument.create();
  const pages = await out.copyPages(
    source,
    Array.from({ length: cap }, (_, i) => i),
  );
  pages.forEach((page) => out.addPage(page));
  return out.save();
};

const read = async (name: string): Promise<IRBlock[]> => {
  const bytes = new Uint8Array(readFileSync(join(here, "../../fixtures/docx-heading-reel", `${name}-Word.pdf`)));
  return (await extractPdf(await firstPages(bytes, 15))).pages.flat();
};
const textOf = (block: IRBlock): string => ("inlines" in block ? block.inlines.map((i) => i.text).join("") : "");
const LEADER_RUN = /(\.{4,}|…{2,}|(\. ){4,})\s*(\d{1,4}|[ivxlc]{1,6})(\s|$)/g;
const headingsOf = (blocks: readonly IRBlock[]): string[] => blocks.filter((b) => b.kind === "heading").map(textOf);

describe("contents lines of real Word documents", () => {
  for (const name of ["04-nserc-accessibility-plan-2022-english", "03-2025-12-08-guide-communications-toolkit"]) {
    it(`${name.slice(0, 2)}: no published paragraph holds two leader-dot entries`, async () => {
      const blocks = (await read(name)).filter((b) => b.kind === "paragraph").map(textOf);
      expect(blocks.filter((t) => (t.match(LEADER_RUN) ?? []).length >= 2)).toEqual([]);
      // Witness: the contents entries are still published, one per paragraph.
      expect(blocks.filter((t) => (t.match(LEADER_RUN) ?? []).length === 1).length).toBeGreaterThan(5);
    }, 120_000);
  }
});

describe("la règle N est retirée : les lignes numérotées en gras restent des paragraphes (05/11/2026)", () => {
  // Accepted cost: these headings are lost as headings. The witness: the text is still there, as a paragraph.
  it("08: « 6.1 Roles and Responsibilities » n'est plus un titre, et n'est pas perdu", async () => {
    const blocks = await read("08-tbs-open-government-implementation-plan-2015-2016");
    expect(headingsOf(blocks).some((t) => t.startsWith("6.1 Roles"))).toBe(false);
    expect(JSON.stringify(blocks)).toContain("6.1 Roles and Responsibilities: Deputy Head");
  }, 120_000);

  it("18: aucune ligne numérotée de cellule n'est un titre — la question ne se pose même plus", async () => {
    const blocks = await read("18-rapport-annuel-vie-privee-2021-2022");
    expect(JSON.stringify(blocks)).toContain("1.1 Nombre de demandes reçues");
    expect(headingsOf(blocks).filter((t) => /^\d+\.\d+\s/.test(t))).toEqual([]);
  }, 120_000);
});

describe("headings next to page furniture (doc 17)", () => {
  it("17: « Note 4. Prêts » redevient un paragraphe (chemin par critères retiré, 05/11/2026) ; les titres par TAILLE restent", async () => {
    const blocks = await read("17-canada-account-annual-report-march-31-2024-final_fr");
    const headings = headingsOf(blocks);
    // Witness: the document still has its size headings, and the note title is published as a paragraph.
    expect(headings.length).toBeGreaterThanOrEqual(3);
    expect(headings.some((t) => t.startsWith("Note 4. Prêts"))).toBe(false);
    expect(blocks.map(textOf).join(" ")).toContain("Note 4. Prêts");
  }, 120_000);
});
