/** The wiring of the rectangle rules in the PDF reader: which module uses which row of `RECT_RULES`. The rules
 *  themselves are held by the base (`rect-rules.test.ts`, and their equality with the old functions by
 *  `rect.equivalence.test.ts`); neither sees a site that names the WRONG row (swapping « text-in-shape » for
 *  « cell-encloses » in a call turned no test red on 08/10/2026). This reads the sources of this package: each row is
 *  named in exactly the module(s) listed here, and a row of the other reader is named by none of them.
 *  ONE TEST PER READER since 19/11/2026: the table of rules is the base's, its sites are each reader's own, and a test
 *  reads no file outside its package. The declared formats hold their half in their own `rect-rules.sites.test.ts`. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { RECT_RULES } from "doc-ir/internal";

type Row = keyof typeof RECT_RULES;

const OWN_SOURCES = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Row of the table → the production modules of this package that evaluate it. A new site is a new entry here. */
const SITES: Partial<Record<Row, readonly string[]>> = {
  "cell-encloses": ["layout/intersection-cells.ts"],
  "grid-claim": ["extractor/pdf-page-tables.ts"],
};
/** The rows this package evaluates nowhere: the declared formats' own. Named, so that a new row is filed on purpose. */
const NOT_OURS: readonly Row[] = ["diagram-frame", "text-in-shape", "centre-in-box"];

const sourceOf = (path: string): string => readFileSync(join(OWN_SOURCES, path), "utf8");
const allSites = [...new Set(Object.values(SITES).flat())];

describe("each row of RECT_RULES the PDF reader uses is named in the module that owns it, and only there", () => {
  for (const [row, modules] of Object.entries(SITES)) {
    it(`"${row}" is used by ${modules.join(", ")} and by no other site of this package`, () => {
      for (const path of modules)
        expect(sourceOf(path), `${path} must name "${row}"`).toContain(`RECT_RULES["${row}"]`);
      for (const path of allSites) {
        if (modules.includes(path)) continue;
        // Failure value: a site wired to the row of another one.
        expect(sourceOf(path), `${path} must not name "${row}"`).not.toContain(`RECT_RULES["${row}"]`);
      }
    });
  }

  it("no site of this package names a row of the other reader", () => {
    for (const row of NOT_OURS)
      for (const path of allSites)
        expect(sourceOf(path), `${path} must not name "${row}"`).not.toContain(`RECT_RULES["${row}"]`);
  });

  it("the table and this map list the same rows", () => {
    expect([...Object.keys(SITES), ...NOT_OURS].sort()).toEqual(Object.keys(RECT_RULES).sort());
  });
});
