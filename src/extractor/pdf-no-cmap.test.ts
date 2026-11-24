/**
 * Point 10 of the former ideas log (git history) v0.6 — fonts without a mapping table
 * (08/09/2026).
 *
 * WHAT WAS OBSERVED, AND IT WAS WORSE THAN STATED
 * ===============================================
 * The entry announced "noisy content that passes all the checks".
 * The measurement on `13-Police-Sans-CMap.pdf` (subset font, encoding with
 * opaque glyph names, NO `/ToUnicode`) gave three facts, two of
 * which the entry did not anticipate:
 *
 *  1. pdf.js rendered the **raw codes as control characters** —
 *     `\u0001\u0002\u0003\u0003\u0004 …` for "Rapport confidentiel 2026";
 *     neither an empty string, nor U+FFFD, nor printable symbols.
 *  2. The page was **not flagged as scanned** (the predicate tested
 *     `lines.length === 0`, yet it has lines), so it was never sent to
 *     OCR — whereas its visual rendering is intact and OCR is
 *     exactly the tool that can recover it.
 *  3. Seventeen control characters reached the **published XHTML**, hence
 *     the body of a request to the Confluence API. C0 characters are **forbidden in
 *     XML 1.0** (§2.2): an invalid document was being sent.
 *
 * TWO FIXES, AND ONE POINT THAT REMAINS OPEN
 * ==========================================
 *  - `lib/xml.ts` removes the characters forbidden at serialisation. The
 *    serialiser is responsible for never producing an invalid document,
 *    whatever the origin of the string (tests in `xml.test.ts`).
 *  - `pdf.ts#hasReadableText` replaces `lines.length === 0`. The predicate
 *    conflated "no text" and "no usable text"; a page without
 *    a single printable character has no text. It is a DEFINITION, not
 *    a threshold.
 *
 * ⚠️ **Point 10 is NOT closed.** The case handled is the total case: zero
 * readable characters. The PARTIAL case — real text mixed with noise, a page
 * of which only half the fonts are broken — requires a threshold ("from
 * what proportion do we switch to OCR?"), hence a product
 * arbitration, and it remains open.
 *
 * A note on ordering, which nearly escaped me: fixing XML validity alone
 * would have made the failure MORE silent, not less — the invalid XML would
 * probably have failed loudly on the API side, whereas an empty, valid page
 * goes out without anything flagging it. The two fixes are only worth anything together.
 *
 * This file belongs to the `pdf` batch of `vitest.config.ts` — it reads PDFs with our reader.
 * NOT here: the rendered page (that its XHTML carries no character forbidden in XML is held where the page is
 * rendered, by the publisher's application); only what the READER hands over.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { extractPdf } from "./pdf";

const here = dirname(fileURLToPath(import.meta.url));
const bytes = new Uint8Array(readFileSync(join(here, "../../fixtures/pdf/13-Police-Sans-CMap.pdf")));

describe("PDF without /ToUnicode — the page goes to OCR instead of publishing noise", () => {
  it("is flagged scanned, although it carries « lines » of text", async () => {
    const { scannedPageIndices } = await extractPdf(bytes);
    expect(scannedPageIndices).toEqual([0]);
  });

  it("produces no block — nothing noisy goes down the pipeline", async () => {
    const { pages } = await extractPdf(bytes);
    expect(pages).toEqual([[]]);
  });
});

describe("the predicate triggers ONLY on the total absence of readable text", () => {
  it("an ordinary digital PDF is never flagged scanned", async () => {
    // Non-regression safeguard: `hasReadableText` must not switch a healthy
    // document to OCR, which costs one vision call per page.
    const digital = new Uint8Array(readFileSync(join(here, "../../fixtures/pdf/05a-Rapport-Annuel-Digital.pdf")));
    const { scannedPageIndices } = await extractPdf(digital);
    expect(scannedPageIndices).toEqual([]);
  });

  it("a PDF whose text is intact despite ligatures stays digital", async () => {
    const ligatures = new Uint8Array(readFileSync(join(here, "../../fixtures/pdf/14-Ligatures-ToUnicode.pdf")));
    const { scannedPageIndices } = await extractPdf(ligatures);
    expect(scannedPageIndices).toEqual([]);
  });

  it("a PDF that embeds its fonts (18-Composition-Reelle) is not flagged scanned either", async () => {
    // The reader's half of the golden test of this document: the published door counts scanned pages and names none.
    const embedded = new Uint8Array(readFileSync(join(here, "../../fixtures/pdf/18-Composition-Reelle.pdf")));
    const { scannedPageIndices } = await extractPdf(embedded);
    expect(scannedPageIndices).toEqual([]);
  });
});
