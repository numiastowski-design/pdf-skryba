/** POC `docs/POC-SANS-PDFJS.md`: THE FONT of an abstention, and what its `/ToUnicode` ALREADY says.
 *  DEVELOPMENT tool, outside the bundle. Decides: nothing.
 *  The question it settles: when pdf.js names a PRINTABLE character where we abstain, does it
 *  take it from the embedded font program — knowledge we will never have, and we then lose
 *  real text — or does it simply reinterpret the CODE as a Unicode code point, which is an
 *  invention? The discriminant is written down: if the font's `/ToUnicode` covers OTHER codes but not
 *  that one, and the character pdf.js returned EQUALS the code, it is the code reread as Unicode.
 *  Called by: `npx tsx tools/poc/abstained-font.ts <file.pdf>`. */

import { readFileSync } from "node:fs";

import { readContentOps } from "../../src/extractor/pdf-objects/content";
import { openPdfObjects } from "../../src/extractor/pdf-objects/document";
import type { PdfDict, PdfValue } from "../../src/extractor/pdf-objects/objects";
import { readToUnicode } from "../../src/extractor/pdf-fonts/to-unicode";

const file = process.argv[2] as string;
const doc = openPdfObjects(new Uint8Array(readFileSync(file)));
const nameOf = (v: PdfValue | undefined): string | undefined => (v?.kind === "name" ? v.value : undefined);

/** The codes a content stream paints, by font name, without following the forms. */
function paintedCodes(data: Uint8Array, fonts: PdfDict | undefined): Map<string, Set<number>> {
  const byFont = new Map<string, Set<number>>();
  let current: string | undefined;
  let perGlyph = 1;
  for (const { op, operands } of readContentOps(data)) {
    if (op === "Tf") {
      current = nameOf(operands[0]);
      const font = current === undefined ? undefined : doc.dictOf(fonts?.get(current));
      perGlyph = nameOf(doc.resolve(font?.get("Subtype"))) === "Type0" ? 2 : 1;
      continue;
    }
    if (current === undefined) continue;
    const strings: Uint8Array[] = [];
    if (op === "Tj" || op === "'" || op === '"') {
      const shown = operands[operands.length - 1];
      if (shown?.kind === "string") strings.push(shown.bytes);
    } else if (op === "TJ") {
      const array = operands[0];
      if (array?.kind === "array") for (const item of array.items) if (item.kind === "string") strings.push(item.bytes);
    } else continue;
    let set = byFont.get(current);
    if (set === undefined) {
      set = new Set();
      byFont.set(current, set);
    }
    for (const bytes of strings) {
      for (let at = 0; at < bytes.length; at += perGlyph) {
        let code = 0;
        for (let i = 0; i < perGlyph && at + i < bytes.length; i += 1) code = code * 256 + (bytes[at + i] as number);
        set.add(code);
      }
    }
  }
  return byFont;
}

for (const [index, page] of doc.pages().entries()) {
  const contents = doc.resolve(page.dict.get("Contents"));
  const streams = contents?.kind === "array" ? contents.items.map((i) => doc.resolve(i)) : [contents];
  const parts: Buffer[] = [];
  for (const stream of streams)
    if (stream?.kind === "stream") parts.push(Buffer.from(doc.streamBytes(stream)), Buffer.from("\n", "latin1"));
  const fonts = doc.dictOf(page.resources?.get("Font"));

  for (const [name, codes] of paintedCodes(new Uint8Array(Buffer.concat(parts)), fonts)) {
    const font = doc.dictOf(fonts?.get(name));
    if (font === undefined) {
      // The case that was skipped silently, and the most interesting one: the stream paints with a font name that
      // the page's resources do NOT declare. Nothing can then say what the codes paint.
      console.log(`page ${index + 1}  /${name}  ⚠️ ABSENTE DES RESSOURCES DE LA PAGE (${codes.size} codes peints)`);
      continue;
    }
    const subtype = nameOf(doc.resolve(font.get("Subtype"))) ?? "?";
    const base = nameOf(doc.resolve(font.get("BaseFont"))) ?? "?";
    const encoding = nameOf(doc.resolve(font.get("Encoding"))) ?? "(dictionnaire ou absent)";
    const stream = doc.resolve(font.get("ToUnicode"));
    let table: ReadonlyMap<number, string> | undefined;
    if (stream?.kind === "stream") {
      try {
        table = readToUnicode(doc.streamBytes(stream)).text;
      } catch {
        table = undefined;
      }
    }
    const missing = [...codes].filter((code) => table?.get(code) === undefined).sort((a, b) => a - b);
    if (missing.length === 0) continue;
    console.log(`page ${index + 1}  /${name}  ${subtype}  ${base}  /Encoding ${encoding}`);
    console.log(
      `  /ToUnicode : ${stream?.kind === "stream" ? (table === undefined ? "présente mais illisible" : `${table.size} codes`) : "ABSENTE"}`,
    );
    console.log(`  codes peints : ${codes.size} ; sans texte chez nous : ${missing.length}`);
    console.log(
      `  ces codes : ${missing
        .slice(0, 12)
        .map((c) => `0x${c.toString(16)}`)
        .join(" ")}`,
    );
    const asUnicode = missing.map((c) => (c > 0x20 && c < 0x7f ? String.fromCharCode(c) : "·")).join("");
    console.log(`  le CODE relu comme de l'Unicode donnerait : ${JSON.stringify(asUnicode.slice(0, 24))}`);
  }
}
