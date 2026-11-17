/** The product's zip reader: open an archive (or refuse it), list its files,
 *  know a file without inflating it, and read one under a per-read ceiling and
 *  a package-wide one. Replaced jszip in production on 05/10/2026.
 *  NOT here: OPC (relationships, content types, the main part), XML, the CFB
 *  classification of what is not a zip, the error words the user sees — all
 *  stay in `ooxml/package.ts`, which maps this module's refusals.
 *  Called by: `ooxml/package.ts` (every archive the product reads),
 *  `zip/zip-package.test.ts` and the differential fuzz against jszip. */

import { createInflateRaw } from "node:zlib";

import { ReaderError } from "doc-ir/lib/reader-error";
import { concatBytes } from "doc-ir/extractor/bytes";
import { readLocalHeaders, type LocalEntry } from "./local-headers";

/**
 * WHAT IS OFFERED.
 * - `openZip` throws the `ReaderError` of `readLocalHeaders` (central directory,
 *   local headers, overlaps) when the bytes are no archive we read.
 * - `has(path)`: a FILE (never a directory) of that exact name, known from the
 *   headers alone. `names`: files only, central directory order.
 * - `readBytes(path, maxBytes?)`: the per-read ceiling is
 *   `min(partMaxBytes, maxBytes)`, exactly the ceiling accepted; every read is
 *   spent from the package budget (a part read twice counts twice).
 *
 * Refusals are `ZipEntryRefusal`, two classes: `damaged` (the
 * entry's own bytes; `package.ts` may map it to `PartDamagedError`) and
 * `ceiling` (a bomb; never degradable). Past the package budget is `ceiling`.
 *
 * WHAT IS COUNTED. Deflated data is inflated as a `zlib.InflateRaw` stream
 * (Node `zlib`, class `InflateRaw`: a truncated input ends in an `'error'`
 * event) and EVERY chunk it emits is added to the package count BEFORE the
 * ceilings are checked, whatever happens next: an entry refused as damaged
 * after inflating 63 MB has still spent 63 MB (review of 05/10/2026). Hence a
 * stream, not `inflateRawSync`, which reports nothing about the bytes it
 * produced before an error (tried in slice 3, removed). Node documents
 * `maxOutputLength` for the convenience methods only, so the stream is
 * bounded by our own count: at most one chunk (`chunkSize`, 16 KB by default)
 * is produced past a ceiling before the stream is destroyed. Stored data is
 * the archive's own bytes: a stored read is charged its real length, never a
 * declared one, except when it is refused past its read ceiling: then it is
 * charged just past that ceiling (`cap + 1`) and nothing is copied: a refused
 * part must not spend the rest of the budget of a reader that goes on
 * (`google-drawings.ts`).
 * The produced length is then compared with the declared uncompressed size:
 * a difference is damage, never a ceiling.
 */

/** Two classes, never mixed: `damaged` blames the entry's own bytes (a caller may degrade an auxiliary part, like
 *  `PartDamagedError`); `ceiling` is a bomb and must never be softened. Our literals: zlib's words, the entry's
 *  name and its bytes are dropped. */
export type ZipEntryRefusalKind = "damaged" | "ceiling";

/** Which ceiling a `ceiling` refusal hit: the READ's own (`min(partMaxBytes, maxBytes)`) or the package-wide one. A caller
 *  that passed a tighter `maxBytes` may leave ONE entry out when its own allowance was passed; the package ceiling stays
 *  a refusal. */
export type ZipCeilingReason = "read" | "package";

export class ZipEntryRefusal extends ReaderError {
  constructor(
    readonly kind: ZipEntryRefusalKind,
    readonly reason: ZipCeilingReason = "package",
  ) {
    // A ceiling is a bomb, not damage: its own code, which proposes nothing (a damaged entry stays an ordinary read failure).
    super(
      kind === "ceiling" ? "FILE_UNSAFE" : "EXTRACT_FAILED",
      kind === "ceiling" ? "zip: entry exceeds the inflation ceiling" : "zip: entry data is damaged",
    );
    this.name = "ZipEntryRefusal";
  }
}

export interface ZipReadLimits {
  /** Bytes one read may produce. */
  readonly partMaxBytes: number;
  /** Bytes all reads of this archive may produce together. */
  readonly packageMaxBytes: number;
}

