/** The one light check of the « Attachment only » mode, which reads nothing else (25/10/2026, option B): for a zip-based Office
 *  file, the sizes the central directory DECLARES are compared with the ceilings the readers use (`PART_MAX_BYTES`, `PACKAGE_MAX_BYTES`,
 *  one definition in `ooxml/package.ts`). Nothing is inflated; local headers and the directory are all that is read. Past a ceiling,
 *  or for the overlapping-entries bomb, the file is refused `FILE_UNSAFE`. A zip our layer refuses for any other reason is merely damaged
 *  (not hostile): the user asked for the file as it is, so it passes.
 *  NOT here: inflating or reading any part (`zip/zip-package.ts`, the readers), the failure record (`orchestrator/doc-processor.ts`).
 *  Called by: `orchestrator/doc-processor.ts`. */
import { ReaderError } from "doc-ir/lib/reader-error";
import { PACKAGE_MAX_BYTES, PART_MAX_BYTES } from "./ceilings";
import { ENTRIES_OVERLAP_REASON } from "./zip/local-headers";
import { openZip } from "./zip/zip-package";

const unsafe = (reason: string): ReaderError =>
  new ReaderError("FILE_UNSAFE", `the file is refused for safety: ${reason}`);

/** Throws `FILE_UNSAFE` when the zip's declared sizes pass a ceiling; returns otherwise (also for bytes that are no readable zip). */
export function assertZipDeclaredSizesSafe(bytes: Uint8Array): void {
  let zip: ReturnType<typeof openZip>;
  try {
    zip = openZip(bytes, { partMaxBytes: PART_MAX_BYTES, packageMaxBytes: PACKAGE_MAX_BYTES });
  } catch (e) {
    if (e instanceof ReaderError && e.message.endsWith(ENTRIES_OVERLAP_REASON)) throw unsafe("overlapping entries");
    if (e instanceof ReaderError) return;
    throw e;
  }
  let total = 0;
  for (const name of zip.names) {
    const declared = zip.sizeOf(name) ?? 0;
    if (declared > PART_MAX_BYTES) throw unsafe("a part declares a size past the per-part ceiling");
    total += declared;
    if (total > PACKAGE_MAX_BYTES) throw unsafe("the parts declare a size past the package ceiling");
  }
}
