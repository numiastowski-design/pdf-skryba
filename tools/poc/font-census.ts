/** Census: where would the unicode of each painted glyph come from without the embedded font program?
 *  Development tool.
 *  Decides: nothing. For each font a content stream really uses, it names the source of unicode available
 *  without the program (ISO 32000-1): `/ToUnicode` (§9.10.3), a predefined CMap (§9.7.5), the glyph names of an
 *  encoding (§9.6.6 and the Adobe glyph list), the built-in encoding of one of the standard 14 fonts (§9.6.2.2),
 *  or none.
 *  Each font weighs by the bytes it paints, not by its existence: a font declared and never used decides nothing.
 *  NOT here: the translation itself.
 *  Called by: `npx tsx tools/poc/font-census.ts [folder…]` (from the monorepo root,
 *  `packages/reader/tools/poc/…`). */

import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import { openPdfObjects, type PdfObjectsDocument } from "../../src/extractor/pdf-objects/document";
import type { PdfDict } from "../../src/extractor/pdf-objects/objects";
import { PdfObjectsRefusal } from "../../src/extractor/pdf-objects/refusal";
import { contentsOf, nameOf, shownOf } from "./shown-glyphs";

const DEFAULT_DIRS = ["fixtures/pdf", "fixtures/docx-reel"];

/** The four sources of unicode available without a font program, and the case where there is none. */
type UnicodeSource = "ToUnicode" | "CMap prédéfinie" | "noms de glyphes" | "police standard" | "RIEN SANS pdf.js";

interface FontUse {
  readonly key: string;
  readonly subtype: string;
  readonly source: UnicodeSource;
  readonly embedded: boolean;
  readonly symbolic: boolean;
  bytes: number;
}

/** The standard 14 fonts (§9.6.2.2): their built-in encoding is known data, not a program. */
const STANDARD_14 = new Set([
  "Courier",
  "Courier-Bold",
  "Courier-BoldOblique",
  "Courier-Oblique",
  "Helvetica",
  "Helvetica-Bold",
  "Helvetica-BoldOblique",
  "Helvetica-Oblique",
  "Times-Roman",
  "Times-Bold",
  "Times-BoldItalic",
  "Times-Italic",
  "Symbol",
  "ZapfDingbats",
]);

/** §9.6.6: an encoding is a name, or a dictionary with `/BaseEncoding` and `/Differences`. */
function encodingKind(doc: PdfObjectsDocument, font: PdfDict): { named?: string; differences: boolean; base?: string } {
  const encoding = doc.resolve(font.get("Encoding"));
  if (encoding === undefined) return { differences: false };
  if (encoding.kind === "name") return { named: encoding.value, differences: false };
  const dict = doc.dictOf(encoding);
  if (dict === undefined) return { differences: false };
  const differences = doc.resolve(dict.get("Differences"))?.kind === "array";
  const base = nameOf(doc.resolve(dict.get("BaseEncoding")));
  return { differences, ...(base === undefined ? {} : { base }) };
}

/** A font's descriptor: its symbolic flag (§9.8.2, bit 3) and whether its program is embedded. */
function descriptorOf(doc: PdfObjectsDocument, font: PdfDict): { symbolic: boolean; embedded: boolean } {
  const descendants = doc.resolve(font.get("DescendantFonts"));
  const descendant = descendants?.kind === "array" ? doc.dictOf(descendants.items[0]) : undefined;
  const descriptor = doc.dictOf((descendant ?? font).get("FontDescriptor"));
  if (descriptor === undefined) return { symbolic: false, embedded: false };
  const flags = doc.resolve(descriptor.get("Flags"));
  const symbolic = flags?.kind === "number" ? (flags.value & 4) !== 0 && (flags.value & 32) === 0 : false;
  const embedded = ["FontFile", "FontFile2", "FontFile3"].some((key) => descriptor.get(key) !== undefined);
  return { symbolic, embedded };
}

function classify(doc: PdfObjectsDocument, font: PdfDict): Omit<FontUse, "key" | "bytes"> {
  const subtype = nameOf(doc.resolve(font.get("Subtype"))) ?? "?";
  const { symbolic, embedded } = descriptorOf(doc, font);
  const hasToUnicode = font.get("ToUnicode") !== undefined;
  const encoding = encodingKind(doc, font);
  const base = nameOf(doc.resolve(font.get("BaseFont")))?.replace(/^[A-Z]{6}\+/, "");

  const source = ((): UnicodeSource => {
    // §9.10.2: `/ToUnicode` is the answer, whatever the font.
    if (hasToUnicode) return "ToUnicode";
    if (subtype === "Type0") {
      // §9.7.5.2: a predefined CMap gives the unicode; `Identity-H/V` gives glyph numbers only.
      const named = encoding.named ?? "";
      return named !== "" && !named.startsWith("Identity") ? "CMap prédéfinie" : "RIEN SANS pdf.js";
    }
    // §9.6.6.4: a named encoding or `/Differences` give glyph names, which the Adobe glyph list translates.
    if (encoding.named !== undefined || encoding.base !== undefined || encoding.differences) return "noms de glyphes";
    if (base !== undefined && STANDARD_14.has(base)) return "police standard";
    // A simple font with no declared encoding uses that of its program (§9.6.6.1).
    return symbolic || embedded ? "RIEN SANS pdf.js" : "noms de glyphes";
  })();

  return { subtype, source, embedded, symbolic };
}

