/**
 * Fuzz of images, then outlines, links and layers, through `readPdfSource` and `extractPdf`. Lot 8 of the PDF fuzz
 * design (16/11/2026).
 * Input: real fixtures with an incremental update appended (ISO 32000-1:2008 §7.5.6, `pdf-rewriter.test.support.ts`)
 * that writes a new version of one object: an image XObject replaced by a generated one (§8.9.5: size, bits per
 * component, colour space, an indexed palette, a chain of stream filters; its data the exact length, cut short or too
 * long; now and then a dictionary entry out of range); the first page given a generated link annotation (§12.5.6.5,
 * §12.6.4.7); the catalogue given a generated outline tree (§12.3.3, links between items at random, cycles included)
 * or generated optional content (§8.11.4).
 * Properties: an image is nothing, or a buffer of width × height × channels (a packed bit per pixel for `gray-1`), and a
 * generated image read back has its declared size; a link has an accepted protocol and a finite rectangle; the outline
 * is absent or within its bounds; the words stay those of the intact file; a failure is a refusal of ours.
 *
 * The seed is fixed (`PDF_FUZZ_SEED`): a red run replays as is. The run counts are the written ones, times the weekly
 * multiplier (`lib/pdf-fuzz-runs.test.support.ts`).
 * NOT covered: image filters (JPEG, JPX, JBIG2, CCITT: their decoders are tested apart), soft masks, inline images
 * (lot 1 tokenizes them), content marked as optional (no seed holds any: the words cannot change).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { extractPdf } from "./pdf";
import { agreedTargets, publishedWords } from "./pdf-document-fuzz.test.support";
import { expectRefusalOfOurs, OutcomeTally, PDF_FUZZ_SEED } from "./pdf-fuzz-outcome.test.support";
import type { PdfImageData } from "./pdf-images";
import { OUTLINE_READ_MAX_ENTRIES, OUTLINE_TITLE_MAX_CHARS } from "./pdf-outline";
import { openPdfObjects } from "./pdf-objects/document";
import type { PdfDict, PdfValue } from "./pdf-objects/objects";
import { appendObjects, asBuilt, type WrittenObject } from "./pdf-objects/pdf-rewriter.test.support";
import { Choices, drawsArb, modelOf, writeValue } from "./pdf-objects/pdf-syntax-writer.test.support";
import { chainDict, encodeChain, STREAM_FILTERS, type FilterStep } from "./pdf-objects/stream-encoders.test.support";
import { readXref } from "./pdf-objects/xref";
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

const latin1 = (text: string): Uint8Array => Uint8Array.from(text, (char) => char.charCodeAt(0));

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Pseudo-random bytes from a seed (a linear congruential generator): long data without kilobytes in a counter-example. */
function longData(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

interface Seed {
  readonly bytes: Uint8Array;
  readonly words: readonly string[];
  readonly trailer: PdfDict;
  readonly images: readonly { readonly num: number; readonly gen: number }[];
}

/** Seeds with images: a JPEG pair (RGB and grey), a CCITT image, five Flate images with soft masks, a CMYK JPEG, a page
 *  scan beside a text page; and 05a (no image), whose update adds a link, an outline or layers. */
const IMAGE_SEEDS = [
  "pdf/digital-rgb-gray-jpeg.pdf",
  "pdf/60-Image-CCITT-Groupe4.pdf",
  "pdf/digital-flate-smask.pdf",
  "pdf/digital-cmyk-jpeg.pdf",
  "pdf/05d-Dossier-Mixte.pdf",
];
const STRUCTURE_SEED = "pdf/05a-Rapport-Annuel-Digital.pdf";

const seeds = new Map<string, Seed>();

beforeAll(async () => {
  for (const name of [...IMAGE_SEEDS, STRUCTURE_SEED]) {
    const bytes = fixture(name);
    const trailer = new Map<string, PdfValue>();
    const xrefTrailer = readXref(bytes).trailer;
    for (const key of ["Root", "Info", "ID"]) {
      const value = xrefTrailer.get(key);
      if (value !== undefined) trailer.set(key, value);
    }
    const images = agreedTargets(bytes)
      .agreed.filter((target) => target.kind === "image")
      .map(({ num, gen }) => ({ num, gen }));
    seeds.set(name, { bytes, words: publishedWords((await extractPdf(bytes)).pages), trailer, images });
  }
});

const objectBytes = (num: number, gen: number, body: Uint8Array): Uint8Array =>
  concat([latin1(`${num} ${gen} obj\n`), body, latin1("\nendobj")]);

const dictBytes = (entries: PdfDict, choices: Choices): Uint8Array =>
  writeValue(modelOf({ kind: "dict", entries }), choices);

const num = (value: number): PdfValue => ({ kind: "number", value });
const name = (value: string): PdfValue => ({ kind: "name", value });
const ref = (n: number): PdfValue => ({ kind: "ref", num: n, gen: 0 });
const str = (bytes: Uint8Array): PdfValue => ({ kind: "string", bytes });

/** The pixel bytes `readImage` must give for an image it reads (§8.9.5 and the shared PNG writer's formats). */
function expectedLength(image: PdfImageData): number {
  if (image.format === "gray-1") return Math.ceil(image.width / 8) * image.height;
  return image.width * image.height * (image.format === "rgb-24" ? 3 : 4);
}

async function settle<T>(read: () => Promise<T>): Promise<{ value?: T; error?: unknown }> {
  try {
    return { value: await read() };
  } catch (error) {
    return { error };
  }
}

/** The file read with every page's operators, then extracted: a refusal of ours, or the intact words. */
async function readBoth(bytes: Uint8Array, seed: Seed): Promise<PdfSource | undefined> {
  const source = await settle(() => readPdfSource(bytes, { wantOps: () => true }));
  const extracted = await settle(() => extractPdf(bytes));
  if (source.error !== undefined) expectRefusalOfOurs(source.error);
  if (extracted.error !== undefined) {
    expectRefusalOfOurs(extracted.error);
    return undefined;
  }
  expect(publishedWords(extracted.value?.pages ?? []), "the words of the intact file").toEqual(seed.words);
  return source.value;
}

// ---------------------------------------------------------------------------------------------------------------------
// Images.

type Space = "DeviceGray" | "DeviceRGB" | "DeviceCMYK" | "Indexed";
const COMPONENTS: Readonly<Record<Space, number>> = { DeviceGray: 1, DeviceRGB: 3, DeviceCMYK: 4, Indexed: 1 };

interface ImageModel {
  readonly width: number;
  readonly height: number;
  readonly bpc: number;
  readonly space: Space;
  readonly hival: number;
  readonly filters: readonly FilterStep[];
  /** The data length against the exact one: exact (0), shorter (< 0) or longer (> 0). */
  readonly lengthShift: number;
  readonly dataSeed: number;
  /** Entries written over the dictionary, out of range now and then. */
  readonly wild: readonly (readonly [string, PdfValue])[];
}

const WILD_VALUES: readonly PdfValue[] = [
  num(0),
  num(-1),
  num(1.5),
  num(2 ** 31),
  num(100000),
  name("Foo"),
  { kind: "null" },
  { kind: "array", items: [num(1), num(0)] },
];

const imageArb: fc.Arbitrary<ImageModel> = fc
  .record({
    width: fc.integer({ min: 1, max: 24 }),
    height: fc.integer({ min: 1, max: 24 }),
    bpc: fc.constantFrom(1, 2, 4, 8, 8, 8, 16),
    space: fc.constantFrom<Space>("DeviceGray", "DeviceRGB", "DeviceRGB", "DeviceCMYK", "Indexed"),
    hival: fc.integer({ min: 0, max: 255 }),
    filters: fc.array(
      fc.constantFrom(...STREAM_FILTERS).map((filter): FilterStep => ({ filter })),
      { maxLength: 2 },
    ),
    lengthShift: fc.oneof({ weight: 4, arbitrary: fc.constant(0) }, fc.integer({ min: -40, max: 40 })),
    dataSeed: fc.nat(),
    wild: fc.oneof(
      { weight: 3, arbitrary: fc.constant([] as (readonly [string, PdfValue])[]) },
      fc.array(
        fc.tuple(
          fc.constantFrom("Width", "Height", "BitsPerComponent", "ColorSpace", "Decode", "ImageMask", "DecodeParms"),
          fc.constantFrom(...WILD_VALUES),
        ),
        { minLength: 1, maxLength: 2 },
      ),
    ),
  })
  // §8.6.6.3: an indexed image has at most 8 bits per sample.
  .map((model) => (model.space === "Indexed" && model.bpc > 8 ? { ...model, bpc: 8 } : model));

const exactLength = (model: ImageModel): number =>
  model.height * Math.ceil((model.width * COMPONENTS[model.space] * model.bpc) / 8);

/** The image XObject of `model`, as object `num gen`. */
function imageObject(model: ImageModel, n: number, gen: number, choices: Choices): Uint8Array {
  const samples = longData(Math.max(0, exactLength(model) + model.lengthShift), model.dataSeed);
  const body = encodeChain(samples, model.filters, choices);
  const entries = new Map<string, PdfValue>([
    ["Type", name("XObject")],
    ["Subtype", name("Image")],
    ["Width", num(model.width)],
    ["Height", num(model.height)],
    ["BitsPerComponent", num(model.bpc)],
    [
      "ColorSpace",
      model.space === "Indexed"
        ? {
            kind: "array",
            items: [
              name("Indexed"),
              name("DeviceRGB"),
              num(model.hival),
              str(longData(3 * (model.hival + 1), model.dataSeed + 1)),
            ],
          }
        : name(model.space),
    ],
    ...chainDict(model.filters, choices),
  ]);
  for (const [key, value] of model.wild) entries.set(key, value);
  entries.set("Length", num(body.length));
  return objectBytes(n, gen, concat([dictBytes(entries, choices), latin1("\nstream\n"), body, latin1("\nendstream")]));
}

/**
 * The images the reader's picture path decodes, measured on 24/11/2026 over the 133 combinations of colour space, bits
 * per component and one filter (fixture `digital-cmyk-jpeg`, its image replaced): grey, RGB or indexed samples of 1 to
 * 8 bits, unfiltered or under `/FlateDecode`. The rest is refused, a written limit and not a defect: another stream filter
 * ("bytes": LZW, RunLength, the two ASCII filters, an abbreviation, which §8.9.7 keeps for inline images), 16 bits or
 * CMYK samples ("shape"). An in-scope image that is painted and not read back is a failure.
 */
function inScope(model: ImageModel): boolean {
  const filters = model.filters.map((step) => step.filter);
  const flateOrNone = filters.length === 0 || (filters.length === 1 && filters[0] === "FlateDecode");
  return (
    flateOrNone && model.bpc <= 8 && model.space !== "DeviceCMYK" && model.wild.length === 0 && model.lengthShift === 0
  );
}

describe("images replaced through an incremental update (8.9.5, 7.5.6)", () => {
  it("nothing, or an image whose buffer is width × height × channels; a generated image read back has its size", async () => {
    const tally = new OutcomeTally();
    let inScopePainted = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...IMAGE_SEEDS),
        fc.nat(),
        imageArb,
        drawsArb,
        async (seedName, pick, model, draws) => {
          const seed = seeds.get(seedName) as Seed;
          const target = seed.images[pick % seed.images.length] as { num: number; gen: number };
          const choices = new Choices(draws);
          const written: WrittenObject = {
            num: target.num,
            gen: target.gen,
            bytes: imageObject(model, target.num, target.gen, choices),
          };
          const updated = appendObjects(asBuilt(seed.bytes), seed.trailer, [written], choices).bytes;
          const source = await readBoth(updated, seed);
          if (source === undefined) {
            tally.add("refused");
            return;
          }
          tally.add("read");
          // Which painted name is the replaced object, read from the page's resources and not from the decoded image:
          // an image the reader did not decode has no reference to give.
          const entries = source.document.pages();
          for (const [pageIndex, page] of source.pages.entries()) {
            const xobjects = source.document.dictOf(entries[pageIndex]?.resources?.get("XObject"));
            for (const op of page.ops) {
              if (op.op !== "paintImageXObject") continue;
              const imageName = String((op.args as unknown[])[0]);
              const image = page.readImage(imageName);
              const declared = xobjects?.get(imageName);
              const isReplaced = declared?.kind === "ref" && declared.num === target.num;
              if (isReplaced && inScope(model)) {
                inScopePainted += 1;
                expect(
                  image,
                  `an in-scope generated image not read back (${page.imageRefusal(imageName)})`,
                ).toBeDefined();
              }
              if (image === undefined) continue;
              expect(image.data.length, `${image.format} ${image.width} × ${image.height}`).toBe(expectedLength(image));
              if (!isReplaced || model.wild.length > 0) continue;
              expect([image.width, image.height], "the generated image's size").toEqual([model.width, model.height]);
            }
          }
        },
      ),
      params(40),
    );
    // Starting value to calibrate, measured on 24/11/2026 with this seed: 40 of 40 read, 400 of 400 at x10 (an image
    // the reader cannot decode is a lost picture, never a refused document).
    expect(tally.readShare, "share of updated files still read").toBeGreaterThanOrEqual(0.5);
    expect(inScopePainted, "in-scope generated images painted").toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Links, outlines, layers.

/** A link target: a plausible one, or bytes at random. */
const uriArb: fc.Arbitrary<Uint8Array> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc
      .tuple(
        fc.constantFrom(
          "http://",
          "https://",
          "ftp://",
          "mailto:",
          "tel:",
          "javascript:",
          "file:///",
          "www.",
          "",
          "data:",
        ),
        fc.stringMatching(/^[a-z0-9./%?#=&@:-]{0,24}$/u),
      )
      .map(([scheme, rest]) => latin1(scheme + rest)),
  },
  fc.uint8Array({ maxLength: 32 }),
);

const rectArb: fc.Arbitrary<PdfValue> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc
      .array(fc.integer({ min: -1000, max: 1000 }), { minLength: 4, maxLength: 4 })
      .map((items) => ({ kind: "array" as const, items: items.map(num) })),
  },
  fc.constantFrom<PdfValue>(
    { kind: "array", items: [num(0), num(0), num(1e300), num(-1e300)] },
    { kind: "array", items: [num(1), num(2)] },
    name("Rect"),
    { kind: "null" },
  ),
);

