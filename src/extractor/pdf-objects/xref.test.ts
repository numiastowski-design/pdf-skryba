/**
 * Slice A2 of the object reader (docs/CONCEPTION-LECTEUR-OBJETS-PDF.md): cross-reference TABLE, trailer, `Prev`
 * chain and incremental updates. ISO 32000-1:2008 clauses 7.5.4 (table), 7.5.5 (file trailer and `startxref`),
 * 7.5.6 (incremental updates) — https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf.
 * Tests only, written before any product code. The contract fixed here:
 *   readXref(bytes) -> { entries: Map<number, XrefEntry>, trailer: PdfDict }
 *   XrefEntry = { kind: "offset", offset, gen } | { kind: "compressed", container, index }
 * NEWEST WINS, per object and per trailer key (7.5.6: an update's section is read first, its `Prev` after).
 * A FREE entry (`f`) is absent from `entries` — including when it frees an object an older section placed.
 * Every failure is a PdfObjectsRefusal, nothing else (no TypeError, no RangeError).
 */
import { describe, expect, it } from "vitest";

import { MAX_XREF_ENTRIES, MAX_XREF_FIELD_BYTES, MAX_XREF_SECTIONS, STARTXREF_SEARCH_BYTES } from "./bounds";
import type { PdfValue } from "./objects";
import { PdfObjectsRefusal } from "./refusal";
import { MAX_TABLE_TOKEN_BYTES, readXref } from "./xref";

const enc = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "latin1"));

function refusalOf(fn: () => unknown): PdfObjectsRefusal {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PdfObjectsRefusal);
    return error as PdfObjectsRefusal;
  }
  throw new Error("expected a PdfObjectsRefusal, nothing was thrown");
}

/** A ten-digit offset and a five-digit generation, as 7.5.4 writes them. */
const entry = (offset: number, gen: number, type: "n" | "f"): string =>
  `${String(offset).padStart(10, "0")} ${String(gen).padStart(5, "0")} ${type}\r\n`;

/** A file whose body is `body` and whose single table starts where `%%` marks it; the marker is replaced by the real offset. */
function fileWithTable(body: string, table: string, extraTail = ""): Uint8Array {
  const head = `%PDF-1.4\n${body}`;
  return enc(`${head}${table}${extraTail}startxref\n${head.length}\n%%EOF\n`);
}

const numberOf = (value: PdfValue | undefined): number => {
  if (value?.kind !== "number") throw new Error(`expected a number, got ${value?.kind ?? "nothing"}`);
  return value.value;
};

describe("readXref: one classic table (7.5.4)", () => {
  const table = `xref\n0 3\n${entry(0, 65_535, "f")}${entry(17, 0, "n")}${entry(81, 0, "n")}trailer\n<< /Size 3 /Root 1 0 R >>\n`;
  const bytes = fileWithTable("1 0 obj\n<< >>\nendobj\n", table);

  it("reads every in-use entry, by object number", () => {
    const { entries } = readXref(bytes);
    expect(entries.get(1)).toEqual({ kind: "offset", offset: 17, gen: 0 });
    expect(entries.get(2)).toEqual({ kind: "offset", offset: 81, gen: 0 });
  });

  it("leaves the free entry out", () => {
    expect(readXref(bytes).entries.has(0)).toBe(false);
  });

  it("reads the trailer dictionary", () => {
    const { trailer } = readXref(bytes);
    expect(numberOf(trailer.get("Size"))).toBe(3);
    expect(trailer.get("Root")).toEqual({ kind: "ref", num: 1, gen: 0 });
  });

  it("takes the LAST startxref of the file (7.5.5: an update appends its own)", () => {
    // A stale `startxref` sits BEFORE the real one, pointing nowhere: reading the first would refuse `xref-offset`.
    const stale = fileWithTable("1 0 obj\n<< >>\nendobj\n", table, "startxref\n999999\n%%EOF\n");
    expect(readXref(stale).entries.get(1)).toEqual({ kind: "offset", offset: 17, gen: 0 });
  });

  it("reads several subsections of one table", () => {
    const twoRanges = `xref\n0 1\n${entry(0, 65_535, "f")}4 2\n${entry(40, 0, "n")}${entry(60, 3, "n")}trailer\n<< /Size 6 >>\n`;
    const { entries } = readXref(fileWithTable("", twoRanges));
    expect(entries.get(4)).toEqual({ kind: "offset", offset: 40, gen: 0 });
    expect(entries.get(5)).toEqual({ kind: "offset", offset: 60, gen: 3 });
    expect(entries.size).toBe(2);
  });
});

