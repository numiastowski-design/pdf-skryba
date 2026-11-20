/**
 * Slice A4 of the object reader (docs/POC-SANS-PDFJS.md): the DOCUMENT — objects resolved through the
 * cross-reference section, compressed objects read from their container, a stale table seen — and the PAGE TREE.
 * ISO 32000-1:2008 §7.3.10 (indirect objects), §7.5.7 (object streams), §7.7.2 (catalog), §7.7.3 (page tree and
 * its inheritable attributes, Table 29) — https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf
 * Tests only, written before any product code. The contract fixed here:
 *   openPdfObjects(bytes) -> { trailer, resolve, dictOf, streamBytes, pages }
 *   pages() -> readonly PdfPageEntry[]   ({ ref, dict, view, rotate, resources })
 *   `view` is the CropBox clipped to the MediaBox, normalised, as pdf.js's `page.view` gave it.
 * Every failure is a PdfObjectsRefusal, nothing else.
 */
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { MAX_OBJECT_STREAM_CACHE, MAX_PAGE_TREE_DEPTH, MAX_PAGES, MAX_REF_HOPS, MAX_VALUE_NODES } from "./bounds";
import { openPdfObjects, remember } from "./document";
import type { PdfValue } from "./objects";
import { PdfObjectsRefusal } from "./refusal";

const enc = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "latin1"));
const latin1 = (b: Uint8Array | Buffer): string => Buffer.from(b).toString("latin1");

function refusalOf(fn: () => unknown): PdfObjectsRefusal {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PdfObjectsRefusal);
    return error as PdfObjectsRefusal;
  }
  throw new Error("expected a PdfObjectsRefusal, nothing was thrown");
}

/** A file holding `bodies` as objects 1..n, with a classic table and `/Root 1 0 R`. `confuse` makes a STALE table
 *  by pointing one object's entry at ANOTHER object — which parses perfectly and carries the wrong number, the
 *  only shape that exercises the check (a random byte shift only refuses as `syntax`, measured 31/10/2026). */
