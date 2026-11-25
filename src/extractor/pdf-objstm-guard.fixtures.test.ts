/** The guard in front of `pdf-lib` (`pdf-objstm-guard.ts`) does not refuse an ordinary file: it ran on the fixture PDFs and the
 *  security review of 02/11/2026 (round 4) found 9 of 57 refused to tort by a `/Type1` mistaken for a type key. Files our own reader
 *  refuses (damaged, AES) never reach the guard in production and are left out. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { openPdfObjects } from "./pdf-objects/document";
import { assertObjectStreamsBounded } from "./pdf-objstm-guard";
import { objectStreamSource } from "./pdf-objstm-source";
import { publicFixturePath, publicFixtures } from "./public-fixtures.test.support";

describe("assertObjectStreamsBounded : les fixtures PDF ordinaires ne sont pas refusées", () => {
  const files = publicFixtures(".pdf");
  it("au moins trente fichiers sont exercés", () => expect(files.length).toBeGreaterThan(30));
  for (const name of files) {
    it(
      name,
      async () => {
        const bytes = new Uint8Array(readFileSync(publicFixturePath(name)));
        let doc;
        try {
          doc = openPdfObjects(bytes);
          doc.pages();
        } catch {
          return; // our reader refuses it: it never reaches the guard
        }
        await expect(assertObjectStreamsBounded(bytes, objectStreamSource(doc))).resolves.toBeUndefined();
      },
      60_000,
    );
  }
});
