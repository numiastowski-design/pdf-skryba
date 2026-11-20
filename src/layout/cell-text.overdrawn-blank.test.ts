/**
 * A blank glyph with no room of its own is not a space. Between two letters of a word, the producer paints a blank
 * that the next letter covers: the blank and the next letter start at the same abscissa. A rule that looks at the
 * previous letter only keeps that blank, and the word is cut in two for search.
 *
 * Why this document: the same word is broken at different places in four cells of one column. One mechanism.
 *
 * What it is not: the word-gap threshold. Every gap of the line is within ±0.02 em, and raising `WORD_GAP_EM` far
 * beyond reason repairs nothing.
 */ import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { extractPdf } from "../extractor/pdf";
import type { IRBlock } from "doc-ir";

const here = dirname(fileURLToPath(import.meta.url));
const FILE = join(here, "../../fixtures/pdf/55-PA-Annual-Report-2022-Word.pdf");

const textOf = (blocks: readonly IRBlock[]): string => {
  const out: string[] = [];
  const walk = (list: readonly IRBlock[]): void => {
    for (const b of list) {
      if (b.kind === "table") for (const row of b.rows) for (const cell of row.cells) walk(cell.blocks);
      else if (b.kind === "list") for (const item of b.items) walk(item);
      else if ("inlines" in b) out.push(b.inlines.map((inline) => inline.text).join(""));
    }
  };
  walk(blocks);
  return out.join("\n");
};

describe("un glyphe blanc recouvert par la lettre suivante n'est pas une espace", () => {
  it("🔴 « op erations: » se publie « operations: », comme les cinq autres du même document", async () => {
    const read = await extractPdf(new Uint8Array(readFileSync(FILE)), "en", {
      pageLimit: Number.POSITIVE_INFINITY,
      firstPages: 30,
    });
    const text = textOf(read.pages.flat());
    expect(text).not.toContain("op erations");
    // The right word must stay present, otherwise the test would pass on an empty document.
    expect(text.match(/operations/gu)?.length ?? 0).toBeGreaterThanOrEqual(6);
  }, 120_000);
});
