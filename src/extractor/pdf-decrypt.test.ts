/** 🔴 On an encrypted PDF (RC4 128 bits, R=3, empty password): `fixtures/pdf/59-Document-Chiffre-RC4.pdf`, made up and encrypted by a
 *  third-party tool (qpdf, through its generator). The real encrypted documents handed over to us are held by the application's tests. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, PDFName, PDFRawStream } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";
import { ReaderError } from "doc-ir";
import { extractPdf } from "./pdf";
import { standardOutcome } from "./pdf-decrypt";
import { openDecryptorFor, readStandardSecurity } from "./pdf-decrypt-pdflib";
import { encryptedPdf, passwordProtectedPdf } from "./pdf-password-protected.test.support";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => new Uint8Array(readFileSync(join(here, "../../fixtures", name)));
/** A made-up document that was never encrypted: the witness of « clear ». */
const CLAIR = "pdf/11-Brochure-Deux-Colonnes.pdf";
/** The JPEG the generator of the encrypted fixture embeds, as a file: what a right decryption must give back. */
const EMBEDDED_JPEG = "jpeg/ours-420-64x48.jpg";

const loadEncrypted = () => PDFDocument.load(encryptedPdf(), { ignoreEncryption: true });

describe("déchiffrement standard d'un PDF", () => {
  it("🔴 rend les JPEG d'origine, octet pour octet", async () => {
    const doc = await loadEncrypted();
    const outcome = openDecryptorFor(doc);
    expect(outcome.kind, "RC4 128 bits, R=3, empty password: this case must be handled").toBe("decryptor");
    if (outcome.kind !== "decryptor") return;

    const ctx = doc.context as unknown as {
      enumerateIndirectObjects: () => [{ objectNumber: number; generationNumber: number }, unknown][];
    };
    const stored: Uint8Array[] = [];
    const jpegs: Uint8Array[] = [];
    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFRawStream)) continue;
      if (obj.dict.get(PDFName.of("Subtype"))?.toString() !== "/Image") continue;
      // `/Filter` may be a NAME or an ARRAY of names: here `[ /DCTDecode ]`.
      if (obj.dict.get(PDFName.of("Filter"))?.toString().includes("/DCTDecode") !== true) continue;
      stored.push(new Uint8Array(obj.contents));
      jpegs.push(outcome.decryptor.decryptStream(ref.objectNumber, ref.generationNumber, new Uint8Array(obj.contents)));
    }

    expect(jpegs.length, "the fixture carries one JPEG").toBe(1);
    const original = fixture(EMBEDDED_JPEG);
    // The stored stream is NOT the JPEG: without this, a file that was never encrypted would pass the comparison below.
    expect(Buffer.from(stored[0]!).equals(Buffer.from(original)), "the stored stream must be encrypted").toBe(false);
    expect(Buffer.from(stored[0]!.slice(0, 3)).toString("hex")).not.toBe("ffd8ff");
    for (const jpeg of jpegs) {
      expect(Buffer.from(jpeg.slice(0, 3)).toString("hex"), "the header of a JPEG").toBe("ffd8ff");
      // And the END, or a decryption right on the first bytes only would pass: `ffd9` is the end-of-image marker.
      expect(Buffer.from(jpeg.slice(-2)).toString("hex"), "the end-of-image marker").toBe("ffd9");
    }
    // The original file, byte for byte: decrypting re-encodes nothing.
    expect(jpegs.map((jpeg) => jpeg.length)).toEqual([original.length]);
    expect(Buffer.from(jpegs[0]!).equals(Buffer.from(original))).toBe(true);
  });

  it("un document en clair est reconnu comme tel, et n'est pas déchiffré", async () => {
    expect(openDecryptorFor(await PDFDocument.load(fixture(CLAIR), { ignoreEncryption: true })).kind).toBe("clear");
  });

  it("🔴 un VRAI mot de passe est reconnu et REFUSÉ, jamais déchiffré avec une clé fausse", async () => {
    // The same document with a falsified `/U`: exactly what the code sees in front of a document whose user password
    // is not empty.
    const security = readStandardSecurity(await loadEncrypted());
    expect(typeof security).not.toBe("string");
    if (typeof security === "string") return;

    // As it stands the empty password fits, or the next assertion would say nothing.
    expect(standardOutcome(security).kind).toBe("decryptor");

    const u = Uint8Array.from(security.u);
    u[0] = u[0]! ^ 0xff; // one byte is enough to invalidate the empty password
    expect(standardOutcome({ ...security, u }).kind).toBe("password-protected");
    // `/R` 3 is handled: a wrong `/U` still concludes "password-protected".
    expect(standardOutcome({ ...security, v: 2, r: 3, u }).kind).toBe("password-protected");
  });

  it("an unhandled `/R` is unsupported BEFORE any password verdict, even with a wrong `/U`", async () => {
    const security = readStandardSecurity(await loadEncrypted());
    if (typeof security === "string") throw new Error("fixture must be encrypted");
    const u = Uint8Array.from(security.u);
    u[0] = u[0]! ^ 0xff;
    expect(standardOutcome({ ...security, v: 2, r: 5, u }).kind).toBe("unsupported");
    expect(standardOutcome({ ...security, v: 2, r: 1, u }).kind).toBe("unsupported");
  });

  /** A WHOLE FILE, not a made-up object. `/U` is written in hexadecimal in the bytes of the PDF (`/U <e270…>`), so
   *  changing ONE digit keeps the exact length: the cross-reference table stays valid and the file stays a legitimate
   *  PDF, only protected by a password nobody has (`pdf-password-protected.test.support.ts`). */
  it("🔴 un document réellement protégé est REFUSÉ, pas publié à moitié", async () => {
    const original = encryptedPdf();
    const protege = passwordProtectedPdf();
    expect(protege.length, "the length must not move, or the PDF would be broken").toBe(original.length);
    expect(Buffer.from(protege).equals(Buffer.from(original)), "the protected file must differ").toBe(false);

    // The original file does extract: without this, the refusal below could come from anything else.
    await expect(extractPdf(original)).resolves.toBeDefined();

    await expect(extractPdf(protege)).rejects.toMatchObject({
      code: "DOCUMENT_PASSWORD_PROTECTED",
    });
    await expect(extractPdf(passwordProtectedPdf())).rejects.toBeInstanceOf(ReaderError);
  });
});