describe("readXref: incremental update (7.5.6)", () => {
  /** An original file, then an update whose table has `/Prev` on the first one. */
  function updatedFile(updateTable: string): Uint8Array {
    const head = "%PDF-1.4\n1 0 obj\n<< >>\nendobj\n";
    const firstTable = `xref\n0 3\n${entry(0, 65_535, "f")}${entry(9, 0, "n")}${entry(30, 0, "n")}trailer\n<< /Size 3 /Root 1 0 R /Info 9 0 R >>\n`;
    const firstStart = head.length;
    const upTo = `${head}${firstTable}startxref\n${firstStart}\n%%EOF\n`;
    const secondStart = upTo.length;
    return enc(`${upTo}${updateTable.replace("@PREV@", String(firstStart))}startxref\n${secondStart}\n%%EOF\n`);
  }

  it("prefers the update's offset for an object both sections place", () => {
    const update = `xref\n0 1\n${entry(0, 65_535, "f")}1 1\n${entry(500, 0, "n")}trailer\n<< /Size 3 /Root 1 0 R /Prev @PREV@ >>\n`;
    const { entries } = readXref(updatedFile(update));
    expect(entries.get(1)).toEqual({ kind: "offset", offset: 500, gen: 0 });
  });

  it("keeps an object only the older section places", () => {
    const update = `xref\n0 1\n${entry(0, 65_535, "f")}1 1\n${entry(500, 0, "n")}trailer\n<< /Size 3 /Root 1 0 R /Prev @PREV@ >>\n`;
    expect(readXref(updatedFile(update)).entries.get(2)).toEqual({ kind: "offset", offset: 30, gen: 0 });
  });

  it("drops an object the update FREES, even though the older section places it", () => {
    const update = `xref\n2 1\n${entry(0, 1, "f")}trailer\n<< /Size 3 /Root 1 0 R /Prev @PREV@ >>\n`;
    expect(readXref(updatedFile(update)).entries.has(2)).toBe(false);
  });

  it("merges the trailer key by key, the newest winning", () => {
    const update = `xref\n2 1\n${entry(0, 1, "f")}trailer\n<< /Size 9 /Root 7 0 R /Prev @PREV@ >>\n`;
    const { trailer } = readXref(updatedFile(update));
    expect(trailer.get("Root")).toEqual({ kind: "ref", num: 7, gen: 0 });
    expect(numberOf(trailer.get("Size"))).toBe(9);
    // Only the older trailer carries it: it stays.
    expect(trailer.get("Info")).toEqual({ kind: "ref", num: 9, gen: 0 });
  });
});

