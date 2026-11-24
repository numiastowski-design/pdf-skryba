/**
 * Fuzz of the whole document: `readPdfSource`, then `extractPdf`, on real fixtures damaged OUTSIDE the objects that
 * carry text. Lot 6 of the PDF fuzz design (16/11/2026).
 * Input: one object that carries no text (an image XObject, the `/Info` dictionary, an outline item, a `/Metadata`
 * stream, a link annotation), located by our reader AND by a naive scan of the bytes that shares no code with it
 * (`pdf-document-fuzz.test.support.ts`); damaged inside its own bytes, the file's length kept: bytes overwritten, a run
 * filled, its body replaced by `null`, its stream data overwritten.
 * Properties: THE SAME WORDS as the intact file (decision of 24/11/2026: a part that carries no text fails alone,
 * `pdf-objects/refusal.ts#partOrAbsent`), or a refusal FOR SECURITY, a bound that bit (decision of 25/10/2026: a trapped
 * file is refused as a whole, `isSecurityRefusal`); never a refusal for a merely unreadable part. And the published words
 * are pieces of the read words (the layout invents nothing). The damage keeps every cross-reference offset true, so it
 * never reaches the structure (a structure refusal stays allowed where it does: the `/Encrypt` dictionary of lot 7).
 *
 * The seed is fixed (`PDF_FUZZ_SEED`): a red run replays as is. The run counts are the written ones, times the weekly
 * multiplier (`lib/pdf-fuzz-runs.test.support.ts`): 60 base runs in all (question 5 of the design, 24/11/2026), most on
 * small seeds, a few on three real office documents.
 * NOT covered: damage to an object that carries text (lots 1 to 5 call those layers directly), encrypted files
 * (lot 7), an image replaced by a valid but different one (lot 8), objects inside an object stream (the naive scan
 * cannot see them: it abstains).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { extractPdf } from "./pdf";
import {
  agreedTargets,
  type Damage,
  damaged,
  FRAGMENTS,
  inventedTokens,
  publishedWords,
  type Target,
} from "./pdf-document-fuzz.test.support";
import { OutcomeTally, PDF_FUZZ_SEED } from "./pdf-fuzz-outcome.test.support";
import { isSecurityRefusal, PdfObjectsRefusal } from "./pdf-objects/refusal";
import type { PdfExtractResult } from "./pdf-model";
import { readPdfSource, type PdfSource } from "./pdf-source";
import { fuzzRuns, fuzzTestTimeout } from "../lib/pdf-fuzz-runs.test.support";

vi.setConfig({ testTimeout: fuzzTestTimeout(60000, process.env) });

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (path: string): Uint8Array => new Uint8Array(readFileSync(join(here, "../../fixtures", path)));

const params = (baseRuns: number): fc.Parameters<unknown> => ({
  numRuns: fuzzRuns(baseRuns, process.env),
  seed: PDF_FUZZ_SEED,
  timeout: 20000,
});

interface Seed {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly targets: readonly Target[];
  readonly words: readonly string[];
  readonly textUnread: readonly unknown[];
}

/** Small seeds, a few milliseconds a read: the info dictionary (05a, 18), images (60 CCITT, the JPEG pair, 05d mixed
 *  with a scan), and outline items with a metadata stream (the PowerPoint diagram, which publishes no word). */
const SMALL = [
  "pdf/05a-Rapport-Annuel-Digital.pdf",
  "pdf/18-Composition-Reelle.pdf",
  "pdf/60-Image-CCITT-Groupe4.pdf",
  "pdf/digital-rgb-gray-jpeg.pdf",
  "pdf/05d-Dossier-Mixte.pdf",
  "diagrammes-generes/f-fr-raster-diagram-only-PowerPoint.pdf",
];

/** Real office documents, 170 to 280 ms a read: 18 outline items (Word), 51 links (Word 365), six images and five
 *  links (LibreOffice). */
const OFFICE = [
  "docx-heading-reel/09-2026-terms-of-reference-working-group-on-interim-state-architecture-fo-Word.pdf",
  "pdf/40-School-Improvement-Planning-Word365.pdf",
  "pdf/31-Guide-Demarche-AAP-LibreOffice.pdf",
];

const seeds = new Map<string, Seed>();

