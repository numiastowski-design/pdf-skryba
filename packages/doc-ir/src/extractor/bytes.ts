/** Big-endian byte helpers and one concatenation, shared by the image and JPEG readers, the PNG reader and writer, and the zip reader.
 *  Reads past the end count as 0, so a truncated header never throws.
 *  NOT here: any format knowledge (what a PNG or JPEG field means) or little-endian reads (the zip readers keep their own).
 *  Called by: `extractor/{image-format,png,png-decode}.ts`, `extractor/jpeg/markers.ts`, `extractor/zip/zip-package.ts`. */

export const u16be = (b: Uint8Array, at: number): number => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
export const u32be = (b: Uint8Array, at: number): number => ((u16be(b, at) << 16) | u16be(b, at + 2)) >>> 0;

/** The four big-endian bytes of an unsigned 32-bit value. */
export const putU32be = (value: number): Uint8Array =>
  new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);

/** The parts laid end to end in one fresh array. `total` is their summed length when the caller already knows it. */
export const concatBytes = (
  parts: readonly Uint8Array[],
  total: number = parts.reduce((n, p) => n + p.length, 0),
): Uint8Array => {
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
