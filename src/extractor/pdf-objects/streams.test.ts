/**
 * Slice A3 of the object reader (docs/CONCEPTION-LECTEUR-OBJETS-PDF.md): stream DECODING (FlateDecode and the PNG
 * predictors), cross-reference STREAMS and OBJECT streams. ISO 32000-1:2008 §7.4.4 (FlateDecode, predictors),
 * §7.5.7 (object streams), §7.5.8 (cross-reference streams) —
 * https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf
 * Tests only, written before any product code. The contract fixed here:
 *   decodeStream(bytes, stream, resolve?) -> Uint8Array          (FlateDecode only; any other filter is refused)
 *   readObjectStream(bytes, stream, decode) -> { numbers, valueOf(num) }
 *   readXref(bytes) also accepts a cross-reference STREAM where a table would be, and a hybrid `XRefStm`.
 * Every failure is a PdfObjectsRefusal, nothing else.
 */
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import type { PdfStream, PdfValue } from "./objects";
import { parseValue } from "./parse";
import { PdfObjectsRefusal } from "./refusal";
import { MAX_DECODED_STREAM_BYTES, MAX_FILTER_CHAIN, MAX_OBJECT_STREAM_MEMBERS } from "./bounds";
import { encodeChain, lzwEncode, pngPredict, type FilterStep } from "./stream-encoders.test.support";
import { decodeStream, decodeToImageFilter, readObjectStream, type DecodeStream } from "./streams";
import { Choices } from "./pdf-syntax-writer.test.support";
import { readXref } from "./xref";

const enc = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "latin1"));
const latin1 = (b: Uint8Array | Buffer): string => Buffer.from(b).toString("latin1");
const deflate = (s: string): string => latin1(deflateSync(Buffer.from(s, "latin1")));

function refusalOf(fn: () => unknown): PdfObjectsRefusal {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PdfObjectsRefusal);
    return error as PdfObjectsRefusal;
  }
  throw new Error("expected a PdfObjectsRefusal, nothing was thrown");
}

/** `N 0 obj << dict >> stream … endstream endobj`, and the parsed stream it holds. */
function streamObject(dict: string, data: string): { bytes: Uint8Array; stream: PdfStream } {
  const body = `1 0 obj\n<< ${dict} /Length ${data.length} >>\nstream\n${data}\nendstream\nendobj\n`;
  const bytes = enc(body);
  const { value } = parseValue(bytes, body.indexOf("<<"));
  // `parseValue` stops at the dictionary; the stream is read by `parseIndirectObject`. Build the shape by hand so
  // that this test fixes only the decoding contract.
  if (value.kind !== "dict") throw new Error("fixture is not a dictionary");
  const start = body.indexOf("stream\n") + "stream\n".length;
  return { bytes, stream: { kind: "stream", dict: value.entries, start, length: data.length } };
}

/** §7.5.4: one entry of a classic cross-reference table, ten digits of offset and five of generation. */
const entry = (offset: number, gen: number, type: "n" | "f"): string =>
  `${String(offset).padStart(10, "0")} ${String(gen).padStart(5, "0")} ${type}\r\n`;

/** Big-endian unsigned integer on `width` bytes, as latin1 text. */
function be(value: number, width: number): string {
  let out = "";
  for (let i = width - 1; i >= 0; i -= 1) out += String.fromCharCode((value >>> (8 * i)) & 0xff);
  return out;
}