/** A link annotation (§12.5.6.5) with a URI action (§12.6.4.7), flags at random (§12.5.3 Table 165). */
const linkArb = fc.record({
  uri: uriArb,
  rect: rectArb,
  flags: fc.option(fc.integer({ min: 0, max: 63 }), { nil: undefined, freq: 3 }),
  newWindow: fc.integer({ min: 0, max: 4 }).map((draw) => draw === 0),
});

/** An outline tree (§12.3.3): `size` items, each of whose links points to an item at random (or nowhere), so cycles
 *  and broken chains both come out; titles of random bytes, a UTF-16BE byte order mark now and then. */
const outlineArb = fc.integer({ min: 1, max: 6 }).chain((size) =>
  fc.record({
    size: fc.constant(size),
    items: fc.array(
      fc.record({
        title: fc.oneof(
          fc.uint8Array({ maxLength: 40 }),
          fc.uint8Array({ maxLength: 40 }).map((bytes) => concat([Uint8Array.from([0xfe, 0xff]), bytes])),
          fc.constant(new Uint8Array(400).fill(0x41)),
        ),
        links: fc.array(fc.option(fc.integer({ min: 0, max: size }), { nil: undefined }), {
          minLength: 5,
          maxLength: 5,
        }),
        count: fc.option(fc.integer({ min: -5, max: 5 }), { nil: undefined }),
      }),
      { minLength: size, maxLength: size },
    ),
  }),
);

