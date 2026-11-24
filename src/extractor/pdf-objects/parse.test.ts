/**
 * Slice A1 of the object reader: lexer and objects, ISO 32000-1:2008
 * clauses 7.2-7.3 (https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf).
 * Tests only, written before any product code. The contract fixed here:
 *   parseValue(bytes, offset)  -> { value, end }                (end = offset just past the value)
 *   parseIndirectObject(bytes, offset, resolveLength) -> { num, gen, value, end }
 *     (end = offset just past `endobj`; a stream's `start` is its first data byte, `length` its byte count)
 *   Every failure is a PdfObjectsRefusal, nothing else (no RangeError, no TypeError).
 * A dictionary entry whose value is null is OMITTED from the map (7.3.7 and 7.3.9); in an array null stays.
 * Refusal: `new PdfObjectsRefusal(reason, objectNumber?)`, fields `reason` and `objectNumber`, code EXTRACT_FAILED,
 * message `pdf-objects: <reason>` or `pdf-objects: <reason> (object N)`.
 */
import { describe, expect, it } from "vitest";

import { ReaderError } from "doc-ir";
import { MAX_NAME_BYTES, MAX_NESTING_DEPTH, MAX_STRING_BYTES, MAX_TOKEN_BYTES } from "./bounds";
import type { PdfValue } from "./objects";
import { parseIndirectObject, parseValue } from "./parse";
import { PdfObjectsRefusal } from "./refusal";

const enc = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "latin1"));
const val = (s: string): PdfValue => parseValue(enc(s), 0).value;
const bytesOf = (v: PdfValue): number[] => {
  if (v.kind !== "string") throw new Error(`expected a string, got ${v.kind}`);
  return [...v.bytes];
};
const num = (n: number): PdfValue => ({ kind: "number", value: n });
const name = (s: string): PdfValue => ({ kind: "name", value: s });

function refusalOf(fn: () => unknown): PdfObjectsRefusal {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PdfObjectsRefusal);
    return error as PdfObjectsRefusal;
  }
  throw new Error("expected a PdfObjectsRefusal, nothing was thrown");
}
const noLength = (): number | undefined => undefined;

describe("§7.2.2 white-space characters (Table 1) and §7.2.3 comments", () => {
  it("treats NUL, HT, LF, FF, CR and SP (Table 1) as separators between tokens", () => {
    expect(val("[1\x002\t3\n4\x0c5\r6 7]")).toEqual({ kind: "array", items: [1, 2, 3, 4, 5, 6, 7].map(num) });
  });
  it("skips leading white space and reports the end just past the value", () => {
    const r = parseValue(enc(" \r\n\t  42 tail"), 0);
    expect(r.value).toEqual(num(42));
    expect(r.end).toBe(enc(" \r\n\t  42").length);
  });
  it("starts reading at the given offset", () => {
    expect(parseValue(enc("XXXX 7"), 4).value).toEqual(num(7));
  });
  it("§7.2.3 ignores a comment up to the end of line, delimiters included, and a comment separates tokens (abc%...\\n123)", () => {
    expect(val("[ 1 % ( /% ) blah ] >>\n 2 ]")).toEqual({ kind: "array", items: [num(1), num(2)] });
    expect(val("[ 1%c\r2%c\n3 ]")).toEqual({ kind: "array", items: [num(1), num(2), num(3)] });
  });
  it("§7.2.3 a comment hides the end of a nested structure", () => {
    expect(val("[ 1 %]\n ]")).toEqual({ kind: "array", items: [num(1)] });
  });
  it("§7.2.3 a comment is NOT started by a percent sign inside a string", () => {
    expect(bytesOf(val("(a%b)"))).toEqual([0x61, 0x25, 0x62]);
  });
});

describe("§7.3.2 booleans, §7.3.9 null", () => {
  it("reads true and false", () => {
    expect(val("true")).toEqual({ kind: "bool", value: true });
    expect(val("false")).toEqual({ kind: "bool", value: false });
  });
  it("§7.3.2 keywords are case-sensitive (§7.2.2: PDF is case-sensitive): True is refused", () => {
    expect(refusalOf(() => val("True")).reason).toBe("syntax");
  });
  it("§7.3.9 reads null", () => {
    expect(val("null")).toEqual({ kind: "null" });
  });
  it("§7.3.9 a null entry in a dictionary is omitted, as if the entry did not exist; in an array null stays", () => {
    const d = val("<< /A null /B 1 >>");
    expect(d.kind === "dict" && [...d.entries.keys()]).toEqual(["B"]);
    expect(val("[null 1]")).toEqual({ kind: "array", items: [{ kind: "null" }, num(1)] });
  });
  it("§7.2.2 a keyword ends at a delimiter: [true]", () => {
    expect(val("[true]")).toEqual({ kind: "array", items: [{ kind: "bool", value: true }] });
  });
  it("§7.2.2 an unknown bare word is refused (syntax)", () => {
    expect(refusalOf(() => val("trues")).reason).toBe("syntax");
  });
});

describe("§7.3.3 numeric objects", () => {
  it.each([
    ["123", 123],
    ["43445", 43445],
    ["+17", 17],
    ["-98", -98],
    ["0", 0],
    ["34.5", 34.5],
    ["-3.62", -3.62],
    ["+123.6", 123.6],
    ["4.", 4],
    ["-.002", -0.002],
    ["+.5", 0.5],
    ["0.0", 0],
  ])("reads %s as %d (examples 1 and 2 of §7.3.3, plus +.5)", (text, expected) => {
    expect(val(text)).toEqual(num(expected));
  });
  it("§7.3.3 a number ends at a delimiter or white space", () => {
    expect(val("[1/N 2(a)3<41>4]")).toEqual({
      kind: "array",
      items: [
        num(1),
        name("N"),
        num(2),
        { kind: "string", bytes: enc("a") },
        num(3),
        { kind: "string", bytes: enc("A") },
        num(4),
      ],
    });
  });
  it.each(["16#FFFE", "6.02E23", "1e5", "--5", "1.2.3", "+", "-", ".", "12abc"])(
    "§7.3.3 NOTE 1: %s (radix, exponent or malformed) is refused (syntax)",
    (text) => {
      expect(refusalOf(() => val(text)).reason).toBe("syntax");
    },
  );
  it("Annex C Table C.1: the largest integer 2147483647 and the smallest -2147483648 read exactly", () => {
    expect(val("2147483647")).toEqual(num(2147483647));
    expect(val("-2147483648")).toEqual(num(-2147483648));
  });
});

