/** The font tables a DOCUMENT keeps are bounded in all, not only per table (security review of 02/11/2026, finding 7).
 *  A `/ToUnicode` or a CID `/W` table is capped at 65 536 entries and shared when several fonts name the same object, but
 *  two DISTINCT objects are two tables: a hundred fonts, each with its own sixty-byte CMap that maps every code, kept a
 *  hundred tables (about six and a half million entries, 300 to 600 MB) for a file of a few kilobytes.
 *  Two populations fix the ceiling (measured on 02/11/2026): the 80 files of `fixtures/pdf` keep at most 202 755 entries in
 *  all (four safedocs files above 135 000), the 251 documents of the corpus at most 1 628. */
import { describe, expect, it } from "vitest";

import { openOurGlyphs } from "./pdf-glyph-source";
import { readPdfSource } from "./pdf-source";
import { MAX_FONT_TABLE_ENTRIES_PER_DOCUMENT } from "./pdf-fonts/bounds";
import { PdfObjectsRefusal } from "./pdf-objects/refusal";

/** What one table that maps every code counts: 65 536 codes and the 2 049 the reader refuses (surrogates). Three of them are
 *  202 755 entries, EXACTLY the largest real document measured. */
const FULL_TABLE = 67_585;

/** A one-page PDF drawing a letter in each of `fonts` simple fonts, font k having its own `/ToUnicode` that maps all 65 536 codes. */
function pdfOfFonts(fonts: number): Uint8Array {
  const text = (s: string): Buffer => Buffer.from(s, "latin1");
  const stream = (body: string): Buffer =>
    Buffer.from(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`, "latin1");
  const fontObjects = (k: number): number => 5 + k; // font k is object 5 + k, its CMap object 5 + fonts + k
  const content = Array.from({ length: fonts }, (_, k) => `BT /F${k} 12 Tf (A) Tj ET`).join("\n");
  const bodies: Buffer[] = [
    text("<< /Type /Catalog /Pages 2 0 R >>"),
    text("<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>"),
    text(
      `<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << ${Array.from({ length: fonts }, (_, k) => `/F${k} ${fontObjects(k)} 0 R`).join(" ")} >> >> >>`,
    ),
    stream(content),
    ...Array.from({ length: fonts }, (_, k) =>
      text(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode ${5 + fonts + k} 0 R >>`),
    ),
    // Each CMap maps <0000>..<FFFF> to a DIFFERENT destination, so no two fonts can share a table.
    ...Array.from({ length: fonts }, (_, k) =>
      stream(
        `/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n1 begincodespacerange <0000> <FFFF> endcodespacerange\n1 beginbfrange <0000> <FFFF> <${(0x4e00 + k).toString(16)}> endbfrange\nendcmap`,
      ),
    ),
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

/** `pages` pages, each drawing a letter in its own `fontsPerPage` fonts, every font with its own full CMap: no two pages share a table. */
function pdfOfPages(pages: number, fontsPerPage: number): Uint8Array {
  const text = (s: string): Buffer => Buffer.from(s, "latin1");
  const stream = (body: string): Buffer =>
    Buffer.from(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`, "latin1");
  const perPage = 2 + 2 * fontsPerPage; // page, content, fonts, CMaps
  const first = (p: number): number => 3 + p * perPage; // object number of page p
  const bodies: Buffer[] = [
    text("<< /Type /Catalog /Pages 2 0 R >>"),
    text(
      `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, p) => `${first(p)} 0 R`).join(" ")}] /Count ${pages} /MediaBox [0 0 612 792] >>`,
    ),
  ];
  for (let p = 0; p < pages; p += 1) {
    const fontNo = (k: number): number => first(p) + 2 + k;
    const cmapNo = (k: number): number => first(p) + 2 + fontsPerPage + k;
    const content = Array.from({ length: fontsPerPage }, (_, k) => `BT /F${k} 12 Tf (A) Tj ET`).join("\n");
    bodies.push(
      text(
        `<< /Type /Page /Parent 2 0 R /Contents ${first(p) + 1} 0 R /Resources << /Font << ${Array.from({ length: fontsPerPage }, (_, k) => `/F${k} ${fontNo(k)} 0 R`).join(" ")} >> >> >>`,
      ),
    );
    bodies.push(stream(content));
    for (let k = 0; k < fontsPerPage; k += 1)
      bodies.push(text(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode ${cmapNo(k)} 0 R >>`));
    for (let k = 0; k < fontsPerPage; k += 1) {
      const destination = (0x4e00 + p * fontsPerPage + k).toString(16);
      bodies.push(
        stream(
          `/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n1 begincodespacerange <0000> <FFFF> endcodespacerange\n1 beginbfrange <0000> <FFFF> <${destination}> endbfrange\nendcmap`,
        ),
      );
    }
  }
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