/** Optional content (§8.11.4): groups, and a default configuration whose arrays name them at random. */
const layersArb = fc.record({
  groups: fc.integer({ min: 0, max: 4 }),
  on: fc.array(fc.nat({ max: 5 }), { maxLength: 4 }),
  off: fc.array(fc.nat({ max: 5 }), { maxLength: 4 }),
  baseState: fc.constantFrom("ON", "OFF", "Unchanged", "Foo"),
  order: fc.boolean(),
});

type Structure =
  | { readonly kind: "link"; readonly link: typeof linkArb extends fc.Arbitrary<infer T> ? T : never }
  | { readonly kind: "outline"; readonly outline: typeof outlineArb extends fc.Arbitrary<infer T> ? T : never }
  | { readonly kind: "layers"; readonly layers: typeof layersArb extends fc.Arbitrary<infer T> ? T : never };

const OUTLINE_KEYS = ["First", "Last", "Next", "Prev", "Parent"] as const;

/** The objects an update writes for `structure`, from `next` on: new objects, and a new version of the first page
 *  (a link) or of the catalogue (an outline, layers). */
function structureObjects(bytes: Uint8Array, structure: Structure, next: number, choices: Choices): WrittenObject[] {
  const doc = openPdfObjects(bytes);
  const write = (n: number, gen: number, entries: PdfDict): WrittenObject => ({
    num: n,
    gen,
    bytes: objectBytes(n, gen, dictBytes(entries, choices)),
  });
  const rootRef = doc.trailer().get("Root");
  const root = new Map(doc.dictOf(rootRef) ?? []);
  const rootNum = rootRef?.kind === "ref" ? rootRef : { num: 1, gen: 0 };
  if (structure.kind === "link") {
    const { link } = structure;
    const action = new Map<string, PdfValue>([
      ["S", name("URI")],
      ["URI", str(link.uri)],
    ]);
    if (link.newWindow) action.set("NewWindow", { kind: "bool", value: true });
    const annot = new Map<string, PdfValue>([
      ["Type", name("Annot")],
      ["Subtype", name("Link")],
      ["Rect", link.rect],
      ["A", { kind: "dict", entries: action }],
    ]);
    if (link.flags !== undefined) annot.set("F", num(link.flags));
    const page = doc.pages()[0];
    if (page === undefined) return [];
    const pageDict = new Map(page.dict);
    pageDict.set("Annots", { kind: "array", items: [ref(next)] });
    return [write(next, 0, annot), write(page.ref.num, page.ref.gen, pageDict)];
  }
  if (structure.kind === "outline") {
    const { size, items } = structure.outline;
    const at = (index: number | undefined): PdfValue | undefined =>
      index === undefined ? undefined : ref(next + index);
    // Item 0 is the outline dictionary; items 1 to size are entries.
    const out: WrittenObject[] = [
      write(
        next,
        0,
        new Map<string, PdfValue>([
          ["Type", name("Outlines")],
          ["First", ref(next + 1)],
          ["Last", ref(next + size)],
        ]),
      ),
    ];
    items.forEach((item, index) => {
      const entries = new Map<string, PdfValue>([["Title", str(item.title)]]);
      OUTLINE_KEYS.forEach((key, k) => {
        const target = at(item.links[k]);
        if (target !== undefined) entries.set(key, target);
      });
      if (!entries.has("Parent")) entries.set("Parent", ref(next));
      if (item.count !== undefined) entries.set("Count", num(item.count));
      out.push(write(next + 1 + index, 0, entries));
    });
    root.set("Outlines", ref(next));
    out.push(write(rootNum.num, rootNum.gen, root));
    return out;
  }
  const { groups, on, off, baseState, order } = structure.layers;
  const groupRefs = Array.from({ length: groups }, (_, i) => ref(next + i));
  const pickRefs = (indices: readonly number[]): PdfValue => ({
    kind: "array",
    items: indices.map((i) => ref(next + i)),
  });
  const config = new Map<string, PdfValue>([
    ["BaseState", name(baseState)],
    ["ON", pickRefs(on)],
    ["OFF", pickRefs(off)],
  ]);
  if (order) config.set("Order", { kind: "array", items: groupRefs });
  root.set("OCProperties", {
    kind: "dict",
    entries: new Map<string, PdfValue>([
      ["OCGs", { kind: "array", items: groupRefs }],
      ["D", { kind: "dict", entries: config }],
    ]),
  });
  const out = groupRefs.map((_, i) =>
    write(
      next + i,
      0,
      new Map<string, PdfValue>([
        ["Type", name("OCG")],
        ["Name", str(latin1(`Layer ${i}`))],
      ]),
    ),
  );
  out.push(write(rootNum.num, rootNum.gen, root));
  return out;
}

