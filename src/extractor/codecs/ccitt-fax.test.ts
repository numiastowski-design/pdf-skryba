/** The CCITT fax decoder (`ccitt-fax.ts`). The reference was pdf.js's own decoder (since removed from the product), which ran PDFium's code: the whole
 *  corpus of 264 CCITT images was compared to it once, row by row, and all 264 agreed (1/11/2026). The vector below is a
 *  MADE-UP picture (19/11/2026; it was the smallest image of that corpus, taken from a real document): its rows are
 *  known from the drawing itself, without decoding anything, and its stream is written by libtiff, not by us. The hash
 *  is the hash of the rows, with the padding bits of each row's last byte ignored. */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { decodeCcittFax, type CcittOptions } from "./ccitt-fax";

/** The Group 4 stream of a made-up 24 × 20 picture — a frame, a diagonal, a filled block, a dotted row. The generator
 *  beside the made-up PDF that carries the same stream prints both this text and the hash below, from its drawing. */
const VECTOR = Uint8Array.from(
  Buffer.from("JqBeU5QzspP2VMF7K/7K77Kz7Kv7KI7KR2UfsqnZU+yv7K7srOR0R0R0R0R0R0CBJEdAgS4iIiIi0+wXEYAIAIA=", "base64"),
);
const VECTOR_OPTIONS: CcittOptions = {
  K: -1,
  EndOfLine: false,
  EncodedByteAlign: false,
  BlackIs1: false,
  columns: 24,
  rows: 20,
};

/** The hash of the rows, the bits of each row's last byte beyond the columns left out. */
function hashOf(bits: Uint8Array, columns: number, rows: number, pitch: number): string {
  const bytes = Math.ceil(columns / 8);
  const last = columns % 8 === 0 ? 0xff : (0xff << (8 - (columns % 8))) & 0xff;
  const picture = new Uint8Array(rows * bytes);
  for (let r = 0; r < rows; r += 1) {
    for (let i = 0; i < bytes; i += 1) {
      const mask = i === bytes - 1 ? last : 0xff;
      picture[r * bytes + i] = (bits[r * pitch + i]! & mask) | (~mask & 0xff);
    }
  }
  return createHash("sha256").update(picture).digest("hex");
}

describe("decodeCcittFax: le décodeur CCITT, contre pdf.js sur le corpus", () => {
  it("a made-up picture coded by libtiff gives back the rows its generator drew", () => {
    const image = decodeCcittFax(VECTOR, VECTOR_OPTIONS)!;
    expect(image.rows).toBe(20);
    // The last row is the bottom of the frame, all black: a decoder that stopped early would leave it white.
    expect([...image.bits.subarray(19 * image.pitch, 19 * image.pitch + 3)]).toEqual([0, 0, 0]);
    expect(hashOf(image.bits, 24, 20, image.pitch)).toBe(
      "99f98e91d9e72e57167dece8f9a9a33ab7da45b4453405a2a36e01def3d14fc2",
    );
  });

  it("des lignes verticales sans changement sont des lignes blanches (V0 : un bit à 1 par ligne)", () => {
    const image = decodeCcittFax(Uint8Array.from([0xff, 0xff]), { ...VECTOR_OPTIONS, rows: 8 })!;
    expect(image.bits.every((b) => b === 0xff)).toBe(true);
  });

  it("BlackIs1 inverse le dessin : le même flux donne des bits complémentaires", () => {
    const normal = decodeCcittFax(VECTOR, VECTOR_OPTIONS)!;
    const inverted = decodeCcittFax(VECTOR, { ...VECTOR_OPTIONS, BlackIs1: true })!;
    expect(inverted.bits.every((b, i) => b === (~normal.bits[i]! & 0xff))).toBe(true);
  });

  it("un flux qui s'arrête tôt laisse les lignes manquantes blanches", () => {
    const image = decodeCcittFax(VECTOR.subarray(0, 4), VECTOR_OPTIONS)!;
    const lastRow = image.bits.subarray((image.rows - 1) * image.pitch, image.rows * image.pitch);
    expect(lastRow.every((b) => b === 0xff)).toBe(true);
  });

  it("une image trop grande est refusée, comme PDFium refuse plus de 65 535 pixels de côté", () => {
    expect(decodeCcittFax(VECTOR, { ...VECTOR_OPTIONS, columns: 70000 })).toBeUndefined();
    expect(decodeCcittFax(VECTOR, { ...VECTOR_OPTIONS, columns: 60000, rows: 60000 })).toBeUndefined();
  });
});
