/** Test helper: the made-up encrypted PDF of `fixtures/pdf/` (`59-Document-Chiffre-RC4`, written by its generator with an EMPTY user
 *  password), and the same file protected by a password nobody has — one hexadecimal digit of its `/U` entry changed (same length, so the
 *  cross-reference table stays valid). Opening the second fails for good with `DOCUMENT_PASSWORD_PROTECTED`: the definitive failure the
 *  tests use since a damaged PDF is published as an attachment (24/10/2026).
 *  A TWIN, on purpose: the application's private repository holds the same code but for the depth of the path to `fixtures/`
 *  (`src/readers/pdf-password-protected.test.support.ts`), because a public repository cannot lend it a test support. A fix to one
 *  goes to the other; the application's repository holds the two equal by a test.
 *  NOT here: any rule (`pdf-open.ts`, `pdf-decrypt.ts`). Called by: the tests that need an encrypted PDF, or a PDF that fails for good. */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENCRYPTED = "59-Document-Chiffre-RC4.pdf";
/** The `/U` entry of the encryption dictionary, written in hexadecimal: the name, optional white space, the opening bracket. */
const USER_ENTRY = /\/U\s*</;

/** The encrypted PDF's bytes, as its generator wrote them: it opens with no password. */
export const encryptedPdf = (): Uint8Array => new Uint8Array(readFileSync(join(here, "../../fixtures/pdf", ENCRYPTED)));

/** The protected PDF's bytes. */
export const passwordProtectedPdf = (): Uint8Array => {
  const bytes = Buffer.from(encryptedPdf());
  const entry = USER_ENTRY.exec(bytes.toString("latin1"));
  if (entry === null) throw new Error("the encryption dictionary of the fixture moved: its /U entry was not found");
  const digit = entry.index + entry[0].length;
  bytes[digit] = bytes[digit] === 0x30 ? 0x31 : 0x30;
  return new Uint8Array(bytes);
};