const ACCEPTED_PROTOCOLS = new Set(["http:", "https:", "ftp:", "mailto:", "tel:"]);

/** One structure written through an update to 05a, read, then its links and outline checked. */
async function structureTrial(structure: Structure, draws: number[], seen: { link: number; outline: number }) {
  const seed = seeds.get(STRUCTURE_SEED) as Seed;
  const choices = new Choices(draws);
  const base = asBuilt(seed.bytes);
  const objects = structureObjects(seed.bytes, structure, base.nextNum, choices);
  const updated = appendObjects(base, seed.trailer, objects, choices).bytes;
  const source = await readBoth(updated, seed);
  if (source === undefined) return "refused" as const;
  for (const link of source.pages.flatMap((page) => page.links)) {
    seen.link += 1;
    expect(ACCEPTED_PROTOCOLS.has(new URL(link.url).protocol), link.url).toBe(true);
    expect(
      link.rect.every((value) => Number.isFinite(value)),
      String(link.rect),
    ).toBe(true);
  }
  const outline = source.outline;
  if (outline === undefined) return "read" as const;
  seen.outline += 1;
  expect(outline.length).toBeLessThanOrEqual(OUTLINE_READ_MAX_ENTRIES);
  outline.forEach((entry) => {
    expect(entry.title.length).toBeLessThanOrEqual(OUTLINE_TITLE_MAX_CHARS);
    expect(Number.isInteger(entry.depth) && entry.depth >= 1).toBe(true);
    // Not checked: a depth one more than the entry before. An item without a title is left out and its children keep
    // their depth (`pdf-outline.ts#flattenOutline`): the first entry may sit at depth 2 (observed 24/11/2026).
  });
  return "read" as const;
}

