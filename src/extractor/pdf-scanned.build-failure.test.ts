/**
 * A batch PDF that cannot be built fails BEFORE any vision call: the port (where the AI seat is taken, in the
 * orchestrator's gate) is never reached, so nothing is paid for a build that then fails.
 */

import { describe, expect, it } from "vitest";

import { FakeVisionPort } from "./pdf-fake-vision.test.support";
import { ocrScannedPages } from "./pdf-scanned";

describe("ocrScannedPages — batch build failure", () => {
  it("rejects without calling the vision port when the bytes are not a PDF", async () => {
    const vision = new FakeVisionPort();
    let calls = 0;
    vision.analyzeDocument = async () => {
      calls++;
      return [];
    };
    await expect(ocrScannedPages(new Uint8Array([1, 2, 3, 4]), [0, 1], vision)).rejects.toBeDefined();
    expect(calls).toBe(0);
  });
});
