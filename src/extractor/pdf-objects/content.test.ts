/**
 * Slice A5 of the proof of concept of the reader without pdf.js: the CONTENT STREAM read as operators and operands,
 * the job pdf.js's `page.getOperatorList()` did for us before its removal (01/11/2026).
 * ISO 32000-1:2008 §7.8.2 (content streams), §8.9.7 (inline images,
 * `BI … ID … EI`), §7.3.2-7.3.9 (the operands are ordinary objects, and §7.8.2 forbids indirect references
 * there) — https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf
 * Tests only, written before any product code. The contract fixed here:
 *   readContentOps(data) -> readonly { op: string, operands: readonly PdfValue[] }[]
 * An operator we do not know is kept as it is: this layer reads, it does not judge.
 * An inline image is ONE operator carrying its dictionary, and its binary data is skipped, not parsed.
 * Every failure is a PdfObjectsRefusal, nothing else.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_CONTENT_NODES,
  MAX_CONTENT_OPS,
  MAX_INLINE_IMAGE_ENTRIES,
  MAX_TOKEN_BYTES,
  MAX_VALUE_NODES,
} from "./bounds";
import { readContentOps } from "./content";
import type { PdfValue } from "./objects";
import { PdfObjectsRefusal } from "./refusal";

const enc = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "latin1"));
const opsOf = (s: string): readonly { op: string; operands: readonly PdfValue[] }[] => readContentOps(enc(s));
const names = (s: string): string[] => opsOf(s).map((entry) => entry.op);

function refusalOf(fn: () => unknown): PdfObjectsRefusal {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PdfObjectsRefusal);
    return error as PdfObjectsRefusal;
  }
  throw new Error("expected a PdfObjectsRefusal, nothing was thrown");
}

describe("readContentOps: operators and their operands (7.8.2)", () => {
  it("reads a text object, operator by operator", () => {
    expect(names("BT /F1 12 Tf (Hi) Tj ET")).toEqual(["BT", "Tf", "Tj", "ET"]);
  });

  it("gives each operator its own operands, and empties the stack after it", () => {
    const [, tf, tj] = opsOf("BT /F1 12 Tf (Hi) Tj ET");
    expect(tf?.operands).toEqual([
      { kind: "name", value: "F1" },
      { kind: "number", value: 12 },
    ]);
    expect(tj?.operands).toHaveLength(1);
    expect((tj?.operands[0] as { kind: string }).kind).toBe("string");
  });

  it("reads the array of a TJ, strings and numbers mixed", () => {
    const [tj] = opsOf("[(A) -250 (B) 10.5] TJ");
    expect(tj?.op).toBe("TJ");
    const array = tj?.operands[0] as { kind: string; items: readonly PdfValue[] };
    expect(array.kind).toBe("array");
    expect(array.items.map((item) => item.kind)).toEqual(["string", "number", "string", "number"]);
  });

  it("reads a matrix of six reals, negatives and leading points included", () => {
    const [cm] = opsOf("1 0 0 -1 .5 -842.0 cm");
    expect(cm?.operands.map((operand) => (operand as { value: number }).value)).toEqual([1, 0, 0, -1, 0.5, -842]);
  });

  it("reads a dictionary operand (marked content, 14.6)", () => {
    const [bdc] = opsOf("/OC << /MCID 3 >> BDC");
    expect(bdc?.op).toBe("BDC");
    expect(bdc?.operands[1]?.kind).toBe("dict");
  });

  it("reads the bare words 7.3.2 and 7.3.9 allow as operands", () => {
    const [gs] = opsOf("true false null gs");
    expect(gs?.operands.map((operand) => operand.kind)).toEqual(["bool", "bool", "null"]);
  });

  it("keeps an operator it does not know", () => {
    expect(names("1 2 ZZ")).toEqual(["ZZ"]);
  });

  it("ignores comments (7.2.3)", () => {
    expect(names("BT % this is a comment with (parens) and /names\nET")).toEqual(["BT", "ET"]);
  });

  it("reads a hexadecimal string, as a Type0 font's bytes come (9.4.3)", () => {
    const [tj] = opsOf("<00480065> Tj");
    expect([...(tj?.operands[0] as { bytes: Uint8Array }).bytes]).toEqual([0x00, 0x48, 0x00, 0x65]);
  });

  it("reads the two text-showing operators that take spacing (9.4.3)", () => {
    expect(names("1 2 (a) \" (b) '")).toEqual(['"', "'"]);
  });

  it("reads nothing from empty bytes", () => {
    expect(opsOf("")).toEqual([]);
  });

  it("NO INDIRECT REFERENCE HERE (7.8.2): `1 1 1 RG` is three numbers and a colour operator", () => {
    // Measured 31/10/2026: with the `N G R` rule of §7.3.10 left on, this one line makes 16 of our 56 real PDFs
    // refuse their first page — `RG` starts with `R`, so the rule commits to a reference and then refuses.
    const [rg] = opsOf("1 1 1 RG");
    expect(rg?.op).toBe("RG");
    expect(rg?.operands.map((operand) => (operand as { value: number }).value)).toEqual([1, 1, 1]);
  });

  it("reads `0 0 0 RG` and `0 0.4 RG` the same way", () => {
    expect(names("0 0 0 RG 0 0.4 RG")).toEqual(["RG", "RG"]);
  });

  it("reads an empty dash array (`[] 0 d`)", () => {
    const [d] = opsOf("[] 0 d");
    expect(d?.op).toBe("d");
    expect(d?.operands[0]).toEqual({ kind: "array", items: [] });
  });

  it("reads the star operators (`W*`, `T*`, `f*`, `B*`)", () => {
    expect(names("W* T* f* B*")).toEqual(["W*", "T*", "f*", "B*"]);
  });
});

describe("readContentOps: inline images (8.9.7)", () => {
  it("reads an inline image as ONE operator carrying its dictionary", () => {
    const data = "\u0001\u0002\u0003\u0004";
    const ops = opsOf(`q BI /W 2 /H 2 /BPC 8 /CS /G ID ${data} EI Q`);
    expect(ops.map((entry) => entry.op)).toEqual(["q", "BI", "Q"]);
    const dict = ops[1]?.operands[0] as { kind: string; entries: ReadonlyMap<string, PdfValue> };
    expect(dict.kind).toBe("dict");
    expect(dict.entries.get("W")).toEqual({ kind: "number", value: 2 });
  });

  it("does not stop at an EI that is INSIDE the binary data", () => {
    // « EI » glued to other bytes is not the end marker: §8.9.7 ends the data at a WHITE SPACE then `EI` then a
    // separator. Four data bytes here spell `xEIy`, which a naive scan would cut in the middle.
    const ops = opsOf(`BI /W 2 /H 1 /BPC 8 /CS /G ID xEIy EI Q`);
    expect(ops.map((entry) => entry.op)).toEqual(["BI", "Q"]);
  });

  it("refuses an inline image whose data never ends", () => {
    expect(refusalOf(() => opsOf("BI /W 2 /H 2 /BPC 8 /CS /G ID 0000")).reason).toBe("inline-image");
  });

  it("reads an inline image whose ID is followed by CR LF and that declares its /L", () => {
    // The reader's only tolerance: CR LF counts as ONE separator. Without it, the declared end falls one
    // byte too early and the page is refused (finding of the review of 31/10/2026).
    const ops = opsOf(`BI /W 2 /H 1 /BPC 8 /CS /G /L 4 ID\r\nabcd EI Q`);
    expect(ops.map((entry) => entry.op)).toEqual(["BI", "Q"]);
  });

  it("refuses an operator longer than the lexer's token ceiling", () => {
    expect(refusalOf(() => opsOf(`BT ${"Z".repeat(MAX_TOKEN_BYTES + 1)} ET`)).reason).toBe("token-too-long");
  });

  it("refuses an inline image with no ID", () => {
    expect(refusalOf(() => opsOf("BI /W 2 /H 2 EI")).reason).toBe("inline-image");
  });
});

describe("readContentOps: refusals, never a crash", () => {
  it("refuses a string that is never closed", () => {
    expect(refusalOf(() => opsOf("(unterminated")).reason).toBe("truncated");
  });

  it("refuses a stream of more than MAX_CONTENT_OPS operators", () => {
    // The same number as the product's ceiling, so that the two readers refuse the same page
    // (`PDF_MAX_OPS_PER_PAGE`, in the application).
    expect(refusalOf(() => opsOf("n ".repeat(MAX_CONTENT_OPS + 1))).reason).toBe("content-too-long");
  });

  it("refuses a stream that would RETAIN more than MAX_CONTENT_NODES, under the operator ceiling", () => {
    // 🔴 This test tells the TWO ceilings apart: 700 000 operators are far below MAX_CONTENT_OPS, but
    // each carries two operands, hence 2.1 million retained nodes. It is the memory that this ceiling bounds, and
    // the operators ceiling does not see it.
    const ops = Math.ceil((MAX_CONTENT_NODES + 100_000) / 3);
    expect(ops).toBeLessThan(MAX_CONTENT_OPS);
    expect(refusalOf(() => opsOf("1 1 n ".repeat(ops))).reason).toBe("content-too-long");
  });

  it("refuses an inline image whose dictionary carries more than MAX_INLINE_IMAGE_ENTRIES keys", () => {
    // §8.9.7 Table 93 names twelve keys. A `BI` cost ONE node whatever its dictionary, so 64 MB of
    // `/Aaaaaa 0` passed under both ceilings while retaining millions of Map entries (security review of
    // 31/10/2026).
    const keys = Array.from({ length: MAX_INLINE_IMAGE_ENTRIES + 1 }, (_, i) => `/K${i} 0`).join(" ");
    expect(refusalOf(() => opsOf(`BI ${keys} ID x EI`)).reason).toBe("inline-image");
  });

  it("counts the nodes an inline image dictionary retains against MAX_CONTENT_NODES", () => {
    // The dictionary fits under the ENTRIES ceiling, and each array fits under `MAX_VALUE_NODES`: it is
    // the nodes of the whole that are counted, not the number of keys nor a value taken on its own.
    const each = Math.floor(MAX_VALUE_NODES * 0.9);
    const array = `[${"1 ".repeat(each)}]`;
    expect(each * 3).toBeGreaterThan(MAX_CONTENT_NODES);
    expect(refusalOf(() => opsOf(`BI /A ${array} /B ${array} /C ${array} ID x EI`)).reason).toBe("content-too-long");
  });

  it("refuses more operands than any operator takes", () => {
    expect(refusalOf(() => opsOf(`${"1 ".repeat(200)}Tj`)).reason).toBe("content-operands");
  });

  it("refuses a lone container closer", () => {
    expect(refusalOf(() => opsOf("] Tj")).reason).toBe("content-syntax");
  });
});
