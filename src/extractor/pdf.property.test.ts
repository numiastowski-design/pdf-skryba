/**
 * Fuzz of the whole PDF reader through `extractPdf`, on damaged bytes of the small digital fixture `05a`.
 * Lot 0 of the PDF fuzz design (16/11/2026): every trial gives a result or a refusal of ours, never a raw error of ours;
 * no page comes out without its text; two reads of the same bytes agree; and each mutation keeps a minimal share of
 * trials that give a result, so the fuzz does not stop at the first layer without anyone seeing it.
 *
 * The seed is fixed (`PDF_FUZZ_SEED`): a red run replays as is. The run count is the written one, times the weekly
 * multiplier (`lib/pdf-fuzz-runs.test.support.ts`).
 *
 * Measured on 24/11/2026, 499 trials with this seed (99 truncations, 200 tail fills, 200 range fills), about 6 ms a
 * trial with its second read: truncation 0 read / 99 refused (`startxref-missing`); tail fill 33 read / 167 refused
 * (`startxref-missing` 152, `xref-offset` 15); range fill 94 read / 106 refused (`token-too-long` 69, `syntax` 37). No
 * raw error, no page without text, no read that differed from the intact file's, no second read that differed.
 *
 * What it cannot see: the catch-alls of the reader that turn an error of ours into an unknown font or a named refusal
 * (`pdf-glyph-source.ts`, `pdf-fonts/font-text.ts`, `pdf-objects/streams.ts`, `pdf-objects/xref.ts`). Only the page
 * one (`pdf-source.ts#readPageText`) is visible here, through `textUnreadByPage`. The others need a fuzz that calls
 * their layer directly (lots 1 to 5).
 * NOT covered: encrypted files and circular page trees (lots 5 and 7).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import { extractPdf } from "./pdf";
import { checkTrial, OutcomeTally, PDF_FUZZ_SEED, type PdfRead } from "./pdf-fuzz-outcome.test.support";
import { fuzzRuns, fuzzTestTimeout } from "../lib/pdf-fuzz-runs.test.support";

// The two reads of each trial add up over many cases.
vi.setConfig({ testTimeout: fuzzTestTimeout(20000, process.env) });

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_BYTES = new Uint8Array(readFileSync(join(here, "../../fixtures/pdf/05a-Rapport-Annuel-Digital.pdf")));

const read: PdfRead = (bytes) => extractPdf(bytes);

/** The fast-check parameters of one property: the fixed seed, the written count times the weekly multiplier. */
const params = (baseRuns: number): fc.Parameters<unknown> => ({
  numRuns: fuzzRuns(baseRuns, process.env),
  seed: PDF_FUZZ_SEED,
  timeout: 8000,
});

describe("extractPdf - truncation fuzzing", () => {
  it("a truncated file gives a refusal of ours, the same way twice", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 99 }), async (percent) => {
        const truncated = FIXTURE_BYTES.slice(0, Math.floor((FIXTURE_BYTES.length * percent) / 100));
        await checkTrial(read, truncated);
      }),
      params(40),
    );
    // No minimal share of reads: the reader never repairs a file (`pdf-objects/xref.ts`), and every cut loses the
    // `startxref` of the tail. Measured: 0 read in 99, and in 400.
  });
});

describe("extractPdf - xref/trailer corruption fuzzing", () => {
  it("overwriting the tail (xref table and trailer) gives a result or a refusal of ours, the same way twice", async () => {
    const tally = new OutcomeTally();
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 500 }),
        fc.integer({ min: 0, max: 255 }),
        async (tailBytes, fillByte) => {
          const corrupted = FIXTURE_BYTES.slice();
          const start = Math.max(0, corrupted.length - tailBytes);
          for (let i = start; i < corrupted.length; i++) corrupted[i] = fillByte;
          tally.add(await checkTrial(read, corrupted));
        },
      ),
      params(40),
    );
    // Starting value to calibrate: measured with this seed 9 read in 40 at the written
    // count, 33 in 200, 55 in 400.
    expect(tally.readShare, "share of tail fills that give a result").toBeGreaterThanOrEqual(0.08);
  });
});

describe("extractPdf - the exact corruption behind CI run 13 (06/09/2026)", () => {
  // Pinned, not random: bytes 500-689 filled with 0x54 once made pdf.js (removed on 01/11/2026) leak a rejection
  // nobody held. Kept so a change of reader behavior on this input surfaces here first.
  it("the corruption that leaked a floating pdf.js rejection gives a refusal of ours, the same way twice", async () => {
    const corrupted = FIXTURE_BYTES.slice();
    for (let i = 500; i < 690; i++) corrupted[i] = 0x54;
    expect(await checkTrial(read, corrupted)).toBe("refused");
  });
});

describe("extractPdf - content-stream corruption fuzzing", () => {
  it("overwriting a contiguous byte range anywhere gives a result or a refusal of ours, the same way twice", async () => {
    const tally = new OutcomeTally();
    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.integer({ min: 1, max: 200 }),
        fc.integer({ min: 0, max: 255 }),
        async (offsetFraction, runLength, fillByte) => {
          const corrupted = FIXTURE_BYTES.slice();
          const start = Math.max(0, Math.min(corrupted.length - 1, Math.floor(corrupted.length * offsetFraction)));
          const end = Math.min(corrupted.length, start + runLength);
          for (let i = start; i < end; i++) corrupted[i] = fillByte;
          tally.add(await checkTrial(read, corrupted));
        },
      ),
      params(50),
    );
    // Starting value to calibrate: measured with this seed 26 read in 50 at the written
    // count, 94 in 200, 225 in 500.
    expect(tally.readShare, "share of range fills that give a result").toBeGreaterThanOrEqual(0.25);
  });
});
