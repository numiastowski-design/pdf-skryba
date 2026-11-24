/**
 * Fuzz of decryption through `extractPdf`. Lot 7 of the PDF fuzz design (16/11/2026).
 * Input: clear fixtures encrypted by a test encryptor written from ISO 32000-1:2008 §7.6 (RC4, revisions 2 and 3, keys
 * of 40 to 128 bits, random permissions, owner password and `/ID`: `pdf-rc4-encryptor.test.support.ts`); and the one
 * real encrypted fixture of this repository, `59-Document-Chiffre-RC4.pdf`, damaged inside its `/Encrypt` dictionary,
 * its info dictionary or an image (`pdf-document-fuzz.test.support.ts`). The design also named
 * `25-Notice-Montre-InDesign` and two school reports: they are not in this repository's fixtures.
 * Properties: encrypted then read = the same words and images as the clear file; a real user password gives the
 * password refusal, never a plausible text; a damaged real encrypted file gives a refusal of ours or the same words.
 * AES (`/V 4`, `/V 5`) is REFUSED BY DESIGN (`pdf-decrypt.ts`: no real file to check an implementation against): one
 * case below holds that refusal, nothing fuzzes AES.
 *
 * The seed is fixed (`PDF_FUZZ_SEED`): a red run replays as is. The run counts are the written ones, times the weekly
 * multiplier (`lib/pdf-fuzz-runs.test.support.ts`).
 * NOT covered: revision 4 (`/V 4`, crypt filters), `/EncryptMetadata false`, the public-key handler.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { ReaderError } from "doc-ir";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { extractPdf } from "./pdf";
import { agreedTargets, type Damage, damaged, FRAGMENTS, publishedWords } from "./pdf-document-fuzz.test.support";
import { expectRefusalOfOurs, OutcomeTally, PDF_FUZZ_SEED } from "./pdf-fuzz-outcome.test.support";
import type { PdfExtractResult } from "./pdf-model";
import { Choices, drawsArb } from "./pdf-objects/pdf-syntax-writer.test.support";
import { encryptPdf, type Rc4Security } from "./pdf-rc4-encryptor.test.support";
import { fuzzRuns, fuzzTestTimeout } from "../lib/pdf-fuzz-runs.test.support";

vi.setConfig({ testTimeout: fuzzTestTimeout(60000, process.env) });

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (path: string): Uint8Array => new Uint8Array(readFileSync(join(here, "../../fixtures", path)));

const params = (baseRuns: number): fc.Parameters<unknown> => ({
  numRuns: fuzzRuns(baseRuns, process.env),
  seed: PDF_FUZZ_SEED,
  timeout: 20000,
});

/** Clear seeds with text: ReportLab (05a, 18), a ToUnicode with ligatures (14), object streams (11, 21), a CCITT image
 *  (60), a JPEG pair (the RGB and grey one). */
const CLEAR = [
  "pdf/05a-Rapport-Annuel-Digital.pdf",
  "pdf/18-Composition-Reelle.pdf",
  "pdf/14-Ligatures-ToUnicode.pdf",
  "pdf/11-Brochure-Deux-Colonnes.pdf",
  "pdf/21-Encadre-Avec-Intitule.pdf",
  "pdf/60-Image-CCITT-Groupe4.pdf",
  "pdf/digital-rgb-gray-jpeg.pdf",
];
const ENCRYPTED = "pdf/59-Document-Chiffre-RC4.pdf";

interface Reading {
  readonly words: readonly string[];
  readonly images: readonly string[];
}

const readingOf = (result: PdfExtractResult): Reading => ({
  words: publishedWords(result.pages),
  images: (result.images ?? []).map((image) => image.sha256),
});

const clear = new Map<string, { bytes: Uint8Array; reading: Reading }>();

beforeAll(async () => {
  for (const name of CLEAR) {
    const bytes = fixture(name);
    clear.set(name, { bytes, reading: readingOf(await extractPdf(bytes)) });
  }
});

const bytesArb = (length: number): fc.Arbitrary<Uint8Array> => fc.uint8Array({ minLength: length, maxLength: length });

/** §7.6.3.2 Table 21: revision 2 is 40 bits; revision 3 takes 40 to 128 bits, a multiple of 8. */
const securityArb = (userPassword: fc.Arbitrary<Uint8Array>): fc.Arbitrary<Rc4Security> =>
  fc.record({
    revision: fc.constantFrom<2 | 3>(2, 3),
    lengthBits: fc.integer({ min: 5, max: 16 }).map((bytes) => bytes * 8),
    permissions: fc.integer({ min: -(2 ** 31), max: 2 ** 31 - 1 }),
    userPassword,
    ownerPassword: fc.uint8Array({ maxLength: 40 }),
    id: bytesArb(16),
  });

const passwordProtected = (error: unknown): boolean =>
  error instanceof ReaderError && error.code === "DOCUMENT_PASSWORD_PROTECTED";

async function settle(bytes: Uint8Array): Promise<{ result?: PdfExtractResult; error?: unknown }> {
  try {
    return { result: await extractPdf(bytes) };
  } catch (error) {
    return { error };
  }
}

