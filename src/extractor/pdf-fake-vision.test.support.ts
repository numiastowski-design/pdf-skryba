/**
 * The deterministic stand-in for the vision port the PDF reader is given: a test sets the per-page results for given
 * document bytes, anything else answers an empty list, and every call is kept.
 * Decides: nothing about a reading. Never a network call, never randomness.
 * WHY HERE. The port is declared by the library (`doc-ir/lib/vision-port.ts`) and implemented by its caller; the
 * tests of the PDF reader need an implementation of their own, and may not take the application's.
 * NOT here: the contract (`doc-ir/lib/vision-port.ts`), nor any real model call.
 * Called by: the `pdf-scanned.*.test.ts` files.
 */

import type { VisionPort, VisionResult } from "doc-ir";
import type { BinaryRef } from "doc-ir/internal";

const keyOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

export class FakeVisionPort implements VisionPort {
  private readonly documentResults = new Map<string, VisionResult[]>();
  private readonly documentCalls: BinaryRef[] = [];

  /** Sets the per-page results returned the next time `analyzeDocument` is called with these exact bytes. */
  setDocumentResult(bytes: Uint8Array, results: VisionResult[]): void {
    this.documentResults.set(keyOf(bytes), results);
  }

  get documentCallCount(): number {
    return this.documentCalls.length;
  }

  get documentCalledWith(): readonly BinaryRef[] {
    return this.documentCalls;
  }

  async analyzeDocument(doc: BinaryRef): Promise<VisionResult[]> {
    this.documentCalls.push(doc);
    return this.documentResults.get(keyOf(doc.bytes)) ?? [];
  }
}