describe("MAX_FONT_TABLE_ENTRIES_PER_DOCUMENT : les tables de polices d'un document sont bornées en tout", () => {
  it("la valeur de départ tient entre le réel le plus gros (202 755) et le fichier hostile (20 tables pleines : 1 351 700)", () => {
    expect(MAX_FONT_TABLE_ENTRIES_PER_DOCUMENT).toBe(1_000_000);
    expect(MAX_FONT_TABLE_ENTRIES_PER_DOCUMENT).toBeGreaterThan(202_755);
    expect(MAX_FONT_TABLE_ENTRIES_PER_DOCUMENT).toBeLessThan(20 * FULL_TABLE);
  });

  it("🔴 vingt polices à CMap distincts et pleins (1 351 700 entrées) : le document est refusé (font-tables-too-many)", () => {
    let refusal: unknown;
    try {
      openOurGlyphs(pdfOfFonts(20)).glyphsOfPage(0);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(PdfObjectsRefusal);
    expect((refusal as PdfObjectsRefusal).reason).toBe("font-tables-too-many");
  });

  it("trois tables pleines (202 755 entrées, le plus gros document réel mesuré) passent, et se comptent", () => {
    const source = openOurGlyphs(pdfOfFonts(3));
    source.glyphsOfPage(0);
    expect(source.tableEntries()).toBe(3 * FULL_TABLE);
  });

  it("🔴 par le chemin du produit (readPdfSource), le plafond vaut pour le DOCUMENT : deux pages de dix tables pleines (1 351 700 en tout) sont refusées", async () => {
    // Each page keeps 675 850 entries, under the ceiling; only the sum (1 351 700) is over it.
    await expect(readPdfSource(pdfOfPages(2, 10))).rejects.toThrow();
  }, 60_000);

  it("deux pages de quatre tables pleines (540 680 en tout) passent", async () => {
    await expect(readPdfSource(pdfOfPages(2, 4))).resolves.toBeDefined();
  }, 60_000);
});

/** A one-page PDF with `fonts` Type0 fonts that all name the SAME descendant (object 5), whose `/W` places the advance of every CID. */
function pdfOfSharedDescendant(fonts: number): Uint8Array {
  const text = (s: string): Buffer => Buffer.from(s, "latin1");
  const content = Array.from({ length: fonts }, (_, k) => `BT /F${k} 12 Tf <0041> Tj ET`).join("\n");
  const bodies: Buffer[] = [
    text("<< /Type /Catalog /Pages 2 0 R >>"),
    text("<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>"),
    text(
      `<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << ${Array.from({ length: fonts }, (_, k) => `/F${k} ${6 + k} 0 R`).join(" ")} >> >> >>`,
    ),
    Buffer.from(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`, "latin1"),
    text(
      "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /X /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 /W [0 65535 500] >>",
    ),
    ...Array.from({ length: fonts }, () =>
      text("<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [5 0 R] >>"),
    ),
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

describe("la table /W d'un descendant partagé est lue et comptée UNE fois (revue de performance du 02/11/2026)", () => {
  it("🔴 vingt polices Type0 qui nomment le même descendant (une table pleine de 65 536 entrées) ne comptent qu'une table", () => {
    const source = openOurGlyphs(pdfOfSharedDescendant(20));
    source.glyphsOfPage(0);
    expect(source.tableEntries()).toBeLessThanOrEqual(2 * 65_536);
  });
});
