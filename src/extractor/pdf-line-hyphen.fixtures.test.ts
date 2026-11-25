/**
 * A WORD THE PAPER CUT AT A LINE END COMES OUT WHOLE, IN PROSE TOO — on the
 * document that found it (manual three-way test, 29/10/2026).
 *
 * WHAT HAPPENED, MEASURED ON THE FILE ITSELF. 38-SOP page 6 prints a URL that
 * the paper wraps twice, on its own hyphens. The PDF holds it WHOLE and right:
 * the reference reading (PDFium) gives one single word,
 * `https://www.gmc-uk.org/registration-and-licensing/managing-your-registration/revalidation/my-db-tool,`.
 * Our page published `registration and-licensing` and `my-db tool`: a real
 * hyphen LOST, and a space INVENTED in its place. The URL exists nowhere on the
 * page — not to click, not to find. Chrome's own copy of the same PDF glues the
 * two halves instead (`my-dbtool`), so there is no reference to copy here: the
 * file is the reference, and we read it.
 *
 * WHY IT IS THE SAME FAMILY AS « sous-utilisés » (29/10, the night before) AND
 * WHY IT NEEDED ITS OWN RULE. The cell rule (`pdf-cell-paragraphs.ts`) only
 * fires on a line truly WRAPPED INSIDE A CELL; this text is prose, and the
 * junction is made elsewhere (`pdf-paragraphs.ts`). The counter-review of that
 * night is the reason this file exists rather than a shared predicate reused on
 * faith: a rule is only as safe as what its CALLER guarantees.
 *
 * THE BIAS, CHOSEN AND WRITTEN: a true hyphenation (« Dis-plays ») comes out
 * with a hyphen it should not have. Measured on the corpus the day before: 4
 * wrong out of 96 junctions, assumed by on 27/10/2026. We publish a
 * hyphen too many rather than cut a word in two — ugly and visible beats wrong
 * and invisible.
 *
 * Called by: nothing (a test).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import type { IRBlock } from "doc-ir";
import { extractPdf } from "./pdf";

const here = dirname(fileURLToPath(import.meta.url));
const SOP = "38-SOP-Video-Appraisals-Word365.pdf";

/** Every published text, cells and list items included, joined: the question here is what the page HOLDS, not where. */
const allText = (pages: readonly IRBlock[][]): string => {
  const out: string[] = [];
  const walk = (blocks: readonly IRBlock[]): void => {
    for (const block of blocks) {
      if (block.kind === "table") for (const row of block.rows) for (const cell of row.cells) walk(cell.blocks);
      else if (block.kind === "list") for (const item of block.items) walk(item);
      else if ("inlines" in block) out.push(block.inlines.map((i) => i.text).join(""));
    }
  };
  for (const page of pages) walk(page);
  return out.join("\n");
};

describe("un mot coupé par la fin d'une ligne, en PROSE (29/10/2026)", () => {
  let text: string;

  beforeAll(async () => {
    text = allText((await extractPdf(new Uint8Array(readFileSync(join(here, "../../fixtures/pdf", SOP))))).pages);
  }, 120_000);

  it("joint le premier retour à la ligne : « registration-and-licensing » sort entier", () => {
    expect(text).toContain("registration-and-licensing");
  });

  // The two halves of the URL came out in two table rows, so a search for the whole word found nothing. A row of
  // one cell that goes on with a URL returns into the cell above, with no separator.
  // Tried and set aside, both without effect: letting a cut word win over the vertical gap in the cell paragraphs,
  // then in the page paragraphs. The cut comes from before the paragraph grouping.
  it("rend l'URL entière, son second trait d'union gardé", () => {
    expect(text).toContain("my-db-tool");
  });

  it("n'invente pas une espace à la place du trait d'union", () => {
    expect(text).not.toContain("my-db tool");
    expect(text).not.toContain("registration and-licensing");
  });

  it("ne soude pas non plus, comme le fait la copie de Chrome", () => {
    expect(text).not.toContain("my-dbtool");
    expect(text).not.toContain("registrationand-licensing");
  });
});
