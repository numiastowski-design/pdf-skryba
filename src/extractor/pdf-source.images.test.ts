/**
 * The painted images, read by the boundary (15/09/2026): an image our reader does not decode is counted, never lost.
 * NOT here: the boundary's reading of every painted image of a real Word document, which this package may not carry.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractPdf } from "./pdf";
import { readPdfSource } from "./pdf-source";

const here = dirname(fileURLToPath(import.meta.url));
/** A public scan: 11 pages, each painting two JPXDecode images (plus a JBIG2 stream per page, never painted on its own). */
const dominion = () =>
  new Uint8Array(readFileSync(join(here, "../../fixtures/pdf/scans-publics/Dominion-Saw-Works-1886.pdf")));

const paintedNames = (ops: readonly { op: string; args: unknown }[]): string[] =>
  ops.filter((o) => o.op === "paintImageXObject").map((o) => String((o.args as unknown[])[0]));

/** JPX and JBIG2 images are never decoded: their decoders needed the `wasmUrl` our factory refused (`pdfjs-module.ts` (deleted, see git history), removed with pdf.js). Measured
 *  07/10/2026, with pdf.js: it delivered each object with nothing in it, so the boundary saw it arrive (not « slow ») and empty. */
describe("an image our reader does not decode (JPX, JBIG2) is counted, never silently lost (Dominion-Saw-Works-1886)", () => {
  it("the 22 JPX paintings arrive without pixels and without a PDF object: failure « unreadable », never « slow »", async () => {
    const source = await readPdfSource(dominion(), { wantOps: () => true });
    const all = source.pages.flatMap((page) => paintedNames(page.ops).map((name) => ({ name, page })));
    expect(all).toHaveLength(22);
    expect(all.map(({ page, name }) => [page.readImage(name), page.imageRef(name), page.imageFailure(name)])).toEqual(
      all.map(() => [undefined, undefined, "unreadable"]),
    );
  });

  it("extractPdf publishes no image and counts the 22 placements in ONE pdf-image-unread notice", async () => {
    const result = await extractPdf(dominion());
    expect(result.images ?? []).toEqual([]);
    // 03/11/2026: the notice NAMES what it counts. All 22 placements are JPEG 2000, so all say `codec` — the cause
    // that means « nothing to do about it », our written limit of the 05/10/2026. Five are named, 17 counted in `more`.
    // The ids are the ORDER of the picture on its page (`#1`, `#2`), composed by us: our reader gives no PDF object for
    // these pictures — which is what the test above asserts — and the resource names the file wrote (`img274`, `Im001`)
    // are client content, kept out of every notice (review 06/11/2026). Each PLACEMENT is named, not each picture.
    expect(result.notices).toEqual([
      {
        kind: "pdf-image-unread",
        slow: 0,
        unreadable: 22,
        places: [
          { page: 1, id: "#1", why: "codec" },
          { page: 1, id: "#2", why: "codec" },
          { page: 2, id: "#1", why: "codec" },
          { page: 2, id: "#2", why: "codec" },
          { page: 3, id: "#1", why: "codec" },
        ],
        more: 17,
      },
    ]);
  });
});
