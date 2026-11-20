/**
 * Characterisation (12/10/2026): the `languages` hint reaches the vision port as `{ languages }` when it is set (an empty
 * list included), and as nothing when it is not, from both `ocrScannedPages` and `extractPdfWithVision`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { VisionResult } from "doc-ir";
import type { BinaryRef } from "doc-ir/internal";
import { FakeVisionPort } from "./pdf-fake-vision.test.support";
import { extractPdfWithVision, ocrScannedPages } from "./pdf-scanned";

const here = dirname(fileURLToPath(import.meta.url));
const scan = () => new Uint8Array(readFileSync(join(here, "../../fixtures/pdf/05c-Scan-Illisible.pdf")));

class RecordingVision extends FakeVisionPort {
  readonly seen: unknown[] = [];
  override async analyzeDocument(_doc: BinaryRef, options?: { languages?: string[] }): Promise<VisionResult[]> {
    this.seen.push(options);
    return [{ text: "read", confidence: 0.95 }];
  }
}

const recording = (): { vision: RecordingVision; seen: unknown[] } => {
  const vision = new RecordingVision();
  return { vision, seen: vision.seen };
};

describe("the languages hint given to the vision port", () => {
  it.each([
    ["a list", ["fr", "en"], [{ languages: ["fr", "en"] }]],
    ["an empty list", [], [{ languages: [] }]],
    ["nothing", undefined, [undefined]],
  ])("ocrScannedPages, %s", async (_name, languages, expected) => {
    const { vision, seen } = recording();
    await ocrScannedPages(scan(), [0], vision, languages === undefined ? undefined : { languages });
    expect(seen).toEqual(expected);
  });

  it.each([
    ["a list", ["fr", "en"], [{ languages: ["fr", "en"] }]],
    ["an empty list", [], [{ languages: [] }]],
    ["nothing", undefined, [undefined]],
  ])("extractPdfWithVision, %s", async (_name, languages, expected) => {
    const { vision, seen } = recording();
    await extractPdfWithVision(scan(), vision, languages === undefined ? {} : { languages });
    expect(seen).toEqual(expected);
  });
});
