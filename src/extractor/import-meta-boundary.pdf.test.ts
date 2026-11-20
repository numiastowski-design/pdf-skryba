/**
 * Boundary (05/10/2026): every `import.meta` in shipped source takes a form Forge's webpack supports.
 *
 * Since 05/10/2026 esbuild bundles the functions (manual packaging, `tools/build-functions.ts`); in
 * CommonJS output it empties `import.meta`, so the same forms behave the same. The boundary stays for a
 * way back to Forge's webpack (removing `app.package` from `manifest.yml`), which rewrites
 * `import.meta.url` and a destructuring `const { x } = import.meta`; any other use, such as
 * `import.meta.resolve(...)`, becomes `({})` and prints « Critical dependency: Accessing import.meta
 * directly is unsupported » on every deploy (`docs/PLATFORM-STATUS.md` §28). That warning came from
 * `pdfjs-module.ts` (deleted, see git history) (since removed with pdf.js) alone and hid any new one behind it.
 *
 * This is a text check, not a bundle: it does not run webpack. The rewrite itself was measured once with
 * the webpack of Forge CLI 13.4.0 (destructuring: no warning, `resolve: undefined` in the bundle).
 *
 * SWEEPS the source tree this file lives in. This copy is the PDF reader's; the declared formats carry their own
 * (`import-meta-boundary.docs.test.ts`), so that each package keeps the guard when the tree is split in two.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** `import.meta.url`, or `import.meta` as the right-hand side of a destructuring declaration. */
const SUPPORTED = /import\.meta\.url\b|\}\s*=\s*import\.meta\s*;/g;

describe("import.meta in shipped source", () => {
  it("only takes the forms Forge's webpack rewrites without a warning", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC_DIR)) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (/^\s*(\*|\/\/)/.test(line)) return;
          if (line.replace(SUPPORTED, "").includes("import.meta")) {
            offenders.push(`${relative(SRC_DIR, file)}:${index + 1}: ${line.trim()}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });
});
