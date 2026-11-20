/** The wiring of the two glyph windows (`glyph-window.ts`): a link reads the glyphs by their CENTRE, the letter-spacing re-reading by
 *  their START with its slack. `glyph-window.test.ts` holds each window; nothing saw a caller using the other one (switching the
 *  links to the start window turned no test red until the 08/10/2026 test of `pdf-links.test.ts`). This reads the sources: each
 *  window is named in the module that owns it and in no other. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const sourceOf = (file: string): string => readFileSync(join(here, file), "utf8");

describe("each glyph window is used by the module that owns it, and only there", () => {
  it("the links read the glyphs by their centre", () => {
    const source = sourceOf("pdf-links.ts");
    expect(source).toContain("CENTRE_WINDOW");
    expect(source).not.toContain("START_WINDOW");
  });

  it("the letter-spacing re-reading reads the glyphs by their start", () => {
    const source = sourceOf("pdf-letter-spacing.ts");
    expect(source).toContain("START_WINDOW");
    expect(source).not.toContain("CENTRE_WINDOW");
  });
});
