/** What OUR PDF reader lends the byte gate that stands in front of `pdf-lib` (`doc-gate/extractor/pdf-objstm-guard.ts`).
 *  Decides: nothing. It carries the reader's two ceilings, its decryption and its refusal across the package boundary, so that the
 *  gate can scan bytes without knowing what a PDF is (12/11/2026: « il reste a decouper ir et lib d'entrée hostile »).
 *  NOT here: the byte scan itself (the gate), what an object stream contains (`pdf-objects/`), the slicing (`pdf-scanned.ts`).
 *  Called by: `extractor/pdf-scanned.ts`, and the two test files of the gate. */

import type { ObjectStreamSource } from "doc-gate/extractor/pdf-objstm-guard";
import { MAX_DECODED_STREAM_BYTES, MAX_DOCUMENT_BYTES } from "./pdf-objects/bounds";
import type { PdfObjectsDocument } from "./pdf-objects/document";
import { PdfObjectsRefusal } from "./pdf-objects/refusal";

/** An object header, as `pdf-lib` reads one: any whitespace (NUL included) between tokens, numbers of any length. */
const OBJECT_HEADER = /(\d{1,10})[\s\0]+(\d{1,10})[\s\0]+obj/g;

/** The streams our reader decrypts for the object headers of `region`, in an encrypted file. An object that is not there or not a
 *  stream is skipped (a fake header); a refusal of our reader (an encryption it does not implement, AES) propagates: `pdf-lib`
 *  would decrypt what we cannot look at. */
function decryptedStreamsOf(doc: PdfObjectsDocument, region: string): Uint8Array[] {
  const streams: Uint8Array[] = [];
  for (const header of region.matchAll(OBJECT_HEADER)) {
    try {
      const value = doc.resolve({ kind: "ref", num: Number(header[1]), gen: Number(header[2]) });
      if (value?.kind === "stream") streams.push(doc.rawStreamBytes(value));
    } catch (error) {
      if (error instanceof PdfObjectsRefusal) throw error;
    }
  }
  return streams;
}

/** The reader's view of a file, as the gate needs it. Without a document — a file our reader could not open — nothing is
 *  decrypted and nothing is declared encrypted, exactly as before the cut. */
export const objectStreamSource = (doc?: PdfObjectsDocument): ObjectStreamSource => ({
  encrypted: doc?.trailer().has("Encrypt") === true,
  maxDecodedStreamBytes: MAX_DECODED_STREAM_BYTES,
  maxDocumentBytes: MAX_DOCUMENT_BYTES,
  decryptedStreams: (region) => (doc === undefined ? [] : decryptedStreamsOf(doc, region)),
  refuse: (reason) => new PdfObjectsRefusal(reason),
});
