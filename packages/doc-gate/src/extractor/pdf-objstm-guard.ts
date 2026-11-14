/** A guard in front of `pdf-lib` for the one path that still lets it open a client's whole file (`pdf-scanned.ts`, which slices
 *  pages into small PDFs for the vision reading).
 *  Decides: whether the streams `pdf-lib` inflates while it LOADS a file — object streams and cross-reference streams — decompress
 *  within bounds, by reading the RAW BYTES, not the cross-reference table: `pdf-lib` reads the body sequentially and inflates every
 *  such stream it meets, referenced or not, and decrypts before it inflates.
 *  How: the file is cut at each `>> stream` (the end of a dictionary and its keyword, which a string inside the dictionary cannot
 *  fake as a bare word could); the text since the previous stream — every object between, whole — is the dictionary region. It is
 *  decoded (`#xx` escapes) and read BROADLY: any `/Type` that is `/ObjStm`, `/XRef` or not a plain name makes the stream counted,
 *  and any `/Filter` that is not one lone Flate refuses the file. A counted stream is inflated in a sink that keeps nothing, so the
 *  memory stays constant. In an encrypted file the bytes come from OUR reader, which decrypts them, for every object header of the
 *  region (a fake header in a string cannot hide the real one). Every other stream — a Flate page image — is skipped: a large scan
 *  costs nothing here. Each byte is looked at about once: the scan jumps over a stream's data to its `endstream`.
 *  🔴 LIMIT, written: this is a byte scan that imitates what `pdf-lib` decides by parsing, and it was bypassed in three rounds of
 *  review (a string holding `stream`, NUL between tokens, an indirect `/Filter`), each time closed by reading MORE broadly. It
 *  errs by excess (a false refusal is possible, a region read too widely) but a form we did not foresee can still pass. The clean fix
 *  is a PDF writer of our own (STATUS, « Plus tard »).
 *  NOT here: what an object stream contains, the PDF vocabulary, the ceilings and the decryption — they belong to the reader and
 *  reach the gate through `ObjectStreamSource` (`extractor/pdf-objstm-source.ts` in the app, 12/11/2026). The gate holds the byte
 *  scan and nothing else, which is what makes it a gate: it can stand in front of a reader it knows nothing about.
 *  Called by: `extractor/pdf-scanned.ts`, through that source. */

import { createInflate } from "node:zlib";

/**
 * WHAT THE READER LENDS THE GATE. The gate reads bytes; everything that needs to know what a PDF IS comes from here —
 * the two ceilings (they live in the reader's own register, `pdf-objects/bounds.ts`, and are not scattered), the
 * decryption of an encrypted file's streams, and the refusal the reader raises so that its callers keep catching the
 * one class they always caught.
 */
export interface ObjectStreamSource {
  /** The file's trailer declares an `/Encrypt` (ISO 32000-1 §7.6.1). */
  readonly encrypted: boolean;
  /** Bytes one stream may decode to. */
  readonly maxDecodedStreamBytes: number;
  /** Bytes all the counted streams may decode to, together. */
  readonly maxDocumentBytes: number;
  /** The streams OUR reader decrypts for the object headers of `region`, in an encrypted file. */
  decryptedStreams: (region: string) => Uint8Array[];
  /** The reader's own refusal. The gate never names a reader's vocabulary, so it asks for the error instead of building it. */
  refuse: (reason: "filter-unsupported" | "document-too-large") => Error;
}

/** The end of a dictionary followed by the stream keyword, with whitespace and comments between, as `pdf-lib` reads them. */
const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);

/** The next `>> stream` at or after `from` — whitespace and comments allowed between — as `dictEnd` (just after the `>>`) and `keywordAt`.
 *  Written by hand, not as a regex: `(?:…|%[^\r\n]*[\r\n])*` backtracked quadratically on a file made of `>>%` (11.8 s for 240 KB, found
 *  by the performance review of 02/11/2026). The end of a comment is cached, so a run of comments with no line ending is read once. */
function streamKeywordFinder(text: string): (from: number) => { dictEnd: number; keywordAt: number } | undefined {
  let commentEnd = -1;
  const endOfComment = (i: number): number => {
    if (commentEnd >= i) return commentEnd;
    let j = i;
    while (j < text.length && text.charCodeAt(j) !== 0x0a && text.charCodeAt(j) !== 0x0d) j += 1;
    commentEnd = j;
    return j;
  };
  return (from) => {
    for (let at = text.indexOf(">>", from); at >= 0; at = text.indexOf(">>", at + 1)) {
      let i = at + 2;
      for (;;) {
        const c = text.charCodeAt(i);
        if (WHITESPACE.has(c)) i += 1;
        else if (c === 0x25) i = endOfComment(i);
        else break;
      }
      if (text.startsWith("stream", i)) return { dictEnd: at + 2, keywordAt: i };
    }
    return undefined;
  };
}

