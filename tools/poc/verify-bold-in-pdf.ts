/** Throwaway probe: in the PDF's RAW STREAM, which font is set just before a given text, and its /BaseFont. */
import { readFileSync } from "node:fs";

import { openPdfObjects } from "../../src/extractor/pdf-objects/document";
import { readContentOps } from "../../src/extractor/pdf-objects/content";

const doc = openPdfObjects(new Uint8Array(readFileSync(process.argv[2] as string)));
const word = Buffer.from(process.argv[3] as string, "latin1");
for (const [index, page] of doc.pages().entries()) {
  const contents = doc.resolve(page.dict.get("Contents"));
  const streams = contents?.kind === "array" ? contents.items.map((i) => doc.resolve(i)) : [contents];
  const parts: Buffer[] = [];
  for (const s of streams)
    if (s?.kind === "stream") parts.push(Buffer.from(doc.streamBytes(s)), Buffer.from("\n", "latin1"));
  const fonts = doc.dictOf(page.resources?.get("Font"));
  let current: string | undefined;
  for (const op of readContentOps(new Uint8Array(Buffer.concat(parts)))) {
    if (op.op === "Tf") current = (op.operands[0] as { value?: string } | undefined)?.value;
    if (["Tj", "TJ", "'", '"'].includes(op.op)) {
      const hit = op.operands.some((o) => o.kind === "string" && Buffer.from(o.bytes).includes(word));
      const alt = op.operands.some(
        (o) => o.kind === "array" && o.items.some((i) => i.kind === "string" && Buffer.from(i.bytes).includes(word)),
      );
      if (hit || alt) {
        const dict = doc.dictOf(fonts?.get(current ?? ""));
        const base = (doc.resolve(dict?.get("BaseFont")) as { value?: string } | undefined)?.value;
        console.log(`page ${index + 1} : Tf /${current} → /BaseFont ${base} (texte trouvé dans le flux brut)`);
      }
    }
  }
}