export interface ZipPackage {
  readonly names: readonly string[];
  has(path: string): boolean;
  /** The uncompressed size the central directory DECLARES for a file, known without inflating it; `undefined` when no file
   *  has this name. A header may lie, so this only lets a caller skip a read it would refuse anyway: every read is still
   *  counted and capped on what it really produces. */
  sizeOf(path: string): number | undefined;
  /** `undefined` when no file has this name; `maxBytes` tightens this read's ceiling. */
  readBytes(path: string, maxBytes?: number): Promise<Uint8Array | undefined>;
}

const METHOD_STORED = 0;

const isLimit = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;

export function openZip(bytes: Uint8Array, limits: ZipReadLimits): ZipPackage {
  // A caller's bug, not the archive's: NaN would compare false to every count, i.e. no ceiling at all.
  if (!isLimit(limits.partMaxBytes) || !isLimit(limits.packageMaxBytes)) {
    throw new Error("openZip: limits must be safe integers >= 0");
  }
  const files = new Map<string, LocalEntry>();
  for (const entry of readLocalHeaders(bytes).entries) if (!entry.dir) files.set(entry.name, entry);
  const names = [...files.keys()];
  const spent = { bytes: 0 };

  // The package ceiling wins when both are passed: a bomb is never softened.
  const ceilingHit = (produced: number, cap: number): ZipCeilingReason | undefined => {
    if (spent.bytes > limits.packageMaxBytes) return "package";
    return produced > cap ? "read" : undefined;
  };

  const readBytes = async (path: string, maxBytes?: number): Promise<Uint8Array | undefined> => {
    const entry = files.get(path);
    if (!entry) return undefined;
    if (maxBytes !== undefined && !isLimit(maxBytes)) throw new Error("openZip: maxBytes must be a safe integer >= 0");
    const cap = Math.min(limits.partMaxBytes, maxBytes ?? limits.partMaxBytes);
    const data = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);

    let out: Uint8Array;
    if (entry.method === METHOD_STORED) {
      // Charged up to just past this read's ceiling: a refused part must not spend the rest of the package budget
      // (`google-drawings.ts` reads on after a refusal).
      spent.bytes += Math.min(data.length, cap + 1);
      const stored = ceilingHit(data.length, cap);
      if (stored) throw new ZipEntryRefusal("ceiling", stored);
      // A copy: never a view on the caller's archive.
      out = data.slice();
    } else if (entry.compressedSize === 0 && entry.uncompressedSize === 0) {
      // APPNOTE 6.3.10 §4.3.8: a zero-byte file MUST NOT include file data, so a deflated one may have no stream at
      // all; zlib calls that damage, we read 0 bytes (as jszip did).
      out = new Uint8Array();
    } else {
      out = await inflateCounted(
        data,
        (chunk) => {
          spent.bytes += chunk;
        },
        (produced) => ceilingHit(produced, cap),
      );
    }
    if (out.length !== entry.uncompressedSize) throw new ZipEntryRefusal("damaged");
    return out;
  };

  return { names, has: (path) => files.has(path), sizeOf: (path) => files.get(path)?.uncompressedSize, readBytes };
}

/** Inflates `data` as a stream; `charge` sees every chunk's length as it is
 *  produced, then `over` decides whether the total so far passes a ceiling. */
function inflateCounted(
  data: Uint8Array,
  charge: (chunkLength: number) => void,
  over: (produced: number) => ZipCeilingReason | undefined,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const inflater = createInflateRaw();
    const chunks: Buffer[] = [];
    let produced = 0;
    let settled = false;
    // zlib's own words are dropped: only our class crosses.
    const refuse = (kind: "damaged" | "ceiling", reason?: ZipCeilingReason): void => {
      if (settled) return;
      settled = true;
      inflater.destroy();
      reject(new ZipEntryRefusal(kind, reason));
    };
    inflater.on("data", (chunk: Buffer) => {
      if (settled) return;
      produced += chunk.length;
      charge(chunk.length);
      const hit = over(produced);
      if (hit) {
        refuse("ceiling", hit);
        return;
      }
      chunks.push(chunk);
    });
    inflater.on("error", () => refuse("damaged"));
    inflater.on("end", () => {
      if (settled) return;
      settled = true;
      // One fresh buffer: zlib's chunks are copied once, never handed out.
      resolve(concatBytes(chunks, produced));
    });
    inflater.end(data);
  });
}
