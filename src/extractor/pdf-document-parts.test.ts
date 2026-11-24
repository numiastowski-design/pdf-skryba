/**
 * A part of the document that carries no text fails ALONE (decision of 24/11/2026): one bad byte in the `/Info`
 * dictionary, an outline item, an image XObject, a link annotation or a `/Metadata` stream drops that part, and the
 * read goes on with the same words. Found by lot 6 of the PDF fuzz (`pdf-document.property.test.ts`).
 * Each case breaks the syntax of ONE object of a real fixture: its first `<<` becomes `))`, the file's length kept, so
 * the cross-reference table stays true (no repair is involved).
 */

import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

import { MAX_NOTICE_PAGE_RANGES } from "doc-ir/internal";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { extractPdf, pdfPartUnreadNotices } from "./pdf";
import { agreedTargets, publishedWords, type TargetKind } from "./pdf-document-fuzz.test.support";
import { MAX_NESTING_DEPTH } from "./pdf-objects/bounds";
import { openPdfObjects } from "./pdf-objects/document";
import { PdfObjectsRefusal } from "./pdf-objects/refusal";
import { decodePdfTextString } from "./pdf-text-string";
import { readPdfSource } from "./pdf-source";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (path: string): Uint8Array => new Uint8Array(readFileSync(join(here, "../../fixtures", path)));

/** `bytes` with the first `<<` of object `num` turned into `))`: a syntax refusal at that object, and only there. */
function broken(bytes: Uint8Array, num: number, kind: TargetKind): Uint8Array {
  const target = agreedTargets(bytes).agreed.find((candidate) => candidate.num === num);
  expect(target?.kind, `object ${num}`).toBe(kind);
  const at = Buffer.from(bytes.subarray(target!.start, target!.end)).indexOf("<<");
  expect(at).toBeGreaterThan(0);
  const out = bytes.slice();
  out[target!.start + at] = 0x29;
  out[target!.start + at + 1] = 0x29;
  return out;
}

const WORD_TOR = "docx-heading-reel/09-2026-terms-of-reference-working-group-on-interim-state-architecture-fo-Word.pdf";

describe("a part that carries no text fails alone (decision of 24/11/2026)", () => {
  it("the /Info dictionary: the same words, the document facts absent", async () => {
    const intact = fixture("pdf/05a-Rapport-Annuel-Digital.pdf");
    const damaged = broken(intact, 7, "info");
    expect(publishedWords((await extractPdf(damaged)).pages)).toEqual(publishedWords((await extractPdf(intact)).pages));
    expect((await readPdfSource(intact)).info).toBeDefined();
    expect((await readPdfSource(damaged)).info).toBeUndefined();
  });

  it("an outline item: the same words, that item absent and the items before it kept", async () => {
    const intact = fixture(WORD_TOR);
    const damaged = broken(intact, 51, "outline");
    expect(publishedWords((await extractPdf(damaged)).pages)).toEqual(publishedWords((await extractPdf(intact)).pages));
    const title = openPdfObjects(intact).dictOf({ kind: "ref", num: 51, gen: 0 })?.get("Title");
    const itemTitle = title?.kind === "string" ? decodePdfTextString(title.bytes).normalize("NFKC").trim() : "";
    const before = (await readPdfSource(intact)).outline ?? [];
    const after = (await readPdfSource(damaged)).outline ?? [];
    expect(before.map((entry) => entry.title)).toContain(itemTitle);
    expect(after.map((entry) => entry.title)).not.toContain(itemTitle);
    expect(after).toEqual(before.slice(0, after.length));
  });

  // Its `/Subtype` is in the damaged bytes, so it may have been a form carrying text: an unread OBJECT, never called a
  // lost picture (decision of 24/11/2026).
  it("an XObject whose /Subtype cannot be read: the same words, counted as an unread object, not as a lost image", async () => {
    const intact = fixture("pdf/60-Image-CCITT-Groupe4.pdf");
    const damaged = broken(intact, 5, "image");
    const before = await extractPdf(intact);
    const after = await extractPdf(damaged);
    expect(publishedWords(after.pages)).toEqual(publishedWords(before.pages));
    expect(before.images ?? []).toHaveLength(1);
    expect(after.images ?? []).toEqual([]);
    expect(after.notices ?? []).not.toContainEqual(expect.objectContaining({ kind: "pdf-image-unread" }));
    expect([...after.unreadObjectsByPage]).toEqual([[0, 1]]);
    expect([...before.unreadObjectsByPage]).toEqual([]);
    expect(after.notices).toContainEqual({ kind: "pdf-part-unread", count: 1, pages: [{ from: 1, to: 1 }], more: 0 });
    expect(before.notices ?? []).not.toContainEqual(expect.objectContaining({ kind: "pdf-part-unread" }));
  });

  it("a link annotation: the same words, that link absent and the others kept", async () => {
    const intact = fixture("pdf/31-Guide-Demarche-AAP-LibreOffice.pdf");
    const damaged = broken(intact, 14, "link");
    expect(publishedWords((await extractPdf(damaged)).pages)).toEqual(publishedWords((await extractPdf(intact)).pages));
    const before = (await readPdfSource(intact)).pages.flatMap((page) => page.links);
    const after = (await readPdfSource(damaged)).pages.flatMap((page) => page.links);
    expect(after).toHaveLength(before.length - 1);
    for (const link of after) expect(before).toContainEqual(link);
  });

  // Green before the decision too: the reader never reads a `/Metadata` stream. Kept so that the day it does, it reads
  // it as a part that fails alone.
  it("a /Metadata stream: the same words", async () => {
    const intact = fixture(WORD_TOR);
    const damaged = broken(intact, 558, "metadata");
    expect(publishedWords((await extractPdf(damaged)).pages)).toEqual(publishedWords((await extractPdf(intact)).pages));
  });
});

