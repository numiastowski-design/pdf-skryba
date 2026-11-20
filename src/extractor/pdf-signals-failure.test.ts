/**
 * When the page-signal pass crashes, nobody knows whether the PDF carries an OCR layer: the document is refused
 * (EXTRACT_FAILED) rather than read as digital, which would publish the layer (review of cfe20d24, 05/10/2026).
 * Measured the same day: the pass crashed on 0 of the 114 corpus PDFs it opens.
 *
 * Kept OUT of the `pdf` batch of `vitest.config.ts`: that batch shares its modules (`isolate: false`), where `vi.mock` never
 * applies. One small PDF: about 0.3 s.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { ReaderError } from "doc-ir";
import { extractPdf } from "./pdf";

vi.mock("./pdf-table-detector", async (original) => ({
  ...(await original<typeof import("./pdf-table-detector")>()),
  detectPdfPageSignals: async () => {
    throw new Error("simulated detector crash");
  },
}));

const here = dirname(fileURLToPath(import.meta.url));

describe("extractPdf — a crashed page-signal pass", () => {
  it("🔴 refuses the PDF with EXTRACT_FAILED instead of publishing an OCR layer it could not see", async () => {
    const bytes = new Uint8Array(readFileSync(join(here, "../../fixtures/pdf/12-Archive-OCR-Ancien.pdf")));
    const outcome = await extractPdf(bytes).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(ReaderError);
    expect((outcome as ReaderError).code).toBe("EXTRACT_FAILED");
  });
});
