/** What a pdf-lib document says about its own encryption — the ONE place that reads cantoo's object model for
 *  decryption, so that the decryption itself (`./pdf-decrypt.ts`) carries no library at all.
 *  Decides: nothing. It translates cantoo's `PDFDict`/`PDFString`/`PDFNumber` into the plain `StandardSecurity`
 *  data the standard handler takes, and names the three cases a document can be in (clear, readable,
 *  unsupported).
 *  WHY THIS FILE EXISTS (31/10/2026): `pdf-decrypt.ts` imported cantoo at module level, so
 *  anyone who only wanted to DECRYPT (our object reader, `pdf-objects/document.ts`) pulled cantoo
 *  into their graph. The DATA part is now alone in `./pdf-decrypt.ts`, and this half only serves
 *  the path that already reads with cantoo.
 *  NOT here: the standard security handler and its keys (`./pdf-decrypt.ts`), finding the image streams
 *  (`./pdf-embedded-images.ts`), decoding pixels (`./pdf-images.ts`).
 *  Called by: `./pdf-embedded-images.ts` and `./pdf-decrypt.test.ts`. */

import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFString, type PDFDocument } from "@cantoo/pdf-lib";

import { standardOutcome, type DecryptOutcome, type StandardSecurity } from "./pdf-decrypt";

const bytesOfEntry = (dict: PDFDict, key: string): Uint8Array | undefined => {
  const v = dict.get(PDFName.of(key));
  if (v instanceof PDFHexString || v instanceof PDFString) return v.asBytes();
  return undefined;
};

const numberOfEntry = (dict: PDFDict, key: string): number | undefined => {
  const v = dict.get(PDFName.of(key));
  return v instanceof PDFNumber ? v.asNumber() : undefined;
};

/**
 * What the document says about its encryption, and what can be done with it.
 *
 * ⚠️ The document must have been loaded with `ignoreEncryption: true`, otherwise
 * `pdf-lib` refuses to open it before this function can say anything about it.
 */
export function readStandardSecurity(doc: PDFDocument): StandardSecurity | "clear" | "unsupported" {
  const ctx = doc.context as unknown as { lookup: (x: unknown) => unknown; trailerInfo: { Encrypt?: unknown; ID?: unknown } };
  const encRaw = ctx.trailerInfo.Encrypt;
  if (encRaw === undefined) return "clear";
  const enc = ctx.lookup(encRaw);
  if (!(enc instanceof PDFDict)) return "unsupported";
  if (enc.get(PDFName.of("Filter"))?.toString() !== "/Standard") return "unsupported";

  const idArray = ctx.lookup(ctx.trailerInfo.ID);
  const idFirst = idArray instanceof PDFArray ? idArray.get(0) : undefined;
  const o = bytesOfEntry(enc, "O");
  const u = bytesOfEntry(enc, "U");
  const p = numberOfEntry(enc, "P");
  if (o === undefined || u === undefined || p === undefined) return "unsupported";
  if (!(idFirst instanceof PDFHexString || idFirst instanceof PDFString)) return "unsupported";

  return {
    v: numberOfEntry(enc, "V") ?? 0,
    r: numberOfEntry(enc, "R") ?? 0,
    lengthBits: numberOfEntry(enc, "Length") ?? 40,
    o,
    u,
    p,
    idFirst: idFirst.asBytes(),
    encryptMetadata: enc.get(PDFName.of("EncryptMetadata"))?.toString() !== "false",
  };
}

export function openDecryptorFor(doc: PDFDocument): DecryptOutcome {
  const security = readStandardSecurity(doc);
  if (security === "clear") return { kind: "clear" };
  if (security === "unsupported") return { kind: "unsupported" };
  return standardOutcome(security);
}
