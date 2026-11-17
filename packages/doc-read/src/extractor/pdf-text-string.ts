/** Decodes a PDF TEXT STRING (ISO 32000-1:2008 §7.9.2.2): UTF-16BE when it starts with the BOM FE FF,
 *  PDFDocEncoding otherwise. Decides: the text of a title, an annotation, a bookmark. Nothing else.
 *  The PDFDocEncoding codes beyond ASCII come from ANNEX D OF THE STANDARD, read by
 *  `tools/poc/build-pdfdoc-table.ts` (deleted, see git history): never from memory. A code the standard does not define is not published
 *  (neither a control character nor an invention): it is an abstention, as everywhere else with us.
 *  NOT here: the content strings of a page (`./pdf-fonts/`), the reading of the object that carries the string.
 *  Called by: `extractor/pdf-outline.ts`, `extractor/pdf-symbol-page.ts` (future), `pdf-text-string.test.ts`. */

/** PDFDocEncoding above ASCII, for the codes the standard defines: 0x18–0x1F, 0x80–0x9E and 0xA0.
 *  Source: ISO 32000-1 Annex D (pages 665, 668 and 669 of the standard), extracted by tools/poc/build-pdfdoc-table.ts. */
const PDFDOC_HIGH: ReadonlyMap<number, number> = new Map<number, number>([
  [0x18, 0x02d8],
  [0x19, 0x02c7],
  [0x1a, 0x02c6],
  [0x1b, 0x02d9],
  [0x1c, 0x02dd],
  [0x1d, 0x02db],
  [0x1e, 0x02da],
  [0x1f, 0x02dc],
  [0x80, 0x2022],
  [0x81, 0x2020],
  [0x82, 0x2021],
  [0x83, 0x2026],
  [0x84, 0x2014],
  [0x85, 0x2013],
  [0x86, 0x0192],
  [0x87, 0x2044],
  [0x88, 0x2039],
  [0x89, 0x203a],
  [0x8a, 0x2212],
  [0x8b, 0x2030],
  [0x8c, 0x201e],
  [0x8d, 0x201c],
  [0x8e, 0x201d],
  [0x8f, 0x2018],
  [0x90, 0x2019],
  [0x91, 0x201a],
  [0x92, 0x2122],
  [0x93, 0xfb01],
  [0x94, 0xfb02],
  [0x95, 0x0141],
  [0x96, 0x0152],
  [0x97, 0x0160],
  [0x98, 0x0178],
  [0x99, 0x017d],
  [0x9a, 0x0131],
  [0x9b, 0x0142],
  [0x9c, 0x0153],
  [0x9d, 0x0161],
  [0x9e, 0x017e],
  [0xa0, 0x20ac],
]);

/** A code point that really designates a publishable character: neither U+0000, nor half of a surrogate pair. */
const isPublishable = (code: number): boolean => code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);

/** UTF-16BE after the BOM: surrogate pairs are recomposed, a lone half is dropped. */
function decodeUtf16(bytes: Uint8Array): string {
  const units: number[] = [];
  for (let at = 2; at + 1 < bytes.length; at += 2) units.push(((bytes[at] as number) << 8) | (bytes[at + 1] as number));
  let out = "";
  for (let i = 0; i < units.length; i += 1) {
    const unit = units[i] as number;
    const next = units[i + 1];
    if (unit >= 0xd800 && unit <= 0xdbff && next !== undefined && next >= 0xdc00 && next <= 0xdfff) {
      out += String.fromCodePoint(0x10000 + ((unit - 0xd800) << 10) + (next - 0xdc00));
      i += 1;
      continue;
    }
    if (isPublishable(unit)) out += String.fromCharCode(unit);
  }
  return out;
}

/** PDFDocEncoding: printable ASCII and latin-1 above 0xA1 are in place; the other codes
 *  go through the standard's table, or are dropped if it does not define them. */
function decodePdfDoc(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    if ((byte >= 0x20 && byte <= 0x7e) || byte >= 0xa1) out += String.fromCharCode(byte);
    const mapped = PDFDOC_HIGH.get(byte);
    if (mapped !== undefined) out += String.fromCodePoint(mapped);
  }
  return out;
}

/** The text of a PDF string. A code the standard does not define returns nothing. */
export function decodePdfTextString(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return decodeUtf16(bytes);
  return decodePdfDoc(bytes);
}