describe("decodeStream: FlateDecode (7.4.4)", () => {
  it("inflates a flate stream", () => {
    const { bytes, stream } = streamObject("/Filter /FlateDecode", deflate("hello PDF"));
    expect(latin1(decodeStream(bytes, stream))).toBe("hello PDF");
  });

  it("accepts the filter written as a one-element array", () => {
    const { bytes, stream } = streamObject("/Filter [/FlateDecode]", deflate("in an array"));
    expect(latin1(decodeStream(bytes, stream))).toBe("in an array");
  });

  it("gives the raw bytes back when there is no filter", () => {
    const { bytes, stream } = streamObject("", "plain bytes");
    expect(latin1(decodeStream(bytes, stream))).toBe("plain bytes");
  });

  it("undoes a PNG Up predictor (7.4.4.4)", () => {
    // Two rows of three bytes. Row 1 filter 0 (None): 10 20 30. Row 2 filter 2 (Up): +1 +1 +1 → 11 21 31.
    const filtered = `${String.fromCharCode(0, 10, 20, 30)}${String.fromCharCode(2, 1, 1, 1)}`;
    const { bytes, stream } = streamObject(
      "/Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 3 >>",
      deflate(filtered),
    );
    expect([...decodeStream(bytes, stream)]).toEqual([10, 20, 30, 11, 21, 31]);
  });

  it("refuses a filter chain longer than MAX_FILTER_CHAIN", () => {
    // Security review of 31/10/2026: a `/Filter` of a hundred thousand names fits in half a megabyte, and the choice of
    // parameters was redone for EVERY filter — quadratic cost, one buffer allocated per filter.
    const names = Array.from({ length: MAX_FILTER_CHAIN + 1 }, () => "/ASCIIHexDecode").join(" ");
    const { bytes, stream } = streamObject(`/Filter [${names}]`, "41>");
    expect(refusalOf(() => decodeStream(bytes, stream)).reason).toBe("filter-unsupported");
  });

  it("ne refabrique pas sa table à chaque code de remise à zéro LZW", () => {
    // A COST guard, not a verdict: a stream that only emits code 256 outputs NOTHING, so the output
    // ceiling can never bite. Before, every nine-bit code rebuilt 258 typed arrays: a
    // megabyte of 256 codes cost 2.4 × 10⁸ allocations. Here, a thousand 256 codes followed by an end of data, and
    // the test stays within its time budget because the base table is shared.
    const clears = 1000;
    const bits = "100000000".repeat(clears) + "100000001";
    const padded = bits.padEnd(Math.ceil(bits.length / 8) * 8, "0");
    let encoded = "";
    for (let at = 0; at < padded.length; at += 8)
      encoded += String.fromCharCode(Number.parseInt(padded.slice(at, at + 8), 2));
    const { bytes, stream } = streamObject("/Filter /LZWDecode", encoded);
    expect(decodeStream(bytes, stream)).toHaveLength(0);
  });

  it("refuses an IMAGE filter: those bytes are pixels, not structure", () => {
    const { bytes, stream } = streamObject("/Filter /DCTDecode", "whatever");
    expect(refusalOf(() => decodeStream(bytes, stream)).reason).toBe("filter-unsupported");
  });

  it("undoes an ASCIIHexDecode (7.4.2)", () => {
    const { bytes, stream } = streamObject("/Filter /ASCIIHexDecode", "48656c6C6f>");
    expect(latin1(decodeStream(bytes, stream))).toBe("Hello");
  });

  it("undoes an ASCIIHexDecode with an odd number of digits (7.4.2: the last is padded with 0)", () => {
    const { bytes, stream } = streamObject("/Filter /ASCIIHexDecode", "4 1 4>");
    expect([...decodeStream(bytes, stream)]).toEqual([0x41, 0x40]);
  });

  it("undoes an ASCII85Decode (7.4.3)", () => {
    // Fifteen base-85 characters = three groups = twelve bytes, and `~>` closes the data.
    const { bytes, stream } = streamObject("/Filter /ASCII85Decode", '87cURD]i,"Ebo80~>');
    expect(latin1(decodeStream(bytes, stream))).toBe("Hello World!");
  });

  it("undoes an ASCII85Decode z shortcut (four zero bytes)", () => {
    const { bytes, stream } = streamObject("/Filter /ASCII85Decode", "z~>");
    expect([...decodeStream(bytes, stream)]).toEqual([0, 0, 0, 0]);
  });

  it("undoes a RunLengthDecode (7.4.5)", () => {
    // 2 → three literal bytes; 254 → the next byte repeated 3 times; 128 → end of data.
    const run = String.fromCharCode(2, 0x41, 0x42, 0x43, 254, 0x5a, 128);
    const { bytes, stream } = streamObject("/Filter /RunLengthDecode", run);
    expect(latin1(decodeStream(bytes, stream))).toBe("ABCZZZ");
  });

  it("undoes an LZWDecode (7.4.4.2)", () => {
    // THE CLAUSE'S OWN EXAMPLE, Table 10: the code sequence 256 (clear) 45 258 65 259 66 257 (end), nine bits
    // each, packed by hand here — a SECOND, independent construction, since the encoder is not ours. Its input,
    // which the decoder must give back, is `45 45 45 65 45 45 65 66` (the third code stands for `45 45`, the
    // fifth for `45 45 65`): writing `45 45 45 65 65 65 66 66 66` from memory made this test fail, and the
    // decoder was right (31/10/2026).
    const encoded = String.fromCharCode(0x80, 0x0b, 0x60, 0x44, 0x18, 0x19, 0x0a, 0x02);
    const { bytes, stream } = streamObject("/Filter /LZWDecode", encoded);
    expect([...decodeStream(bytes, stream)]).toEqual([45, 45, 45, 65, 45, 45, 65, 66]);
  });

  it("undoes LZW under its abbreviation `/LZW` (§8.9.7 Table 94; decision of 24/11/2026)", () => {
    const text = "abababababcabcabcabcd";
    const encoded = latin1(lzwEncode(enc(text), 1, new Choices([7, 3, 11])));
    const { bytes, stream } = streamObject("/Filter /LZW", encoded);
    expect(latin1(decodeStream(bytes, stream))).toBe(text);
  });

  describe("a single DecodeParms dictionary on a chain goes to the filter that takes a predictor (7.4.4.4)", () => {
    // Two rows of three bytes, whole rows for `/Columns 3`.
    const plain = Uint8Array.from([10, 20, 30, 11, 21, 31]);
    const parms = "/DecodeParms << /Predictor 12 /Columns 3 >>";
    // The abbreviations of §8.9.7 Table 94 must behave exactly like the full names.
    for (const last of ["FlateDecode", "Fl", "LZWDecode", "LZW"] as const) {
      const steps: FilterStep[] = [{ filter: "A85" }, { filter: last }];
      const choices = new Choices([5, 2, 9]);
      const body = latin1(encodeChain(pngPredict(plain, 3, 1, choices), steps, choices));
      const dict = `/Filter [/A85 /${last}] ${parms}`;

      it(`decodeStream undoes the predictor of a chain ending in /${last}`, () => {
        const { bytes, stream } = streamObject(dict, body);
        expect([...decodeStream(bytes, stream)]).toEqual([...plain]);
      });

      it(`decodeToImageFilter undoes the predictor of a chain ending in /${last}`, () => {
        const { bytes, stream } = streamObject(dict, body);
        const raw = bytes.subarray(stream.start, stream.start + stream.length);
        expect([...decodeToImageFilter(raw, stream.dict).data]).toEqual([...plain]);
      });
    }
  });

  it("applies a CHAIN of filters in order (7.4: the first one named is the first applied)", () => {
    const flate = latin1(deflateSync(Buffer.from("chained", "latin1")));
    const hex = [...flate].map((char) => char.charCodeAt(0).toString(16).padStart(2, "0")).join("");
    const { bytes, stream } = streamObject("/Filter [/ASCIIHexDecode /FlateDecode]", `${hex}>`);
    expect(latin1(decodeStream(bytes, stream))).toBe("chained");
  });

  it("takes DecodeParms as an ARRAY, one per filter (7.4, Table 5)", () => {
    const filtered = `${String.fromCharCode(0, 10, 20, 30)}${String.fromCharCode(2, 1, 1, 1)}`;
    const { bytes, stream } = streamObject(
      "/Filter [/FlateDecode] /DecodeParms [<< /Predictor 12 /Columns 3 >>]",
      deflate(filtered),
    );
    expect([...decodeStream(bytes, stream)]).toEqual([10, 20, 30, 11, 21, 31]);
  });

  it("takes a null in a DecodeParms array as « no parameter »", () => {
    const { bytes, stream } = streamObject("/Filter [/FlateDecode] /DecodeParms [null]", deflate("no parms"));
    expect(latin1(decodeStream(bytes, stream))).toBe("no parms");
  });

  it("refuses a TIFF predictor (not implemented, and not a silent pass-through)", () => {
    const { bytes, stream } = streamObject(
      "/Filter /FlateDecode /DecodeParms << /Predictor 2 /Columns 3 >>",
      deflate("abc"),
    );
    expect(refusalOf(() => decodeStream(bytes, stream)).reason).toBe("predictor");
  });

  it("refuses bytes that are not deflate at all", () => {
    const { bytes, stream } = streamObject("/Filter /FlateDecode", "not deflate data");
    expect(refusalOf(() => decodeStream(bytes, stream)).reason).toBe("stream-decode");
  });

  it("refuses a filter name that only exists on Object.prototype", () => {
    for (const name of ["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty"]) {
      const { bytes, stream } = streamObject(`/Filter /${name}`, "whatever");
      expect(refusalOf(() => decodeStream(bytes, stream)).reason).toBe("filter-unsupported");
    }
  });

  // This test was called "refuses an array DecodeParms" until 31/10/2026 and did not exercise it: the array
  // has been accepted since, and the refusal comes from the row arithmetic (3 decoded bytes, stride + 1 = 4).
  it("refuses a predictor whose rows do not fill the decoded data", () => {
    const { bytes, stream } = streamObject(
      "/Filter /FlateDecode /DecodeParms [<< /Predictor 12 /Columns 3 >>]",
      deflate("abc"),
    );
    expect(refusalOf(() => decodeStream(bytes, stream)).reason).toBe("predictor");
  });
});