describe("§7.3.4.2 literal strings (Table 3)", () => {
  it("reads a plain string and the empty string", () => {
    expect(bytesOf(val("( This is a string )"))).toEqual([...enc(" This is a string ")]);
    expect(bytesOf(val("()"))).toEqual([]);
  });
  it("keeps balanced parentheses unescaped (example: Strings may contain balanced parentheses ( ) )", () => {
    expect(bytesOf(val("(a (b (c)) d)"))).toEqual([...enc("a (b (c)) d")]);
  });
  it("Table 3: \\n \\r \\t \\b \\f \\( \\) \\\\ give LF CR HT BS FF ( ) \\", () => {
    expect(bytesOf(val("(\\n\\r\\t\\b\\f\\(\\)\\\\)"))).toEqual([0x0a, 0x0d, 0x09, 0x08, 0x0c, 0x28, 0x29, 0x5c]);
  });
  it("Table 3: an escaped parenthesis does not count for the balance", () => {
    expect(bytesOf(val("(a\\)b\\(c)"))).toEqual([...enc("a)b(c")]);
  });
  it("§7.3.4.2: a backslash before any other character is ignored (\\q gives q)", () => {
    expect(bytesOf(val("(a\\qb)"))).toEqual([...enc("aqb")]);
  });
  it("Table 3 and example 4: \\ddd octal with three digits (\\245 \\307)", () => {
    const b = bytesOf(val("(\\245two octal characters\\307)"));
    expect(b.at(0)).toBe(0xa5);
    expect(b.at(-1)).toBe(0xc7);
  });
  it("example 5: ( \\0053 ) is Control-E then 3; ( \\053 ) and ( \\53 ) are one plus sign", () => {
    expect(bytesOf(val("(\\0053)"))).toEqual([0x05, 0x33]);
    expect(bytesOf(val("(\\053)"))).toEqual([0x2b]);
    expect(bytesOf(val("(\\53)"))).toEqual([0x2b]);
  });
  it("§7.3.4.2: an octal escape stops at a non-octal digit (\\18 is 01 then 8)", () => {
    expect(bytesOf(val("(\\18)"))).toEqual([0x01, 0x38]);
  });
  it("§7.3.4.2: high-order overflow of \\ddd is ignored (\\777 keeps the low 8 bits)", () => {
    expect(bytesOf(val("(\\777)"))).toEqual([0xff]);
  });
  it("§7.3.4.2 example 2: backslash at the end of a line continues the string (LF, CR and CRLF all disregarded)", () => {
    expect(bytesOf(val("(These \\\ntwo strings)"))).toEqual([...enc("These two strings")]);
    expect(bytesOf(val("(These \\\rtwo strings)"))).toEqual([...enc("These two strings")]);
    expect(bytesOf(val("(These \\\r\ntwo strings)"))).toEqual([...enc("These two strings")]);
  });
  it("§7.3.4.2: a bare end-of-line inside a string is byte 0Ah whether CR, LF or CRLF", () => {
    expect(bytesOf(val("(a\rb)"))).toEqual([0x61, 0x0a, 0x62]);
    expect(bytesOf(val("(a\nb)"))).toEqual([0x61, 0x0a, 0x62]);
    expect(bytesOf(val("(a\r\nb)"))).toEqual([0x61, 0x0a, 0x62]);
    expect(bytesOf(val("(a\n\rb)"))).toEqual([0x61, 0x0a, 0x0a, 0x62]);
  });
  it("§7.3.4.2: any 8-bit value stands for itself", () => {
    const raw = new Uint8Array([0x28, 0xff, 0x00, 0x80, 0x29]);
    expect(bytesOf(parseValue(raw, 0).value)).toEqual([0xff, 0x00, 0x80]);
  });
});

describe("§7.3.4.3 hexadecimal strings", () => {
  it("example 1: <4E6F762073686D6F7A206B6120706F702E> reads 'Nov shmoz ka pop.'", () => {
    expect(bytesOf(val("<4E6F762073686D6F7A206B6120706F702E>"))).toEqual([...enc("Nov shmoz ka pop.")]);
  });
  it("ignores white space between digits (SP HT CR LF FF) and accepts both cases", () => {
    expect(bytesOf(val("< 90 1f\tA3\r\n\x0c>"))).toEqual([0x90, 0x1f, 0xa3]);
  });
  it("example 2: < 901FA > is the 3-byte string 90 1F A0 (final missing digit is 0)", () => {
    expect(bytesOf(val("< 901FA >"))).toEqual([0x90, 0x1f, 0xa0]);
  });
  it("reads <> as the empty string, and is not confused with a dictionary opener <<", () => {
    expect(bytesOf(val("<>"))).toEqual([]);
    expect(val("<< >>")).toEqual({ kind: "dict", entries: new Map() });
  });
  it("§7.3.4.3: a non-hexadecimal character inside is refused (syntax)", () => {
    expect(refusalOf(() => val("<41G2>")).reason).toBe("syntax");
  });
});

