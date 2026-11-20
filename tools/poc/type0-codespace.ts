/** POC `docs/POC-SANS-PDFJS.md`: the hypothesis of `shown-glyphs.ts` — "a Type0 font codes its glyphs on
 *  TWO bytes" — measured instead of assumed. DEVELOPMENT tool, outside the bundle.
 *  Decides: nothing. It classifies each USED Type0 font by its `/Encoding` (§9.7.5): `Identity-H/V`, a named
 *  predefined CMap, or an EMBEDDED CMap — and for the latter it reads its `codespacerange` (§9.7.6.2) to
 *  say on how many bytes it really codes. A CMap with one-byte codes would make the number of
 *  glyphs count double, and the POC's verdict depends on it.
 *  NOT here: the translation of codes into unicode (that is the rest of the POC).
 *  Called by: `npx tsx tools/poc/type0-codespace.ts [folder…]`. */

import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import { openPdfObjects, type PdfObjectsDocument } from "../../src/extractor/pdf-objects/document";
import type { PdfDict } from "../../src/extractor/pdf-objects/objects";
import { PdfObjectsRefusal } from "../../src/extractor/pdf-objects/refusal";
import { contentsOf, nameOf, shownOf } from "./shown-glyphs";

const DEFAULT_DIRS = ["fixtures/pdf", "fixtures/docx-reel"];

/** §9.7.6.2: the code space ranges of a CMap, in number of BYTES per code. */
function codespaceWidths(data: Uint8Array): number[] {
  const text = Buffer.from(data).toString("latin1");
  const widths: number[] = [];
  const blocks = text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g);
  for (const block of blocks) {
    for (const hex of (block[1] as string).matchAll(/<([0-9A-Fa-f]+)>/g)) {
      widths.push(Math.ceil((hex[1] as string).length / 2));
    }
  }
  return widths;
}

interface Type0Use {
  readonly file: string;
  readonly encoding: string;
  readonly widths: readonly number[];
  bytes: number;
}

function examine(doc: PdfObjectsDocument, font: PdfDict, file: string): { encoding: string; widths: number[] } {
  const encoding = doc.resolve(font.get("Encoding"));
  const named = nameOf(encoding);
  if (named !== undefined) return { encoding: named, widths: named.startsWith("Identity") ? [2] : [] };
  if (encoding?.kind === "stream") {
    // An embedded CMap states its own code space.
    try {
      return { encoding: "<CMap embarquée>", widths: codespaceWidths(doc.streamBytes(encoding)) };
    } catch {
      return { encoding: "<CMap embarquée, illisible>", widths: [] };
    }
  }
  void file;
  return { encoding: "<absent>", widths: [] };
}

async function pdfsIn(dir: string, root: string): Promise<string[]> {
  const entries = await readdir(join(root, dir), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf"))
    .map((entry) => join(root, dir, entry.name));
}

async function main(): Promise<void> {
  const root = process.cwd();
  const dirs = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_DIRS;
  const files: string[] = [];
  for (const dir of dirs) files.push(...(await pdfsIn(dir, root)));
  if (files.length === 0) throw new Error(`aucun PDF dans ${dirs.join(", ")} — population vide, rien à mesurer`);

  const uses = new Map<string, Type0Use>();
  let refused = 0;
  for (const [index, path] of files.entries()) {
    const file = relative(root, path).split("\\").join("/");
    try {
      const doc = openPdfObjects(new Uint8Array(readFileSync(path)));
      for (const page of doc.pages()) {
        for (const shown of shownOf(doc, contentsOf(doc, page), page.resources)) {
          const font = doc.dictOf(shown.fontValue);
          if (font === undefined || nameOf(doc.resolve(font.get("Subtype"))) !== "Type0") continue;
          const key = shown.fontValue?.kind === "ref" ? `#${shown.fontValue.num}:${file}` : `${file}:${shown.font}`;
          const known = uses.get(key) ?? { file, ...examine(doc, font, file), bytes: 0 };
          known.bytes += shown.codes.length / 2;
          uses.set(key, known);
        }
      }
    } catch (error) {
      refused += error instanceof PdfObjectsRefusal ? 1 : 1;
    }
    process.stdout.write(`\rprogress ${index + 1}/${files.length}`);
  }
  process.stdout.write("\n\n");

  const byEncoding = new Map<string, { fonts: number; bytes: number }>();
  const suspects: Type0Use[] = [];
  for (const use of uses.values()) {
    const bucket = byEncoding.get(use.encoding) ?? { fonts: 0, bytes: 0 };
    bucket.fonts += 1;
    bucket.bytes += use.bytes;
    byEncoding.set(use.encoding, bucket);
    // WHAT WOULD BREAK THE HYPOTHESIS: a range that codes on something other than two bytes.
    if (use.widths.length > 0 && use.widths.some((width) => width !== 2)) suspects.push(use);
    if (use.widths.length === 0 && use.encoding !== "<absent>" && !use.encoding.startsWith("Identity"))
      suspects.push(use);
  }

  console.log(`fichiers                ${files.length} (${refused} refusés)`);
  console.log(`polices Type0 EMPLOYÉES ${uses.size}`);
  console.log("\npar /Encoding (§9.7.5) :");
  for (const [encoding, bucket] of [...byEncoding].sort((a, b) => b[1].bytes - a[1].bytes)) {
    console.log(
      `  ${encoding.padEnd(28)} ${String(bucket.fonts).padStart(5)} polices  ${String(bucket.bytes).padStart(9)} octets`,
    );
  }
  console.log(`\nCE QUI CASSERAIT L'HYPOTHÈSE DES DEUX OCTETS : ${suspects.length}`);
  for (const suspect of suspects.slice(0, 20)) {
    console.log(`  ${suspect.encoding} largeurs ${JSON.stringify(suspect.widths)} — ${suspect.file}`);
  }
}

await main();
