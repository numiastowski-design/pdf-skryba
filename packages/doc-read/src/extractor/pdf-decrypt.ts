/** Standard PDF decryption, to recover a stream exactly as it was written —
 *  what pdf-lib does not give on its own (nor did pdf.js, now removed). WITHOUT ANY LIBRARY: this file only takes
 *  data (`StandardSecurity`), which is exactly what a caller without cantoo needs — our
 *  object reader. The reading of cantoo's model lives next door (`./pdf-decrypt-pdflib.ts`, split off on
 *  31/10/2026: importing this file pulled cantoo into the graph of whoever only wanted to decrypt).
 *  NOT here: what the document SAYS about its encryption (`./pdf-decrypt-pdflib.ts` for cantoo,
 *  `./pdf-objects/document.ts#securityOf` for our reader), finding the image streams
 *  (`extractor/pdf-embedded-images.ts`), nor decoding pixels (`extractor/pdf-images.ts`).
 *  A PDF encrypted for its permissions only ("no copy", opens with no password) IS published (05/10/2026).
 *  Called by: `./pdf-decrypt-pdflib.ts`, `./pdf-objects/document.ts`. */

/**
 * THE STANDARD DECRYPTION OF A PDF, to recover a stream AS IT WAS
 * WRITTEN (17/09/2026).
 *
 * Why this module exists: `pdf-lib` opens an encrypted document but does not
 * decrypt it, and `pdf.js` (now removed) decrypted but only returned DECODED PIXELS. Neither
 * gave the original stream. Without it, republishing the image of an
 * encrypted PDF goes through a PNG re-encoding: measured on a real payslip,
 * 127,825 bytes against 33,500 for the original JPEG, and a loss of fidelity
 * on top. With it, the republished image IS the original image, byte for byte.
 *
 * Assumed scope: **the standard handler, EMPTY user password**
 * — the case of the documents entrusted to us, those that open without asking
 * for anything. A document really protected by a password is not
 * decrypted, and must not be: we abstain, the caller keeps its fallback.
 *
 * ⚠️ AES (`/V` 4 or 5, `AESV2`/`AESV3`) IS NOT HANDLED. This is not an oversight:
 * no document of the corpus uses it, and an implementation that cannot
 * be checked against a real file would be a guess disguised as code. The
 * day such a PDF arrives, it is added here with it as a fixture.
 *
 * Algorithms 1 and 2 of the standard handler, as specified. No
 * tuning, no guessed constant: the padding string below is
 * the one from the specification, and the 50 iterations as well as the truncation to
 * `Length/8` are its rules for `/R >= 3`.
 */

import { createHash } from "node:crypto";

/** The padding string of the standard handler — 32 bytes, fixed by the
 *  specification. It serves as the password when the user has none. */
const PADDING = new Uint8Array([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00,
  0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

interface PdfDecryptor {
  /** The stream of object `(num, gen)`, decrypted. */
  decryptStream(num: number, gen: number, data: Uint8Array): Uint8Array;
}

/** What opening an encrypted document can give. Four cases, named:
 *  a plaintext document has nothing to decrypt; an EMPTY password
 *  decrypts; a REAL password is refused; an algorithm we do not handle
 *  leaves the caller on its fallback, without claiming anything else. */
export type DecryptOutcome =
  | { kind: "clear" }
  | { kind: "decryptor"; decryptor: PdfDecryptor }
  | { kind: "password-protected" }
  | { kind: "unsupported" };

export interface StandardSecurity {
  /** The document's algorithm. Only `1` and `2` (RC4) are handled here. */
  v: number;
  r: number;
  lengthBits: number;
  o: Uint8Array;
  p: number;
  idFirst: Uint8Array;
  encryptMetadata: boolean;
  /** Serves ONLY to check that the user password is empty. */
  u: Uint8Array;
}

const md5 = (...parts: Uint8Array[]): Uint8Array => {
  // eslint-disable-next-line sonarjs/hashing -- MD5 is mandated by the PDF standard security handler (key derivation), not chosen for security.
  const h = createHash("md5");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};

/** `/P` is a SIGNED 32-bit integer, written little-endian. Real documents
 *  carry it negative (`-1340` here): reading it unsigned would give a wrong key
 *  without anything saying so. */
const p32le = (p: number): Uint8Array => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, p | 0, true);
  return out;
};

