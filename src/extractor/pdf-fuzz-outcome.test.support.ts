/**
 * What one fuzz trial of `extractPdf` must show, whatever the damaged bytes: a result, or a refusal of ours.
 * Decides: what counts as "a refusal of ours", which result fields must repeat on a second read, the closed set of
 * refusal messages, and the fixed seed of the PDF property tests.
 * NOT here: the mutations (the property test), the run counts (`lib/pdf-fuzz-runs.test.support.ts`).
 * Called by: `extractor/pdf.property.test.ts`, the document-level fuzz of lots 6 to 8.
 */

import { expect } from "vitest";
import { ReaderError } from "doc-ir";

import type { PdfExtractResult } from "./pdf-model";
import { PdfObjectsRefusal } from "./pdf-objects/refusal";

/** One seed for every PDF property: a red run replays as is (decision of 16/11/2026, question 1 of the fuzz design). */
export const PDF_FUZZ_SEED = 20261124;

export type PdfRead = (bytes: Uint8Array) => Promise<PdfExtractResult>;
export type TrialOutcome = "read" | "refused";

/** The messages a refusal may carry. All are ours: the generic one of `pdf-source.ts#openOrRefuse` and `pdf-open.ts`,
 *  or the one `PdfObjectsRefusal` composes from its closed reason (and an object number). */
const OUR_REFUSAL_MESSAGE = /^(?:the file is damaged or is not a valid PDF|pdf-objects: [a-z-]+(?: \(object \d+\))?)$/;

/** The refusal of ours behind an `EXTRACT_FAILED`: the error itself, or its `cause`. Undefined for a raw error of ours
 *  that a catch-all turned into `EXTRACT_FAILED` (`pdf-open.ts`), which is what this check exists to see. */
function refusalOf(error: ReaderError): PdfObjectsRefusal | undefined {
  if (error instanceof PdfObjectsRefusal) return error;
  const cause = (error as Error & { cause?: unknown }).cause;
  return cause instanceof PdfObjectsRefusal ? cause : undefined;
}

/** The fields of a result that must not change between two reads of the same bytes. Left out: `textSource`, which holds
 *  functions (compared by identity, never equal across reads); its runs are what `pages` publishes. */
function meaningfulOutput(result: PdfExtractResult): unknown {
  return {
    pages: result.pages,
    notices: result.notices,
    textUnreadByPage: [...result.textUnreadByPage],
    imageLossByPage: result.imageLossByPage,
    scannedPageIndices: result.scannedPageIndices,
    flattenedGridPages: result.flattenedGridPages,
    ocrLayerPageIndices: result.ocrLayerPageIndices,
    images: result.images,
    pagesOfImage: result.pagesOfImage,
    docFacts: result.docFacts,
    cost: result.cost,
  };
}

/** The refusal, reduced to what must repeat on a second read. */
function refusalSignature(error: unknown): unknown {
  if (!(error instanceof ReaderError)) return error;
  return { code: error.code, reason: refusalOf(error)?.reason, message: error.message };
}

async function settle(read: PdfRead, bytes: Uint8Array): Promise<{ result?: PdfExtractResult; error?: unknown }> {
  try {
    return { result: await read(bytes) };
  } catch (error) {
    return { error };
  }
}

/**
 * Reads the bytes twice and checks the lot 0 properties:
 * - a failure is a `ReaderError` `EXTRACT_FAILED` that carries a refusal of ours, with a message of ours;
 * - no page comes out without its text (`textUnreadByPage`: the catch-all of `pdf-source.ts#readPageText`);
 * - the second read gives the same result, or the same refusal.
 */
export async function checkTrial(read: PdfRead, bytes: Uint8Array): Promise<TrialOutcome> {
  const first = await settle(read, bytes);
  const second = await settle(read, bytes);
  if (first.result !== undefined) {
    expect([...first.result.textUnreadByPage], "a page came out without its text").toEqual([]);
    expect(second.result && meaningfulOutput(second.result), "a second read gave another result").toEqual(
      meaningfulOutput(first.result),
    );
    return "read";
  }
  const error = first.error;
  expectRefusalOfOurs(error);
  expect(refusalSignature(second.error), "a second read gave another refusal").toEqual(refusalSignature(error));
  return "refused";
}

/** A failure of `extractPdf` or `readPdfSource` is a `ReaderError` `EXTRACT_FAILED` that carries a refusal of ours,
 *  with a message of ours: never a raw error that a catch-all turned into `EXTRACT_FAILED`. */
export function expectRefusalOfOurs(error: unknown): void {
  expect(error).toBeInstanceOf(ReaderError);
  const named = error as ReaderError;
  expect(named.code).toBe("EXTRACT_FAILED");
  expect(
    refusalOf(named),
    "an EXTRACT_FAILED without a refusal of ours (a raw error caught by a catch-all)",
  ).toBeInstanceOf(PdfObjectsRefusal);
  expect(named.message).toMatch(OUR_REFUSAL_MESSAGE);
}

/** Counts the outcomes of a property's trials, to check its share of reads once fast-check is done. */
export class OutcomeTally {
  read = 0;
  refused = 0;
  add(outcome: TrialOutcome): void {
    this[outcome] += 1;
  }
  get readShare(): number {
    const total = this.read + this.refused;
    return total === 0 ? 0 : this.read / total;
  }
}
