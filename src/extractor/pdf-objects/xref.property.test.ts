/**
 * Fuzz of `xref.ts#readXref` and `document.ts#openPdfObjects`, called directly. Lot 5 of the PDF fuzz design
 * (16/11/2026).
 * Input: real fixtures rewritten by a test rewriter made from ISO 32000-1:2008 §7.5 (`pdf-rewriter.test.support.ts`):
 * the same objects in another order, under a classic table or a cross-reference stream, some packed into an object
 * stream, with incremental updates appended that write objects again unchanged; then those updates damaged.
 * Properties: a rewritten file gives the same object graph, the same trailer keys and the same pages; a damaged update
 * (cut short, or a byte of its table or `startxref` overwritten) gives a refusal of ours or exactly the intact result.
 *
 * The seed is fixed (`PDF_FUZZ_SEED`): a red run replays as is. The run counts are the written ones, times the weekly
 * multiplier (`lib/pdf-fuzz-runs.test.support.ts`).
 * NOT covered: encrypted files, hybrid files written by the rewriter (one is read as a seed), a damaged
 * cross-reference stream's data (a type byte turned to 0 frees an object, which §7.5.8.3 allows: no oracle), a damaged
 * trailer value (`/Root 2 0 R` is another document, not a damaged one).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import { PdfObjectsRefusal } from "./refusal";
import { Choices, drawsArb } from "./pdf-syntax-writer.test.support";
import {
  appendUpdate,
  asBuilt,
  type Built,
  type Graph,
  graphOf,
  rewrite,
  type Source,
  sourceOf,
} from "./pdf-rewriter.test.support";
import { PDF_FUZZ_SEED } from "../pdf-fuzz-outcome.test.support";
import { fuzzRuns, fuzzTestTimeout } from "../../lib/pdf-fuzz-runs.test.support";

vi.setConfig({ testTimeout: fuzzTestTimeout(60000, process.env) });

const params = (baseRuns: number): fc.Parameters<unknown> => ({
  numRuns: fuzzRuns(baseRuns, process.env),
  seed: PDF_FUZZ_SEED,
  timeout: 20000,
});

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (file: string): Uint8Array => new Uint8Array(readFileSync(join(here, "../../../fixtures/pdf", file)));

/** Small fixtures that cover both kinds of section: classic tables (13, 14, 05a), a cross-reference stream with object
 *  streams (21, 11). None of the small ones is English; the English one is the hybrid witness below. */
const SEED_FILES = [
  "13-Police-Sans-CMap.pdf",
  "21-Encadre-Avec-Intitule.pdf",
  "05a-Rapport-Annuel-Digital.pdf",
  "11-Brochure-Deux-Colonnes.pdf",
  "14-Ligatures-ToUnicode.pdf",
];

interface Seed {
  readonly bytes: Uint8Array;
  readonly source: Source;
  readonly graph: Graph;
}

/** Read on first use, inside a test: a reader that cannot read a seed fails that test, not the whole file. */
const seeds = new Map<number, Seed>();
function seedAt(index: number): Seed {
  const known = seeds.get(index);
  if (known !== undefined) return known;
  const bytes = fixture(SEED_FILES[index] as string);
  const seed = { bytes, source: sourceOf(bytes), graph: graphOf(bytes) };
  seeds.set(index, seed);
  return seed;
}

const seedArb = fc.integer({ min: 0, max: SEED_FILES.length - 1 });

/** The object numbers a value refers to, at any depth. */
function refsIn(value: unknown, into: Set<number>): Set<number> {
  if (value instanceof Map) for (const item of value.values()) refsIn(item, into);
  else if (Array.isArray(value)) for (const item of value) refsIn(item, into);
  else if (typeof value === "object" && value !== null && !(value instanceof Uint8Array)) {
    const record = value as Record<string, unknown>;
    if (record.kind === "ref" && typeof record.num === "number") into.add(record.num);
    else for (const item of Object.values(record)) refsIn(item, into);
  }
  return into;
}

