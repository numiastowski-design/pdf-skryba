/**
 * The frontier of the PDF object reader, held by a test: `src/extractor/pdf-objects/` reads a PDF with NO
 * library — no cantoo, no pdf.js, no zip, no XML parser. It is the whole point of the folder, and a single
 * `import` would undo it without anything saying so (the split of `pdf-decrypt.ts` on 31/10/2026 was made
 * exactly because importing it dragged cantoo into this graph).
 * Node's own modules are allowed: `node:zlib` for FlateDecode, `node:crypto` for the decryption keys.
 * Seen biting: adding `import { PDFDict } from "@cantoo/pdf-lib"` to `document.ts` makes this test fail
 * (checked on 31/10/2026).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Packages this folder must never reach, and the file that would let one in through the back door. */
const FORBIDDEN = [
  "@cantoo/pdf-lib",
  "pdf-lib",
  "pdfjs-dist",
  "jszip",
  "fast-xml-parser",
  "jpeg-js",
  "unpdf",
  "pdf-decrypt-pdflib",
];

const FOLDER = join(import.meta.dirname, ".");

const sources = readdirSync(FOLDER).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));

describe("the object reader reads a PDF with no library", () => {
  it("has sources to check (an empty population would prove nothing)", () => {
    expect(sources.length).toBeGreaterThan(5);
  });

  it.each(sources)("%s imports none of the extraction packages", (name) => {
    const text = readFileSync(join(FOLDER, name), "utf8");
    const imports = [...text.matchAll(/^\s*import[^;]*?from\s+"([^"]+)"/gm)].map((match) => match[1] as string);
    const reached = imports.filter((from) =>
      FORBIDDEN.some((package_) => from === package_ || from.endsWith(`/${package_}`)),
    );
    expect(reached, `${name} must read a PDF by itself`).toEqual([]);
  });
});
