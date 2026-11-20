/**
 * Fuzz testing — extractors, priority 1, vision path: the output of the model is what is deformed, through
 * FakeVisionPort.
 *
 * Real finding, FIXED same day (read, not guessed, then confirmed by direct
 * evaluation before writing a test around it, then fixed): `ocrScannedPages`'s
 * confidence gate (pdf-scanned.ts) used to be `pageResult.confidence <
 * LOW_CONFIDENCE_THRESHOLD` — a one-sided comparison. `NaN < 0.6` and
 * `Infinity < 0.6` both evaluate to `false` in JS, so a vision result with
 * `confidence: NaN` or `confidence: Infinity` (or any value `> 1`, e.g. a
 * numeric-overflow artifact) used to SILENTLY PASS the low-confidence gate
 * as "confident enough" — degraded content published in silence. `GeminiVisionPort`'s own schema check (`typeof
 * parsed.confidence !== "number"`) doesn't catch this either — `typeof NaN`
 * and `typeof Infinity` are both `"number"` in JS, and `1e400` is valid
 * JSON syntax that parses straight to `Infinity`. Fix: the gate now checks
 * confidence is IN RANGE (`>= threshold && <= 1`), not merely "not below
 * the floor" — bounded both sides, which rejects NaN for free too.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ReaderError } from "doc-ir";
import { FakeVisionPort } from "./pdf-fake-vision.test.support";
import { ocrScannedPages } from "./pdf-scanned";
import { fuzzRuns } from "../lib/pdf-fuzz-runs.test.support";

// A tiny real single-page PDF, built once — `ocrScannedPages` needs valid
// PDF bytes to slice a batch out of (pdf-lib), the vision RESULT is what's
// being fuzzed here, not the PDF structure itself (that's pdf.property.test.ts's job).
async function onePagePdfBytes(): Promise<Uint8Array> {
  const { PDFDocument } = await import("@cantoo/pdf-lib");
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  return doc.save();
}

describe("ocrScannedPages - regression: fixed silent accept of NaN/out-of-range confidence (STATUS.md 04/09/2026, found by fuzzing, fixed same day)", () => {
  it("a NaN or out-of-range confidence (Infinity, >1) is now correctly rejected via OCR_LOW_CONFIDENCE, never silently accepted", async () => {
    const bytes = await onePagePdfBytes();
    for (const badConfidence of [Number.NaN, Number.POSITIVE_INFINITY, 2, 1e400]) {
      const vision = new FakeVisionPort();
      // Override directly (pdf-scanned.test.ts's own established pattern) -
      // `buildBatchPdf` re-serializes via pdf-lib, so the batch bytes
      // `ocrScannedPages` actually sends are never byte-identical to the
      // original `bytes` - `setDocumentResult`'s exact-key matching would
      // never fire, silently falling back to its own empty-array default
      // and testing nothing (found this exact way while first writing this
      // test - a test bug, not a second real one).
      vision.analyzeDocument = async () => [{ text: "some transcribed text", confidence: badConfidence }];
      await expect(ocrScannedPages(bytes, [0], vision)).rejects.toBeInstanceOf(ReaderError);
    }
  });
});

describe("ocrScannedPages - confidence gate, fuzzed (fuzz: extractors priority 1, docs/FUZZ-TESTING.md [purged 27/09/2026, git history] §4, 'chemin vision')", () => {
  it("any confidence genuinely within [LOW_CONFIDENCE_THRESHOLD, 1] with non-empty text is accepted; anything else (including NaN/Infinity) is rejected via OCR_LOW_CONFIDENCE, never a raw crash", async () => {
    const bytes = await onePagePdfBytes();
    const confidenceArbitrary = fc.oneof(
      fc.double({ min: 0, max: 1, noNaN: true }), // valid range
      fc.double({ min: -1000, max: -0.001, noNaN: true }), // clearly too low
      fc.double({ min: 1.001, max: 1000, noNaN: true }), // clearly too high
      fc.constant(Number.NaN),
      fc.constant(Number.POSITIVE_INFINITY),
      fc.constant(Number.NEGATIVE_INFINITY),
    );
    await fc.assert(
      fc.asyncProperty(confidenceArbitrary, fc.string({ minLength: 1, maxLength: 20 }), async (confidence, text) => {
        const vision = new FakeVisionPort();
        vision.analyzeDocument = async () => [{ text, confidence }]; // see the test above for why not setDocumentResult
        const LOW_CONFIDENCE_THRESHOLD = 0.6; // mirrors pdf-scanned.ts's own constant
        // "Non-empty" means after `trim()`: `fc.string({ minLength: 1 })` produces strings of blanks, and a blank is
        // not OCR text (accepting it would publish an empty page as read).
        const shouldBeAccepted = confidence >= LOW_CONFIDENCE_THRESHOLD && confidence <= 1 && text.trim().length > 0;
        if (shouldBeAccepted) {
          await expect(ocrScannedPages(bytes, [0], vision)).resolves.toBeDefined();
        } else {
          await expect(ocrScannedPages(bytes, [0], vision)).rejects.toBeInstanceOf(ReaderError);
        }
      }),
      { numRuns: fuzzRuns(40, process.env) },
    );
  });

  it("une confiance PARFAITE sur du texte blanc est refusée — le cas que le hasard trouvait", async () => {
    // Pinned rather than left to the day's seed: the counter-example of the property above.
    const bytes = await onePagePdfBytes();
    for (const blanc of [" ", "\t", "\n", "   \t  "]) {
      const vision = new FakeVisionPort();
      vision.analyzeDocument = async () => [{ text: blanc, confidence: 1 }];
      await expect(ocrScannedPages(bytes, [0], vision), JSON.stringify(blanc)).rejects.toBeInstanceOf(ReaderError);
    }
  });
});