function buildPdf(
  bodies: readonly string[],
  confuse: { object: number; at: number } | undefined = undefined,
): Uint8Array {
  let file = "%PDF-1.4\n";
  const offsets: number[] = [];
  bodies.forEach((body, i) => {
    offsets.push(file.length);
    file += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  if (confuse !== undefined) offsets[confuse.object - 1] = offsets[confuse.at - 1] as number;
  const xrefAt = file.length;
  let table = `xref\n0 ${bodies.length + 1}\n0000000000 65535 f\r\n`;
  for (const offset of offsets) table += `${String(offset).padStart(10, "0")} 00000 n\r\n`;
  return enc(`${file}${table}trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
}

const numberOf = (value: PdfValue | undefined): number => {
  if (value?.kind !== "number") throw new Error(`expected a number, got ${value?.kind ?? "nothing"}`);
  return value.value;
};

describe("openPdfObjects: objects through the table", () => {
  const bytes = buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>",
    "<< /Type /Page /Parent 2 0 R >>",
  ]);

  it("resolves a reference to the object it names", () => {
    const doc = openPdfObjects(bytes);
    const root = doc.resolve(doc.trailer().get("Root"));
    expect(root?.kind).toBe("dict");
    expect(doc.dictOf(root)?.get("Type")).toEqual({ kind: "name", value: "Catalog" });
  });

  it("gives nothing for an object the table does not place", () => {
    const doc = openPdfObjects(bytes);
    expect(doc.resolve({ kind: "ref", num: 99, gen: 0 })).toBeUndefined();
  });

  it("leaves a direct value alone", () => {
    const doc = openPdfObjects(bytes);
    expect(doc.resolve({ kind: "number", value: 7 })).toEqual({ kind: "number", value: 7 });
  });

  it("SEES A STALE TABLE: the object at the offset does not carry the expected number", () => {
    // The entry for object 3 points at object 2: it parses, and it carries the wrong number.
    const stale = buildPdf(
      ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page >>"],
      { object: 3, at: 2 },
    );
    const doc = openPdfObjects(stale);
    expect(refusalOf(() => doc.resolve({ kind: "ref", num: 3, gen: 0 })).reason).toBe("xref-stale");
  });

  it("resolves an indirect /Length to read a stream's bytes", () => {
    const withStream = buildPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Contents 4 0 R >>",
      "<< /Length 5 0 R >>\nstream\nBT ET\nendstream",
      // The length of `BT ET` itself, five bytes: the end-of-line before `endstream` is not data (§7.3.8.1).
      "5",
    ]);
    const doc = openPdfObjects(withStream);
    const stream = doc.resolve({ kind: "ref", num: 4, gen: 0 });
    expect(stream?.kind).toBe("stream");
    expect(latin1(doc.streamBytes(stream as never))).toBe("BT ET");
  });
});

describe("openPdfObjects: compressed objects (7.5.7)", () => {
  /** A file whose page object lives inside an object stream, placed by a cross-reference stream. */
  function fileWithCompressedPage(): Uint8Array {
    const members = "<< /Type /Page /Parent 2 0 R /Rotate 90 >>";
    const pairs = "3 0 ";
    const objStmData = latin1(deflateSync(Buffer.from(`${pairs}${members}`, "latin1")));
    let file = "%PDF-1.5\n";
    const offsets = new Map<number, number>();
    const add = (num: number, body: string): void => {
      offsets.set(num, file.length);
      file += `${num} 0 obj\n${body}\nendobj\n`;
    };
    add(1, "<< /Type /Catalog /Pages 2 0 R >>");
    add(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 200 100] >>");
    add(
      4,
      `<< /Type /ObjStm /N 1 /First ${pairs.length} /Filter /FlateDecode /Length ${objStmData.length} >>\nstream\n${objStmData}\nendstream`,
    );

    // The cross-reference stream: entries for objects 0..5, /W [1 4 2], uncompressed for readability.
    const rows: string[] = [];
    const row = (type: number, second: number, third: number): string => {
      let out = String.fromCharCode(type);
      for (let i = 3; i >= 0; i -= 1) out += String.fromCharCode((second >>> (8 * i)) & 0xff);
      out += String.fromCharCode((third >>> 8) & 0xff, third & 0xff);
      return out;
    };
    rows.push(row(0, 0, 65_535));
    rows.push(row(1, offsets.get(1) as number, 0));
    rows.push(row(1, offsets.get(2) as number, 0));
    rows.push(row(2, 4, 0)); // object 3 is member 0 of the object stream 4
    rows.push(row(1, offsets.get(4) as number, 0));
    const data = rows.join("");
    const xrefAt = file.length;
    file += `5 0 obj\n<< /Type /XRef /Size 6 /Index [0 5] /W [1 4 2] /Root 1 0 R /Length ${data.length} >>\nstream\n${data}\nendstream\nendobj\n`;
    return enc(`${file}startxref\n${xrefAt}\n%%EOF\n`);
  }

  it("reads an object out of its container stream", () => {
    const doc = openPdfObjects(fileWithCompressedPage());
    const page = doc.dictOf(doc.resolve({ kind: "ref", num: 3, gen: 0 }));
    expect(page?.get("Type")).toEqual({ kind: "name", value: "Page" });
    expect(numberOf(page?.get("Rotate"))).toBe(90);
  });

  it("walks a page tree whose leaf is compressed", () => {
    const pages = openPdfObjects(fileWithCompressedPage()).pages();
    expect(pages).toHaveLength(1);
    expect(pages[0]?.rotate).toBe(90);
    expect(pages[0]?.view).toEqual([0, 0, 200, 100]);
  });
});

describe("remember: the bounded cache of decompressed object streams", () => {
  it("keeps at most `max` entries and drops the oldest", () => {
    const cache = new Map<number, string>();
    for (let i = 0; i < MAX_OBJECT_STREAM_CACHE + 3; i += 1) remember(cache, i, `v${i}`, MAX_OBJECT_STREAM_CACHE);
    expect(cache.size).toBe(MAX_OBJECT_STREAM_CACHE);
    // The first three are gone, the last ones are there: the insertion order decides.
    expect(cache.has(0)).toBe(false);
    expect(cache.has(2)).toBe(false);
    expect(cache.get(MAX_OBJECT_STREAM_CACHE + 2)).toBe(`v${MAX_OBJECT_STREAM_CACHE + 2}`);
  });
});

describe("openPdfObjects: an encrypted document (7.6)", () => {
  // The made-up encrypted specimen (written and encrypted by its generator, through qpdf), and the standard handler with
  // an empty password: the case of documents entrusted to us. §7.6.2 also encrypts the STRINGS, with the key of their object.
  const ENCRYPTED = "fixtures/pdf/59-Document-Chiffre-RC4.pdf";

  it("decrypts the strings of a dictionary, not only the streams", () => {
    // The date is NOT in the file as written: without this, a file that was never encrypted would pass the test below.
    expect(readFileSync(ENCRYPTED).toString("latin1")).not.toMatch(/D:\d{14}/);
    const doc = openPdfObjects(new Uint8Array(readFileSync(ENCRYPTED)));
    const info = doc.dictOf(doc.trailer().get("Info"));
    const created = doc.resolve(info?.get("CreationDate"));
    expect(created?.kind).toBe("string");
    // §7.9.4: a PDF date starts with `D:` and fourteen digits. Encrypted, it has no chance of
    // looking like one (measured: 5 printable bytes out of 17 before decryption).
    const text = Buffer.from((created as { bytes: Uint8Array }).bytes).toString("latin1");
    expect(text).toMatch(/^D:\d{14}/);
  });

  it("reads its pages like any other document", () => {
    const pages = openPdfObjects(new Uint8Array(readFileSync(ENCRYPTED))).pages();
    expect(pages.length).toBeGreaterThan(0);
    expect(pages[0]?.view[2]).toBeGreaterThan(0);
  });
});

describe("pages: the tree and its inheritable attributes (7.7.3, Table 29)", () => {
  it("reads the leaves in the order the kids give, nesting included", () => {
    const bytes = buildPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 3 /MediaBox [0 0 612 792] >>",
      "<< /Type /Pages /Parent 2 0 R /Kids [4 0 R 5 0 R] /Count 2 >>",
      "<< /Type /Page /Parent 3 0 R >>",
      "<< /Type /Page /Parent 3 0 R /MediaBox [0 0 100 200] >>",
      "<< /Type /Page /Parent 2 0 R /Rotate 270 >>",
    ]);
    const pages = openPdfObjects(bytes).pages();
    expect(pages.map((page) => page.ref.num)).toEqual([4, 5, 6]);
  });

  it("inherits MediaBox from an ancestor, and a page's own one wins", () => {
    const bytes = buildPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /MediaBox [0 0 612 792] >>",
      "<< /Type /Page /Parent 2 0 R >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 200] >>",
    ]);
    const pages = openPdfObjects(bytes).pages();
    expect(pages[0]?.view).toEqual([0, 0, 612, 792]);
    expect(pages[1]?.view).toEqual([0, 0, 100, 200]);
  });

  it("clips the CropBox to the MediaBox and normalises the corners, as pdf.js's `view` does", () => {
    const bytes = buildPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /MediaBox [0 0 612 792] >>",
      "<< /Type /Page /Parent 2 0 R /CropBox [10 20 1000 700] >>",
      // Corners given the other way round: a box is a pair of OPPOSITE corners, not an ordered one.
      "<< /Type /Page /Parent 2 0 R /CropBox [500 600 100 200] >>",
    ]);
    const pages = openPdfObjects(bytes).pages();
    expect(pages[0]?.view).toEqual([10, 20, 612, 700]);
    expect(pages[1]?.view).toEqual([100, 200, 500, 600]);
  });

  it("normalises Rotate to a quarter turn in [0, 360)", () => {
    const bytes = buildPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /MediaBox [0 0 10 10] /Rotate -90 >>",
      "<< /Type /Page /Parent 2 0 R >>",
      "<< /Type /Page /Parent 2 0 R /Rotate 450 >>",
    ]);
    const pages = openPdfObjects(bytes).pages();
    expect(pages[0]?.rotate).toBe(270);
    expect(pages[1]?.rotate).toBe(90);
  });

  it("inherits Resources, and keeps the page's own", () => {
    const bytes = buildPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 10 10] /Resources << /Font << /F1 9 0 R >> >> >>",
      "<< /Type /Page /Parent 2 0 R >>",
    ]);
    const resources = openPdfObjects(bytes).pages()[0]?.resources;
    expect(resources?.get("Font")?.kind).toBe("dict");
  });

  it("refuses a page tree that loops", () => {
    const bytes = buildPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Pages /Parent 2 0 R /Kids [2 0 R] /Count 1 >>",
    ]);
    expect(refusalOf(() => openPdfObjects(bytes).pages()).reason).toBe("page-tree");
  });

  it("refuses a catalog with no page tree", () => {
    const bytes = buildPdf(["<< /Type /Catalog >>"]);
    expect(refusalOf(() => openPdfObjects(bytes).pages()).reason).toBe("page-tree");
  });

  it("refuses a kid that is not a dictionary", () => {
    const bytes = buildPdf(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "42"]);
    expect(refusalOf(() => openPdfObjects(bytes).pages()).reason).toBe("page-tree");
  });

  it("refuses a chain of references longer than MAX_REF_HOPS", () => {
    // Each object points to the next; at the ninth hop the reading refuses instead of following.
    const bodies = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"];
    for (let i = 0; i < MAX_REF_HOPS + 2; i += 1) bodies.push(`${bodies.length + 2} 0 R`);
    const doc = openPdfObjects(buildPdf(bodies));
    expect(refusalOf(() => doc.resolve({ kind: "ref", num: 3, gen: 0 })).reason).toBe("ref-hops");
  });

  it("refuses a page tree deeper than MAX_PAGE_TREE_DEPTH", () => {
    const bodies = ["<< /Type /Catalog /Pages 2 0 R >>"];
    // One node per level, each a child of the previous one, and a leaf at the very bottom.
    for (let i = 0; i <= MAX_PAGE_TREE_DEPTH; i += 1) {
      bodies.push(`<< /Type /Pages /Kids [${bodies.length + 2} 0 R] /Count 1 /MediaBox [0 0 10 10] >>`);
    }
    bodies.push("<< /Type /Page >>");
    expect(refusalOf(() => openPdfObjects(buildPdf(bodies)).pages()).reason).toBe("page-tree");
  });

  it("refuses a chain of indirect /Length deeper than MAX_REF_HOPS, without overflowing the call stack", () => {
    // Security review of 31/10/2026: `objectOf → /Length → objectOf` is RECURSIVE, and nothing counted this
    // descent — `MAX_REF_HOPS` only counted the hops of `resolve`, the `reading` set only the cycles.
    // A thousand streams each of whose `/Length` points to the next fit in 75 KB and overflowed the CALL
    // STACK: a `RangeError`, not a refusal.
    const bodies = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"];
    const first = bodies.length + 1;
    const count = MAX_REF_HOPS + 4;
    for (let i = 0; i < count; i += 1) {
      bodies.push(`<< /Length ${first + i + 1} 0 R >>\nstream\nx\nendstream`);
    }
    bodies.push("1");
    const doc = openPdfObjects(buildPdf(bodies));
    expect(refusalOf(() => doc.resolve({ kind: "ref", num: first, gen: 0 })).reason).toBe("ref-hops");
  });

  it("refuses a value with more nodes than MAX_VALUE_NODES", () => {
    // Security review of 31/10/2026: only the DEPTH was bounded. An array of numbers costs ~48 bytes of
    // heap per number, so 64 KB compressed made hundreds of megabytes of them. The fixture is written with
    // an array longer than the ceiling, and the parse refuses instead of allocating.
    const huge = `[${"1 ".repeat(MAX_VALUE_NODES + 2)}]`;
    const bodies = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", huge];
    const doc = openPdfObjects(buildPdf(bodies));
    expect(refusalOf(() => doc.resolve({ kind: "ref", num: 3, gen: 0 })).reason).toBe("value-too-large");
  });

  it("refuses more leaves than MAX_PAGES", () => {
    // I had written that this trial would be "too expensive" WITHOUT measuring it, and that is the mistake this POC paid for
    // three times: the file is 4 MB, it is built in 20 ms and the reading refuses in 169 ms (31/10/2026).
    // A FLAT tree, one leaf per object, because the same object twice is refused earlier as a loop.
    const count = MAX_PAGES + 1;
    const bodies = ["<< /Type /Catalog /Pages 2 0 R >>"];
    const kids = Array.from({ length: count }, (_, i) => `${i + 3} 0 R`).join(" ");
    bodies.push(`<< /Type /Pages /Count ${count} /MediaBox [0 0 10 10] /Kids [${kids}] >>`);
    for (let i = 0; i < count; i += 1) bodies.push("<< /Type /Page /Parent 2 0 R >>");
    expect(refusalOf(() => openPdfObjects(buildPdf(bodies)).pages()).reason).toBe("page-tree");
  });

  it("refuses a page with no box at all (nothing says how big it is)", () => {
    const bytes = buildPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R >>",
    ]);
    expect(refusalOf(() => openPdfObjects(bytes).pages()).reason).toBe("page-box");
  });
});
