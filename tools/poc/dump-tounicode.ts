/** POC of the reader without pdf.js, diagnostic: the RAW TEXT of the `/ToUnicode` of a page's font.
 *  DEVELOPMENT tool, outside the bundle. Decides: nothing. It serves to read the CMap with one's own eyes rather than to
 *  suppose what it contains when our reading and pdf.js's diverged.
 *  Called by: `npx tsx tools/poc/dump-tounicode.ts <file.pdf> <page> <font name> [bytes]`. */

import { readFileSync } from "node:fs";

import { openPdfObjects } from "../../src/extractor/pdf-objects/document";
import type { PdfValue } from "../../src/extractor/pdf-objects/objects";

const [file, page, fontName, limit] = process.argv.slice(2);
const doc = openPdfObjects(new Uint8Array(readFileSync(file as string)));
const nameOf = (v: PdfValue | undefined): string | undefined => (v?.kind === "name" ? v.value : undefined);

const entry = doc.pages()[Number(page) - 1];
if (entry === undefined) throw new Error(`pas de page ${page}`);
const fonts = doc.dictOf(entry.resources?.get("Font"));
const font = doc.dictOf(fonts?.get(fontName as string));
if (font === undefined) throw new Error(`pas de police /${fontName} sur la page ${page}`);

console.log(
  `/${fontName}  Subtype ${nameOf(doc.resolve(font.get("Subtype"))) ?? "?"}  BaseFont ${nameOf(doc.resolve(font.get("BaseFont"))) ?? "?"}`,
);
console.log(`/Encoding ${nameOf(doc.resolve(font.get("Encoding"))) ?? "(dictionnaire ou absent)"}`);

const stream = doc.resolve(font.get("ToUnicode"));
if (stream?.kind !== "stream") {
  console.log("/ToUnicode ABSENTE");
} else {
  const data = Buffer.from(doc.streamBytes(stream));
  console.log(`/ToUnicode : ${data.length} octets décompressés\n`);
  console.log(data.subarray(0, Number(limit ?? 1200)).toString("latin1"));
}