describe("§7.3.5 names (Table 4)", () => {
  it.each([
    ["/Name1", "Name1"],
    ["/ASomewhatLongerName", "ASomewhatLongerName"],
    ["/A;Name_With-Various***Characters?", "A;Name_With-Various***Characters?"],
    ["/$$", "$$"],
    ["/@pattern", "@pattern"],
    ["/lime#20Green", "lime Green"],
    ["/paired#28#29parentheses", "paired()parentheses"],
    ["/The_Key_of_F#23_Minor", "The_Key_of_F#_Minor"],
    ["/A#42", "AB"],
  ])("Table 4: %s reads %s", (text, expected) => {
    expect(val(text)).toEqual(name(expected));
  });
  it("§7.3.5: the solidus alone is the name of the empty sequence", () => {
    expect(val("/")).toEqual(name(""));
    expect(val("[/ /A]")).toEqual({ kind: "array", items: [name(""), name("A")] });
  });
  it("§7.3.5: #xx accepts upper and lower case hexadecimal digits; names are case-sensitive", () => {
    expect(val("/a#2fb")).toEqual(name("a/b"));
    expect(val("/ab")).not.toEqual(val("/Ab"));
  });
  it("§7.3.5: a name ends at white space or a delimiter", () => {
    expect(val("[/A/B(x)/C]")).toEqual({
      kind: "array",
      items: [name("A"), name("B"), { kind: "string", bytes: enc("x") }, name("C")],
    });
  });
  it("§7.3.5: a malformed #xx (non-hexadecimal or cut) is refused (syntax)", () => {
    expect(refusalOf(() => val("/A#GG")).reason).toBe("syntax");
    expect(refusalOf(() => val("/A#4")).reason).toBe("syntax");
  });
  it("§7.3.5: #00 (name with the null character) is refused (syntax)", () => {
    expect(refusalOf(() => val("/A#00B")).reason).toBe("syntax");
  });
  it("§7.3.5: bytes above 7F stay as they are (latin1 view of the byte), no UTF-8 interpretation at this level", () => {
    expect(parseValue(new Uint8Array([0x2f, 0xe9]), 0).value).toEqual(name("é"));
  });
});

describe("§7.3.6 arrays and §7.3.7 dictionaries", () => {
  it("reads the array of §7.3.6: [ 549 3.14 false ( Ralph ) /SomeName ]", () => {
    expect(val("[ 549 3.14 false ( Ralph ) /SomeName ]")).toEqual({
      kind: "array",
      items: [
        num(549),
        num(3.14),
        { kind: "bool", value: false },
        { kind: "string", bytes: enc(" Ralph ") },
        name("SomeName"),
      ],
    });
  });
  it("§7.3.6: an array may be empty and may nest arrays", () => {
    expect(val("[]")).toEqual({ kind: "array", items: [] });
    expect(val("[[1][[2]]]")).toEqual({
      kind: "array",
      items: [
        { kind: "array", items: [num(1)] },
        { kind: "array", items: [{ kind: "array", items: [num(2)] }] },
      ],
    });
  });
  it("§7.3.7: reads a dictionary with direct and nested values (example of §7.3.7, abridged)", () => {
    const v = val("<< /Type /Example /Version 0.01 /StringItem ( a string ) /Sub << /Item2 true /Last ( OK ) >> >>");
    expect(v).toEqual({
      kind: "dict",
      entries: new Map<string, PdfValue>([
        ["Type", name("Example")],
        ["Version", num(0.01)],
        ["StringItem", { kind: "string", bytes: enc(" a string ") }],
        [
          "Sub",
          {
            kind: "dict",
            entries: new Map<string, PdfValue>([
              ["Item2", { kind: "bool", value: true }],
              ["Last", { kind: "string", bytes: enc(" OK ") }],
            ]),
          },
        ],
      ]),
    });
  });
  it("§7.3.7: a dictionary may have zero entries; the order of entries is not significant", () => {
    expect(val("<<>>")).toEqual({ kind: "dict", entries: new Map() });
    expect(val("<</A 1/B 2>>")).toEqual(val("<</B 2/A 1>>"));
  });
  it("§7.3.7: a key must be a name; a number as a key is refused (syntax)", () => {
    expect(refusalOf(() => val("<< 1 2 >>")).reason).toBe("syntax");
  });
  it("§7.3.7: a key without a value is refused (syntax)", () => {
    expect(refusalOf(() => val("<< /A /B /C >>")).reason).toBe("syntax");
    expect(refusalOf(() => val("<< /A >>")).reason).toBe("syntax");
  });
  it("§7.3.7: 'Multiple entries ... shall not have the same key' says nothing of a reader's behaviour; we keep the LAST one (as pdf.js did)", () => {
    const d = val("<< /A 1 /A 2 >>");
    expect(d.kind === "dict" && d.entries.get("A")).toEqual(num(2));
    expect(d.kind === "dict" && d.entries.size).toBe(1);
  });
  it("§7.2.2: a stray closing delimiter is refused (syntax): ] and >> without an opener, or the wrong closer", () => {
    expect(refusalOf(() => val("]")).reason).toBe("syntax");
    expect(refusalOf(() => val(">>")).reason).toBe("syntax");
    expect(refusalOf(() => val("[1 >>")).reason).toBe("syntax");
    expect(refusalOf(() => val("<< /A 1 ]")).reason).toBe("syntax");
  });
  it("§7.2.2: curly braces are delimiters but no object in this slice: refused (syntax)", () => {
    expect(refusalOf(() => val("{")).reason).toBe("syntax");
  });
});

