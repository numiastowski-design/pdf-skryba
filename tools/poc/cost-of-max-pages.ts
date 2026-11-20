/** POC `docs/POC-SANS-PDFJS.md`: HOW MUCH DOES IT COST a trial that makes `MAX_PAGES` bite? DEVELOPMENT tool,
 *  disposable with the POC.
 *  Decides: nothing. It answers a question I had settled by ASSUMING it ("50 001 sheets, too expensive"),
 *  which is the very mistake this POC paid for three times on 31/10/2026. It builds the file, reads it, and
 *  times it — and the figure will say whether the bound can be seen to bite like the other eleven.
 *  Called by: `npx tsx tools/poc/cost-of-max-pages.ts [pages]`. */

import { openPdfObjects } from "../../src/extractor/pdf-objects/document";
import { PdfObjectsRefusal } from "../../src/extractor/pdf-objects/refusal";

/** A FLAT tree: one root node, then `count` distinct leaves, each its own object. */
function buildPdfWithPages(count: number): Uint8Array {
  const parts: string[] = ["%PDF-1.4\n"];
  let length = parts[0]?.length ?? 0;
  const offsets: number[] = [];

  const push = (text: string): void => {
    offsets.push(length);
    parts.push(text);
    length += text.length;
  };

  // Object 1: the catalog. Object 2: the tree. Objects 3..count+2: the leaves.
  push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  const kids: string[] = [];
  for (let i = 0; i < count; i += 1) kids.push(`${i + 3} 0 R`);
  push(`2 0 obj\n<< /Type /Pages /Count ${count} /MediaBox [0 0 10 10] /Kids [${kids.join(" ")}] >>\nendobj\n`);
  for (let i = 0; i < count; i += 1) push(`${i + 3} 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\n`);

  const xrefAt = length;
  let table = `xref\n0 ${count + 3}\n0000000000 65535 f\r\n`;
  for (const offset of offsets) table += `${String(offset).padStart(10, "0")} 00000 n\r\n`;
  parts.push(`${table}trailer\n<< /Size ${count + 3} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  return Uint8Array.from(Buffer.from(parts.join(""), "latin1"));
}

function main(): void {
  const count = Number(process.argv[2] ?? "50001");
  const start = process.hrtime.bigint();
  const bytes = buildPdfWithPages(count);
  const built = process.hrtime.bigint();

  let verdict: string;
  try {
    const pages = openPdfObjects(bytes).pages();
    verdict = `lu, ${pages.length} pages`;
  } catch (error) {
    verdict = error instanceof PdfObjectsRefusal ? `refus ${error.reason}` : `défaut ${(error as Error).name}`;
  }
  const done = process.hrtime.bigint();

  const ms = (from: bigint, to: bigint): string => `${Number(to - from) / 1e6} ms`.replace(/(\.\d)\d+/, "$1");
  console.log(`pages demandées   ${count}`);
  console.log(`fichier           ${(bytes.length / 1e6).toFixed(1)} Mo, fabriqué en ${ms(start, built)}`);
  console.log(`lecture           ${ms(built, done)} → ${verdict}`);
}

main();
