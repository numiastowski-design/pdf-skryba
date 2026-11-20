/** The first pass keeps a page's operators and glyphs only if the caller can ask for them (performance review of 02/11/2026, finding 3):
 *  held for every page until `readPdfSource` returned, they were a few hundred megabytes on a 300-page text document. */
import { describe, expect, it } from "vitest";

import { openOurGlyphs } from "./pdf-glyph-source";
import { readPageText } from "./pdf-source";

function pdfWithText(): Uint8Array {
  const text = (s: string): Buffer => Buffer.from(s, "latin1");
  const content = "BT /F1 12 Tf 72 700 Td (Hello world) Tj ET";
  const bodies: Buffer[] = [
    text("<< /Type /Catalog /Pages 2 0 R >>"),
    text("<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>"),
    text("<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>"),
    text(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`),
    text("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
  ];
  const chunks: Buffer[] = [text("%PDF-1.4\n")];
  const offsets: number[] = [];
  let length = chunks[0]!.length;
  bodies.forEach((body, i) => {
    offsets.push(length);
    const object = Buffer.concat([text(`${i + 1} 0 obj\n`), body, text("\nendobj\n")]);
    chunks.push(object);
    length += object.length;
  });
  let table = `xref\n0 ${bodies.length + 1}\n0000000000 65535 f\r\n`;
  for (const offset of offsets) table += `${String(offset).padStart(10, "0")} 00000 n\r\n`;
  chunks.push(text(`${table}trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(chunks));
}

const contextOf = (bytes: Uint8Array, keepOps: boolean, keepGlyphs: boolean) => {
  const ours = openOurGlyphs(bytes);
  return {
    file: bytes,
    cost: undefined,
    ourDoc: ours.document,
    memo: ours.memo,
    readLayerConfig: () => undefined,
    keepOps,
    keepGlyphs,
  } as never;
};

describe("readPageText : ce que l'appelant ne demandera jamais n'est pas gardé", () => {
  const bytes = pdfWithText();

  it("sans prédicat (ni opérations ni glyphes demandés) : ni les opérateurs ni les glyphes, mais les mots sont lus", () => {
    const page = readPageText(contextOf(bytes, false, false), 0);
    expect(page.ops).toHaveLength(0);
    expect(page.glyphs).toHaveLength(0);
    expect(page.runs.map((run) => run.text).join("")).toContain("Hello");
  });

  it("🔴 avec un prédicat d'opérations : les opérateurs sont gardés, pas les glyphes", () => {
    const page = readPageText(contextOf(bytes, true, false), 0);
    expect(page.ops.length).toBeGreaterThan(0);
    expect(page.glyphs).toHaveLength(0);
  });

  it("avec un prédicat de glyphes : les deux sont gardés", () => {
    const page = readPageText(contextOf(bytes, true, true), 0);
    expect(page.ops.length).toBeGreaterThan(0);
    expect(page.glyphs.length).toBeGreaterThan(0);
  });
});

describe("readPageText : le contenu d'une page est décodé une fois (revue de performance du 02/11/2026)", () => {
  it("🔴 les opérateurs, puis les polices, puis les glyphes d'une page ne décodent son flux qu'une fois", () => {
    const bytes = pdfWithText();
    const ours = openOurGlyphs(bytes);
    let decodes = 0;
    const counting = {
      ...ours.document,
      streamBytes: (stream: Parameters<typeof ours.document.streamBytes>[0]) => (
        (decodes += 1),
        ours.document.streamBytes(stream)
      ),
    };
    const ctx = {
      file: bytes,
      cost: undefined,
      ourDoc: counting,
      memo: ours.memo,
      readLayerConfig: () => undefined,
      keepOps: false,
      keepGlyphs: false,
    } as never;
    readPageText(ctx, 0);
    expect(decodes, "un flux de contenu, un décodage").toBe(1);
  });
});