interface FileCensus {
  readonly file: string;
  readonly refusal?: string | undefined;
  readonly fonts: readonly FontUse[];
  readonly pages: number;
}

function censusOf(path: string, root: string): FileCensus {
  const file = relative(root, path).split("\\").join("/");
  const bytes = new Uint8Array(readFileSync(path));
  try {
    const doc = openPdfObjects(bytes);
    const pages = doc.pages();
    const uses = new Map<string, FontUse>();
    for (const page of pages) {
      // The stream walk (`./shown-glyphs.ts`) honours the `q`/`Q` stack: without it the bytes go to the font of
      // the previous block.
      for (const shown of shownOf(doc, contentsOf(doc, page), page.resources)) {
        const painted = shown.codes.length / 2;
        if (painted === 0) continue;
        // The font comes from the stream's own resources (the form's, inside a form): `shownOf` carries it.
        const ref = shown.fontValue;
        const font = doc.dictOf(ref);
        if (font === undefined) {
          // A painted font those resources do not resolve: counted apart, unclassified, so that an unknown never
          // passes for an easy case.
          const key = `?${shown.font}`;
          const unknown = uses.get(key) ?? {
            key,
            subtype: "?",
            source: "RIEN SANS pdf.js" as const,
            embedded: false,
            symbolic: false,
            bytes: 0,
          };
          unknown.bytes += painted;
          uses.set(key, unknown);
          continue;
        }
        const key = ref?.kind === "ref" ? `#${ref.num}` : `${file}:${shown.font}`;
        const known = uses.get(key) ?? { key, ...classify(doc, font), bytes: 0 };
        known.bytes += painted;
        uses.set(key, known);
      }
    }
    return { file, fonts: [...uses.values()], pages: pages.length };
  } catch (error) {
    const reason =
      error instanceof PdfObjectsRefusal
        ? error.reason
        : `defect:${(error as Error).name}: ${(error as Error).message}`;
    return { file, refusal: reason, fonts: [], pages: 0 };
  }
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

  const results: FileCensus[] = [];
  for (const [index, path] of files.entries()) {
    results.push(censusOf(path, root));
    process.stdout.write(`\rprogress ${index + 1}/${files.length}`);
  }
  process.stdout.write("\n\n");

  const refused = results.filter((result) => result.refusal !== undefined);
  const read = results.filter((result) => result.refusal === undefined);
  const bySource = new Map<UnicodeSource, { fonts: number; bytes: number }>();
  let totalBytes = 0;
  let totalFonts = 0;
  for (const result of read) {
    for (const font of result.fonts) {
      const bucket = bySource.get(font.source) ?? { fonts: 0, bytes: 0 };
      bucket.fonts += 1;
      bucket.bytes += font.bytes;
      bySource.set(font.source, bucket);
      totalBytes += font.bytes;
      totalFonts += 1;
    }
  }

  console.log(`fichiers lus           ${read.length} / ${results.length}`);
  console.log(`pages                  ${read.reduce((sum, result) => sum + result.pages, 0)}`);
  console.log(`polices EMPLOYÉES      ${totalFonts}`);
  console.log(`octets peints          ${totalBytes}`);
  console.log("\nd'où viendrait l'unicode SANS pdf.js (pesé par les octets peints) :");
  const share = (value: number): string => (totalBytes === 0 ? "—" : `${((value / totalBytes) * 100).toFixed(2)} %`);
  for (const [source, bucket] of [...bySource].sort((a, b) => b[1].bytes - a[1].bytes)) {
    console.log(
      `  ${source.padEnd(18)} ${String(bucket.fonts).padStart(5)} polices  ${String(bucket.bytes).padStart(10)} octets  ${share(bucket.bytes)}`,
    );
  }

  const hard = read
    .map((result) => ({
      file: result.file,
      bytes: result.fonts
        .filter((font) => font.source === "RIEN SANS pdf.js")
        .reduce((sum, font) => sum + font.bytes, 0),
    }))
    .filter((entry) => entry.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes);
  console.log(`\nfichiers où pdf.js reste indispensable : ${hard.length} / ${read.length}`);
  for (const entry of hard.slice(0, 25)) console.log(`  ${String(entry.bytes).padStart(8)} octets  ${entry.file}`);

  if (refused.length > 0) {
    console.log("\nrefusés :");
    for (const result of refused) console.log(`  ${result.refusal}  ${result.file}`);
  }
}

await main();