describe("readXref and openPdfObjects - real files rewritten after ISO 32000-1 §7.5", () => {
  it("a rewritten file gives the same objects, trailer keys and pages (7.5.4-7.5.8)", () => {
    fc.assert(
      fc.property(seedArb, fc.integer({ min: 0, max: 2 }), drawsArb, (index, updates, draws) => {
        const seed = seedAt(index);
        const choices = new Choices(draws);
        let built: Built = rewrite(seed.source, choices);
        for (let i = 0; i < updates; i += 1) built = appendUpdate(built, seed.source, choices);
        expect(graphOf(built.bytes)).toEqual(seed.graph);
      }),
      params(60),
    );
  });

  it("an incremental update that changes nothing, appended to the file as it is, changes nothing (7.5.6)", () => {
    fc.assert(
      fc.property(seedArb, drawsArb, (index, draws) => {
        const seed = seedAt(index);
        const built = appendUpdate(asBuilt(seed.bytes), seed.source, new Choices(draws));
        expect(graphOf(built.bytes)).toEqual(seed.graph);
      }),
      params(40),
    );
  });

  it("witness: an English hybrid file with a Prev chain, rewritten flat, gives the same document (7.5.8.4)", () => {
    const bytes = fixture("40-School-Improvement-Planning-Word365.pdf");
    const source = sourceOf(bytes);
    const graph = graphOf(bytes);
    // The oracle is the reader itself, so the source must be read whole: this file refers to no object that its sections
    // (its hybrid stream included) do not place (checked on 24/11/2026).
    const dangling = [...refsIn([...graph.objects.values(), graph.trailer, graph.pages], new Set())].filter(
      (num) => !graph.objects.has(num),
    );
    expect(dangling, "references to objects the sections do not place").toEqual([]);
    fc.assert(
      fc.property(drawsArb, (draws) => {
        expect(graphOf(rewrite(source, new Choices(draws)).bytes)).toEqual(graph);
      }),
      params(3),
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Damaged updates.

interface Damage {
  /** Cut the file inside the update (true), or overwrite bytes of its table and `startxref` (false). */
  readonly cut: boolean;
  readonly at: number;
  readonly writes: readonly { readonly at: number; readonly byte: number }[];
}

/** A byte that cannot turn an in-use entry into a free one: `f` would hide an object, which §7.5.4 allows (no oracle). */
const notFree = fc.integer({ min: 0, max: 255 }).filter((byte) => byte !== 0x66);

const damageArb: fc.Arbitrary<Damage> = fc.record({
  cut: fc.boolean(),
  at: fc.nat(),
  writes: fc.array(fc.record({ at: fc.nat(), byte: notFree }), { minLength: 1, maxLength: 3 }),
});

const text = (bytes: Uint8Array): string => Buffer.from(bytes).toString("latin1");

/** The bytes an overwrite may touch in an update: its table from `xref` to the end of `trailer` (never the trailer's
 *  values) and the digits after its `startxref`; apart, the type letters of its entries, since a damaged `n` is the one
 *  change that could hide an object. Both empty for an update whose section is a stream. */
function damageZone(bytes: Uint8Array, from: number): { readonly table: number[]; readonly letters: number[] } {
  const tail = text(bytes.subarray(from));
  const xref = tail.search(/(?:^|[\r\n])xref[\r\n ]/);
  const trailer = tail.indexOf("trailer", Math.max(0, xref));
  const startxref = tail.lastIndexOf("startxref");
  if (xref < 0 || trailer < 0 || startxref < 0) return { table: [], letters: [] };
  const table: number[] = [];
  for (let at = xref; at < trailer + "trailer".length; at += 1) table.push(from + at);
  const letters: number[] = [];
  for (let at = tail.indexOf(" n", xref); at >= 0 && at < trailer; at = tail.indexOf(" n", at + 1))
    letters.push(from + at + 1);
  const digits = /^startxref\s+(\d+)/.exec(tail.slice(startxref));
  const first = startxref + (digits?.[0].length ?? 0) - (digits?.[1]?.length ?? 0);
  for (let at = first; at < startxref + (digits?.[0].length ?? 0); at += 1) table.push(from + at);
  return { table, letters };
}

/** Cut inside the update, or overwrite bytes of its zone: one write in two lands on a type letter when there is one. */
function damaged(bytes: Uint8Array, from: number, damage: Damage): Uint8Array {
  if (damage.cut) return bytes.slice(0, from + (damage.at % (bytes.length - from)));
  const { table, letters } = damageZone(bytes, from);
  const out = bytes.slice();
  for (const { at, byte } of damage.writes) {
    const zone = at % 2 === 0 && letters.length > 0 ? letters : table;
    if (zone.length > 0) out[zone[Math.floor(at / 2) % zone.length] as number] = byte;
  }
  return out;
}

describe("readXref and openPdfObjects - a damaged incremental update", () => {
  it("gives a refusal of ours or exactly the intact result (7.5.6)", () => {
    const seen = { intact: 0, refused: 0 };
    fc.assert(
      fc.property(seedArb, fc.boolean(), drawsArb, damageArb, (index, asIs, draws, damage) => {
        const seed = seedAt(index);
        const choices = new Choices(draws);
        const base = asIs ? asBuilt(seed.bytes) : rewrite(seed.source, choices);
        const update = appendUpdate(base, seed.source, choices);
        const bytes = damaged(update.bytes, update.from, damage);
        let graph;
        try {
          graph = graphOf(bytes);
        } catch (error) {
          expect(error, "a refusal of ours, never a raw error").toBeInstanceOf(PdfObjectsRefusal);
          seen.refused += 1;
          return;
        }
        expect(graph, "a damaged update read as another document").toEqual(seed.graph);
        seen.intact += 1;
      }),
      params(80),
    );
    // Both branches must be exercised. Measured on 24/11/2026 with this seed: 66 of 80 intact, 14 refused.
    expect(seen.intact, "damaged updates read as the intact file").toBeGreaterThan(0);
    expect(seen.refused, "damaged updates refused").toBeGreaterThan(0);
  });
});