/** A one-page PDF: « Hello world » in Helvetica, then the picture `Im` (object 6), drawn from `image`. */
function pageWithPicture(image: { readonly dict: string; readonly data: Uint8Array }): Uint8Array {
  const text = (value: string): Buffer => Buffer.from(value, "latin1");
  const content = "BT /F1 24 Tf 72 700 Td (Hello world) Tj ET q 100 0 0 100 72 500 cm /Im Do Q";
  const bodies: Buffer[] = [
    text("<< /Type /Catalog /Pages 2 0 R >>"),
    text("<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>"),
    text(
      "<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /Im 6 0 R >> >> >>",
    ),
    text(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`),
    text("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"),
    Buffer.concat([
      text(`<< ${image.dict} /Length ${image.data.length} >>\nstream\n`),
      Buffer.from(image.data),
      text("\nendstream"),
    ]),
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

const RGB = "/Type /XObject /Subtype /Image /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode";

/** The refusal of ours an extraction ended with: the error itself or its `cause`. */
async function refusalOfRead(bytes: Uint8Array): Promise<PdfObjectsRefusal | undefined> {
  try {
    await extractPdf(bytes);
    return undefined;
  } catch (error) {
    if (error instanceof PdfObjectsRefusal) return error;
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof PdfObjectsRefusal ? cause : undefined;
  }
}

describe("a refusal for security is never absorbed by a part (decision of 25/10/2026)", () => {
  it("a merely damaged picture is dropped alone: the same words, the picture counted lost", async () => {
    const intact = pageWithPicture({ dict: `${RGB} /Width 2 /Height 2`, data: deflateSync(new Uint8Array(12)) });
    const damaged = pageWithPicture({ dict: `${RGB} /Width 2 /Height 2`, data: new Uint8Array(12).fill(0x41) });
    const before = await extractPdf(intact);
    const after = await extractPdf(damaged);
    expect(publishedWords(before.pages)).toEqual(["Hello", "world"]);
    expect(publishedWords(after.pages)).toEqual(["Hello", "world"]);
    expect(after.notices).toContainEqual(expect.objectContaining({ kind: "pdf-image-unread", unreadable: 1 }));
  });

  it("a picture that decodes past the stream ceiling refuses the whole document", async () => {
    // 5000 x 5000 RGB is under the picture ceiling (25 M pixels) and decodes to 75 MB, past MAX_DECODED_STREAM_BYTES.
    const bomb = deflateSync(new Uint8Array(5000 * 5000 * 3));
    const refusal = await refusalOfRead(pageWithPicture({ dict: `${RGB} /Width 5000 /Height 5000`, data: bomb }));
    expect(refusal?.reason).toBe("stream-too-large");
  });

  it("an XObject nested past the parser's ceiling refuses the whole document", async () => {
    const deep = `/Deep ${"[".repeat(MAX_NESTING_DEPTH + 1)}${"]".repeat(MAX_NESTING_DEPTH + 1)}`;
    const refusal = await refusalOfRead(
      pageWithPicture({ dict: `${RGB} /Width 2 /Height 2 ${deep}`, data: new Uint8Array(1) }),
    );
    expect(refusal?.reason).toBe("nesting-too-deep");
  });
});

describe("pdfPartUnreadNotices: the folding, a pure unit", () => {
  it("counts the objects, folds the pages into ranges counted from 1, and leaves out the pages the AI replaced", () => {
    const unread = new Map([
      [0, 2],
      [1, 1],
      [4, 3],
    ]);
    expect(pdfPartUnreadNotices(unread, new Set())).toEqual([
      {
        kind: "pdf-part-unread",
        count: 6,
        pages: [
          { from: 1, to: 2 },
          { from: 5, to: 5 },
        ],
        more: 0,
      },
    ]);
    expect(pdfPartUnreadNotices(unread, new Set([4]))).toEqual([
      { kind: "pdf-part-unread", count: 3, pages: [{ from: 1, to: 2 }], more: 0 },
    ]);
  });

  it("gives no notice when no object is unread", () => {
    expect(pdfPartUnreadNotices(new Map(), new Set())).toBeUndefined();
    expect(pdfPartUnreadNotices(new Map([[3, 1]]), new Set([3]))).toBeUndefined();
  });

  it("keeps at most MAX_NOTICE_PAGE_RANGES ranges and counts the pages left out", () => {
    const unread = new Map(Array.from({ length: 2_000 }, (_, i) => [i * 2, 1] as [number, number]));
    const [notice] = pdfPartUnreadNotices(unread, new Set()) ?? [];
    const { pages, more, count } = notice as { pages: readonly unknown[]; more: number; count: number };
    expect(count).toBe(2_000);
    expect(pages).toHaveLength(MAX_NOTICE_PAGE_RANGES);
    expect(more).toBe(2_000 - MAX_NOTICE_PAGE_RANGES);
  });
});
