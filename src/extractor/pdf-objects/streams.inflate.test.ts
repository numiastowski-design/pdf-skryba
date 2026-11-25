/**
 * The zlib output ceiling must not break decoding. With an options object, `inflateSync` decodes by chunks, and a
 * back-reference that reaches further than the chunk fails; the DEFLATE window is 32 KB (RFC 1951), so
 * `INFLATE_CHUNK_BYTES` is the first power of two above it.
 */
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { MAX_DECODED_STREAM_BYTES } from "./bounds";
import type { PdfStream, PdfValue } from "./objects";
import { decodeStream } from "./streams";

describe("un flux dont la référence arrière dépasse le morceau de décodage", () => {
  it("a Flate stream past 64 MB is REFUSED as a bound, and the 64 KB chunk changes nothing", () => {
    // Since pdf-skryba 0.10.0 (24/11/2026) the ceiling has its own reason, `stream-too-large`, a security refusal
    // distinct from a damaged stream (`stream-decode`).
    // Limit: this test stays green without `maxOutputLength`, because our own buffer (`grownTo`) stops the bomb too.
    // It holds the chain, not the zlib ceiling alone; that ceiling keeps zlib from allocating before our buffer sees
    // a byte.
    const bomb = deflateSync(Buffer.alloc(MAX_DECODED_STREAM_BYTES + 1_000_000));
    const dict = new Map<string, PdfValue>([["Filter", { kind: "name", value: "FlateDecode" }]]);
    const stream: PdfStream = { kind: "stream", dict, start: 0, length: bomb.length };
    expect(() => decodeStream(new Uint8Array(bomb), stream)).toThrow(/stream-too-large/u);
  }, 60_000);
});