describe("§7.3.10 indirect references", () => {
  it("reads 12 0 R as a reference", () => {
    expect(val("12 0 R")).toEqual({ kind: "ref", num: 12, gen: 0 });
  });
  it("tells a reference from two plain numbers: [1 0 R] is one ref, [1 0] is two numbers, [1 0 5] is three", () => {
    expect(val("[1 0 R]")).toEqual({ kind: "array", items: [{ kind: "ref", num: 1, gen: 0 }] });
    expect(val("[1 0]")).toEqual({ kind: "array", items: [num(1), num(0)] });
    expect(val("[1 0 5]")).toEqual({ kind: "array", items: [num(1), num(0), num(5)] });
  });
  it("reads mixed references and numbers: [1 2 R 3 4 5 0 R 6]", () => {
    expect(val("[1 2 R 3 4 5 0 R 6]")).toEqual({
      kind: "array",
      items: [{ kind: "ref", num: 1, gen: 2 }, num(3), num(4), { kind: "ref", num: 5, gen: 0 }, num(6)],
    });
  });
  it("reads references as dictionary values: << /Length 8 0 R /Next 9 3 R >>", () => {
    const d = val("<< /Length 8 0 R /Next 9 3 R >>");
    expect(d.kind === "dict" && d.entries.get("Length")).toEqual({ kind: "ref", num: 8, gen: 0 });
    expect(d.kind === "dict" && d.entries.get("Next")).toEqual({ kind: "ref", num: 9, gen: 3 });
  });
  it("§7.3.10: white space between the three parts may be any run, comments included", () => {
    expect(val("12\r\n0%x\n R")).toEqual({ kind: "ref", num: 12, gen: 0 });
  });
  it("§7.3.10: R is a keyword, not a prefix: '12 0 Rx' is refused (syntax)", () => {
    expect(refusalOf(() => val("12 0 Rx")).reason).toBe("syntax");
  });
  it("§7.3.10: a reference needs a positive object number and a non-negative integer generation: 0 0 R, 1 -1 R and 1 2.5 R are not references", () => {
    expect(refusalOf(() => val("[0 0 R]")).reason).toBe("syntax");
    expect(refusalOf(() => val("[1 -1 R]")).reason).toBe("syntax");
    expect(refusalOf(() => val("[1 2.5 R]")).reason).toBe("syntax");
  });
  it("Annex C Table C.1: an object number above 8 388 607 is refused (syntax)", () => {
    expect(val("8388607 0 R")).toEqual({ kind: "ref", num: 8388607, gen: 0 });
    expect(refusalOf(() => val("8388608 0 R")).reason).toBe("syntax");
  });
});

describe("§7.3.10 indirect object definitions", () => {
  it("example 1: '12 0 obj ( Brillig ) endobj' defines object 12, generation 0, a string", () => {
    const text = "12 0 obj\n    ( Brillig )\n\nendobj";
    const r = parseIndirectObject(enc(text), 0, noLength);
    // `nodes` entered the contract on 31/10/2026: the caller needs to know HOW MANY nodes a value
    // holds in order to bound its heap (a string counts for one).
    expect(r).toEqual({
      num: 12,
      gen: 0,
      value: { kind: "string", bytes: enc(" Brillig ") },
      end: text.length,
      nodes: 1,
    });
  });
  it("a reference may be the value of an object: '5 0 obj 6 0 R endobj'", () => {
    const text = "5 0 obj 6 0 R endobj";
    const r = parseIndirectObject(enc(text), 0, noLength);
    expect(r.num).toBe(5);
    expect(r.gen).toBe(0);
    expect(r.value).toEqual({ kind: "ref", num: 6, gen: 0 });
    expect(r.end).toBe(text.length);
  });
  it("reads a non-zero generation and starts at an offset; end is just past endobj", () => {
    const text = "junk\n7 3 obj<</A 1>>endobj\ntrailing";
    const r = parseIndirectObject(enc(text), 5, noLength);
    expect([r.num, r.gen]).toEqual([7, 3]);
    expect(r.end).toBe("junk\n7 3 obj<</A 1>>endobj".length);
  });
  it("accepts a keyword glued to the value: '1 0 obj[1 2]endobj'", () => {
    expect(parseIndirectObject(enc("1 0 obj[1 2]endobj"), 0, noLength).value).toEqual({
      kind: "array",
      items: [num(1), num(2)],
    });
  });
  it("§7.3.10: a missing endobj at end of file is refused (truncated)", () => {
    expect(refusalOf(() => parseIndirectObject(enc("1 0 obj 5"), 0, noLength)).reason).toBe("truncated");
  });
  it("§7.3.10: something other than endobj after the value is refused (syntax)", () => {
    expect(refusalOf(() => parseIndirectObject(enc("1 0 obj 5 6 endobj"), 0, noLength)).reason).toBe("syntax");
  });
  it("§7.3.10: a header that is not 'num gen obj' is refused (syntax)", () => {
    expect(refusalOf(() => parseIndirectObject(enc("x 0 obj 5 endobj"), 0, noLength)).reason).toBe("syntax");
    expect(refusalOf(() => parseIndirectObject(enc("1 0 object 5 endobj"), 0, noLength)).reason).toBe("syntax");
    expect(refusalOf(() => parseIndirectObject(enc("0 0 obj 5 endobj"), 0, noLength)).reason).toBe("syntax");
    expect(refusalOf(() => parseIndirectObject(enc("1 -1 obj 5 endobj"), 0, noLength)).reason).toBe("syntax");
  });
  it("an offset past the end of the bytes, or empty input, is refused (truncated), not a RangeError", () => {
    expect(refusalOf(() => parseIndirectObject(enc("1 0 obj 5 endobj"), 999, noLength)).reason).toBe("truncated");
    expect(refusalOf(() => parseValue(enc("1"), 5)).reason).toBe("truncated");
    expect(refusalOf(() => parseValue(enc(""), 0)).reason).toBe("truncated");
  });
  it("a negative or non-integer offset is refused (syntax)", () => {
    expect(refusalOf(() => parseValue(enc("1"), -1)).reason).toBe("syntax");
    expect(refusalOf(() => parseValue(enc("1"), 0.5)).reason).toBe("syntax");
  });
});

