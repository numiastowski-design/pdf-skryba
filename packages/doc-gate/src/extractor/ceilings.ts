/** What an inflated zip-based document may weigh, and nothing else.
 *  Decides: the two ceilings every OOXML reader is judged against, and the gate reads before it inflates anything
 *  (`attachment-safety.ts`).
 *  NOT here: how a part is read or inflated (`zip/zip-package.ts`, `extractor/ooxml/package.ts` in the app), nor any
 *  format knowledge.
 *  Called by: `attachment-safety.ts`, `extractor/ooxml/package.ts`, which re-exports both for its own readers.
 *  They live here since 12/11/2026 (« il reste a decouper ir et lib d'entrée hostile ») because the gate
 *  must know them WITHOUT importing a reader: a ceiling is the first thing read about a hostile file. */

/** Inflated bytes one part may reach. Starting value to calibrate (review of
 *  27/09/2026 night, finding 2): the heaviest real document the repository
 *  knows weighs ~15 MB whole; a binary is downloaded up to 50 MB (T9), and a
 *  part inflating past 64 MB is a decompression bomb, not a document. */
export const PART_MAX_BYTES = 64_000_000;

/** Inflated bytes the whole package may reach, every read counted (a part
 *  read twice counts twice). Starting value to calibrate: four parts at the
 *  per-part ceiling — far above any real document, far below what one
 *  invocation can hold. */
export const PACKAGE_MAX_BYTES = 256_000_000;
