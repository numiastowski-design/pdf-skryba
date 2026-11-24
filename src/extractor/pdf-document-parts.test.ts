/**
 * A part of the document that carries no text fails ALONE (decision of 24/11/2026): one bad byte in the `/Info`
 * dictionary, an outline item, an image XObject, a link annotation or a `/Metadata` stream drops that part, and the
 * read goes on with the same words. Found by lot 6 of the PDF fuzz (`pdf-document.property.test.ts`).
 * Each case breaks the syntax of ONE object of a real fixture: its first `<<` becomes `))`, the file's length kept, so
 * the cross-reference table stays true (no repair is involved).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { extractPdf } from "./pdf";
import { agreedTargets, publishedWords, type TargetKind } from "./pdf-document-fuzz.test.support";
import { openPdfObjects } from "./pdf-objects/document";
import { decodePdfTextString } from "./pdf-text-string";
import { readPdfSource } from "./pdf-source";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (path: string): Uint8Array => new Uint8Array(readFileSync(join(here, "../../fixtures", path)));

/** `bytes` with the first `<<` of object `num` turned into `))`: a syntax refusal at that object, and only there. */
function broken(bytes: Uint8Array, num: number, kind: TargetKind): Uint8Array {
  const target = agreedTargets(bytes).agreed.find((candidate) => candidate.num === num);
  expect(target?.kind, `object ${num}`).toBe(kind);
  const at = Buffer.from(bytes.subarray(target!.start, target!.end)).indexOf("<<");
  expect(at).toBeGreaterThan(0);
  const out = bytes.slice();
  out[target!.start + at] = 0x29;
  out[target!.start + at + 1] = 0x29;
  return out;
}

const WORD_TOR = "docx-heading-reel/09-2026-terms-of-reference-working-group-on-interim-state-architecture-fo-Word.pdf";

describe("a part that carries no text fails alone (decision of 24/11/2026)", () => {
  it("the /Info dictionary: the same words, the document facts absent", async () => {
    const intact = fixture("pdf/05a-Rapport-Annuel-Digital.pdf");
    const damaged = broken(intact, 7, "info");
    expect(publishedWords((await extractPdf(damaged)).pages)).toEqual(publishedWords((await extractPdf(intact)).pages));
    expect((await readPdfSource(intact)).info).toBeDefined();
    expect((await readPdfSource(damaged)).info).toBeUndefined();
  });

  it("an outline item: the same words, that item absent and the items before it kept", async () => {
    const intact = fixture(WORD_TOR);
    const damaged = broken(intact, 51, "outline");
    expect(publishedWords((await extractPdf(damaged)).pages)).toEqual(publishedWords((await extractPdf(intact)).pages));
    const title = openPdfObjects(intact).dictOf({ kind: "ref", num: 51, gen: 0 })?.get("Title");
    const itemTitle = title?.kind === "string" ? decodePdfTextString(title.bytes).normalize("NFKC").trim() : "";
    const before = (await readPdfSource(intact)).outline ?? [];
    const after = (await readPdfSource(damaged)).outline ?? [];
    expect(before.map((entry) => entry.title)).toContain(itemTitle);
    expect(after.map((entry) => entry.title)).not.toContain(itemTitle);
    expect(after).toEqual(before.slice(0, after.length));
  });

  it("an image XObject: the same words, the image lost and counted in the pdf-image-unread notice", async () => {
    const intact = fixture("pdf/60-Image-CCITT-Groupe4.pdf");
    const damaged = broken(intact, 5, "image");
    const before = await extractPdf(intact);
    const after = await extractPdf(damaged);
    expect(publishedWords(after.pages)).toEqual(publishedWords(before.pages));
    expect(before.images ?? []).toHaveLength(1);
    expect(after.images ?? []).toEqual([]);
    expect(after.notices).toContainEqual(expect.objectContaining({ kind: "pdf-image-unread", unreadable: 1 }));
  });

  it("a link annotation: the same words, that link absent and the others kept", async () => {
    const intact = fixture("pdf/31-Guide-Demarche-AAP-LibreOffice.pdf");
    const damaged = broken(intact, 14, "link");
    expect(publishedWords((await extractPdf(damaged)).pages)).toEqual(publishedWords((await extractPdf(intact)).pages));
    const before = (await readPdfSource(intact)).pages.flatMap((page) => page.links);
    const after = (await readPdfSource(damaged)).pages.flatMap((page) => page.links);
    expect(after).toHaveLength(before.length - 1);
    for (const link of after) expect(before).toContainEqual(link);
  });

  // Green before the decision too: the reader never reads a `/Metadata` stream. Kept so that the day it does, it reads
  // it as a part that fails alone.
  it("a /Metadata stream: the same words", async () => {
    const intact = fixture(WORD_TOR);
    const damaged = broken(intact, 558, "metadata");
    expect(publishedWords((await extractPdf(damaged)).pages)).toEqual(publishedWords((await extractPdf(intact)).pages));
  });
});
