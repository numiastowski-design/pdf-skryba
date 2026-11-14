/** The document read ONCE — its pages, its text, its glyphs, its signals —
 *  and the name given to a read that fails.
 *  NOT here: the reading of the file itself (`extractor/pdf-source.ts`,
 *  `extractor/pdf-table-detector.ts`), nor any decision on what was read.
 *  Called by: `extractor/pdf.ts`. */

import { NO_CAP } from "doc-ir/lib/reader-limits";
import { ReaderError } from "doc-ir/lib/reader-error";
import type { ExtractionCost } from "./extraction-cost";
import type { GlyphFragment } from "./glyph-positions";
import { readPdfSource, type PdfSource, type PdfTextRun } from "./pdf-source";
import { detectPdfPageSignals, type PdfPageSignals } from "./pdf-table-detector";

/** The open document and its text, or a NAMED error. */
export const openPdfSource = async (
  bytes: Uint8Array,
  cost: ExtractionCost,
  // NO CAP by default since 09/11/2026: the library imposes no page ceiling, the CALLER asks for one
  // (`core/document-caps.ts#PRODUCT_READER_LIMITS.pageLimit` is what Miksumia Publisher asks; the manual upload asks for none).
  pageLimit: number = NO_CAP,
  // Bench probes only (`readPdfSource`'s `firstPages`): read the first pages of a longer document instead of refusing it.
  firstPages?: number,
): Promise<{ source: PdfSource; items: PdfTextRun[][] }> => {
  let items: PdfTextRun[][];
  // HISTORICAL (pdf.js, removed on 01/11/2026): the proxy was HOISTED out of the try, because the same instance was then used to re-read the
  // operator list of the pages that carry a grid. Reopening the document gave a second pdf.js
  // instance — and two instances meant two configurations, hence the worker
  // version conflict measured on 09/09/2026. There is no proxy any more: a single opening, by our reader.
  let source: PdfSource;
  /** Whether one page of the document has text: read once, on the first page without runs (`PdfSourcePage.hasText`, the same reading as the `scanned-page` stage: a page whose runs hold one printable character). */
  let documentHasText: boolean | undefined;
  try {
    // ONE SINGLE READING OF THE DOCUMENT, AND IT IS BEHIND THE BOUNDARY
    // (14/09/2026). This file no longer calls pdf.js: neither
    // `getDocumentProxy`, nor `extractTextItems`, nor `getResolvedPDFJS`. The
    // detector receives the SAME reading, and the glyphs are rebuilt on
    // already-named operations — three pdf.js entries for one.
    //
    // `wantOps` names the operators of the pages WITH text, and — since 07/10/2026 — of a page without text when
    // another page has some: that page is no scan, its pictures are published (Mikolaj, 05/10/2026; `pdf-scanned.ts`).
    // A scan (no page with text) still pays for no operator at all. Known cost, accepted: when the AI is on, the
    // pictures of such a page are read, then dropped with the page the AI's text replaces; and a scan carrying an OCR
    // layer on one page and no text on the others pays the same for nothing, as does a PDF whose pages hold only control
    // characters (a font without a character map, fixture 13).
    // The glyphs are rebuilt on exactly the pages whose operators are named (`wantGlyphs` implies `wantOps`): one predicate.
    const wantsPage = (
      _pageIndex: number,
      runs: readonly PdfTextRun[],
      _allRuns: readonly (readonly PdfTextRun[])[],
      allHasText: readonly boolean[],
    ): boolean => runs.length > 0 || (documentHasText ??= allHasText.some(Boolean));
    source = await readPdfSource(bytes, {
      cost,
      // THE CEILING IS APPLIED BEFORE A SINGLE PAGE IS READ. A
      // refused document therefore pays for no extraction — that is the whole point
      // of a volume guard. The ceiling is the CALLER's (`pageLimit`, `NO_CAP` when it
      // asked for none): see `core/document-caps.ts#DOCUMENT_PAGE_LIMIT` for the
      // product's value and for why detection can NOT be done on the file size.
      onOpen: (pageCount) => {
        if (firstPages !== undefined) return;
        if (pageCount > pageLimit) {
          throw new ReaderError("DOCUMENT_TOO_MANY_PAGES", `pdf has ${pageCount} pages, limit is ${pageLimit}`, { pageCount });
        }
      },
      wantOps: wantsPage,
      wantGlyphs: wantsPage,
      firstPages,
    });
    items = source.pages.map((page) => page.runs);
  } catch (error) {
    // ⚠️ AN ALREADY-NAMED ERROR PASSES THROUGH UNTOUCHED (14/09/2026). This `catch` used to flatten ALL of them into `EXTRACT_FAILED`,
    // a cap refusal included: it became indistinguishable from a broken extraction and, worse, RETRIABLE although it is final. The
    // defect stayed invisible while nothing named came up from here; it showed at the first case and would have trapped the next one.
    if (error instanceof ReaderError) throw error;
    // 🔴 A PASSWORD-PROTECTED DOCUMENT IS REFUSED, AND NAMED (17/09/2026, Mikolaj's decision: "reject it outright"). pdf.js threw a
    // `PasswordException`: a CLASS name, composed by the dependency but bounded by construction, so readable to CLASSIFY. That is all
    // we took from it; its message did not cross. Our reader now refuses with the reason `encrypted` (`pdf-source.ts#openOrRefuse`);
    // the class-name test below stays for a failure that carries it.
    //
    // Not to be confused with the common case: an ENCRYPTED PDF whose user password is EMPTY opens without asking and syncs normally
    // (`pdf-decrypt.ts`). Here opening needs a secret nobody gave us; replaying changes nothing, so FINAL.
    if ((error as Error).name === "PasswordException") {
      throw new ReaderError("DOCUMENT_PASSWORD_PROTECTED", "this PDF is protected by a password");
    }
    // Upstream text never crosses (CLAUDE.md, provenance rule). Until 18/09/2026 the exception's class name did, and
    // "InvalidPDFException" on the dashboard told the admin nothing: the name is read to classify, then dropped, like the message.
    // A damaged file is a FAILURE, never published by itself (25/10/2026): the message proposes « Attachment only » and the user chooses.
    // pdf.js signed a PDF it could not open with `InvalidPDFException` (thrown at opening only), but no branch read it: the same code covers a
    // page error (`UnknownErrorException`, also given for a refused allocation, so possibly a hostile file), a bug of ours in this `try` and
    // our own refusals. Hence "may be damaged" in the text. The choice stays the user's: « Attachment only » is offered for any file under the caps.
    // Not judged: pdf.js's silent repair (rebuilt cross-reference table; removed with pdf.js); 0 case in 401 PDFs (24/10/2026), and its console was no interface.
    throw new ReaderError("EXTRACT_FAILED", "the file is damaged or is not a valid PDF");
  }
  return { source, items };
};