async function seedOf(name: string): Promise<Seed> {
  const bytes = fixture(name);
  const { agreed } = agreedTargets(bytes);
  const result = await extractPdf(bytes);
  return {
    name,
    bytes,
    targets: agreed,
    words: publishedWords(result.pages),
    textUnread: [...result.textUnreadByPage],
  };
}

beforeAll(async () => {
  for (const name of [...SMALL, ...OFFICE]) seeds.set(name, await seedOf(name));
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
      { minLength: 1, maxLength: 6 },
    ),
  }),
  fc.record({
    kind: fc.constant("fill" as const),
    at: fc.nat(),
    length: fc.integer({ min: 1, max: 64 }),
    byte: fc.integer({ min: 0, max: 255 }),
  }),
  fc.constant({ kind: "null" as const }),
  fc.record({
    kind: fc.constant("stream-data" as const),
    at: fc.nat(),
    length: fc.integer({ min: 1, max: 256 }),
    byte: fc.integer({ min: 0, max: 255 }),
  }),
);

/** The refusal behind an extraction's error: the error itself, or its `cause`. */
const refusalBehind = (error: unknown): unknown =>
  error instanceof PdfObjectsRefusal ? error : ((error as { cause?: unknown }).cause ?? error);

/** One trial: the damaged file read by `readPdfSource`, then by `extractPdf`. Only a refusal for security may stop it. */
async function trial(seed: Seed, target: Target, damage: Damage): Promise<"read" | "refused"> {
  const bytes = damaged(seed.bytes, target, damage);
  let source: PdfSource;
  let result: PdfExtractResult;
  try {
    source = await readPdfSource(bytes);
    result = await extractPdf(bytes);
  } catch (error) {
    expect(isSecurityRefusal(refusalBehind(error)), `a refusal at object ${target.num} (${target.kind})`).toBe(true);
    return "refused";
  }
  const words = publishedWords(result.pages);
  expect(words, `the same words as the intact ${seed.name} (object ${target.num}, ${target.kind})`).toEqual(seed.words);
  expect([...result.textUnreadByPage], "a page lost its text").toEqual(seed.textUnread);
  expect(inventedTokens(words, source), "published words the reading does not hold").toEqual([]);
  return "read";
}

const caseArb = (names: readonly string[]) =>
  fc.record({ name: fc.constantFrom(...names), pick: fc.nat(), damage: damageArb });

describe("readPdfSource and extractPdf - damage outside the objects that carry text", () => {
  it("our reader and a naive scan locate the same objects on every seed, and each seed has some", () => {
    for (const name of [...SMALL, ...OFFICE]) {
      const { agreed, readerOnly, naiveOnly } = agreedTargets(fixture(name));
      expect(readerOnly, `${name}: objects only our reader locates`).toEqual([]);
      expect(naiveOnly, `${name}: objects only the naive scan locates`).toEqual([]);
      expect(agreed.length, `${name}: objects to damage`).toBeGreaterThan(0);
    }
  });

  it("the intact seeds publish only words they read", async () => {
    for (const name of [...SMALL, ...OFFICE]) {
      const seed = seeds.get(name) as Seed;
      expect(inventedTokens(seed.words, await readPdfSource(seed.bytes)), name).toEqual([]);
    }
  });

  // Measured with this seed, damaged files still read. Before 24/11/2026, when one bad byte in such a part refused
  // the whole document: small seeds 35 of 50 at x1, 329 of 500 at x10; office documents 6 of 10, 59 of 100. Since the
  // decisions of 24/11/2026: 50 of 50, 496 of 500 (four `token-too-long`, a bound); 10 of 10, 100 of 100. The share is a
  // starting value to calibrate.
  for (const [label, names, runs, share] of [
    ["small seeds", SMALL, 50, 0.9],
    ["office documents", OFFICE, 10, 0.9],
  ] as const) {
    it(`${label}: the same words as the intact file or a refusal for security, and no word the reading does not hold`, async () => {
      const tally = new OutcomeTally();
      await fc.assert(
        fc.asyncProperty(caseArb(names), async ({ name, pick, damage }) => {
          const seed = seeds.get(name) as Seed;
          tally.add(await trial(seed, seed.targets[pick % seed.targets.length] as Target, damage));
        }),
        params(runs),
      );
      expect(tally.readShare, `${label}: share of damaged files still read`).toBeGreaterThanOrEqual(share);
    });
  }
});