describe("readObjectStream: compressed objects (7.5.7)", () => {
  /** An object stream holding `/Type /ObjStm`, two members: object 4 then object 5. */
  function objStm(): { bytes: Uint8Array; stream: PdfStream } {
    const members = "<< /Kind /First >> 42";
    const pairs = "4 0 5 19 ";
    const data = deflate(`${pairs}${members}`);
    return streamObject(`/Type /ObjStm /N 2 /First ${pairs.length} /Filter /FlateDecode`, data);
  }

  it("lists the object numbers it holds, in the order the pairs give", () => {
    const { bytes, stream } = objStm();
    expect([...readObjectStream(bytes, stream, decodeStream).numbers]).toEqual([4, 5]);
  });

  it("reads a member's value at its own offset", () => {
    const { bytes, stream } = objStm();
    const members = readObjectStream(bytes, stream, decodeStream);
    const first: PdfValue | undefined = members.valueOf(4)?.value;
    expect(first?.kind).toBe("dict");
    expect(members.valueOf(5)?.value).toEqual({ kind: "number", value: 42 });
  });

  it("DIT COMBIEN DE NŒUDS le membre fait retenir, pas seulement sa valeur", () => {
    // 🔴 Security review of 31/10/2026: `valueOf` dropped the parse's node count, so the
    // COMPRESSED path — the cheapest for an attacker — only paid for its source bytes. Ten members each carrying
    // a million nodes fit in a few compressed kilobytes and retained ~480 MB for a 20 MB
    // budget. The count must cross.
    const members = "[1 1 1 1] 42";
    const pairs = "4 0 5 10 ";
    const { bytes, stream } = streamObject(
      `/Type /ObjStm /N 2 /First ${pairs.length} /Filter /FlateDecode`,
      deflate(`${pairs}${members}`),
    );
    const read = readObjectStream(bytes, stream, decodeStream);
    expect(read.valueOf(4)?.nodes).toBeGreaterThanOrEqual(4);
    expect(read.valueOf(5)?.nodes).toBe(1);
  });

  it("gives nothing for an object it does not hold", () => {
    const { bytes, stream } = objStm();
    expect(readObjectStream(bytes, stream, decodeStream).valueOf(9)).toBeUndefined();
  });

  it("refuses an N bigger than the data can hold", () => {
    const { bytes, stream } = streamObject("/Type /ObjStm /N 9999 /First 4 /Filter /FlateDecode", deflate("1 0 "));
    expect(refusalOf(() => readObjectStream(bytes, stream, decodeStream)).reason).toBe("object-stream");
  });

  it("refuses an /N over MAX_OBJECT_STREAM_MEMBERS WITHOUT decompressing anything", () => {
    // The guard is not seen in its refusal — without it, the pairs are missing and the refusal is the same. It is seen
    // in this: it refuses BEFORE decompressing. The decoder passed here therefore fails the test if it is
    // called, and that is the only way to see it bite (31/10/2026).
    const { bytes, stream } = streamObject(`/Type /ObjStm /N ${MAX_OBJECT_STREAM_MEMBERS + 1} /First 4`, "1 0 ");
    const refuse: DecodeStream = () => {
      throw new Error("le flux a été décompressé alors que son /N était déjà hors borne");
    };
    expect(refusalOf(() => readObjectStream(bytes, stream, refuse)).reason).toBe("object-stream");
  });

  it("refuses a stream that would decode past MAX_DECODED_STREAM_BYTES", () => {
    // §7.4.5: a length byte of 129 emits 128 copies, so two input bytes yield 128. A megabyte
    // of input thus exceeds the 64 MB ceiling, and the buffer refuses before reaching it.
    const run = String.fromCharCode(129, 0x41).repeat(Math.ceil(MAX_DECODED_STREAM_BYTES / 128) + 1);
    const { bytes, stream } = streamObject("/Filter /RunLengthDecode", run);
    expect(refusalOf(() => decodeStream(bytes, stream)).reason).toBe("stream-decode");
  });

  it("refuses a First outside the decoded data", () => {
    const { bytes, stream } = streamObject("/Type /ObjStm /N 1 /First 999 /Filter /FlateDecode", deflate("4 0 << >>"));
    expect(refusalOf(() => readObjectStream(bytes, stream, decodeStream)).reason).toBe("object-stream");
  });

  it("refuses a pair that is not two integers", () => {
    const { bytes, stream } = streamObject("/Type /ObjStm /N 1 /First 6 /Filter /FlateDecode", deflate("4 /x  << >>"));
    expect(refusalOf(() => readObjectStream(bytes, stream, decodeStream)).reason).toBe("object-stream");
  });
});

