/** The vision half of the PDF path: the pages with no digital text sent to OCR
 *  in batches, and the result merged back in page order.
 *  NOT here: the digital text layer (`extractor/pdf.ts`), the model call
 *  (`vision/**`), nor the budget that may refuse it
 *  (`orchestrator/doc-processor-ai-budget.ts`).
 *  Called by: `src/readers/dispatch.ts`, through the published door `lib/pdf.ts`. */

/**
 * pdf-scanned — the vision-backed half of the PDF path (MIKSUDOC « Spécification technique » §5.4:
 * "PDF scanné/mixte | pdf-lib : découpage en lots de pages → vision (Gemini)
 * par lots"). `pdf.ts`'s `extractPdf` only ever reads a PDF's digital text
 * layer and reports pages with none; this module OCRs those pages and merges
 * the result back in the right page order — needed for a mixed document
 * (the golden corpus of MIKSUDOC « Spécification fonctionnelle » §8 has one: `05d-Dossier-Mixte.pdf`, digital
 * page 0 + scanned pages 1-2).
 *
 * Gemini reads PDF pages natively — no page-to-image rasterization needed,
 * which matters here specifically: rasterizing would need `@napi-rs/canvas`,
 * a native (compiled) addon, a real risk in Forge's sandboxed Node runtime.
 * `pdf-lib` (pure JS) only slices out page *ranges* as small PDFs; Gemini
 * does the actual reading.
 *
 * The confidence/empty-text gates from §5.5 live HERE, not in the vision
 * port itself: `VisionPort.analyzeImage`/`analyzeDocument` have no way to
 * express "this is a whole scanned page, an empty result is a failure" vs "a
 * standalone image can legitimately be mute" — that distinction only exists
 * at this call site.
 */

import { chunk } from "../lib/chunk";
import { PDFDocument } from "@cantoo/pdf-lib";

import { ReaderError } from "doc-ir";
import type { ExtractOptions } from "../lib/reader-options";
import type { DocumentNotice } from "doc-ir";
import type { PdfTableDetection } from "../layout/geometry";
import type { IRBlock, IRDoc } from "doc-ir";
import type { VisionPort } from "doc-ir";
// The PDF shape, not the union of the three: naming the union would pull the declared formats' types into the
// published PDF package.
import type { PdfConservationSource } from "../pipeline/pdf-conservation-source";
import type { RawImage } from "doc-ir/internal";
import { extractPdf, pdfImageUnreadNotices, pdfTextUnreadNotices } from "./pdf";
import { openPdfObjects } from "./pdf-objects/document";
import { assertObjectStreamsBounded } from "./pdf-objstm-guard";
import { objectStreamSource } from "./pdf-objstm-source";
import { pdfPageTabs } from "./pdf-page-tabs";
import type { PdfDocumentFacts } from "./pdf-facts";

// Pages per Gemini call, not one call per page (spec: "par lots"). 10 pages per batch is the app's own
// choice, from the real 40-page scanned fixture (~5.3 MB / 40 pages, ~133 KB/page): most real documents
// (a handful of scanned pages, per the corpus) then fit in one batch. Heavy pages are cut by bytes below.
const BATCH_SIZE = 10;

// MIKSUDOC « Spécification technique » §5.5 default, calibrated in C1: "confidence < 0,6 sur un
// scan ⇒ OCR_LOW_CONFIDENCE, jamais de page quasi vide".
const LOW_CONFIDENCE_THRESHOLD = 0.6;

// Largest saved size of one batch PDF sent to the vision port (valeur de départ à calibrer). The app's own
// margin below the vision API's documented limits (docs/PLATFORM-STATUS.md §62); base64 inflates the payload by a
// third. A single page above it still goes alone.
export const OCR_BATCH_MAX_BYTES = 12_000_000;

/** OCR'd page text has no structural markers at all (not even the line
 *  geometry `pdf.ts` uses for a digital PDF) — a blank line is the only
 *  paragraph-break signal a model's transcription can be expected to
 *  preserve consistently, so that's what's used here. */
