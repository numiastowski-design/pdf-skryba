/**
 * TASK 8 of the « page plan » chantier: THE BOUNDARY. Nobody but the plan asks for the geometry of a page.
 *
 * What this guard holds: the LIST of production files that touch `readingBands`, `readingSegments` or `bandedSplit`.
 * A list, not a count — a name that appears fails, even if another one is gone. Without it, step 2 could fix the drop
 * cap in the plan while a second path goes on deciding beside it, and the defect would come back by the back door.
 *
 * ⚠️ A GUARD HAS A PERIMETER, AND A PERIMETER THAT SHRINKS DOES NOT FAIL (paid on 13/11/2026 on the `fast-xml-parser`
 * guard, which swept 79 files out of 461 since the split into packages). Hence the two coverage checks before the list.
 *
 * SWEEPS ITS OWN PACKAGE ALONE (19/11/2026): in its public repository this package is the whole tree, and the base is
 * an installed dependency. The home repository holds the rest: the three packages swept together in
 * `tools/package-source-sweeps.test.ts`, the app's side — none of its production files calls the band reader — in
 * `src/page-plan-boundary.test.ts`.
 *
 * This file belongs to the `main` batch: it reads sources, it extracts nothing.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Its own package is found from where this file stands, never by its folder's name: the same path in the home
// repository and in the package's own.
const OWN_SOURCES = join(dirname(fileURLToPath(import.meta.url)), "..");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : /\.tsx?$/i.test(path) ? [path] : [];
  });

/** An import of one of the three names FROM the band reader — a mention in a comment is not a call. */
const CALLS_THE_BAND_READER =
  /import\s*\{[^}]*\b(?:readingBands|readingSegments|bandedSplit)\b[^}]*\}\s*from\s*["'][^"']*pdf-bands["']/;

describe("la frontière du plan de page", () => {
  it("🔴 seuls le plan — et la prose des pages à tableau, nommée ici — demandent la géométrie d'une page", () => {
    const scanned = walk(OWN_SOURCES).filter((path) => !/\.test(\.support)?\.tsx?$/.test(path));
    // Measured on 19/11/2026: 135 production files in this package. 167 when this test also swept the base (32), which
    // `tools/package-source-sweeps.test.ts` sweeps since; 461 on 13/11 with the app's 209, which its own half sweeps.
    // The floor says the sweep does not collapse.
    expect(scanned.length, "le balayage a rétréci : les sources du paquet ont changé de place").toBeGreaterThan(120);

    const callers = scanned
      .filter((path) => CALLS_THE_BAND_READER.test(readFileSync(path, "utf8")))
      .map((path) => path.slice(OWN_SOURCES.length + 1).replace(/\\/g, "/"))
      .sort();
    // `pdf-page-plan.ts` is the intended boundary. `pdf-page-tables.ts` is the named exception: `bandedSplit` cuts the
    // prose around a grid into four named parts, which the plan (slices and segments) has no shape for yet.
    expect(callers).toEqual(["extractor/pdf-page-plan.ts", "extractor/pdf-page-tables.ts"]);
  });

  it("le motif distingue un APPEL d'une mention en commentaire", () => {
    // The pattern must not count the comments that cite these names, or the list would be noise.
    expect(
      CALLS_THE_BAND_READER.test(`import { readingBands, readingSegments, type ReadSegment } from "./pdf-bands";`),
    ).toBe(true);
    expect(CALLS_THE_BAND_READER.test(" * voir `pdf-bands.ts#readingSegments`, qui se récurse dessus")).toBe(false);
  });
});
