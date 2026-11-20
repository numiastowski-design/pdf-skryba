/** POC `docs/POC-SANS-PDFJS.md`: how many glyphs a content stream PAINTS, and with which font — the only
 *  implementation, read by the two POC tools (`./glyph-count-shadow.ts` (deleted, see git history), `./first-divergence.ts` (deleted, see git history)).
 *  DEVELOPMENT tool, outside the bundle. Decides: nothing, it counts.
 *
 *  🔴 WHAT IT COST TO WRITE IT (31/10/2026): **the font is part of the GRAPHICS STATE**
 *  (ISO 32000-1 §8.4.1, Table 52: the TEXT state, font included, is in the graphics state), so `q`
 *  saves it and `Q` RESTORES IT. A reader that follows the `Tf` linearly gets the wrong font after every `Q` — and
 *  this is no textbook case: Word's generator writes
 *      q BT /F4 Tf [<002F00B6>…] TJ ET Q  q BT [(p)13(r)-3(i)…] TJ ET Q
 *  where the SECOND block has NO `Tf` and paints with the font from before the `q`. Measured: this single error
 *  explained 7,026 glyphs of difference with pdf.js on 4 files (a Type0 font counted at 2 bytes per glyph
 *  where the real font takes 1).
 *
 *  WHAT IT ASSUMED IS MEASURED (31/10/2026, `./type0-codespace.ts`): a Type0 font encodes its glyphs on
 *  TWO bytes. On the 304 files of the fixtures and the corpus, **1,156 Type0 fonts used, ALL in
 *  `Identity-H`**, zero counter-examples — neither an embedded CMap nor a predefined CMap. The limit that remains, written down: a
 *  CJK document with a predefined CMap (`UniGB-UCS2-H` and its siblings) may encode on one byte in certain ranges,
 *  and would then count its glyphs twice; the corpus contains none, and the tool above would say so.
 *  NOT here: the position of the glyphs, their unicode, their advance. */

import { readContentOps } from "../../src/extractor/pdf-objects/content";
import type { PdfObjectsDocument } from "../../src/extractor/pdf-objects/document";
import type { PdfDict, PdfValue } from "../../src/extractor/pdf-objects/objects";

/** §8.10: forms nested deeper than this are not followed. */
const MAX_FORM_DEPTH = 8;
/** §8.4.4: pdf.js kept 256 levels of saved state (removed since); the same ceiling is kept here. */
const MAX_STATE_DEPTH = 256;

export const nameOf = (value: PdfValue | undefined): string | undefined =>
  value?.kind === "name" ? value.value : undefined;

const stringBytes = (value: PdfValue | undefined): number => (value?.kind === "string" ? value.bytes.length : 0);

/** One text-showing operator: the font in force, how many glyphs it paints, and the codes it paints (hex). */
export interface Shown {
  readonly font: string;
  readonly glyphs: number;
  readonly codes: string;
  readonly where: string;
  /** The font in force as the STREAM'S RESOURCES name it — those of the form when we are inside a
   *  form. Without it, a `/F1` painted in a form was classed with the PAGE's `/F1`, which is often a
   *  different font: the census verdict depends on it (review of 31/10/2026). */
  readonly fontValue: PdfValue | undefined;
  /** Bytes per glyph code in the font in force: 1, or 2 for a Type0 (§9.4.3). */
  readonly perGlyph: number;
}

interface TextState {
  font: string;
  perGlyph: number;
  fontValue: PdfValue | undefined;
}

/** §9.4.3: how many bytes one glyph code takes in this font — one for a simple font, two for a Type0. */
function bytesPerGlyph(doc: PdfObjectsDocument, font: PdfDict | undefined): number {
  if (font === undefined) return 1;
  return nameOf(doc.resolve(font.get("Subtype"))) === "Type0" ? 2 : 1;
}

