/** The CCITT image of a digital page, as the image reader takes it (`pdf-ccitt-images.ts`). The fixture
 *  `fixtures/pdf/60-Image-CCITT-Groupe4.pdf` is a made-up digital page (text and one CCITT picture, 24 × 20, coded by libtiff); its
 *  generator DREW the picture and counts 147 black pixels in its drawing, which our decoder gives back (19/11/2026). The page it
 *  replaced carried a picture of a real document; the decoder of pdf.js (since removed) and ours agreed on it (1/11/2026). */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ccittImageObjectOf } from "./pdf-ccitt-images";
import { openPdfObjects } from "./pdf-objects/document";

const GREY_1 = 1;
const FILE = new Uint8Array(readFileSync(join(__dirname, "../../fixtures/pdf/60-Image-CCITT-Groupe4.pdf")));
const fixture = () => openPdfObjects(FILE);

describe("ccittImageObjectOf: une image CCITT lue par notre décodeur", () => {
  it("gives the size, the 1-bit grey format, and the 147 black pixels its generator drew", () => {
    const doc = fixture();
    const image = ccittImageObjectOf(doc, FILE, doc.pages()[0]!, "Im1", GREY_1)!;
    expect([image.width, image.height, image.kind]).toEqual([24, 20, GREY_1]);
    expect(image.data.length).toBe(3 * 20);
    let black = 0;
    for (const byte of image.data) for (let bit = 0; bit < 8; bit += 1) if (((byte >> bit) & 1) === 0) black += 1;
    expect(black).toBe(147);
  });

  it("une image qui n'est pas CCITT n'est pas décodée ici", () => {
    const doc = fixture();
    expect(ccittImageObjectOf(doc, FILE, doc.pages()[0]!, "Missing", GREY_1)).toBeUndefined();
  });
});