describe("readXref: a cross-reference STREAM where a table would be (7.5.8)", () => {
  /** A file whose only cross-reference section is a stream: object 1 free, object 2 at 9, object 3 in stream 2. */
  function fileWithXrefStream(extraDict = ""): Uint8Array {
    const rows = [
      `${be(0, 1)}${be(0, 2)}${be(65_535, 2)}`,
      `${be(1, 1)}${be(9, 2)}${be(0, 2)}`,
      `${be(2, 1)}${be(2, 2)}${be(7, 2)}`,
    ].join("");
    const data = deflate(rows);
    const head = "%PDF-1.5\n";
    const object = `4 0 obj\n<< /Type /XRef /Size 4 /W [1 2 2] /Index [1 3] /Root 1 0 R ${extraDict} /Filter /FlateDecode /Length ${data.length} >>\nstream\n${data}\nendstream\nendobj\n`;
    return enc(`${head}${object}startxref\n${head.length}\n%%EOF\n`);
  }

  it("reads an offset entry (type 1)", () => {
    expect(readXref(fileWithXrefStream()).entries.get(2)).toEqual({ kind: "offset", offset: 9, gen: 0 });
  });

  it("reads a compressed entry (type 2) as its container and index", () => {
    expect(readXref(fileWithXrefStream()).entries.get(3)).toEqual({ kind: "compressed", container: 2, index: 7 });
  });

  it("leaves a free entry (type 0) out", () => {
    expect(readXref(fileWithXrefStream()).entries.has(1)).toBe(false);
  });

  it("takes the stream's own dictionary as the trailer", () => {
    expect(readXref(fileWithXrefStream()).trailer.get("Root")).toEqual({ kind: "ref", num: 1, gen: 0 });
  });

  it("CHARGE ses octets décompressés au budget du document (revue sécurité du 31/10/2026)", () => {
    // 🔴 `MAX_DOCUMENT_BYTES` claimed to bound "a chain of 64 sections decompressing 64 MB each". It did not
    // bound it: `readXref` runs BEFORE the document budget exists, and `readStreamSection` called
    // `decodeStream` directly. With `/W [1 1 1] /Index [0 1]`, the post-decompression check
    // (`total * rowBytes > data.length`) passes whatever the size of the stream, so each of the 64 sections
    // could inflate 64 MB — about 4 GB, without a single byte being counted, from a 4 MB file.
    const spent: number[] = [];
    const spend = (n: number): void => {
      spent.push(n);
    };
    readXref(fileWithXrefStream(), spend);
    expect(spent.reduce((sum, n) => sum + n, 0)).toBeGreaterThan(0);
  });

  it("refuses when ses octets décompressés dépassent le budget qu'on lui donne", () => {
    const spend = (): void => {
      throw new PdfObjectsRefusal("document-too-large");
    };
    expect(refusalOf(() => readXref(fileWithXrefStream(), spend)).reason).toBe("document-too-large");
  });

  it("refuses a W that is not three widths of a sane size", () => {
    const head = "%PDF-1.5\n";
    const object = `4 0 obj\n<< /Type /XRef /Size 4 /W [1 99 2] /Length 0 >>\nstream\n\nendstream\nendobj\n`;
    const bytes = enc(`${head}${object}startxref\n${head.length}\n%%EOF\n`);
    expect(refusalOf(() => readXref(bytes)).reason).toBe("xref-stream");
  });

  it("HYBRID FILE (7.5.8.4): the /XRefStm supplies what the classic table marks FREE", () => {
    // That is the WHOLE point of the entry: the table says "free" so that a 1.4 reader ignores the object, and the
    // stream says where it really is. A "first wins" merge therefore made the support dead (review of
    // 31/10/2026), and none of the 304 files measured could tell: the corpus has no hybrid file.
    const head = "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n";
    const rows = `${be(2, 1)}${be(7, 2)}${be(3, 2)}`; // object 4: compressed in container 7, index 3
    const streamObj = `5 0 obj\n<< /Type /XRef /Size 5 /Index [4 1] /W [1 2 2] /Length ${rows.length} >>\nstream\n${rows}\nendstream\nendobj\n`;
    const streamAt = head.length;
    const upTo = `${head}${streamObj}`;
    const tableAt = upTo.length;
    const table = `xref\n0 5\n${entry(0, 65_535, "f")}${entry(9, 0, "n")}${entry(0, 0, "f")}${entry(0, 0, "f")}${entry(0, 0, "f")}trailer\n<< /Size 5 /Root 1 0 R /XRefStm ${streamAt} >>\n`;
    const bytes = enc(`${upTo}${table}startxref\n${tableAt}\n%%EOF\n`);

    expect(readXref(bytes).entries.get(4)).toEqual({ kind: "compressed", container: 7, index: 3 });
    // And what the TABLE places wins: object 1 stays at the offset it gives.
    expect(readXref(bytes).entries.get(1)).toEqual({ kind: "offset", offset: 9, gen: 0 });
  });

  it("refuses an object at that offset that is not a cross-reference stream", () => {
    const head = "%PDF-1.5\n";
    const object = `4 0 obj\n<< /Type /Page >>\nendobj\n`;
    const bytes = enc(`${head}${object}startxref\n${head.length}\n%%EOF\n`);
    expect(refusalOf(() => readXref(bytes)).reason).toBe("xref-offset");
  });
});
