/**
 * Operator-count cap per page (security, review of the PDF slice, 03/10/2026).
 * A content stream can inflate to hundreds of millions of operators: without a
 * bound, the walk saturates Forge's 512 MB or its 900 s, and the retry replays
 * the same bomb. The page read refuses the document BEFORE walking the operators.
 *
 * No giant file: the operator list of the real page is replaced by a fake that only carries a `length` (nothing is allocated).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReaderError } from "doc-ir";

const state = vi.hoisted(() => ({ fakeLength: undefined as number | undefined }));

vi.mock("./pdf-ops-ours", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pdf-ops-ours")>();
  return {
    ...actual,
    // Same document as production, but a page answers a fake list (a sparse array of that length) when `state.fakeLength` is set.
    ourOpsOfPage: vi.fn((...args: Parameters<typeof actual.ourOpsOfPage>) => {
      if (state.fakeLength === undefined) return actual.ourOpsOfPage(...args);
      const fake: unknown[] = [];
      fake.length = state.fakeLength;
      return fake as ReturnType<typeof actual.ourOpsOfPage>;
    }),
  };
});

import { MAX_CONTENT_OPS } from "./pdf-objects/bounds";
import { ourOpsOfPage } from "./pdf-ops-ours";
import { PDF_MAX_OPS_PER_PAGE, readPdfSource } from "./pdf-source";

const here = dirname(fileURLToPath(import.meta.url));
// Any ordinary document does: the ceiling is judged on the fake list, and the witness (c) on a page that keeps its operators
// when they are asked for. A made-up brochure of two pages.
const bytes = () => new Uint8Array(readFileSync(join(here, "../../fixtures/pdf/11-Brochure-Deux-Colonnes.pdf")));

describe("PDF_MAX_OPS_PER_PAGE : un flux de contenu gonflé est refusé avant d'être parcouru", () => {
  beforeEach(() => {
    state.fakeLength = undefined;
    vi.mocked(ourOpsOfPage).mockClear();
  });

  it("(a) la constante vaut 1_000_000, et le MÊME nombre que le plafond de notre lecteur", () => {
    // ARBITRARY threshold settled by on 31/10/2026: a "clear refusal" rather than a memory risk. It
    // was 3_000_000, and the security review of the same day showed that a RETAINED operator costs ~110 bytes and
    // not 48 — so the old figure allowed ~340 MB on a runtime that has 512.
    // The two ceilings are deliberately equal so that the two readers refuse the SAME page: it is this
    // equality that the test holds, not only the number.
    expect(PDF_MAX_OPS_PER_PAGE).toBe(1_000_000);
    expect(PDF_MAX_OPS_PER_PAGE).toBe(MAX_CONTENT_OPS);
  });

  it("(b) une page dont la liste d'opérateurs dépasse le plafond est refusée par notre erreur", async () => {
    state.fakeLength = PDF_MAX_OPS_PER_PAGE + 1;
    const error = await readPdfSource(bytes(), { wantOps: () => true }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ReaderError);
    const appError = error as ReaderError;
    // A safety refusal, which a caller must not retry (the retry would replay the same bomb): the application holds
    // with its own test that it treats this code as permanent.
    expect(appError.code).toBe("FILE_UNSAFE");
    // Composed by us: no library words, no content.
    expect(appError.message).toBe("the PDF has a page with too many drawing operations to be read");
  });

  it("(b ter) exactement au plafond : accepté, la page est lue", async () => {
    state.fakeLength = PDF_MAX_OPS_PER_PAGE;
    const source = await readPdfSource(bytes());
    expect(source.pages.length).toBeGreaterThan(0);
  });

  it("(c) témoin : une page normale se lit, ses opérateurs sont gardés", async () => {
    const source = await readPdfSource(bytes(), { wantOps: () => true });
    expect(source.pages.length).toBeGreaterThan(0);
    expect(source.pages.some((page) => page.ops.length > 0)).toBe(true);
  });
});