/** Every text-showing operator of one stream, forms followed, the graphics state stack honoured. */
export function shownOf(
  doc: PdfObjectsDocument,
  data: Uint8Array,
  resources: PdfDict | undefined,
  into: Shown[] = [],
  depth = 0,
  inherited: TextState = { font: "?", perGlyph: 1, fontValue: undefined },
): Shown[] {
  const fonts = doc.dictOf(resources?.get("Font"));
  const xobjects = doc.dictOf(resources?.get("XObject"));
  // The state the stream starts in is the one its caller was in (a form inherits the state of the `Do`).
  let state: TextState = { ...inherited };
  const saved: TextState[] = [];
  const where = depth === 0 ? "page" : `forme/${depth}`;

  for (const { op, operands } of readContentOps(data)) {
    if (op === "q") {
      // Past the ceiling we STILL PUSH the state: skipping the save would desynchronise the stack
      // for good, and every following `Q` would restore the wrong level — hence the wrong font, exactly the
      // defect that the header of this file tells (review of 31/10/2026). Here the ceiling only serves to say that the
      // page is abnormal, not to save work.
      if (saved.length >= MAX_STATE_DEPTH) throw new Error(`plus de ${MAX_STATE_DEPTH} états graphiques empilés`);
      saved.push({ ...state });
      continue;
    }
    if (op === "Q") {
      // §8.4.4: an unbalanced `Q` restores nothing rather than failing the page.
      const restored = saved.pop();
      if (restored !== undefined) state = restored;
      continue;
    }
    if (op === "Tf") {
      const name = nameOf(operands[0]) ?? "?";
      const fontValue = fonts?.get(name);
      state = { font: name, perGlyph: bytesPerGlyph(doc, doc.dictOf(fontValue)), fontValue };
      continue;
    }
    if (op === "Tj" || op === "'" || op === '"') {
      const shown = operands[operands.length - 1];
      into.push({
        font: state.font,
        glyphs: Math.ceil(stringBytes(shown) / state.perGlyph),
        codes: shown?.kind === "string" ? Buffer.from(shown.bytes).toString("hex") : "",
        where: `${where} ${state.perGlyph}o`,
        fontValue: state.fontValue,
        perGlyph: state.perGlyph,
      });
      continue;
    }
    if (op === "TJ") {
      const array = operands[0];
      if (array?.kind !== "array") continue;
      let glyphs = 0;
      let codes = "";
      for (const item of array.items) {
        if (item.kind !== "string") continue;
        glyphs += Math.ceil(item.bytes.length / state.perGlyph);
        codes += Buffer.from(item.bytes).toString("hex");
      }
      into.push({
        font: state.font,
        glyphs,
        codes,
        where: `${where} ${state.perGlyph}o`,
        fontValue: state.fontValue,
        perGlyph: state.perGlyph,
      });
      continue;
    }
    if (op === "Do" && depth < MAX_FORM_DEPTH) {
      const name = nameOf(operands[0]);
      const resolved = doc.resolve(name === undefined ? undefined : xobjects?.get(name));
      if (resolved?.kind !== "stream" || nameOf(doc.resolve(resolved.dict.get("Subtype"))) !== "Form") continue;
      // §8.10.1: the form's own resources, or the page's when it declares none.
      const own = doc.dictOf(resolved.dict.get("Resources")) ?? resources;
      shownOf(doc, doc.streamBytes(resolved), own, into, depth + 1, state);
    }
  }
  return into;
}

/** The content of one page as ONE stream. §7.7.3.3 is explicit: an array of streams « shall be treated as a
 *  single stream », concatenated with white space between them — so the graphics state carries from one to the
 *  next, and reading them separately would reset the font at each boundary. */
export function contentsOf(doc: PdfObjectsDocument, page: { dict: PdfDict }): Uint8Array {
  const contents = doc.resolve(page.dict.get("Contents"));
  if (contents === undefined) return new Uint8Array(0);
  const streams = contents.kind === "array" ? contents.items.map((item) => doc.resolve(item)) : [contents];
  const parts: Buffer[] = [];
  for (const stream of streams) {
    if (stream?.kind !== "stream") continue;
    parts.push(Buffer.from(doc.streamBytes(stream)), Buffer.from("\n", "latin1"));
  }
  return new Uint8Array(Buffer.concat(parts));
}