/** RC4, written here rather than borrowed from `node:crypto`: OpenSSL 3 puts it in
 *  its "legacy" provider, disabled by default, so `createDecipheriv`
 *  would fail depending on how Node was built. Twenty deterministic lines
 *  are worth more than a dependency on a build option. */
function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i]! + key[i % key.length]!) & 0xff;
    [s[i], s[j]] = [s[j]!, s[i]!];
  }
  const out = new Uint8Array(data.length);
  let a = 0;
  let b = 0;
  for (let k = 0; k < data.length; k++) {
    a = (a + 1) & 0xff;
    b = (b + s[a]!) & 0xff;
    [s[a], s[b]] = [s[b]!, s[a]!];
    out[k] = data[k]! ^ s[(s[a]! + s[b]!) & 0xff]!;
  }
  return out;
}

/** Algorithm 2: the document key, derived from an EMPTY user password
 *  — hence from the padding string alone. */
function documentKey(s: StandardSecurity): Uint8Array {
  const n = s.r === 2 ? 5 : Math.floor(s.lengthBits / 8);
  const parts: Uint8Array[] = [PADDING, s.o, p32le(s.p), s.idFirst];
  if (s.r >= 4 && !s.encryptMetadata) parts.push(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
  let hash = md5(...parts);
  if (s.r >= 3) {
    // 50 iterations over the first n bytes, not over the whole digest.
    for (let i = 0; i < 50; i++) hash = md5(hash.subarray(0, n));
  }
  return hash.subarray(0, n);
}

/** Algorithm 5: the `/U` value that an EMPTY password would produce. If it does
 *  not match the document's, a real password exists —
 *  and it is the ONLY way to know: nothing in the dictionary says
 *  "protected". Without this check, we would decrypt with a wrong key
 *  and return plausible, wrong bytes, exactly what this repository refuses
 *  elsewhere. */
function emptyPasswordMatches(s: StandardSecurity, key: Uint8Array): boolean {
  if (s.r === 2) return rc4(key, PADDING).every((b, i) => b === s.u[i]);
  let x = md5(PADDING, s.idFirst);
  x = rc4(key, x);
  for (let i = 1; i <= 19; i++) {
    const tweaked = key.map((b) => b ^ i);
    x = rc4(tweaked, x);
  }
  // Only the leading 16 bytes: the specification leaves the following 16
  // free, and real producers put anything there.
  return x.subarray(0, 16).every((b, i) => b === s.u[i]);
}

function openStandardDecryptor(s: StandardSecurity): PdfDecryptor | undefined {
  // `/V` 4 and 5 go through encryption filters (AES): not handled,
  // see the header. `/V` 0 does not exist in a valid document.
  if (s.v !== 1 && s.v !== 2) return undefined;
  if (s.r !== 2 && s.r !== 3 && s.r !== 4) return undefined;
  const key = documentKey(s);

  return {
    decryptStream(num, gen, data) {
      // Algorithm 1: the object key. The three low-order bytes of the
      // object number, then the two of the generation, little-endian.
      const extended = new Uint8Array(key.length + 5);
      extended.set(key, 0);
      extended[key.length] = num & 0xff;
      extended[key.length + 1] = (num >> 8) & 0xff;
      extended[key.length + 2] = (num >> 16) & 0xff;
      extended[key.length + 3] = gen & 0xff;
      extended[key.length + 4] = (gen >> 8) & 0xff;
      // Capped at 16 bytes by the specification, never beyond.
      const objKey = md5(extended).subarray(0, Math.min(key.length + 5, 16));
      return rc4(objKey, data);
    },
  };
}

/** Separate from the cantoo reading (`./pdf-decrypt-pdflib.ts`) so it can be exercised on a FABRICATED
 *  security: the corpus contains no really protected document, and
 *  fabricating one would require writing an encrypter. Tampering with `/U` produces
 *  exactly what the code sees in that case. */
export function standardOutcome(security: StandardSecurity): DecryptOutcome {
  if (security.v !== 1 && security.v !== 2) return { kind: "unsupported" };
  if (security.r !== 2 && security.r !== 3 && security.r !== 4) return { kind: "unsupported" };
  const key = documentKey(security);
  // ORDER MATTERS: an unhandled algorithm says NOTHING about the password, so
  // it must never be reported as "protected". Only a case we know how to
  // check can conclude.
  if (!emptyPasswordMatches(security, key)) return { kind: "password-protected" };
  const decryptor = openStandardDecryptor(security);
  return decryptor === undefined ? { kind: "unsupported" } : { kind: "decryptor", decryptor };
}
