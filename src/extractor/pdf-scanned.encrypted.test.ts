/**
 * A scanned PDF protected by an OWNER password only (empty user password: common for « non printable » scans) opens in
 * our reader, so it reaches the AI reading. The batch PDF sent to the vision port must then be READABLE: pdf-lib refuses to load
 * such a file without a password, and loading it with `ignoreEncryption` copies the pages still encrypted into an
 * unencrypted document (the AI would be paid for noise).
 */

import { PDFDocument } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";

import { FakeVisionPort } from "./pdf-fake-vision.test.support";
import { ocrScannedPages } from "./pdf-scanned";

async function ownerOnlyProtectedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([300, 200]).drawText("hello world protected", { x: 10, y: 100 });
  doc.addPage([200, 200]);
  (doc as unknown as { encrypt(options: object): void }).encrypt({
    userPassword: "",
    ownerPassword: "owner-secret",
    permissions: { printing: false, copying: false },
  });
  return doc.save();
}

describe("ocrScannedPages — a PDF protected by an owner password only", () => {
  // pdf-lib writes AES, which our reader does not implement: such a file is refused by the reading that comes BEFORE the AI reading
  // (the page text), so in production it never gets here. Called directly, the guard in front of pdf-lib refuses it too: it
  // cannot look into streams it cannot decrypt, and pdf-lib would inflate them. The readable batch of an owner-only file written
  // with RC4 is not covered here: no generator of such a file exists in the repository.
  it("refuses a file whose streams our reader cannot decrypt, and does not call the vision port", async () => {
    const bytes = await ownerOnlyProtectedPdf();
    let calls = 0;
    const vision = new FakeVisionPort();
    vision.analyzeDocument = async () => {
      calls += 1;
      return [{ text: "ok", confidence: 1 }] as never;
    };
    await expect(ocrScannedPages(bytes, [0], vision)).rejects.toMatchObject({ reason: "encrypted" });
    expect(calls).toBe(0);
  });
});