const decodeNameEscapes = (text: string): string => text.replace(/#([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));

/** A stream `pdf-lib` inflates when it loads a file, or whose kind we cannot tell: some `/Type` of the region names `/ObjStm` or `/XRef`,
 *  or is not a plain name (an indirect reference, `/Type 7 0 R` or `/Type 7 0R`, which `pdf-lib` follows and we do not). The key must END
 *  at `/Type`: the value `/Type1` of `/Subtype` is a font, not a type key (it refused 9 of 57 ordinary fixtures). */
function isLoadTimeStream(region: string): boolean {
  for (const found of region.matchAll(/\/Type(?=[\s\0/<[(%>])[\s\0]*(\/[^\s\0/<>[\]()%]*)?/g)) {
    const name = found[1];
    if (name === undefined || name === "/ObjStm" || name === "/XRef") return true;
  }
  return false;
}

/** The filters of a counted region: each is exactly one `FlateDecode` (`/Standard` is the encryption handler's name, not a filter of a
 *  stream), or the file is refused (a chain, LZW, ASCIIHex in front of Flate, or a filter not written in the dictionary at all,
 *  `/Filter 9 0 R`: we cannot count what `pdf-lib` would decode). */
function assertLoneFlate(region: string, source: ObjectStreamSource): void {
  for (const found of region.matchAll(/\/Filter[\s\0]*(\[[^\]]{0,1000}\]|\/[A-Za-z0-9]+)?/g)) {
    const names = found[1]?.match(/\/[A-Za-z0-9]+/g) ?? [];
    if (names.length !== 1 || !/^\/(?:FlateDecode|Fl|Standard)$/.test(names[0]!)) throw source.refuse("filter-unsupported");
  }
}

/** Where the data of the stream whose keyword starts at `at` begins: after the keyword, optional spaces, then CR LF, LF or a lone CR (the
 *  three endings `pdf-lib` accepts). `undefined` when the word is not followed by a line ending (it is not a stream keyword). */
function dataStartOf(text: string, at: number): number | undefined {
  let i = at + "stream".length;
  while (text.charCodeAt(i) === 0x20) i += 1;
  if (text.charCodeAt(i) === 0x0d) return text.charCodeAt(i + 1) === 0x0a ? i + 2 : i + 1;
  return text.charCodeAt(i) === 0x0a ? i + 1 : undefined;
}

/** Where the data of a stream ends: the later of the first `endstream` and the declared `/Length`, since `pdf-lib` trusts a correct length and
 *  reads past an `endstream` inside the data. Inflating stops by itself at the end of the zlib stream, so too much is harmless. */
function dataEndOf(text: string, region: string, start: number): number {
  const end = text.indexOf("endstream", start);
  const declared = /\/Length[\s\0]+(\d+)(?![\s\0]+\d+[\s\0]+R)/.exec(region)?.[1];
  return Math.min(text.length, Math.max(end < 0 ? text.length : end, declared === undefined ? 0 : start + Number(declared)));
}

/** How many bytes `data` inflates to, counted and not kept, stopping as soon as the count passes `limit` (then it is above `limit`). A
 *  stream that errors counts what it had inflated or its own length, whichever is larger: a corrupt checksum does not hide a bomb. */
function inflatedLength(data: Uint8Array, limit: number): Promise<number> {
  return new Promise((resolve) => {
    const inflate = createInflate();
    let count = 0;
    inflate.on("data", (chunk: Buffer) => {
      count += chunk.length;
      if (count > limit) {
        inflate.destroy();
        resolve(count);
      }
    });
    inflate.on("end", () => resolve(count));
    inflate.on("error", () => resolve(Math.max(count, data.length)));
    inflate.end(data);
  });
}

/** Refuses a file whose load-time streams decompress past the bounds the reader lends the gate: one stream past
 *  `maxDecodedStreamBytes`, or all of them past `maxDocumentBytes` (`document-too-large`). The source is OUR reader's view of the
 *  same file; it decrypts the streams of an encrypted file, which the gate cannot inflate as they are. */
export async function assertObjectStreamsBounded(bytes: Uint8Array, source: ObjectStreamSource): Promise<void> {
  const { maxDecodedStreamBytes: MAX_DECODED_STREAM_BYTES, maxDocumentBytes: MAX_DOCUMENT_BYTES } = source;
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  const encrypted = source.encrypted;
  let total = 0;
  let regionStart = 0;
  const nextKeyword = streamKeywordFinder(text);
  let resumeAt = 0;
  for (let found = nextKeyword(resumeAt); found !== undefined; found = nextKeyword(resumeAt)) {
    const keywordAt = found.keywordAt;
    const start = dataStartOf(text, keywordAt);
    // `>> stream` with no line ending after it is a keyword `pdf-lib` accepts, or the text of a string: we cannot tell which, and a real
    // file always has the line ending (ISO 32000-1 §7.3.8.1).
    if (start === undefined) throw source.refuse("filter-unsupported");
    const region = decodeNameEscapes(text.slice(regionStart, found.dictEnd));
    const stopAt = dataEndOf(text, region, start);
    regionStart = stopAt;
    // The scan continues after this stream's data, which may hold anything, `>> stream` included.
    resumeAt = stopAt;
    if (!isLoadTimeStream(region)) continue;
    assertLoneFlate(region, source);
    // A cross-reference stream is never encrypted (ISO 32000-1 §7.6.1), so it is counted as it is.
    const viaReader = encrypted && !/\/XRef(?![A-Za-z0-9])/.test(region);
    const datas = viaReader ? source.decryptedStreams(region) : [bytes.subarray(start, stopAt)];
    for (const data of datas) {
      const size = await inflatedLength(data, Math.min(MAX_DECODED_STREAM_BYTES, MAX_DOCUMENT_BYTES - total));
      total += size;
      if (size > MAX_DECODED_STREAM_BYTES || total > MAX_DOCUMENT_BYTES) throw source.refuse("document-too-large");
    }
  }
}
