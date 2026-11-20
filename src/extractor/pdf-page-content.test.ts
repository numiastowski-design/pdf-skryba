/** The content of a page as ONE stream (`pdf-page-content.ts`), and its ceiling (security review of 02/11/2026, finding 6).
 *  Each stream was bounded to 64 MB and the document to 200 MB, but a page assembled its streams three or four times over
 *  (a copy per part, one for the join, one for the result) and the sum was bounded by nothing: two 40 MB streams, from a few
 *  hundred kilobytes of file, held about 400 MB before the first operator was read, on a runtime that has 512. */
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { MAX_DECODED_STREAM_BYTES } from "./pdf-objects/bounds";
import { openPdfObjects } from "./pdf-objects/document";
import { PdfObjectsRefusal } from "./pdf-objects/refusal";
import { ourOpsOfPage } from "./pdf-ops-ours";
import { pageContentOf } from "./pdf-page-content";

/** A one-page PDF whose `/Contents` is the given streams (raw bytes, Flate-coded when `flate`). */
function pdfOfContents(streams: readonly { data: Uint8Array; flate?: boolean }[]): Uint8Array {
  const text = (s: string): Buffer => Buffer.from(s, "latin1");
  const bodies: Buffer[] = [
    text("<< /Type /Catalog /Pages 2 0 R >>"),
    text("<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>"),
    text(`<< /Type /Page /Parent 2 0 R /Contents [${streams.map((_, i) => `${4 + i} 0 R`).join(" ")}] >>`),
    ...streams.map(({ data, flate }) => {
      const body = flate === true ? Buffer.from(deflateSync(Buffer.from(data))) : Buffer.from(data);
      return Buffer.concat([
        text(`<< ${flate === true ? "/Filter /FlateDecode " : ""}/Length ${body.length} >>\nstream\n`),
        body,
        text("\nendstream"),
      ]);
    }),
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

const latin1 = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "latin1"));

describe("pageContentOf : le contenu d'une page, en un seul flux", () => {
  it("joint les flux d'un tableau /Contents, chacun suivi d'un saut de ligne (§7.7.3.3)", () => {
    const doc = openPdfObjects(pdfOfContents([{ data: latin1("q") }, { data: latin1("Q") }]));
    expect(Buffer.from(pageContentOf(doc, doc.pages()[0]!)).toString("latin1")).toBe("q\nQ\n");
  });

  it("une page sans /Contents n'a aucun octet", () => {
    const doc = openPdfObjects(pdfOfContents([]));
    expect(pageContentOf(doc, doc.pages()[0]!).length).toBe(0);
  });

  it("🔴 deux flux de 40 Mo (80 Mo ensemble, au-delà du plafond d'un flux de 64 Mo) sont refusés (content-too-long)", () => {
    const forty = new Uint8Array(40_000_000);
    expect(MAX_DECODED_STREAM_BYTES).toBeLessThan(2 * forty.length);
    const doc = openPdfObjects(
      pdfOfContents([
        { data: forty, flate: true },
        { data: forty, flate: true },
      ]),
    );
    const page = doc.pages()[0]!;
    let refusal: unknown;
    try {
      pageContentOf(doc, page);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(PdfObjectsRefusal);
    expect((refusal as PdfObjectsRefusal).reason).toBe("content-too-long");
  });

  it("🔴 le lecteur d'opérateurs refuse la même page avant de lire un opérateur", () => {
    const forty = new Uint8Array(40_000_000);
    const doc = openPdfObjects(
      pdfOfContents([
        { data: forty, flate: true },
        { data: forty, flate: true },
      ]),
    );
    expect(() => ourOpsOfPage(doc, doc.pages()[0]!)).toThrow(PdfObjectsRefusal);
  });
});