export const textToParagraphs = (text: string): IRBlock[] =>
  text
    .split(/\n{2,}/)
    .map((p) =>
      p
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .join(" "),
    )
    .filter((p) => p.length > 0)
    .map((p) => ({ kind: "paragraph" as const, inlines: [{ text: p }] }));

/** Copies `pageIndices` of the already-parsed `source` into a fresh PDF. The source is parsed once per document
 *  (in `ocrScannedPages`), not once per batch: a split-heavy document builds many batches. */
const buildBatchPdf = async (source: PDFDocument, pageIndices: number[]): Promise<Uint8Array> => {
  const out = await PDFDocument.create();
  const copiedPages = await out.copyPages(source, pageIndices);
  for (const page of copiedPages) out.addPage(page);
  return out.save();
};

/** Builds the batch PDF for `pages` and, when it exceeds `OCR_BATCH_MAX_BYTES` with more than one page,
 *  splits the pages in two halves recursively. Page order is kept: the batches come out in reading order. */
const boundedBatches = async (
  source: PDFDocument,
  pages: number[],
): Promise<{ pages: number[]; bytes: Uint8Array }[]> => {
  const batchBytes = await buildBatchPdf(source, pages);
  if (batchBytes.length <= OCR_BATCH_MAX_BYTES || pages.length === 1) return [{ pages, bytes: batchBytes }];
  const half = Math.ceil(pages.length / 2);
  return [
    ...(await boundedBatches(source, pages.slice(0, half))),
    ...(await boundedBatches(source, pages.slice(half))),
  ];
};

/** Every batch of `pageIndices`, built before any vision call. The parsed source lives only in here, so it can be collected
 *  while the vision calls run; no page, no parse. */
const planBatches = async (
  bytes: Uint8Array,
  pageIndices: number[],
): Promise<{ pages: number[]; bytes: Uint8Array }[]> => {
  if (pageIndices.length === 0) return [];
  // An owner-password-only PDF (empty user password) opens in our reader; an empty password lets pdf-lib decrypt it, so the batch is
  // readable. `ignoreEncryption` would copy the pages still encrypted into an unencrypted batch (noise sent to the AI).
  // `pdf-lib` inflates every object stream of the file with none of our bounds: the bytes are checked first (`pdf-objstm-guard.ts`).
  await assertObjectStreamsBounded(bytes, objectStreamSource(openPdfObjects(bytes)));
  const source = await PDFDocument.load(bytes, { password: "" });
  const batches: { pages: number[]; bytes: Uint8Array }[] = [];
  for (const group of chunk(pageIndices, BATCH_SIZE)) batches.push(...(await boundedBatches(source, group)));
  return batches;
};

/** OCRs every page in `pageIndices` (0-based, the `scannedPageIndices` of
 *  MIKSUDOC « Spécification technique » §5.5) and returns its blocks, keyed by that same index —
 *  so a caller merging into a mixed digital/scanned document can substitute
 *  the right pages without losing page order.
 *
 *  Throws `ReaderError("OCR_LOW_CONFIDENCE")` — aborting the whole call, not
 *  just the offending page — the moment any page fails the confidence/empty
 *  gate: MIKSUDOC « Spécification fonctionnelle » §6.8's "unreadable scan fails loudly" scenario is a
 *  whole-document outcome (the failure queue, a single diagnosis), matching
 *  the granularity DocState already models (no partial-document state).
 *
 *  NO FALLBACK, AND NO EXCEPTION (02/10/2026). A failed reading never falls back on an invisible OCR layer: since
 *  05/10/2026 a page carrying one belongs to a scan, whose whole document is read here, and the layer is never published. */
