/**
 * Fuzz testing — extractors, priority 1 (from a fuzz-testing plan purged on 27/09/2026), PDF
 * (digital) path.
 *
 * Only the small DIGITAL fixture (05a) is used here — the 40-page scanned
 * fixture (05b, 5.3 MB) would make repeated fuzzing far too slow, and its
 * own path (OCR/vision) is a separate, not-yet-built fuzz target
 * (the purged fuzz-testing plan's §4, its own "vision path" section), not this one.
 *
 * `extractPdf` already wraps its ENTIRE read of the document (`readPdfSource`,
 * `pdf-open.ts`; formerly the pdf.js call) in one try/catch — a narrower, more defended surface
 * than pptx's own. The interesting PDF-specific corruption per
 * that plan is the xref table (near the file's own tail) and the
 * content stream, not a ZIP-style missing-part - constructed by mutating
 * real PDF bytes directly, not synthesizing malformed structure by hand.
 *
 * NOT built tonight, real gaps (flagged, not silently skipped):
 * encrypted/password-protected PDF (needs an encryption-capable PDF
 * builder, not currently a repo dependency), and circular page-tree
 * references (needs hand-built low-level PDF object graph manipulation).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReaderError } from "doc-ir";

// Same reasoning as xlsx.property.test.ts's own file-wide raise (the PDF
// reads of many fast-check cases add up too).
vi.setConfig({ testTimeout: fuzzTestTimeout(20000, process.env) });

// pdf.js (removed 01/11/2026) logged its own internal recovery attempts straight to console
// (warn/error) — expected, noisy, and not a test failure (it's exactly the
// resilience this file is verifying) — silenced here, test-file-local only,
// never touching production code.
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});
import { extractPdf } from "./pdf";
import { fuzzRuns, fuzzTestTimeout } from "../lib/pdf-fuzz-runs.test.support";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_BYTES = new Uint8Array(readFileSync(join(here, "../../fixtures/pdf/05a-Rapport-Annuel-Digital.pdf")));
const KNOWN_FIXTURE_TEXT_FRAGMENT = "Rapport";

async function assertNeverCrashesOnlyNamedFailure(bytes: Uint8Array): Promise<void> {
  try {
    await extractPdf(bytes);
    // Resolving is fine - a damaged file can still be read.
  } catch (error) {
    expect(error).toBeInstanceOf(ReaderError); // P1
    const appError = error as ReaderError;
    expect(appError.code).toBe("EXTRACT_FAILED"); // P2
    expect(appError.message).not.toContain(KNOWN_FIXTURE_TEXT_FRAGMENT); // P6
  }
}

describe("extractPdf - corruption fuzzing, truncation (fuzz: extractors priority 1)", () => {
  it("truncating a real digital PDF at any byte percentage never crashes the process, only ever fails named", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 99 }), async (percent) => {
        const truncated = FIXTURE_BYTES.slice(0, Math.floor((FIXTURE_BYTES.length * percent) / 100));
        await assertNeverCrashesOnlyNamedFailure(truncated);
      }),
      { numRuns: fuzzRuns(40, process.env), timeout: 8000 }, // P5: a read of a damaged file can be slower than a simple ZIP re-read
    );
  });
});

describe("extractPdf - corruption fuzzing, xref/trailer corruption (fuzz: extractors priority 1, the purged fuzz-testing plan §4, 'inconsistent object table (xref)')", () => {
  it("corrupting the file's own tail bytes (where the xref table + trailer live) never crashes the process", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 500 }), fc.integer({ min: 0, max: 255 }), (tailBytes, fillByte) => {
        const corrupted = FIXTURE_BYTES.slice();
        const start = Math.max(0, corrupted.length - tailBytes);
        for (let i = start; i < corrupted.length; i++) corrupted[i] = fillByte;
        return assertNeverCrashesOnlyNamedFailure(corrupted);
      }),
      { numRuns: fuzzRuns(40, process.env), timeout: 8000 },
    );
  });
});

describe("extractPdf - corruption fuzzing, the exact corruption behind CI run 13 (06/09/2026)", () => {
  // Pinned, not random: bytes 500-689 filled with 0x54 is the corruption the
  // post-mortem isolated as a reliable-ish producer of pdf.js's internally-
  // escaping rejection (src/extractor/pdfjs-internal-errors.ts, a file that went with pdf.js — a promise
  // nobody held, unreachable from extractPdf's try/catch, timing-dependent).
  // vitest.config.ts's `onUnhandledError` filter was what kept that escapee
  // from failing the run (it no longer exists); this case keeps the scenario permanently in the
  // suite so a change of reader behavior surfaces here first, not as a
  // once-a-fortnight red main.
  it("the corruption that leaked a floating pdf.js rejection still fails named, never crashes the run", async () => {
    const corrupted = FIXTURE_BYTES.slice();
    for (let i = 500; i < 690; i++) corrupted[i] = 0x54;
    await assertNeverCrashesOnlyNamedFailure(corrupted);
  });
});

describe("extractPdf - corruption fuzzing, content-stream corruption (fuzz: extractors priority 1, the purged fuzz-testing plan §4, 'corrupted content stream')", () => {
  it("flipping a contiguous byte range anywhere in the file never crashes the process", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.integer({ min: 1, max: 200 }),
        fc.integer({ min: 0, max: 255 }),
        (offsetFraction, runLength, fillByte) => {
          const corrupted = FIXTURE_BYTES.slice();
          const start = Math.max(0, Math.min(corrupted.length - 1, Math.floor(corrupted.length * offsetFraction)));
          const end = Math.min(corrupted.length, start + runLength);
          for (let i = start; i < end; i++) corrupted[i] = fillByte;
          return assertNeverCrashesOnlyNamedFailure(corrupted);
        },
      ),
      { numRuns: fuzzRuns(50, process.env), timeout: 8000 },
    );
  });
});
