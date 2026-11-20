/**
 * A PDF that cannot be opened (formerly pdf.js's `InvalidPDFException`) is a plain EXTRACT_FAILED: a failure, never published automatically (the user may
 * then choose « Attachment only »). A refusal already named passes intact.
 *
 * `vi.mock` of `./pdf-source` (the seam `openPdfSource` reads through) lets a test make the read throw an error of a given class; the
 * real read is kept by default. This file stays out of the shared-module `pdf` batch of `vitest.config.ts`.
 */
import { PDFDocument } from "@cantoo/pdf-lib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReaderError } from "doc-ir";
import { emptyExtractionCost } from "./extraction-cost";
import { openPdfSource } from "./pdf-open";
import { DOCUMENT_PAGE_LIMIT } from "./pdf-page-caps.test.support";

const state = vi.hoisted(() => ({ failure: undefined as Error | undefined }));

vi.mock("./pdf-source", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pdf-source")>();
  return {
    ...actual,
    readPdfSource: (...args: Parameters<typeof actual.readPdfSource>) => {
      if (state.failure !== undefined) return Promise.reject(state.failure);
      return actual.readPdfSource(...args);
    },
  };
});

afterEach(() => {
  state.failure = undefined;
});

const failureOf = async (bytes: Uint8Array): Promise<ReaderError> => {
  // The page ceiling is a caller's, asked for here by the test: the reader holds none of its own since 09/11/2026.
  const outcome = await openPdfSource(bytes, emptyExtractionCost(), DOCUMENT_PAGE_LIMIT).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(outcome, "the open must refuse").toBeInstanceOf(ReaderError);
  return outcome as ReaderError;
};

const named = (name: string, message = "simulated"): Error => Object.assign(new Error(message), { name });

describe("openPdfSource — a PDF pdf.js cannot open is a failure", () => {
  it("🔴 bytes that are not a PDF (the real InvalidPDFException) give EXTRACT_FAILED", async () => {
    expect((await failureOf(new Uint8Array([1, 2, 3, 4, 5]))).code as string).toBe("EXTRACT_FAILED");
  });

  it("🔴 an error of the class InvalidPDFException read inside the open gives EXTRACT_FAILED, and its words do not cross", async () => {
    state.failure = named("InvalidPDFException", "Invalid PDF structure SECRET-UPSTREAM-WORDS");
    const error = await failureOf(new Uint8Array([1, 2, 3]));
    expect(error.code as string).toBe("EXTRACT_FAILED");
    expect(error.message).not.toContain("SECRET-UPSTREAM-WORDS");
    expect(error.message).not.toContain("InvalidPDFException");
  });

  it("an UnknownErrorException (a page error, also a refused allocation) stays EXTRACT_FAILED", async () => {
    state.failure = named("UnknownErrorException");
    expect((await failureOf(new Uint8Array([1, 2, 3]))).code).toBe("EXTRACT_FAILED");
  });

  it("a plain TypeError inside the read (a bug of ours) stays EXTRACT_FAILED", async () => {
    state.failure = new TypeError("x is not a function");
    expect((await failureOf(new Uint8Array([1, 2, 3]))).code).toBe("EXTRACT_FAILED");
  });

  it("a password-protected document keeps DOCUMENT_PASSWORD_PROTECTED", async () => {
    state.failure = named("PasswordException");
    expect((await failureOf(new Uint8Array([1, 2, 3]))).code).toBe("DOCUMENT_PASSWORD_PROTECTED");
  });

  it("a document over the page cap keeps DOCUMENT_TOO_MANY_PAGES", async () => {
    const pdf = await PDFDocument.create();
    for (let i = 0; i < 16; i++) pdf.addPage();
    expect((await failureOf(await pdf.save())).code).toBe("DOCUMENT_TOO_MANY_PAGES");
  });
});
