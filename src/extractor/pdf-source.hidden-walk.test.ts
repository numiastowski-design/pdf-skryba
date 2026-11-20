/** A page with hidden-text candidates walks its operators for glyphs ONCE (performance review of 02/11/2026, finding 4): `readGlyphs` fed the
 *  hide policy, then `buildGlyphFragments` called it again with the same operators, so every page of an OCR'd scan (an invisible text layer)
 *  paid its glyph walk twice. */
import { describe, expect, it, vi } from "vitest";

import { openOurGlyphs } from "./pdf-glyph-source";

const walks = vi.hoisted(() => ({ count: 0, builds: 0 }));
vi.mock("./glyph-positions", async (importActual) => {
  const actual = await importActual<typeof import("./glyph-positions")>();
  return {
    ...actual,
    readGlyphs: (...args: Parameters<typeof actual.readGlyphs>) => ((walks.count += 1), actual.readGlyphs(...args)),
    // `buildGlyphFragments` walks the operators INSIDE the module, where the count above cannot see it: the page must not call it at all.
    buildGlyphFragments: (...args: Parameters<typeof actual.buildGlyphFragments>) => (
      (walks.builds += 1),
      actual.buildGlyphFragments(...args)
    ),
  };
});

import { readPageText } from "./pdf-source";

function pdfWithContent(content: string): Uint8Array {
  const text = (s: string): Buffer => Buffer.from(s, "latin1");
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

const walksFor = (content: string): number => {
  const bytes = pdfWithContent(content);
  const ours = openOurGlyphs(bytes);
  const ctx = {
    file: bytes,
    cost: undefined,
    ourDoc: ours.document,
    memo: ours.memo,
    readLayerConfig: () => undefined,
    keepOps: false,
    keepGlyphs: false,
  } as never;
  walks.count = 0;
  walks.builds = 0;
  readPageText(ctx, 0);
  return walks.count + walks.builds;
};

describe("readPageText : les glyphes d'une page se lisent une fois", () => {
  it("une page ordinaire : une lecture", () => {
    expect(walksFor("BT /F1 12 Tf 72 700 Td (Hello) Tj ET")).toBe(1);
  });

  it("🔴 une page à texte invisible (3 Tr, la couche d'un scan océrisé) : une lecture, pas deux", () => {
    expect(walksFor("BT /F1 12 Tf 3 Tr 72 700 Td (Hello) Tj ET")).toBe(1);
  });
});