describe("§7.3.8 streams", () => {
  const stream = (head: string, data: string, tail = "\nendstream\nendobj"): Uint8Array => enc(`${head}${data}${tail}`);

  it("§7.3.8.1/Table 5: direct Length, LF after the keyword stream: start is the first data byte", () => {
    const head = "12 0 obj\n<< /Length 5 >>\nstream\n";
    const bytes = stream(head, "HELLO");
    const r = parseIndirectObject(bytes, 0, noLength);
    expect(r.value).toEqual({ kind: "stream", dict: new Map([["Length", num(5)]]), start: head.length, length: 5 });
    expect(r.end).toBe(bytes.length);
  });
  it("§7.3.8.1: CR LF after the keyword stream is one end-of-line marker; start is after both", () => {
    const head = "12 0 obj\r\n<< /Length 5 >>\r\nstream\r\n";
    const r = parseIndirectObject(stream(head, "HELLO", "\r\nendstream\r\nendobj"), 0, noLength);
    expect(r.value).toMatchObject({ kind: "stream", start: head.length, length: 5 });
  });
  it("§7.3.8.1 NOTE 2: after stream, CR LF is the marker, so data may begin with LF (data '\\nAB', Length 3)", () => {
    const head = "1 0 obj<</Length 3>>stream\r\n";
    const r = parseIndirectObject(stream(head, "\nAB"), 0, noLength);
    expect(r.value).toMatchObject({ kind: "stream", start: head.length, length: 3 });
  });
  it("§7.3.8.1: the keyword stream followed by CR alone is not allowed: refused (syntax)", () => {
    expect(refusalOf(() => parseIndirectObject(stream("1 0 obj<</Length 2>>stream\r", "AB"), 0, noLength)).reason).toBe(
      "syntax",
    );
  });
  it("§7.3.8.1: stream followed by no end-of-line marker at all is refused (syntax)", () => {
    expect(refusalOf(() => parseIndirectObject(stream("1 0 obj<</Length 2>>stream", "AB"), 0, noLength)).reason).toBe(
      "syntax",
    );
  });
  it("§7.3.8.1: the data may contain endstream/endobj-looking text and any byte; Length alone decides", () => {
    const data = "ab\nendstream\nendobj\x00\xff";
    const head = `1 0 obj<</Length ${data.length}>>stream\n`;
    const r = parseIndirectObject(stream(head, data), 0, noLength);
    expect(r.value).toMatchObject({ kind: "stream", start: head.length, length: data.length });
  });
  it("§7.3.8.1: Length 0 is a valid empty stream", () => {
    const head = "1 0 obj<</Length 0>>stream\n";
    const r = parseIndirectObject(enc(`${head}\nendstream\nendobj`), 0, noLength);
    expect(r.value).toMatchObject({ kind: "stream", start: head.length, length: 0 });
  });
  it("§7.3.8.1: an end-of-line marker (LF, CR or CRLF) before endstream, not counted in Length, is accepted; so is no marker", () => {
    const head = "1 0 obj<</Length 2>>stream\n";
    for (const tail of ["\nendstream\nendobj", "\r\nendstream\nendobj", "\rendstream\nendobj", "endstream\nendobj"]) {
      const r = parseIndirectObject(enc(`${head}AB${tail}`), 0, noLength);
      expect(r.value).toMatchObject({ kind: "stream", length: 2 });
    }
  });
  it("§7.3.8.2: Length too small (more than one end-of-line before endstream): refused (stream-end)", () => {
    expect(
      refusalOf(() => parseIndirectObject(stream("1 0 obj<</Length 2>>stream\n", "ABCD"), 0, noLength)).reason,
    ).toBe("stream-end");
  });
  it("§7.3.8.2: Length too large (the counted bytes run into endstream): refused (stream-end)", () => {
    expect(
      refusalOf(() => parseIndirectObject(enc("1 0 obj<</Length 9>>stream\nAB\nendstream\nendobj"), 0, noLength))
        .reason,
    ).toBe("stream-end");
  });
  it("§7.3.8.1: endstream missing (end of file after the data, or endobj instead) is refused (stream-end)", () => {
    expect(refusalOf(() => parseIndirectObject(enc("1 0 obj<</Length 2>>stream\nAB"), 0, noLength)).reason).toBe(
      "stream-end",
    );
    expect(
      refusalOf(() => parseIndirectObject(enc("1 0 obj<</Length 2>>stream\nAB\nendobj"), 0, noLength)).reason,
    ).toBe("stream-end");
  });
  it("§7.3.8.1: nothing but white space may sit between endstream and endobj; endobj missing is refused", () => {
    expect(
      refusalOf(() => parseIndirectObject(enc("1 0 obj<</Length 2>>stream\nAB\nendstream\nJUNK endobj"), 0, noLength))
        .reason,
    ).toBe("syntax");
    expect(
      refusalOf(() => parseIndirectObject(enc("1 0 obj<</Length 2>>stream\nAB\nendstream"), 0, noLength)).reason,
    ).toBe("truncated");
  });
  it("§7.3.8.2: a direct Length beyond the bytes remaining in the file is refused (stream-length), with no huge allocation", () => {
    expect(
      refusalOf(() => parseIndirectObject(enc("1 0 obj<</Length 99>>stream\nAB\nendstream\nendobj"), 0, noLength))
        .reason,
    ).toBe("stream-length");
    expect(
      refusalOf(() =>
        parseIndirectObject(enc("1 0 obj<</Length 2147483647>>stream\nAB\nendstream\nendobj"), 0, noLength),
      ).reason,
    ).toBe("stream-length");
  });
  it("§7.3.8.2: a Length entry is required: missing is refused (stream-length)", () => {
    expect(
      refusalOf(() => parseIndirectObject(enc("1 0 obj<</Foo 1>>stream\nAB\nendstream\nendobj"), 0, noLength)).reason,
    ).toBe("stream-length");
  });
  it("Table 5: Length must be an integer: negative, real, name, string, array, boolean are refused (stream-length)", () => {
    for (const bad of ["-1", "2.5", "/Two", "(2)", "[2]", "true"]) {
      expect(
        refusalOf(() => parseIndirectObject(enc(`1 0 obj<</Length ${bad}>>stream\nAB\nendstream\nendobj`), 0, noLength))
          .reason,
      ).toBe("stream-length");
    }
  });
  it("§7.3.10 example 3: indirect Length (7 0 obj << /Length 8 0 R >>) is resolved through the callback, called once with the reference", () => {
    const calls: Array<{ num: number; gen: number }> = [];
    const head = "7 0 obj\n<< /Length 8 0 R >>\nstream\n";
    const r = parseIndirectObject(stream(head, "HELLO"), 0, (ref) => {
      calls.push({ num: ref.num, gen: ref.gen });
      return 5;
    });
    expect(calls).toEqual([{ num: 8, gen: 0 }]);
    expect(r.value).toEqual({
      kind: "stream",
      dict: new Map([["Length", { kind: "ref", num: 8, gen: 0 }]]),
      start: head.length,
      length: 5,
    });
  });
  it("the callback is NOT called when Length is direct", () => {
    let called = 0;
    parseIndirectObject(stream("1 0 obj<</Length 2>>stream\n", "AB"), 0, () => {
      called += 1;
      return 2;
    });
    expect(called).toBe(0);
  });
  it("§7.3.8.2: an indirect Length that the callback cannot resolve (undefined) is refused (length-unresolved)", () => {
    expect(
      refusalOf(() => parseIndirectObject(stream("1 0 obj<</Length 8 0 R>>stream\n", "AB"), 0, noLength)).reason,
    ).toBe("length-unresolved");
  });
  it("§7.3.8.2: an indirect Length resolved to a negative, non-integer, NaN or infinite value is refused (stream-length)", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        refusalOf(() => parseIndirectObject(stream("1 0 obj<</Length 8 0 R>>stream\n", "AB"), 0, () => bad)).reason,
      ).toBe("stream-length");
    }
  });
  it("§7.3.8.2: an indirect Length beyond the remaining bytes is refused (stream-length)", () => {
    expect(
      refusalOf(() => parseIndirectObject(stream("1 0 obj<</Length 8 0 R>>stream\n", "AB"), 0, () => 10_000)).reason,
    ).toBe("stream-length");
  });
  it("a PdfObjectsRefusal thrown by the callback passes through unchanged", () => {
    const inner = new PdfObjectsRefusal("syntax", 8);
    let caught: unknown;
    try {
      parseIndirectObject(stream("1 0 obj<</Length 8 0 R>>stream\n", "AB"), 0, () => {
        throw inner;
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(inner);
  });
  it("§7.3.8.1: the stream dictionary is a direct object: its other entries are parsed (Filter, DecodeParms, references)", () => {
    const head = "3 0 obj<</Length 2/Filter/FlateDecode/DecodeParms<</Predictor 12/Columns 4>>/X 9 0 R>>stream\n";
    const r = parseIndirectObject(stream(head, "AB"), 0, noLength);
    expect(r.value.kind).toBe("stream");
    const d = r.value.kind === "stream" ? r.value.dict : new Map<string, PdfValue>();
    expect(d.get("Filter")).toEqual(name("FlateDecode"));
    expect(d.get("X")).toEqual({ kind: "ref", num: 9, gen: 0 });
    expect(d.get("DecodeParms")?.kind).toBe("dict");
  });
  it("§7.3.8.1: a dictionary object not followed by stream is a plain dict, not a stream", () => {
    expect(parseIndirectObject(enc("1 0 obj<</Length 2>>endobj"), 0, noLength).value.kind).toBe("dict");
  });
  it("reads what the previous object left: two objects back to back are read from r.end", () => {
    const first = "1 0 obj 42 endobj\n";
    const bytes = enc(`${first}2 0 obj (x) endobj`);
    const a = parseIndirectObject(bytes, 0, noLength);
    const b = parseIndirectObject(bytes, a.end, noLength);
    expect([a.num, b.num]).toEqual([1, 2]);
    expect(b.value).toEqual({ kind: "string", bytes: enc("x") });
  });
});

describe("hostile input: bounds (initial values to calibrate; Annex C Table C.1 for names)", () => {
  it("bounds have the documented initial values", () => {
    expect(MAX_NESTING_DEPTH).toBe(64);
    expect(MAX_TOKEN_BYTES).toBe(64);
    expect(MAX_NAME_BYTES).toBe(127);
    expect(MAX_STRING_BYTES).toBe(1_048_576);
  });
  it("100 000 nested '[' is refused (nesting-too-deep), not a stack overflow", () => {
    let error: unknown;
    try {
      parseValue(enc("[".repeat(100_000)), 0);
    } catch (e) {
      error = e;
    }
    expect(error).not.toBeInstanceOf(RangeError);
    expect(error).toBeInstanceOf(PdfObjectsRefusal);
    expect((error as PdfObjectsRefusal).reason).toBe("nesting-too-deep");
  });
  it("100 000 nested '[' CLOSED correctly is refused too (depth is checked on the way down)", () => {
    const text = "[".repeat(100_000) + "]".repeat(100_000);
    expect(refusalOf(() => parseValue(enc(text), 0)).reason).toBe("nesting-too-deep");
  });
  it("100 000 nested dictionaries '<</A' is refused (nesting-too-deep)", () => {
    expect(refusalOf(() => parseValue(enc("<</A".repeat(100_000)), 0)).reason).toBe("nesting-too-deep");
  });
  it("alternating '[<</A' nesting is refused (nesting-too-deep)", () => {
    expect(refusalOf(() => parseValue(enc("[<</A".repeat(50_000)), 0)).reason).toBe("nesting-too-deep");
  });
  it("exactly MAX_NESTING_DEPTH levels are accepted, one more is refused", () => {
    const ok = "[".repeat(MAX_NESTING_DEPTH) + "]".repeat(MAX_NESTING_DEPTH);
    expect(parseValue(enc(ok), 0).value.kind).toBe("array");
    const tooDeep = "[".repeat(MAX_NESTING_DEPTH + 1) + "]".repeat(MAX_NESTING_DEPTH + 1);
    expect(refusalOf(() => parseValue(enc(tooDeep), 0)).reason).toBe("nesting-too-deep");
  });
  it("a deep structure inside an indirect object is bounded the same way", () => {
    const text = `1 0 obj ${"[".repeat(100_000)}`;
    expect(refusalOf(() => parseIndirectObject(enc(text), 0, noLength)).reason).toBe("nesting-too-deep");
  });
  it("a number of 10^6 digits is refused (token-too-long)", () => {
    expect(refusalOf(() => parseValue(enc("9".repeat(1_000_000)), 0)).reason).toBe("token-too-long");
    expect(refusalOf(() => parseValue(enc(`1.${"0".repeat(1_000_000)}`), 0)).reason).toBe("token-too-long");
    expect(refusalOf(() => parseValue(enc(`-${"9".repeat(1_000_000)}`), 0)).reason).toBe("token-too-long");
  });
  it("a number token of exactly MAX_TOKEN_BYTES is read, one more byte is refused", () => {
    expect(parseValue(enc(`0.${"0".repeat(MAX_TOKEN_BYTES - 2)}`), 0).value).toEqual(num(0));
    expect(refusalOf(() => parseValue(enc(`0.${"0".repeat(MAX_TOKEN_BYTES - 1)}`), 0)).reason).toBe("token-too-long");
  });
  it("a bare keyword of 10^6 regular characters is refused (token-too-long)", () => {
    expect(refusalOf(() => parseValue(enc("a".repeat(1_000_000)), 0)).reason).toBe("token-too-long");
  });
  it("Annex C Table C.1: a name of MAX_NAME_BYTES (127) bytes is read, 128 is refused (token-too-long)", () => {
    expect(parseValue(enc(`/${"N".repeat(MAX_NAME_BYTES)}`), 0).value).toEqual(name("N".repeat(MAX_NAME_BYTES)));
    expect(refusalOf(() => parseValue(enc(`/${"N".repeat(MAX_NAME_BYTES + 1)}`), 0)).reason).toBe("token-too-long");
  });
  it("a name of 10^6 bytes is refused (token-too-long); the cap counts bytes AFTER #xx expansion (one per escape)", () => {
    expect(refusalOf(() => parseValue(enc(`/${"N".repeat(1_000_000)}`), 0)).reason).toBe("token-too-long");
    expect(parseValue(enc(`/${"#41".repeat(MAX_NAME_BYTES)}`), 0).value).toEqual(name("A".repeat(MAX_NAME_BYTES)));
    expect(refusalOf(() => parseValue(enc(`/${"#41".repeat(MAX_NAME_BYTES + 1)}`), 0)).reason).toBe("token-too-long");
  });
  it("a literal string of MAX_STRING_BYTES is read, one more byte is refused (string-too-long)", () => {
    const ok = parseValue(enc(`(${"s".repeat(MAX_STRING_BYTES)})`), 0).value;
    expect(ok.kind === "string" && ok.bytes.length).toBe(MAX_STRING_BYTES);
    expect(refusalOf(() => parseValue(enc(`(${"s".repeat(MAX_STRING_BYTES + 1)})`), 0)).reason).toBe("string-too-long");
  });
  it("the string cap counts decoded bytes: a long escaped run under the cap is read", () => {
    const v = parseValue(enc(`(${"\\101".repeat(1000)})`), 0).value;
    expect(v.kind === "string" && v.bytes.length).toBe(1000);
  });
  it("a hexadecimal string beyond the cap is refused (string-too-long), white space included in the scan", () => {
    expect(refusalOf(() => parseValue(enc(`<${"41".repeat(MAX_STRING_BYTES + 1)}>`), 0)).reason).toBe(
      "string-too-long",
    );
    expect(refusalOf(() => parseValue(enc(`<${"4 ".repeat(2 * MAX_STRING_BYTES + 2)}>`), 0)).reason).toBe(
      "string-too-long",
    );
  });
  it("a string of 10^6 unbalanced '(' is refused without recursion (truncated or string-too-long)", () => {
    expect(refusalOf(() => parseValue(enc("(".repeat(1_000_000)), 0)).reason).toMatch(/^(truncated|string-too-long)$/);
  });
  it("an array of 10^6 items is read or refused, never a crash", () => {
    let outcome = "";
    try {
      const v = parseValue(enc(`[${"1 ".repeat(1_000_000)}]`), 0).value;
      outcome = v.kind === "array" ? `read ${v.items.length}` : "wrong";
    } catch (e) {
      expect(e).toBeInstanceOf(PdfObjectsRefusal);
      outcome = "refused";
    }
    expect(outcome).toMatch(/^(read 1000000|refused)$/);
  });
});

describe("hostile input: unterminated constructs at end of file are refused", () => {
  it.each([
    ["literal string", "(abc"],
    ["literal string ending in a backslash", "(abc\\"],
    ["octal escape cut", "(abc\\12"],
    ["nested parenthesis open", "(a(b)c"],
    ["hexadecimal string", "<414243"],
    ["array", "[1 2 3"],
    ["array of arrays", "[[1] [2"],
    ["dictionary", "<< /A 1 /B 2"],
    ["dictionary missing a value", "<< /A"],
    ["dictionary missing the second '>'", "<< /A 1 >"],
    ["comment eating the closer", "[1 2 % ]"],
    ["name escape cut", "/Name#"],
  ])("%s: %s", (_label, text) => {
    expect(["truncated", "syntax"]).toContain(refusalOf(() => val(text)).reason);
  });
  it("an unterminated literal string, array, dictionary and hexadecimal string are 'truncated' exactly", () => {
    expect(refusalOf(() => val("(abc")).reason).toBe("truncated");
    expect(refusalOf(() => val("[1 2 3")).reason).toBe("truncated");
    expect(refusalOf(() => val("<< /A 1 /B 2")).reason).toBe("truncated");
    expect(refusalOf(() => val("<414243")).reason).toBe("truncated");
  });
  it("an object cut after 'obj' or in the middle of its stream data is refused (truncated or stream-length)", () => {
    expect(refusalOf(() => parseIndirectObject(enc("1 0 obj"), 0, noLength)).reason).toBe("truncated");
    expect(["truncated", "stream-length"]).toContain(
      refusalOf(() => parseIndirectObject(enc("1 0 obj<</Length 10>>stream\nABC"), 0, noLength)).reason,
    );
  });
});

describe("hostile input: the refusal type (model: ZipEntryRefusal)", () => {
  const MARKER = "SECRETMARKER_7f3a9";
  const hostile: Array<[string, () => unknown]> = [
    ["marker in an unterminated string", () => val(`(${MARKER}`)],
    ["marker as an unknown keyword", () => val(MARKER)],
    ["marker in an array cut short", () => val(`[1 (${MARKER}) /${MARKER}`)],
    ["marker as a name over the cap", () => val(`/${MARKER}${"N".repeat(MAX_NAME_BYTES)}`)],
    ["marker as a dictionary key without value", () => val(`<< /${MARKER} >>`)],
    ["marker as a dictionary key that is not a name", () => val(`<< ${MARKER} 1 >>`)],
    ["marker as a number-like token", () => val(`12${MARKER}`)],
    ["marker in an object header", () => parseIndirectObject(enc(`${MARKER} 0 obj 1 endobj`), 0, noLength)],
    ["marker after the object value", () => parseIndirectObject(enc(`7 0 obj 1 ${MARKER} endobj`), 0, noLength)],
    [
      "marker in a stream dictionary with a bad Length",
      () => parseIndirectObject(enc(`7 0 obj<</Length /${MARKER}>>stream\nAB\nendstream\nendobj`), 0, noLength),
    ],
    [
      "marker in stream data without endstream",
      () => parseIndirectObject(enc(`7 0 obj<</Length 3>>stream\n${MARKER}\nendobj`), 0, noLength),
    ],
    ["marker in a hexadecimal string", () => val(`<${MARKER}>`)],
  ];
  it.each(hostile)("%s: a PdfObjectsRefusal whose message holds no input byte", (_label, run) => {
    const error = refusalOf(run);
    expect(error).toBeInstanceOf(ReaderError);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("EXTRACT_FAILED");
    expect(error.name).toBe("PdfObjectsRefusal");
    expect(error.message).toMatch(/^pdf-objects: [a-z]+(-[a-z]+)*( \(object \d+\))?$/);
    expect(error.message).not.toContain(MARKER);
    expect(error.message).not.toContain("SECRET");
    const ownValues = Object.getOwnPropertyNames(error).map((k) =>
      String((error as unknown as Record<string, unknown>)[k]),
    );
    expect(JSON.stringify(ownValues)).not.toContain(MARKER);
  });
  it("the reason is from a closed list", () => {
    const allowed = [
      "syntax",
      "truncated",
      "nesting-too-deep",
      "token-too-long",
      "string-too-long",
      "stream-length",
      "stream-end",
      "length-unresolved",
    ];
    for (const [, run] of hostile) expect(allowed).toContain(refusalOf(run).reason);
  });
  it("carries at most an object number, taken from the header of the object being read", () => {
    const e = refusalOf(() => parseIndirectObject(enc("77 0 obj (abc"), 0, noLength));
    expect(e.objectNumber).toBe(77);
    expect(e.message).toBe("pdf-objects: truncated (object 77)");
    expect(refusalOf(() => val("(abc")).objectNumber).toBeUndefined();
    expect(refusalOf(() => val("(abc")).message).toBe("pdf-objects: truncated");
  });
  it("can be built directly with a reason and an optional object number", () => {
    expect(new PdfObjectsRefusal("syntax").message).toBe("pdf-objects: syntax");
    expect(new PdfObjectsRefusal("stream-length", 12).message).toBe("pdf-objects: stream-length (object 12)");
    expect(new PdfObjectsRefusal("syntax").reason).toBe("syntax");
  });
  it("throws nothing but PdfObjectsRefusal on every truncation and every single-byte inversion of a valid object", () => {
    const good = enc(
      "9 0 obj\n<< /Length 4 /K [1 2.5 (s\\n) <4A> /N#41 9 0 R true null] >>\nstream\nDATA\nendstream\nendobj\n",
    );
    const variants = (cut: number): Uint8Array[] => {
      const flipped = good.slice();
      if (cut < flipped.length) flipped[cut] = (flipped[cut] ?? 0) ^ 0xff;
      return [good.slice(0, cut), flipped];
    };
    for (let cut = 0; cut <= good.length; cut += 1) {
      for (const bytes of variants(cut)) {
        try {
          parseIndirectObject(bytes, 0, () => 4);
        } catch (e) {
          expect(e).toBeInstanceOf(PdfObjectsRefusal);
        }
      }
    }
  });
});

describe("review cleanups of slice A1 (24/10/2026)", () => {
  it("§7.3.7 + §7.3.9: a repeated key keeps the LAST value, and a last null removes the entry (null is as if absent)", () => {
    const dict = val("<< /A 1 /A null /B 2 /B 3 >>");
    expect(dict.kind).toBe("dict");
    const entries = (dict as Extract<PdfValue, { kind: "dict" }>).entries;
    expect(entries.has("A"), "the later null removed A").toBe(false);
    expect(entries.get("B")).toEqual({ kind: "number", value: 3 });
  });

  it("Annex C: generation 65535 is read, 65536 is refused", () => {
    expect(val("5 65535 R")).toEqual({ kind: "ref", num: 5, gen: 65535 });
    expect(refusalOf(() => val("5 65536 R")).reason).toBe("syntax");
  });
});