describe("decryption - clear seeds encrypted after ISO 32000-1 §7.6 (RC4)", () => {
  it("the encryptor's writing alone changes nothing: the clear seed written again reads the same", async () => {
    for (const name of CLEAR) {
      const seed = clear.get(name) as { bytes: Uint8Array; reading: Reading };
      const written = encryptPdf(seed.bytes, undefined, new Choices([3, 1, 4, 1, 5]));
      expect(readingOf(await extractPdf(written)), name).toEqual(seed.reading);
    }
  });

  it("encrypted with an empty user password, then read: the same words and images as the clear file", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...CLEAR),
        securityArb(fc.constant(new Uint8Array(0))),
        drawsArb,
        async (name, security, draws) => {
          const seed = clear.get(name) as { bytes: Uint8Array; reading: Reading };
          const encrypted = encryptPdf(seed.bytes, security, new Choices(draws));
          const reading = readingOf(await extractPdf(encrypted));
          const label = `${name}, revision ${security.revision}`;
          expect(reading, label).toEqual(seed.reading);
        },
      ),
      params(30),
    );
  });

  // Found by this lot, fixed on 24/11/2026: the CCITT reader took the file's bytes, never decrypted (§7.6.2).
  it("the CCITT image of an encrypted file reads like the clear one (defect of 24/11/2026)", async () => {
    const name = "pdf/60-Image-CCITT-Groupe4.pdf";
    const seed = clear.get(name) as { bytes: Uint8Array; reading: Reading };
    const security: Rc4Security = {
      revision: 2,
      lengthBits: 40,
      permissions: 0,
      userPassword: new Uint8Array(0),
      ownerPassword: new Uint8Array(0),
      id: new Uint8Array(16),
    };
    const encrypted = encryptPdf(seed.bytes, security, new Choices([0]));
    expect(readingOf(await extractPdf(encrypted)).images).toEqual(seed.reading.images);
  });

  it("encrypted with a real user password: the password refusal, never a text", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...CLEAR),
        securityArb(fc.uint8Array({ minLength: 1, maxLength: 40 })),
        drawsArb,
        async (name, security, draws) => {
          const seed = clear.get(name) as { bytes: Uint8Array; reading: Reading };
          const { error } = await settle(encryptPdf(seed.bytes, security, new Choices(draws)));
          expect(passwordProtected(error), `${name}: ${String(error)}`).toBe(true);
        },
      ),
      params(10),
    );
  });

  it("AES is refused by design: a dictionary declaring /V 4 or /V 5 gives the password refusal", async () => {
    const seed = clear.get(CLEAR[0] as string) as { bytes: Uint8Array; reading: Reading };
    for (const declared of [
      { v: 4, r: 4 },
      { v: 5, r: 5 },
      { v: 5, r: 6 },
    ]) {
      const security: Rc4Security = {
        revision: 3,
        lengthBits: 128,
        permissions: -4,
        userPassword: new Uint8Array(0),
        ownerPassword: new Uint8Array(0),
        id: new Uint8Array(16).fill(1),
        declared,
      };
      const { error } = await settle(encryptPdf(seed.bytes, security, new Choices([2, 7])));
      expect(passwordProtected(error), `/V ${declared.v} /R ${declared.r}`).toBe(true);
    }
  });
});

const damageArb: fc.Arbitrary<Damage> = fc.oneof(
  fc.record({
    kind: fc.constant("overwrite" as const),
    writes: fc.array(
      fc.record({
        at: fc.nat(),
        byte: fc.integer({ min: 0, max: 255 }),
        fragment: fc.option(fc.nat({ max: FRAGMENTS.length - 1 }), { nil: null }),
      }),
      { minLength: 1, maxLength: 4 },
    ),
  }),
  fc.record({
    kind: fc.constant("fill" as const),
    at: fc.nat(),
    length: fc.integer({ min: 1, max: 32 }),
    byte: fc.integer({ min: 0, max: 255 }),
  }),
  fc.constant({ kind: "null" as const }),
  fc.record({
    kind: fc.constant("stream-data" as const),
    at: fc.nat(),
    length: fc.integer({ min: 1, max: 64 }),
    byte: fc.integer({ min: 0, max: 255 }),
  }),
);

describe("decryption - the real encrypted fixture, damaged", () => {
  it("our reader and a naive scan locate the same objects, the /Encrypt dictionary among them", () => {
    const { agreed, readerOnly, naiveOnly } = agreedTargets(fixture(ENCRYPTED));
    expect(readerOnly).toEqual([]);
    expect(naiveOnly).toEqual([]);
    expect(agreed.map((target) => target.kind).sort()).toEqual(["encrypt", "image", "image", "info"]);
  });

  it("a damaged /Encrypt, info or image gives a refusal of ours, the password refusal, or the same words", async () => {
    const bytes = fixture(ENCRYPTED);
    const encryptedIntact = readingOf(await extractPdf(bytes));
    const targets = agreedTargets(bytes).agreed;
    const tally = new OutcomeTally();
    await fc.assert(
      fc.asyncProperty(fc.nat(), damageArb, async (pick, damage) => {
        const target = targets[pick % targets.length] as (typeof targets)[number];
        const { result, error } = await settle(damaged(bytes, target, damage));
        if (error !== undefined) {
          if (!passwordProtected(error)) expectRefusalOfOurs(error);
          tally.add("refused");
          return;
        }
        expect(publishedWords((result as PdfExtractResult).pages), `object ${target.num}, ${target.kind}`).toEqual(
          encryptedIntact.words,
        );
        tally.add("read");
      }),
      params(30),
    );
    // Starting value to calibrate, measured on 24/11/2026 with this seed: 23 of 30 read, 196 of 300 at x10. The
    // refusals: `syntax` or `token-too-long` at the damaged object, and twice the password refusal (a damaged `/O`).
    expect(tally.readShare, "share of damaged files still read").toBeGreaterThanOrEqual(0.5);
  });
});
