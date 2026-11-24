/**
 * The object reader turns only ITS OWN refusals into a named refusal (decided on 24/11/2026). A defect of ours — a native
 * `TypeError` raised under the parse — propagates as it is: it is no longer disguised as a damaged file. The defect is
 * injected where the catches wrap the parse (`./parse`); a damaged input still gives the named refusal.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ armed: false }));

vi.mock("./parse", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./parse")>();
  const defect = (): never => {
    throw new TypeError("a defect of ours");
  };
  return {
    ...actual,
    parseValue: (...args: Parameters<typeof actual.parseValue>) =>
      state.armed ? defect() : actual.parseValue(...args),
    parseIndirectObject: (...args: Parameters<typeof actual.parseIndirectObject>) =>
      state.armed ? defect() : actual.parseIndirectObject(...args),
  };
});

import type { PdfDict, PdfStream } from "./objects";
import { PdfObjectsRefusal } from "./refusal";
import { readObjectStream } from "./streams";
import { readXref } from "./xref";

const enc = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "latin1"));

/** An object stream holding object 4, whose decoded data is `data`. */
function objectStream(data: string): { bytes: Uint8Array; stream: PdfStream; decode: () => Uint8Array } {
  const dict: PdfDict = new Map([
    ["N", { kind: "number", value: 1 }],
    ["First", { kind: "number", value: 4 }],
  ]);
  return { bytes: enc(""), stream: { kind: "stream", dict, start: 0, length: 0 }, decode: () => enc(data) };
}

/** A file whose `startxref` points at `body`, where a cross-reference stream would be. */
function fileWithSectionAt(body: string): Uint8Array {
  const head = "%PDF-1.5\n";
  return enc(`${head}${body}startxref\n${head.length}\n%%EOF\n`);
}

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("nothing was thrown");
}

describe("the object reader names its own refusals only (24/11/2026)", () => {
  beforeEach(() => {
    state.armed = false;
  });

  it("witness: the object stream reads when nothing is injected", () => {
    const { bytes, stream, decode } = objectStream("4 0 42");
    expect(readObjectStream(bytes, stream, decode).valueOf(4)?.value).toEqual({ kind: "number", value: 42 });
  });

  it("🔴 a defect of ours reading a pair of the object stream propagates, not as `object-stream`", () => {
    const { bytes, stream, decode } = objectStream("4 0 42");
    state.armed = true;
    const thrown = thrownBy(() => readObjectStream(bytes, stream, decode));
    expect(thrown).not.toBeInstanceOf(PdfObjectsRefusal);
    expect(thrown).toBeInstanceOf(TypeError);
  });

  it("🔴 a defect of ours reading a member of the object stream propagates, not as `object-stream`", () => {
    const { bytes, stream, decode } = objectStream("4 0 42");
    const members = readObjectStream(bytes, stream, decode);
    state.armed = true;
    const thrown = thrownBy(() => members.valueOf(4));
    expect(thrown).not.toBeInstanceOf(PdfObjectsRefusal);
    expect(thrown).toBeInstanceOf(TypeError);
  });

  it("a damaged pair still gives the named refusal `object-stream`", () => {
    const { bytes, stream, decode } = objectStream("4 ) 42");
    const thrown = thrownBy(() => readObjectStream(bytes, stream, decode));
    expect(thrown).toBeInstanceOf(PdfObjectsRefusal);
    expect((thrown as PdfObjectsRefusal).reason).toBe("object-stream");
  });

  it("a damaged member still gives the named refusal `object-stream`", () => {
    const { bytes, stream, decode } = objectStream("4 0 <<");
    const members = readObjectStream(bytes, stream, decode);
    const thrown = thrownBy(() => members.valueOf(4));
    expect(thrown).toBeInstanceOf(PdfObjectsRefusal);
    expect((thrown as PdfObjectsRefusal).reason).toBe("object-stream");
  });

  it("🔴 a defect of ours reading the object at `startxref` propagates, not as `xref-offset`", () => {
    const bytes = fileWithSectionAt("4 0 obj\n<< /Type /XRef >>\nendobj\n");
    state.armed = true;
    const thrown = thrownBy(() => readXref(bytes));
    expect(thrown).not.toBeInstanceOf(PdfObjectsRefusal);
    expect(thrown).toBeInstanceOf(TypeError);
  });

  it("a damaged object at `startxref` still gives the named refusal `xref-offset`", () => {
    const thrown = thrownBy(() => readXref(fileWithSectionAt("4 0 obj\n<< /Type /XRef\nendobj\n")));
    expect(thrown).toBeInstanceOf(PdfObjectsRefusal);
    expect((thrown as PdfObjectsRefusal).reason).toBe("xref-offset");
  });
});
