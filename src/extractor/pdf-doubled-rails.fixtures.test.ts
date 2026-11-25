/**
 * Rule A2 on a real page (chantier tableaux PDF, tranche A2, 27/10/2026): a thick rule drawn as two edges 3.7-3.8 pt apart is ONE
 * boundary; a comb field's boxes (15.8 pt) are not. The documents that pin those two halves are documents the package may not
 * carry, and stay out of it.
 * This file belongs to the `pdf` batch of `vitest.config.ts`: it reads PDFs with our reader.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { IRBlock } from "doc-ir";
import { walkBlocks } from "doc-ir/internal";
import { extractPdf } from "./pdf";

describe("06-homes page 8 — a 5.4-5.8 pt rail invents two words (28/10/2026)", () => {
  /**
   * KNOWN FAILURE SINCE 28/10/2026 — two INVENTED words on a page already in production (renders 117-120).
   *
   * WHAT THE PAGE REALLY PUBLISHES, MEASURED. Page 8 publishes, in order: a table, a paragraph, two headings, a second table, a
   * paragraph. In the second table, row 1 holds THREE cells — « Organisation: », an EMPTY one, and « orm. Send ministrator » as a
   * single paragraph. So neither neighbour of the fragment holds a « ...f » or a « ...ad »: this is NOT the tail of a word split
   * between adjoining cells. The sentence those pieces come from lives WHOLE in another cell further down the same page (row 13:
   * « ...is not a nominated security administrator. Please submit both the completed authorised signatory form and the security
   * administrator form. Send to ... »). The fragments are DUPLICATES of text published elsewhere: nothing is lost, two words are
   * invented. That is also why the last test below passes — it is satisfied by row 13, never by the defect site — so it does NOT
   * distinguish « repaired » from « the fragment was dropped ». Its job is narrow and stated: it fails only if the page's real
   * sentence disappears.
   *
   * THE GRID, MEASURED. The page draws its table with rails 5.4 to 5.8 pt thick, so the vector grid reads EIGHT column boundaries
   * (36.0 41.4 163.8 169.6 491.1 496.8 554.0 559.4) where the table has four rules — each rail registers its two painted edges.
   * `DOUBLED_RAIL_MAX_GAP_PT` merges a doubled rail up to 4 pt, so NONE of these four pairs is merged, and the sliver columns the
   * unmerged rails leave behind capture pieces of the text that passes OVER them.
   *
   * HYPOTHESIS 1, THE GLOBAL THRESHOLD AT 6 pt: IT DOES REPAIR THIS PAGE, AND IT IS STILL REFUSED. Measured twice on 28/10/2026.
   * With `DOUBLED_RAIL_MAX_GAP_PT = 6` the four rails merge and the invented-text test below PASSES — the direction is right. What
   * refuses it is the cost elsewhere, on three independent guards: `pdf-small-caps-space.fixtures.test.ts` (219 p2) then reads
   * « D ataType » and « P age »; `tools/bench/words` breaks on 01-osfi (words lost or invented); `tools/structure-truth/bench`
   * breaks on the same document (the structure floor). So the lever is wrong, not the direction: a GLOBAL constant admitting a
   * 6 pt gap over-merges pages whose narrow columns are real. The written populations of `pdf-table-detector.ts` stand (doubled
   * rails 3.7-3.84 pt, narrowest real column with text 4.73 pt) — these rails at 5.4-5.8 pt sit ABOVE the real column, which is
   * exactly why no single number separates them.
   *
   * A CLAIM MADE AND WITHDRAWN THE SAME EVENING: « 6 pt repairs nothing here ». It rested on a version of the last test that could
   * not fail at all — two regexes committed with `\b` as a literal BACKSPACE byte (U+0008), which an editor, a diff and
   * `git show` all render as nothing. The re-measurement says the opposite. Kept because a wrong reason for a right decision is
   * worth more dead than buried.
   *
   * HYPOTHESIS 2, NOT YET TRIED, AND NOW THE LIKELIEST: the fix is per-rail, not global. `straddled-boundaries.ts#replacementOf`
   * already folds a rail of the HULL onto its outer painted edge, and only an INNER rail onto the midpoint — which is what the
   * geometric cap of `DOUBLED_RAIL_MAX_GAP_PT` is about (`merged-cells.ts` recognises a boundary only within 2 pt of a painted
   * stroke, so a midpoint further than that makes every row read a colspan). An inner rail folded onto one of its painted edges
   * would lift that cap, and the gap could then be allowed per rail — where the pair holds no fragment centre AND the folded
   * boundary lands on a stroke — instead of being raised for every page at once. Which edge, and what it costs on the three
   * guards above, is measured BEFORE it is written.
   *
   * ALSO OPEN: the bench of 28/10 at 00:45 counted THREE invented words on this page; the reading above finds TWO. The third is
   * not identified, and a fix that repairs only these two would leave it.
   */
  const docxReel = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/docx-reel");

  /** Read and extracted ONCE for the three tests: each of them only reads the result, and the extraction costs ~0.55 s. */
  const page8 = (() => {
    let once: Promise<readonly IRBlock[]> | undefined;
    const read = async (): Promise<readonly IRBlock[]> => {
      const { pages } = await extractPdf(
        new Uint8Array(readFileSync(join(docxReel, "06-homes-england-ims-registration-Word.pdf"))),
      );
      return pages[7] ?? [];
    };
    return (): Promise<readonly IRBlock[]> => (once ??= read());
  })();

  /**
   * The paragraph and heading texts the page publishes, through `lib/ir-walk.ts#walkBlocks` — the repo's ONE traversal, whose
   * exhaustive switch ends in `never` so a container kind added to `IRBlock` fails to COMPILE instead of being silently skipped. A
   * hand-written walk stood here until the review of 28/10/2026 showed it enumerated `list` and `table` only, missing the four
   * other containers `childBlockLists` handles — `footnote`, `section`, `columns` and `tabs` — the same drift that module's header
   * records for 07/10/2026, when three walks missed `columns`. The PDF extractor emits `columns` (`pdf-page-tables.ts`,
   * side-by-side prose) and is moving towards `tabs` (one tab per page), so the blind spot was real on both.
   * WHAT THIS DOES NOT READ, said rather than implied: the text inside a `diagramText` block (`walkInlineRuns` covers that one).
   * The PDF path emits none today — it appears on the docx and pptx paths — so the omission is stated, not closed.
   */
  const textsOf = (blocks: readonly IRBlock[]): string[] => {
    const texts: string[] = [];
    walkBlocks(blocks, (block) => {
      if (block.kind === "paragraph" || block.kind === "heading") {
        texts.push(
          block.inlines
            .map((inline) => inline.text)
            .join("")
            .replace(/\s+/gu, " ")
            .trim(),
        );
      }
    });
    return texts.filter((text) => text !== "");
  };

  /**
   * The invented text, matched on a LOWER-CASED copy with a lookbehind each time, because the obvious forms are all wrong and the
   * reviews of 28/10/2026 found each of them in turn.
   * - `includes("ministrator") && !includes("administrator")` is CASE-SENSITIVE: « Administrator » holds the first and not the
   *   second, so that form accused 30 legitimate paragraphs of pages 6, 7 and 9 to 12 (« Security Administrator Name »,
   *   « 5. Administrators »...). Page 8 escaped only by luck, its row 13 holding the lowercase word too.
   * - `startsWith("orm.")` only sees a fragment at the START of a paragraph: a per-rail fix folding the sliver into its neighbour
   *   would yield « Organisation: orm. Send », which no `startsWith` catches — the test would go green, the `it.fails` would be
   *   removed as « fixed », and an invented word would ship.
   * - `includes("orm.")` catches « form. » too, which is the legitimate word.
   * - `(?<!f)orm\.` excludes the ONE letter `f`, so it accuses every other word ending in `-orm.`: « that is the norm. », « after
   *   the storm. » both matched (measured). Since hypothesis 2 is expected to change this table's cell geometry, a reflow bringing
   *   such a word into one of these cells would keep this test « failing as expected » for a reason unrelated to the defect — the
   *   exact distinction the lookbehind was added to protect.
   * So: a LETTER boundary, not one letter — `(?<![a-z])` on a lower-cased copy, the same shape for both needles so the intent
   * reads. Verified on nine real cases: it catches the fragment, the folded variant « organisation: orm. send » and the per-rail
   * case « form. send ministrator », and innocents « norm. », « storm. », « form. », « administrator », « security administrator
   * name », « 5. administrators », « guidance on administrator role ». No `\b`, and this file is written with an editor and never
   * through a shell: a heredoc turned `\b` into a literal BACKSPACE byte here once, and `it.fails` reported the dead test green.
   */
  const INVENTED = [/(?<![a-z])orm\./u, /(?<![a-z])ministrator/u];

  // The cause: two overlapping merges each collected the slot they share. A slot belongs to one merge only.
  it("publishes none of the invented text", async () => {
    const found = textsOf(await page8()).filter((text) => INVENTED.some((pattern) => pattern.test(text.toLowerCase())));
    expect(found, "a rail left pieces of another cell's sentence in a sliver column").toEqual([]);
  });

  it("reads page 8 at all (a guard on a page that does not exist watches nothing)", async () => {
    const texts = textsOf(await page8());
    expect(texts.length, "page 8 published no text: the extraction was refused or the pages moved").toBeGreaterThan(5);
  });

  /**
   * Case-SENSITIVE on purpose, and it was lower-cased for one commit by mistake (review of 28/10/2026). Row 13 carries both needles
   * in lower case, so lowercasing bought nothing; what it cost is that « administrator » could then be satisfied by a capitalised
   * « Administrator » heading elsewhere on the page — so a fix that DROPPED row 13 while leaving such a heading would keep this
   * test green and the loss of the real sentence would go unseen. This is the only guard watching that sentence; it stays strict.
   */
  it("still publishes the real sentence those fragments come from", async () => {
    const whole = textsOf(await page8()).join(" ");
    for (const word of ["form.", "administrator"]) expect(whole, `${word} must stay published`).toContain(word);
  });
});