export const ocrScannedPages = async (
  bytes: Uint8Array,
  pageIndices: number[],
  vision: VisionPort,
  opts?: { languages?: string[] },
): Promise<Map<number, IRBlock[]>> => {
  const results = new Map<number, IRBlock[]>();
  const visionOpts = opts?.languages ? { languages: opts.languages } : undefined;
  for (const { pages: batch, bytes: batchBytes } of await planBatches(bytes, pageIndices)) {
    const pageResults = await vision.analyzeDocument({ bytes: batchBytes, mimeType: "application/pdf" }, visionOpts);
    if (pageResults.length !== batch.length) {
      throw new ReaderError(
        "OCR_LOW_CONFIDENCE",
        `vision returned ${pageResults.length} page results for a ${batch.length}-page batch`,
      );
    }
    batch.forEach((pageIndex, i) => {
      const pageResult = pageResults[i];
      // Fuzz finding, fixed 04/09/2026 (STATUS.md): a one-sided `confidence
      // < LOW_CONFIDENCE_THRESHOLD` check silently let NaN and any
      // confidence > 1 (Infinity, a numeric-overflow artifact from a
      // response like `1e400`) through as "confident enough" — both
      // `NaN < 0.6` and `Infinity < 0.6` are `false` in JS. A genuinely
      // trustworthy confidence must be IN RANGE, not merely "not below the
      // floor" — bounded on both sides now, which also rejects NaN for
      // free (every comparison against NaN is false, so the bounded check
      // itself evaluates false, and the surrounding `!` flips that to a
      // reject).
      const confidenceInRange =
        pageResult !== undefined && pageResult.confidence >= LOW_CONFIDENCE_THRESHOLD && pageResult.confidence <= 1;
      if (!pageResult || !confidenceInRange || pageResult.text.trim().length === 0) {
        throw new ReaderError(
          "OCR_LOW_CONFIDENCE",
          `page ${pageIndex}: confidence=${pageResult?.confidence ?? "n/a"}, textLength=${pageResult?.text.length ?? 0}`,
        );
      }
      results.set(pageIndex, textToParagraphs(pageResult.text));
    });
  }
  return results;
};

/** 🔴 A FILE NO PAGE OF WHICH COULD BE READ IS NOT PUBLISHED (17/11/2026: « on ne publie pas un fichier illisible »): no page
 *  has text, at least one is unread, and the AI will not read them (`aiOff`). Refused as a file that could not be read — not
 *  as a scan, even when the other pages are scans (no pictures of scans beside empty tabs). With the AI on, every page sent
 *  comes back with text or the reading fails as a whole (`ocrScannedPages`), so nothing is left to refuse after it. */
function refuseUnreadFile(aiOff: boolean, nothingHasText: boolean, unreadPageCount: number): void {
  if (aiOff && nothingHasText && unreadPageCount > 0)
    throw new ReaderError("EXTRACT_FAILED", "no page of the PDF could be read");
}

type PdfExtraction = Awaited<ReturnType<typeof extractPdf>>;

/** The error a failed AI reading becomes: its own code kept, the file's counts carried; another error is `cause`. */
const aiReadingFailure = (error: unknown, counts: { pageCount: number; scannedPageCount: number }): ReaderError =>
  error instanceof ReaderError
    ? new ReaderError(error.code, error.message, counts)
    : new ReaderError("UNKNOWN", "the AI reading failed", counts, { cause: error });

/** For the text-conservation check on the publish path: the digital text as read, and the pages whose runs are not
 *  text we can check (`toRead`: a scan's layer is not published). */
const conservationSourceOf = (
  textSource: PdfExtraction["textSource"],
  toRead: readonly number[],
): PdfConservationSource => ({
  runs: textSource.runs,
  deliberateRemovals: textSource.deliberateRemovals,
  excludedPages: new Set(toRead),
  // The tabs are checked tab by tab (`pipeline/tab-conservation.ts`).
  deliberateRemovalsByPage: textSource.deliberateRemovalsByPage,
  // The second reading of the letters control, beside the word verdict (`pipeline/letter-conservation.ts`).
  letters: textSource.reference,
});