describe("readXref: refusals, never a crash", () => {
  it("refuses a file with no startxref", () => {
    expect(refusalOf(() => readXref(enc("%PDF-1.4\n1 0 obj\n<< >>\nendobj\n%%EOF\n"))).reason).toBe(
      "startxref-missing",
    );
  });

  it("refuses a startxref that is not an integer", () => {
    expect(refusalOf(() => readXref(enc("%PDF-1.4\nstartxref\nabc\n%%EOF\n"))).reason).toBe("xref-offset");
  });

  it("refuses a startxref past the end of the file", () => {
    expect(refusalOf(() => readXref(enc("%PDF-1.4\nstartxref\n99999\n%%EOF\n"))).reason).toBe("xref-offset");
  });

  it("refuses an offset that points at something that is not a table", () => {
    expect(refusalOf(() => readXref(fileWithTable("", "junk\n"))).reason).toBe("xref-offset");
  });

  it("refuses a subsection header that is not two integers", () => {
    const bad = `xref\n0 x\n${entry(17, 0, "n")}trailer\n<< /Size 1 >>\n`;
    expect(refusalOf(() => readXref(fileWithTable("", bad))).reason).toBe("xref-syntax");
  });

  it("refuses an entry whose type is neither n nor f", () => {
    const bad = `xref\n1 1\n0000000017 00000 x\r\ntrailer\n<< /Size 2 >>\n`;
    expect(refusalOf(() => readXref(fileWithTable("", bad))).reason).toBe("xref-syntax");
  });

  it("refuses a table with no trailer", () => {
    const bad = `xref\n1 1\n${entry(17, 0, "n")}`;
    expect(refusalOf(() => readXref(fileWithTable("", bad))).reason).toBe("xref-syntax");
  });

  it("refuses a Prev that loops on itself", () => {
    const head = "%PDF-1.4\n";
    const table = `xref\n0 1\n${entry(0, 65_535, "f")}trailer\n<< /Size 1 /Prev ${head.length} >>\n`;
    expect(refusalOf(() => readXref(fileWithTable("", table))).reason).toBe("xref-chain");
  });

  it("refuses a Prev chain longer than its ceiling", () => {
    // Each section is identical but for its `Prev`, which points at the one before it.
    let file = "%PDF-1.4\n";
    const offsets: number[] = [];
    for (let i = 0; i <= MAX_XREF_SECTIONS; i += 1) {
      offsets.push(file.length);
      const prev = i === 0 ? "" : ` /Prev ${offsets[i - 1]}`;
      file += `xref\n0 1\n${entry(0, 65_535, "f")}trailer\n<< /Size 1${prev} >>\n`;
    }
    const last = offsets[offsets.length - 1] ?? 0;
    expect(refusalOf(() => readXref(enc(`${file}startxref\n${last}\n%%EOF\n`))).reason).toBe("xref-chain");
  });

  it("refuses a Prev that is not an integer offset inside the file", () => {
    const table = `xref\n0 1\n${entry(0, 65_535, "f")}trailer\n<< /Size 1 /Prev 123456 >>\n`;
    expect(refusalOf(() => readXref(fileWithTable("", table))).reason).toBe("xref-offset");
  });

  it("refuses empty bytes with a refusal, not a crash", () => {
    expect(refusalOf(() => readXref(new Uint8Array(0))).reason).toBe("startxref-missing");
  });

  it("refuses a startxref that sits further back than STARTXREF_SEARCH_BYTES", () => {
    const table = `xref\n0 1\n${entry(0, 65_535, "f")}trailer\n<< /Size 1 >>\n`;
    const good = fileWithTable("", table);
    // The same file, followed by enough bytes to push its `startxref` out of the searched tail.
    const buried = enc(`${Buffer.from(good).toString("latin1")}${"%".repeat(STARTXREF_SEARCH_BYTES)}\n`);
    expect(readXref(good).trailer.size).toBe(1);
    expect(refusalOf(() => readXref(buried)).reason).toBe("startxref-missing");
  });

  // `MIN_ENTRY_BYTES` is a cost guard no test can tell apart: without it the loop reads the first entry, runs out of
  // bytes and refuses `xref-syntax` too. It saves loop turns on a lying header, not a different verdict.
  it("refuses a subsection announcing more entries than the file can hold", () => {
    const bad = `xref\n0 1000\n${entry(17, 0, "n")}trailer\n<< /Size 1 >>\n`;
    expect(refusalOf(() => readXref(fileWithTable("", bad))).reason).toBe("xref-syntax");
  });

  it("refuses a token longer than MAX_TABLE_TOKEN_BYTES inside a table", () => {
    // The offset of an entry, written on too many digits: without the guard it reads as a number and the entry is
    // accepted. On the count of a subsection the test would discriminate nothing: the entry-count guard refuses first.
    const long = `${"0".repeat(MAX_TABLE_TOKEN_BYTES + 1)}17 00000 n\r\n`;
    const bad = `xref\n1 1\n${long}trailer\n<< /Size 2 >>\n`;
    expect(refusalOf(() => readXref(fileWithTable("", bad))).reason).toBe("xref-syntax");
  });

  it("refuses a cross-reference STREAM that announces more entries than MAX_XREF_ENTRIES", () => {
    // Refused on its `/Index` alone, before one byte is inflated.
    const head = "%PDF-1.5\n";
    const object = `4 0 obj\n<< /Type /XRef /Size 9 /Index [0 ${MAX_XREF_ENTRIES + 1}] /W [1 2 2] /Length 0 >>\nstream\n\nendstream\nendobj\n`;
    const bytes = enc(`${head}${object}startxref\n${head.length}\n%%EOF\n`);
    expect(refusalOf(() => readXref(bytes)).reason).toBe("xref-too-large");
  });

  it("refuses a /W field wider than MAX_XREF_FIELD_BYTES", () => {
    // One row, with enough bytes for it: without the guard the row would be read and nothing would refuse. With
    // `/Length 0` the refusal would come from the missing bytes, not from the width.
    const width = MAX_XREF_FIELD_BYTES + 1;
    const data = "\u0001".repeat(1 + width + 2);
    const head = "%PDF-1.5\n";
    const object = `4 0 obj\n<< /Type /XRef /Size 2 /Index [1 1] /W [1 ${width} 2] /Length ${data.length} >>\nstream\n${data}\nendstream\nendobj\n`;
    const bytes = enc(`${head}${object}startxref\n${head.length}\n%%EOF\n`);
    expect(refusalOf(() => readXref(bytes)).reason).toBe("xref-stream");
  });
});