/** The glyph positions of ONE page: what `readPdfSource` rebuilt for it under `wantGlyphs`.
 *
 *  One path only (audit 07/10, P2-F22): the product passes the same predicate for `wantGlyphs` as for `wantOps` (the pages
 *  that carry text, or any page of a document that has some), so a scan still pays for no operator, and `glyphFragments` is
 *  counted by `readPdfSource`. A page whose glyphs could not be rebuilt (`buildGlyphFragments` refuses LOUDLY an operator it
 *  does not cover rather than guess) reads as `[]` here and keeps its reason in `PdfSourcePage.glyphsUnavailable`.
 *
 *  BIAS, chosen and written (Mikolaj, 06/10/2026, survey of disguised failures, point 3): such a page has no table recognised
 *  and is published as flat text. No word is lost, only the grid; the page never fails the document. The reason is never
 *  logged nor shown (error messages are composed by us; the upstream text is read to classify, then dropped). The guard is the
 *  corpus oracle (`pdf-source.oracle.test.ts`), which reads `glyphsUnavailable`. Measured 06/10/2026 over the 79 PDFs of
 *  fixtures/pdf and corpus-local: 0 page throws. */
export const glyphReader =
  (source: PdfSource) =>
  (pageIndex: number): GlyphFragment[] => {
    const page = source.pages[pageIndex];
    return page === undefined || page.glyphsUnavailable !== undefined ? [] : page.glyphs;
  };

// The same pass finds the tables AND the pages carrying an invisible OCR layer, which make the PDF a scan (05/10/2026). Until
// then a crash here fell back to « no signal » (flat text, never fatal); it now refuses the document: « nothing found » would
// read an OCR-layer scan as digital and publish the layer (review of cfe20d24, Mikolaj 05/10/2026). Measured the same day: the
// pass crashed on 0 of the 114 corpus PDFs it opens. The crash's own text is dropped (CLAUDE.md, error messages).
export const readPageSignals = async (bytes: Uint8Array, source: PdfSource, cost: ExtractionCost): Promise<PdfPageSignals> => {
  try {
    // The detector shares this reading: without it, it reopened the document and re-extracted all its text.
    return await detectPdfPageSignals(bytes, source, cost);
  } catch (error) {
    if (error instanceof ReaderError) throw error;
    throw new ReaderError("EXTRACT_FAILED", "PDF page signals could not be read");
  }
};