/** The loss notices and the pictures kept once the AI's text replaced the pages of `replaced`. */
const keptAfterAiReading = (
  replaced: ReadonlySet<number>,
  images: PdfExtraction["images"],
  pagesOfImage: PdfExtraction["pagesOfImage"],
  imageLossByPage: PdfExtraction["imageLossByPage"],
  textUnreadByPage: PdfExtraction["textUnreadByPage"],
): { keptNotices: DocumentNotice[] | undefined; keptImages: PdfExtraction["images"] } => {
  // A page whose text could not be read and that the AI read is no loss either (16/11/2026).
  const keptLosses = [
    ...(pdfImageUnreadNotices(imageLossByPage, replaced) ?? []),
    ...(pdfTextUnreadNotices(textUnreadByPage, replaced) ?? []),
  ];
  const keptNotices = keptLosses.length > 0 ? keptLosses : undefined;
  const keptImages = images?.filter((image) => {
    const placedOn = pagesOfImage?.get(image.sha256);
    return placedOn === undefined || [...placedOn].some((pageIndex) => !replaced.has(pageIndex));
  });
  return { keptNotices, keptImages };
};

/** Full PDF path, digital + scanned/mixed (MIKSUDOC « Spécification technique » §5.4): extracts the
 *  digital text layer, OCRs whichever pages have none, and merges both in
 *  original page order — one flat IRDoc, matching MIKSUDOC « Spécification fonctionnelle » §6.8 ("the
 *  published page contains the recognized text of all N pages", no
 *  per-source-page sections, digital or scanned alike).
 *
 *  `tableDetections` (docs/ARBITRAGE-TABLEAUX-PDF.md [purged 27/09/2026, git history] §8, jalon 1/2) passes
 *  through from `extractPdf` unchanged — computed once there, against the
 *  digital text layer only (a scanned page has none, so it never
 *  contributes one), never recomputed here. `dispatch.ts` sources its own
 *  dashboard-signal copy from THIS return value now, rather than a second,
 *  separate detection pass over the same bytes. */
