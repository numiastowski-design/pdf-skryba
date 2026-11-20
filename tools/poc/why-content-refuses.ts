/** Diagnostic: why the content stream reader refuses a file, with the exact place and the bytes around it.
 *  Development tool.
 *  Decides: nothing. It says where to look: without the place, a refusal is diagnosed by bisecting by hand.
 *  NOT here: the font census (`./font-census.ts`).
 *  Called by: `npx tsx tools/poc/why-content-refuses.ts <file…>` (from the monorepo root,
 *  `packages/reader/tools/poc/…`). */

import { readFileSync } from "node:fs";

import { readContentOps } from "../../src/extractor/pdf-objects/content";
import { openPdfObjects } from "../../src/extractor/pdf-objects/document";
import type { PdfValue } from "../../src/extractor/pdf-objects/objects";
import { PdfObjectsRefusal } from "../../src/extractor/pdf-objects/refusal";

const CONTEXT = 60;

/** The bytes around the place, made readable: PDF syntax as is, the rest as dots. */
function around(data: Uint8Array, at: number): string {
  const from = Math.max(0, at - CONTEXT);
  const to = Math.min(data.length, at + CONTEXT);
  const text = [...data.subarray(from, to)]
    .map((byte) =>
      byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : byte === 0x0a || byte === 0x0d ? "⏎" : "·",
    )
    .join("");
  return `${text}\n${" ".repeat(at - from)}^ ici (octet ${at} du flux décodé, ${data.length} en tout)`;
}

function report(path: string): void {
  const bytes = new Uint8Array(readFileSync(path));
  let doc;
  try {
    doc = openPdfObjects(bytes);
  } catch (error) {
    console.log(`${path}\n  structure refusée : ${(error as Error).message}`);
    return;
  }

  let pageNumber = 0;
  for (const page of doc.pages()) {
    pageNumber += 1;
    const contents: PdfValue | undefined = doc.resolve(page.dict.get("Contents"));
    const streams = contents?.kind === "array" ? contents.items.map((item) => doc.resolve(item)) : [contents];
    for (const [index, stream] of streams.entries()) {
      if (stream?.kind !== "stream") continue;
      let data: Uint8Array;
      try {
        data = doc.streamBytes(stream);
      } catch (error) {
        const filter = JSON.stringify(stream.dict.get("Filter"));
        console.log(
          `${path}\n  p${pageNumber} flux ${index} NON DÉCODÉ : ${(error as Error).message} — /Filter ${filter}`,
        );
        return;
      }
      try {
        readContentOps(data);
      } catch (error) {
        if (!(error instanceof PdfObjectsRefusal)) throw error;
        console.log(`${path}\n  p${pageNumber} flux ${index} : ${error.message}`);
        if (error.offset !== undefined) console.log(`  ${around(data, error.offset).split("\n").join("\n  ")}`);
        return;
      }
    }
  }
  console.log(`${path}\n  tout se lit`);
}

for (const path of process.argv.slice(2)) report(path);