describe("links, outlines and layers written through an incremental update (12.5.6.5, 12.3.3, 8.11.4)", () => {
  // Starting values to calibrate, measured on 24/11/2026 with this seed (see the commit).
  for (const [label, arb, runs, reached] of [
    [
      "a link has an accepted protocol and a finite rectangle",
      linkArb.map((link) => ({ kind: "link" as const, link })),
      30,
      "link",
    ],
    [
      "the outline is absent or within its bounds",
      outlineArb.map((outline) => ({ kind: "outline" as const, outline })),
      10,
      "outline",
    ],
    ["layers change no word", layersArb.map((layers) => ({ kind: "layers" as const, layers })), 5, undefined],
  ] as const) {
    it(`${label}; the words stay; a failure is a refusal of ours`, async () => {
      const tally = new OutcomeTally();
      const seen = { link: 0, outline: 0 };
      await fc.assert(
        fc.asyncProperty(arb as fc.Arbitrary<Structure>, drawsArb, async (structure, draws) => {
          tally.add(await structureTrial(structure, draws, seen));
        }),
        params(runs),
      );
      // The reader must be reached, or the property sees nothing of it.
      if (reached !== undefined) expect(seen[reached], `${reached}s read`).toBeGreaterThan(0);
      expect(tally.readShare, "share of updated files still read").toBeGreaterThanOrEqual(0.5);
    });
  }
});