export const extractPdfWithVision = async (
  bytes: Uint8Array,
  vision: VisionPort,
  opts?: ExtractOptions,
): Promise<{
  doc: IRDoc;
  images?: RawImage[];
  tableDetections?: PdfTableDetection[];
  /** The notices of `extractPdf`, passed through — after an AI reading, its `pdf-image-unread` and `pdf-text-unread`
   *  notices composed again without the pages the AI's text replaced; absent when there is none. */
  notices?: DocumentNotice[];
  /** The document's page count, known on opening (the row says « 12 pages »). */
  pageCount: number;
  /** How many pages are scanned, read or not: the pages with NO text at all, or every page of a scan carrying an invisible
   *  OCR layer (the AI reads them all, 05/10/2026). Absent when none: a digital PDF. */
  scannedPages?: number;
  /** What the file says about itself (`pdf-facts.ts`), passed through from `extractPdf`. */
  docFacts: PdfDocumentFacts;
  conservationSource: PdfConservationSource;
}> => {
  const {
    pages,
    images,
    pagesOfImage,
    scannedPageIndices,
    ocrLayerPageIndices,
    tableDetections,
    textSource,
    docFacts,
    notices,
    imageLossByPage,
    textUnreadByPage,
  } = await extractPdf(bytes, opts?.pageLanguage, opts?.limits === undefined ? undefined : { limits: opts.limits });
  const language = opts?.pageLanguage ?? "en";
  const pageCount = pages.length;
  // 🔴 A SCAN (05/10/2026): a PDF whose EVERY page has no text (one page included: a diagram exported as a picture
  // reads the same), or that carries an invisible OCR layer on ANY page. A PDF has no « scan » marker, and the scanner's own
  // OCR is often wrong (« 12 OOO EUROS »): that layer is never published. A document with text and a few pages with none
  // (a cover, a diagram) is NOT a scan: its pages without text are read when the AI is on, else published as they are.
  // 🔴 AN UNREAD PAGE IS NEVER A SCAN (16/11 then 17/11/2026, docs/CONCEPTION-AVIS-TEXTE-PDF.md): a page with no text
  // because its text could not be READ (`textUnreadByPage`) still goes to the AI when the AI is on (it is in
  // `scannedPageIndices`), but it makes no PDF a scan and is counted in no « scanned » figure; its loss is said by a
  // `pdf-text-unread` notice.
  const unreadPages = scannedPageIndices.filter((pageIndex) => textUnreadByPage.has(pageIndex));
  const hasOcrLayer = (ocrLayerPageIndices?.length ?? 0) > 0;
  const nothingHasText = pageCount > 0 && scannedPageIndices.length === pageCount;
  const isScan = (nothingHasText && unreadPages.length === 0) || hasOcrLayer;
  // The AI reads the WHOLE scan, so the whole scan is « scanned »; else only the pages without text. `readAll` (the « Convert with AI »
  // mode, 19/10/2026) sends every page of a PDF that has text too: the AI's text replaces the text layer (never when `ocr` is false).
  const readAll = opts?.readAll === true && opts.ocr !== false;
  const toRead = isScan || readAll ? pages.map((_, pageIndex) => pageIndex) : scannedPageIndices;
  // For the text-conservation check on the publish path: the digital text as
  // read, and the pages whose runs are not text we can check (a scan's layer is not published).
  const conservationSource = conservationSourceOf(textSource, toRead);
  // What the row says: the pages with no text at all, unread pages left out (the upload's rule « too many scans » reads it,
  // `core/document-caps.ts#refusesScannedUpload`) — not the pages the AI was asked to read. A PDF with an invisible OCR layer
  // counts every page, as the AI reads them all (05/10/2026), its unread pages excepted (17/11/2026).
  const scannedPages = (hasOcrLayer ? pageCount : scannedPageIndices.length) - unreadPages.length;
  // The one shape of the answer; the three exits differ only by the blocks, the pictures and notices kept, and the scan count.
  const result = (
    blocks: IRDoc,
    kept: { images: typeof images; notices: typeof notices },
    extra: { scannedPages?: number } = {},
  ) => ({
    doc: blocks,
    ...(kept.images ? { images: kept.images } : {}),
    ...(tableDetections ? { tableDetections } : {}),
    ...(kept.notices ? { notices: kept.notices } : {}),
    pageCount,
    ...extra,
    docFacts,
    conservationSource,
  });
  if (toRead.length === 0) return result(pdfPageTabs(pages, language, opts?.labels), { images, notices });
  const scanned = scannedPages > 0 ? { scannedPages } : {};

  refuseUnreadFile(opts?.ocr === false, nothingHasText, unreadPages.length);

  // 🔴 OCR IS ON REQUEST (01/10/2026): the sync passes `ocr: false` and publishes what the file gives, except a scan,
  // which is refused until the AI reads it (03/10 then 05/10/2026). One page limit serves every PDF
  // (`DOCUMENT_PAGE_LIMIT`, in `extractPdf`): a scan has none of its own.
  if (opts?.ocr === false && isScan && opts.scanAsImages !== true) {
    throw new ReaderError("SCANNED_PDF_NEEDS_AI_OCR", `${scannedPages} scanned pages, AI OCR is off`, {
      pageCount,
      scannedPageCount: scannedPages,
    });
  }
  // The pages without text are published as they are, their pictures included (`pdf-page-stages.ts`, 07/10/2026).
  if (opts?.ocr === false) {
    return result(pdfPageTabs(pages, language, opts?.labels), { images, notices }, scanned);
  }

  // A refused or failed reading keeps its code and carries the file's counts (the row still offers its AI switch). What the OCR
  // service itself threw is not ours: our sentence replaces its text, and the error rides as `cause` for the caller to classify
  // (the app keeps the code of its own `AppError`, `core/reader-bridge.ts`); this library reads nothing of it.
  const ocrByPage = await ocrScannedPages(bytes, toRead, vision, opts).catch((error: unknown) => {
    throw aiReadingFailure(error, { pageCount, scannedPageCount: scannedPages });
  });
  const merged = pages.map((digitalBlocks, pageIndex) => ocrByPage.get(pageIndex) ?? digitalBlocks);
  // The images of a page the AI's text replaced were never to be published: not counted as lost, and not published
  // (they were read with the page, `pdf-open.ts`; one also placed on a kept page stays).
  const { keptNotices, keptImages } = keptAfterAiReading(
    new Set(ocrByPage.keys()),
    images,
    pagesOfImage,
    imageLossByPage,
    textUnreadByPage,
  );
  return result(
    pdfPageTabs(merged, language, opts?.labels),
    { images: keptImages && keptImages.length > 0 ? keptImages : undefined, notices: keptNotices },
    scanned,
  );
};
