/** What a JPEG costs the document's cache (review 06/11/2026). A JPEG republished byte for byte is a VIEW of the file when
 *  the stream carries the DCT filter alone: it holds no memory, so it costs 0. The same JPEG under `[/FlateDecode
 *  /DCTDecode]` is FRESH bytes, inflated for the occasion: they cost their real size. */
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { documentCacheOf } from "./document-cache";
import { openEmbeddedImages } from "./pdf-embedded-images";
import { openPdfObjects } from "./pdf-objects/document";

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 4000 }, (_, i) => (i * 7) % 251)]);

function pdfWithPicture(filter: string, body: Buffer): Uint8Array {
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
  const offsets: number[] = [];
  const length = (): number => parts.reduce((sum, p) => sum + p.length, 0);
  const add = (text: string): void => {
    offsets.push(length());
    parts.push(Buffer.from(text, "latin1"));
  };
  add("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  add("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>\nendobj\n");
  add("3 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\n");
  offsets.push(length());
  parts.push(
    Buffer.from(
      `4 0 obj\n<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter ${filter} /Length ${body.length} >>\nstream\n`,
      "latin1",
    ),
    body,
    Buffer.from("\nendstream\nendobj\n", "latin1"),
  );
  const xrefAt = length();
  let table = `xref\n0 5\n0000000000 65535 f\r\n`;
  for (const offset of offsets) table += `${String(offset).padStart(10, "0")} 00000 n\r\n`;
  parts.push(Buffer.from(`${table}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`, "latin1"));
  return new Uint8Array(Buffer.concat(parts));
}

const priceOf = async (filter: string, body: Buffer): Promise<{ mime: string | undefined; price: number }> => {
  const doc = openPdfObjects(pdfWithPicture(filter, body));
  const read = await openEmbeddedImages(doc);
  const image = read("4R");
  return { mime: image?.mimeType, price: documentCacheOf(doc).size };
};

describe("the price of a JPEG in the document's cache", () => {
  it("a JPEG under the DCT filter alone is a view of the file: it costs nothing", async () => {
    expect(await priceOf("/DCTDecode", jpeg)).toEqual({ mime: "image/jpeg", price: 0 });
  });

  it("🔴 a JPEG under [/FlateDecode /DCTDecode] is fresh bytes: it costs their size", async () => {
    const result = await priceOf("[/FlateDecode /DCTDecode]", deflateSync(jpeg));
    expect(result.mime).toBe("image/jpeg");
    expect(result.price).toBe(jpeg.length);
  });
});
