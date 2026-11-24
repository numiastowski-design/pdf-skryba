/** The operator stream of a page, read from OUR content stream and our dictionary, in the shape `pdf-ops.ts` gives
 *  the operator list pdf.js used to give (removed 01/11/2026): the same operator names and the same argument shapes the walkers read.
 *  Decides: which operator a content operator becomes; that `Tf` names its font by OUR key, `scope + separator + resource
 *  name` (the key `pdf-font-bridge.ts` uses); that a showing operator carries OUR glyphs (`glyphsOfString`, the reader of
 *  `pdf-glyph-source.ts`, with the font state of `q`/`Q`); that `'` and `"` are read as pdf.js read them (a line
 *  move, then the showing); that a form XObject is inlined between `paintFormXObjectBegin` and `paintFormXObjectEnd`,
 *  with its own resources or those of the form that draws it, to a depth of `MAX_FORM_DEPTH`; that an optional-content
 *  operand is the group `layerConfigOf` reads; that a path is built by `PathBuilder`.
 *  🔴 LIMITS, written: (1) the vertical advance is not computed: the glyphs of a vertically written font are only marked
 *  (`vmetric`, see `verticalGlyphs`) and the position reader refuses them; (2) the images are not decoded here:
 *  `paintImageXObject` carries the resource name, and our image readers (`pdf-images.ts` and the decoders) read the picture; (3) a colour in another space than
 *  the device ones is not converted (`fillColourOf`).
 *  NOT here: what the operators mean (`glyph-positions.ts`, `pdf-table-detector.ts`), the fonts (`pdf-font-*.ts`).
 *  Called by: `extractor/pdf-source.ts`, the only way a page's operators are read since pdf.js left. */

import type { PdfObjectsDocument, PdfPageEntry } from "./pdf-objects/document";
import { MAX_CONTENT_OPS } from "./pdf-objects/bounds";
import { readContentOps, type ContentOp } from "./pdf-objects/content";
import { partOrAbsent, PdfObjectsRefusal } from "./pdf-objects/refusal";
import { pageContentOf, parsedFormOf } from "./pdf-page-content";
import { refKey, type PdfDict, type PdfStream, type PdfValue } from "./pdf-objects/objects";
import { SCOPE_SEPARATOR } from "./pdf-font-bridge";
import { cmykHex, greyHex, rgbHex } from "./pdf-colour-ours";
import {
  chargeFormCall,
  glyphsOfString,
  newGlyphMemo,
  MAX_STATE_DEPTH,
  stateOf,
  UNKNOWN,
  type GlyphBudget,
  type GlyphMemo,
  type OurGlyph,
  type TextState,
} from "./pdf-glyph-source";
import { PathBuilder, PATH_OPS } from "./pdf-paths-ours";
import type { PdfOp } from "./pdf-ops";
import type { Matrix2D } from "../layout/geometry";

/** A form nested deeper than this is not inlined: its operators are not read, as pdf.js stopped there. Same value as
 *  `pdf-font-bridge.ts` and `pdf-glyph-source.ts`, so the three readings of forms stay identical. */
const MAX_FORM_DEPTH = 8;

/** The content operators that carry their operands through, one to one with the name pdf.js gave them. */
const ONE_TO_ONE: Readonly<Record<string, string>> = {
  q: "save",
  Q: "restore",
  BT: "beginText",
  ET: "endText",
  TL: "setLeading",
  Tc: "setCharSpacing",
  Tw: "setWordSpacing",
  Tz: "setHScale",
  Ts: "setTextRise",
  Tr: "setTextRenderingMode",
  Td: "moveText",
  TD: "setLeadingMoveText",
  "T*": "nextLine",
  sh: "paintShading",
};

const numberOf = (value: PdfValue | undefined): number | undefined =>
  value?.kind === "number" ? value.value : undefined;

const nameOf = (value: PdfValue | undefined): string | undefined => (value?.kind === "name" ? value.value : undefined);

/** A matrix of six numbers, the form pdf-ops reads (`Matrix2D` after `transform` and `setTextMatrix`). */
const matrixOf = (values: readonly number[]): Matrix2D => ({
  a: values[0]!,
  b: values[1]!,
  c: values[2]!,
  d: values[3]!,
  e: values[4]!,
  f: values[5]!,
});

/** The key of a resource in a scope: the page's scope is empty, a form's scope is `form:<name>` (nested with `/`). */
const keyOf = (scope: string, name: string): string => `${scope}${SCOPE_SEPARATOR}${name}`;

/** What one page's reading shares: the fonts and tables read so far, and the glyph budget of the page. */
interface PageContext {
  readonly doc: PdfObjectsDocument;
  readonly memo: GlyphMemo;
  readonly budget: GlyphBudget;
}

/** The font a stream shows with: its glyph reader, and whether it writes vertically. */
interface TextFont {
  readonly state: TextState;
  readonly vertical: boolean;
}

/** The font of a stream, saved and restored with `q`/`Q` (ISO 32000-1 §8.4.1, Table 52: the font is part of it). */
interface TextTracker {
  font: TextFont;
  readonly saved: TextFont[];
}

/** A Type0 font written vertically (§9.7.4.2): its encoding is `Identity-V` or a predefined `…-V` CMap. Read from the
 *  dictionary, so it holds even where our glyph reader gives up on the font. An embedded CMap whose `/WMode` is 1 is
 *  NOT seen here: no document of the corpus has one, and that is written as a limit. */
function isVerticalFont(doc: PdfObjectsDocument, dict: PdfDict | undefined): boolean {
  if (dict === undefined || nameOf(doc.resolve(dict.get("Subtype"))) !== "Type0") return false;
  return /-V$/.test(nameOf(doc.resolve(dict.get("Encoding"))) ?? "");
}

/** Glyphs of a vertical font are marked: the position reader refuses them (`glyph-positions.ts`, a vertical advance is
 *  not computed), so the page is not read as if the writing were horizontal. */
const verticalGlyphs = (glyphs: readonly OurGlyph[]): OurGlyph[] =>
  glyphs.map((glyph) => ({ ...glyph, vmetric: true }) as OurGlyph);

interface Frame {
  /** The bytes of a page's content (tokenized here), or the operators of a form (tokenized once for the document, `parsedFormOf`). */
  readonly content: Uint8Array | readonly ContentOp[];
  readonly resources: PdfDict | undefined;
  readonly scope: string;
  readonly depth: number;
  readonly text: TextTracker;
  /** The NON-STROKING colour space `cs` set, as its number of components when we can convert it — see
   *  `spaceComponentsOf`. `undefined` means « a space we do not convert », and then `sc`/`scn` stay unknown. Saved and
   *  restored by `q`/`Q` like the font, and a form starts from its caller's (§8.10.1). */
  readonly fill: { components: number | undefined; saved: (number | undefined)[] };
}

/** The operator stream of one page. A page with no content has no operator. */
export function ourOpsOfPage(doc: PdfObjectsDocument, page: PdfPageEntry, memo: GlyphMemo = newGlyphMemo()): PdfOp[] {
  const out: PdfOp[] = [];
  const bytes = pageContentOf(doc, page);
  const context: PageContext = { doc, memo, budget: { painted: 0, forms: 0 } };
  emit(
    context,
    {
      content: bytes,
      resources: page.resources,
      scope: "",
      depth: 0,
      text: { font: { state: UNKNOWN, vertical: false }, saved: [] },
      fill: { components: undefined, saved: [] },
    },
    out,
  );
  return out;
}

/** Reads one content stream into `out`, inlining the forms it draws. */
function emit(context: PageContext, frame: Frame, out: PdfOp[]): void {
  const builder = new PathBuilder();
  for (const operator of frame.content instanceof Uint8Array ? readContentOps(frame.content) : frame.content) {
    // The ceiling holds while the forms unroll, not after: a form drawn many times would otherwise be allocated in full first.
    if (out.length >= MAX_CONTENT_OPS) throw new PdfObjectsRefusal("content-too-long");
    if (PATH_OPS.has(operator.op)) {
      const painted = builder.feed(operator.op, operator.operands);
      if (painted !== undefined) out.push({ op: "constructPath", args: painted });
      continue;
    }
    operatorOf(context, frame, operator, out);
  }
}

/** `cs`, then `sc`/`scn`: the non-stroking colour, read in the space the stream NAMED. True when the operator was one
 *  of those three. A space we cannot convert, or an operand count that does not match it, leaves the colour UNKNOWN —
 *  `pdf-source.ts` then answers « I do not know » rather than keeping a colour the document never asked for. */
function fillSpaceOperatorOf(
  context: PageContext,
  frame: Frame,
  op: string,
  operands: readonly PdfValue[],
  out: PdfOp[],
): boolean {
  if (op === "cs") {
    frame.fill.components = spaceComponentsOf(context.doc, frame, nameOf(operands[0]));
    // §8.6.8: setting the space resets the colour to the space's initial value — black for the three device spaces.
    out.push(
      frame.fill.components === undefined
        ? { op: "setFillColourUnknown", args: null }
        : { op: "setFillRGBColor", args: ["#000000"] },
    );
    return true;
  }
  if (op !== "sc" && op !== "scn") return false;
  // Read HERE and not taken from the caller: the operands are mapped only for the three operators that need them.
  const values = operands.map(numberOf);
  const inSpace = values.every((n): n is number => n !== undefined)
    ? colourInSpace(frame.fill.components, values)
    : undefined;
  out.push(
    inSpace === undefined ? { op: "setFillColourUnknown", args: null } : { op: "setFillRGBColor", args: [inSpace] },
  );
  return true;
}

/** One operator that is not a path operator. Operators outside the table are dropped, as pdf.js dropped what it did not name. */
function operatorOf(context: PageContext, frame: Frame, operator: ContentOp, out: PdfOp[]): void {
  const { op, operands } = operator;
  const numbers = operands.map(numberOf);
  const allNumbers = numbers.every((n): n is number => n !== undefined);
  trackSavedFont(frame, op);
  if (matrixOperatorOf(op, numbers, allNumbers, out)) return;
  if (textOperatorOf(context, frame, op, operands, out)) return;
  if (markerOperatorOf(context, frame, op, operands, out)) return;
  if (op === "gs") {
    out.push({ op: "setGState", args: [extGStateEntries(context.doc, frame, nameOf(operands[0]))] });
    return;
  }
  const colour = fillColourOf(op, numbers, allNumbers);
  if (colour !== undefined) {
    out.push({ op: "setFillRGBColor", args: [colour] });
    return;
  }
  // 🔴 A FILL COLOUR WE DO NOT CONVERT IS SAID OUT LOUD (03/11/2026). `sc`, `scn` and `cs` set the fill colour in a
  // space we do not read (a separation, an indexed or ICC space, a pattern): converting it is the limit written at the
  // top of this file. Silence would be worse than the limit — the reader of the stream would keep the LAST colour it
  // understood, and a stencil (`/ImageMask`, painted with the fill colour) would be published in a colour the document
  // never asked for. This marker lets `pdf-source.ts` answer « I do not know » and count the picture instead.
  if (fillSpaceOperatorOf(context, frame, op, operands, out)) return;
  const mapped = ONE_TO_ONE[op];
  if (mapped !== undefined) out.push({ op: mapped, args: allNumbers ? numbers : operands.map(plainValue) });
}

/** The entries of the named ExtGState, in the `[[key, value], ...]` shape pdf.js handed over for `gs`. Only the fill
 *  opacity `ca` is carried (the table detector reads nothing else); a missing resource or a non-number gives no entry. */
function extGStateEntries(doc: PdfObjectsDocument, frame: Frame, name: string | undefined): unknown[] {
  if (name === undefined) return [];
  const states = doc.dictOf(frame.resources?.get("ExtGState"));
  const state = doc.dictOf(states?.get(name));
  const alpha = numberOf(doc.resolve(state?.get("ca")));
  return alpha === undefined ? [] : [["ca", alpha]];
}

/** The non-stroking colour SPACE follows the very same stack as the font: `q` saves it, `Q` restores it (§8.4.2). */
const trackSavedFillSpace = (frame: Frame, op: string): void => {
  if (op === "q" && frame.fill.saved.length < MAX_STATE_DEPTH) frame.fill.saved.push(frame.fill.components);
  else if (op === "Q" && frame.fill.saved.length > 0) frame.fill.components = frame.fill.saved.pop();
};

/** `q` saves the text state's font, `Q` restores it; both go on to the table like any other operator. */
function trackSavedFont(frame: Frame, op: string): void {
  trackSavedFillSpace(frame, op);
  if (op === "q" && frame.text.saved.length < MAX_STATE_DEPTH) frame.text.saved.push(frame.text.font);
  if (op !== "Q") return;
  const restored = frame.text.saved.pop();
  if (restored !== undefined) frame.text.font = restored;
}

/** `cm` and `Tm` with their six numbers. Returns whether the operator was handled. */
function matrixOperatorOf(
  op: string,
  numbers: readonly (number | undefined)[],
  allNumbers: boolean,
  out: PdfOp[],
): boolean {
  if (!allNumbers || numbers.length !== 6) return false;
  if (op === "cm") {
    out.push({ op: "transform", args: matrixOf(numbers as number[]) });
    return true;
  }
  if (op === "Tm") {
    out.push({ op: "setTextMatrix", args: matrixOf(numbers as number[]) });
    return true;
  }
  return false;
}

/** `aw ac string "`: the word and character spacing are set, then the line moves, then the string is shown. */
function quotedShowing(context: PageContext, frame: Frame, operands: readonly PdfValue[], out: PdfOp[]): void {
  const aw = numberOf(operands[0]);
  const ac = numberOf(operands[1]);
  if (aw !== undefined) out.push({ op: "setWordSpacing", args: [aw] });
  if (ac !== undefined) out.push({ op: "setCharSpacing", args: [ac] });
  out.push({ op: "nextLine", args: [] });
  showing(context, frame, operands, out);
}

/** The font and text-showing operators (`Tf`, `Tj`, `'`, `"`, `TJ`). Returns whether the operator was handled. */
function textOperatorOf(
  context: PageContext,
  frame: Frame,
  op: string,
  operands: readonly PdfValue[],
  out: PdfOp[],
): boolean {
  if (op === "Tf") setFont(context, frame, operands, out);
  else if (op === "Tj") showing(context, frame, operands, out);
  else if (op === "'") {
    out.push({ op: "nextLine", args: [] });
    showing(context, frame, operands, out);
  } else if (op === '"') quotedShowing(context, frame, operands, out);
  else if (op === "TJ") spacedShowing(context, frame, operands, out);
  else return false;
  return true;
}

/** The marked-content and `Do` operators. Returns whether the operator was handled. */
function markerOperatorOf(
  context: PageContext,
  frame: Frame,
  op: string,
  operands: readonly PdfValue[],
  out: PdfOp[],
): boolean {
  if (op === "EMC") out.push({ op: "endMarkedContent", args: [] });
  else if (op === "BDC" || op === "BMC") markedContent(context, frame, op, operands, out);
  else if (op === "Do") doXObject(context, frame, nameOf(operands[0]), out);
  else return false;
  return true;
}

/** `Tf /name size`: the font of this resource becomes the text state's, and the operator names it by our key. */
function setFont(context: PageContext, frame: Frame, operands: readonly PdfValue[], out: PdfOp[]): void {
  const name = nameOf(operands[0]);
  const size = numberOf(operands[1]);
  if (name === undefined || size === undefined) return;
  const fonts = context.doc.dictOf(frame.resources?.get("Font"));
  const dict = context.doc.dictOf(fonts?.get(name));
  frame.text.font = { state: stateOf(context.doc, dict, context.memo), vertical: isVerticalFont(context.doc, dict) };
  out.push({ op: "setFont", args: [keyOf(frame.scope, name), size] });
}

/** `Tj string`: the glyphs of the string, read with the current font. The last operand is the string, as in `'` and `"`. */
function showing(context: PageContext, frame: Frame, operands: readonly PdfValue[], out: PdfOp[]): void {
  const shown = operands[operands.length - 1];
  const glyphs: OurGlyph[] = [];
  if (shown?.kind === "string") glyphsOfString(shown.bytes, frame.text.font.state, glyphs, context.budget);
  out.push({ op: "showText", args: [frame.text.font.vertical ? verticalGlyphs(glyphs) : glyphs] });
}

/** `TJ [items]`: the glyphs of each string, in order, with the numbers (kerning) between them. */
function spacedShowing(context: PageContext, frame: Frame, operands: readonly PdfValue[], out: PdfOp[]): void {
  const array = operands[0];
  const items: unknown[] = [];
  if (array?.kind === "array") {
    for (const item of array.items) {
      if (item.kind === "number") {
        items.push(item.value);
        continue;
      }
      if (item.kind !== "string") continue;
      const glyphs: OurGlyph[] = [];
      glyphsOfString(item.bytes, frame.text.font.state, glyphs, context.budget);
      items.push(...(frame.text.font.vertical ? verticalGlyphs(glyphs) : glyphs));
    }
  }
  out.push({ op: "showSpacedText", args: [items] });
}

/** `BMC /tag` and `BDC /tag props`. An optional-content group is named by its key in the page's /Properties
 *  (`layerConfigOf` reads it); any other marked content is its tag. */
function markedContent(
  context: PageContext,
  frame: Frame,
  op: string,
  operands: readonly PdfValue[],
  out: PdfOp[],
): void {
  const tag = nameOf(operands[0]) ?? "";
  if (op === "BMC") {
    out.push({ op: "beginMarkedContent", args: [tag] });
    return;
  }
  const named = nameOf(operands[1]);
  const entry = named === undefined ? undefined : context.doc.dictOf(frame.resources?.get("Properties"))?.get(named);
  if (tag === "OC" && entry !== undefined) {
    out.push({ op: "beginMarkedContentProps", args: ["OC", groupOperand(context.doc, entry)] });
    return;
  }
  // The marked-content id (`/MCID`, ISO 32000-1 §14.7.4.2) is what ties a glyph to the structure tree: it sits in an inline
  // property dictionary (`/P <</MCID 3>> BDC`) or in the page's /Properties under the operand's name.
  const props = operands[1]?.kind === "dict" ? operands[1].entries : context.doc.dictOf(entry);
  const mcid = context.doc.resolve(props?.get("MCID"));
  out.push({ op: "beginMarkedContentProps", args: [tag, mcid?.kind === "number" ? mcid.value : null] });
}

/** A group operand, in the shape `layerConfigOf` reads: an OCG by its key, a membership dictionary by its members. The
 *  key of a group is its reference (`<num>R`, then the generation when it is not 0), as pdf.js wrote it. */
function groupOperand(doc: PdfObjectsDocument, entry: PdfValue): unknown {
  const group = doc.dictOf(entry);
  if (group === undefined) return null;
  const type = nameOf(doc.resolve(group.get("Type")));
  if (type === "OCG") return entry.kind === "ref" ? { type: "OCG", id: refKey(entry) } : null;
  if (type === "OCMD") {
    const policy = nameOf(doc.resolve(group.get("P")));
    const members = doc.resolve(group.get("OCGs"));
    const ids =
      members?.kind === "array" ? members.items.flatMap((item) => (item.kind === "ref" ? [refKey(item)] : [])) : [];
    // Written limit, not a guard: `/VE`, the visibility expression of an OCMD (ISO 32000-1 §8.11.2.3), is not read.
    // An OCMD that declares `[/Not ocg1]` without `/P` is judged by the default rule (`AnyOn` over `/OCGs`), the
    // opposite verdict. Reading it needs a bounded recursive reader: the expression is nested and comes from the file.
    return { type: "OCMD", ids, policy: policy ?? null, expression: null };
  }
  return null;
}

/** The operator that marks a `Do` whose XObject could not be read (decision of 24/11/2026): it paints nothing. */
export const UNREADABLE_XOBJECT_OP = "unreadableXObject";

/** `Do` of a form (inlined between its begin and end) or of an image (its name only: the picture is decoded downstream). */
function doXObject(context: PageContext, frame: Frame, name: string | undefined, out: PdfOp[]): void {
  if (name === undefined) return;
  const xobjects = context.doc.dictOf(frame.resources?.get("XObject"));
  const declared = xobjects?.get(name);
  // An XObject we cannot read fails alone (decision of 24/11/2026). Its `/Subtype` is inside it: it may have been a
  // FORM carrying text (§8.10), so it is never called a lost picture. The page is published without it, and the marker
  // below counts it (`PdfExtractResult.unreadObjectsByPage`).
  const read = partOrAbsent(() => ({ target: context.doc.resolve(declared) }));
  if (read === undefined) {
    out.push({ op: UNREADABLE_XOBJECT_OP, args: [name] });
    return;
  }
  const { target } = read;
  if (target?.kind !== "stream") return;
  const subtype = nameOf(context.doc.resolve(target.dict.get("Subtype")));
  if (subtype === "Image") {
    // A stencil mask (`/ImageMask true`) is painted with the fill colour: pdf.js named it `paintImageMaskXObject`.
    const mask = context.doc.resolve(target.dict.get("ImageMask"));
    const stencil = mask?.kind === "bool" && mask.value;
    // The resources the `Do` runs in travel with the name: an image of a form is found in the form's resources, not the page's.
    out.push({ op: stencil ? "paintImageMaskXObject" : "paintImageXObject", args: [name, frame.resources] });
    return;
  }
  if (subtype !== "Form" || frame.depth >= MAX_FORM_DEPTH) return;
  paintForm(context, frame, name, target, out);
}

/** The `/Matrix` of a form: its six numbers, or the identity when it is absent or not six numbers. */
function formMatrixOf(doc: PdfObjectsDocument, form: PdfStream): number[] {
  const matrixValues = doc.resolve(form.dict.get("Matrix"));
  const values =
    matrixValues?.kind === "array" && matrixValues.items.length === 6
      ? matrixValues.items.map((item) => numberOf(doc.resolve(item)))
      : undefined;
  return values !== undefined && values.every((n): n is number => n !== undefined) ? values : [1, 0, 0, 1, 0, 0];
}

/** One form drawn by `Do`: begin, its own stream inlined, end. */
function paintForm(context: PageContext, frame: Frame, name: string, form: PdfStream, out: PdfOp[]): void {
  const childScope = frame.scope === "" ? `form:${name}` : `${frame.scope}/form:${name}`;
  const resources = context.doc.dictOf(form.dict.get("Resources")) ?? frame.resources;
  chargeFormCall(context.budget);
  out.push({ op: "paintFormXObjectBegin", args: [formMatrixOf(context.doc, form), undefined] });
  // A form starts from the text state of the stream that draws it, and leaves the outer one as it was (§8.10.1).
  const child: Frame = {
    content: parsedFormOf(context.doc, form),
    resources,
    scope: childScope,
    depth: frame.depth + 1,
    text: { font: frame.text.font, saved: [] },
    fill: { components: frame.fill.components, saved: [] },
  };
  emit(context, child, out);
  out.push({ op: "paintFormXObjectEnd", args: [] });
}

/* 🔴 TRIED AND SET ASIDE (03/11/2026): THE CLIP RECTANGLE AS A CELL BOUNDARY. The page/code reading of the same day
 * saw it on Google Docs (`sd-3262039` p1): « a clip rectangle before the text of each box · this rectangle announces
 * the cell and its reading order ». It would be a real signal for table reading order, which is a known weak spot.
 * TWO REASONS IT IS NOT READ, both measured or standing:
 *  · WE DO NOT READ CLIP PATHS AT ALL. `W` and `W*` are in no table of this file, so the signal does not exist for our
 *    code — and adding it is deeper PDF DECODING, which the direction of 16/10/2026 refuses: a PDF defect is fixed on
 *    the PUBLISHED structure, not by decoding further.
 *  · IT IS EVERYWHERE. Measured on the 282 raw content streams of `d2c-corpus` branch `corpus-150`: **7 185
 *    occurrences over 64 documents and 23 producer families**. A signature that frequent cannot mean « cell » by
 *    itself; it would need a second, discriminating condition that is not measured.
 * What would reopen it: a measured discriminant (clip rectangles of one agreeing height, repeated, each immediately
 * followed by the text drawn inside it), AND a reason to read clip paths that the published structure cannot give. */

/** Components of a colour space whose operands we can convert WITHOUT colour management, by its name
 *  (ISO 32000-1 §8.6.4 device spaces, §8.6.5.2-3 CIE-based grey and RGB). Anything else — Lab, Indexed, Separation,
 *  DeviceN, Pattern — stays out: its operands are not colour components we could read. */
const DEVICE_SPACE_COMPONENTS: ReadonlyMap<string, number> = new Map([
  ["DeviceGray", 1],
  ["CalGray", 1],
  ["DeviceRGB", 3],
  ["CalRGB", 3],
  ["DeviceCMYK", 4],
]);

/** How many components the space `name` has, when we can convert it; `undefined` otherwise.
 *
 * 🔴 WHY THIS EXISTS SINCE 03/11/2026, AND WHAT IT REPAIRS. `cs` and `sc` used to set NOTHING, so a fill painted in a
 * named space kept the LAST colour understood — black, most often. Measured on `sd-0503362` p2 (producer Quartz,
 * `d2c-corpus` branch `corpus-150`): the document writes `/Cs1 cs` then `0.6509804 sc` and `0.8509804 sc` for the two
 * bands behind its headings, and our reader recorded both as `#000000`. The two GREYS are the whole signal there — the
 * darker band is the higher heading level — and they were being flattened to one black.
 *
 * ⚠️ `/Alternate` IS NOT TRUSTED, on purpose. ISO 32000-1 table 66 (p. 149) says `N` is 1, 3 or 4 and matches the
 * profile, and that a reader without colour management falls back on DeviceGray / DeviceRGB / DeviceCMYK according to
 * `N`, with no tint transform. A real file declares `N = 1` with `/Alternate /DeviceRGB` (veraPDF library issue 773),
 * so the fallback is read from `N` alone, and the operand COUNT must match it before anything is converted. */
/** The components of a space written as an ARRAY: `[/ICCBased stream]`, `[/CalGray dict]`, `[/CalRGB dict]`. */
function arraySpaceComponentsOf(doc: PdfObjectsDocument, items: readonly PdfValue[]): number | undefined {
  const family = doc.resolve(items[0]);
  const cie = family?.kind === "name" ? DEVICE_SPACE_COMPONENTS.get(family.value) : undefined;
  if (cie !== undefined) return cie;
  if (family?.kind !== "name" || family.value !== "ICCBased") return undefined;
  const n = numberOf(doc.resolve(doc.dictOf(items[1])?.get("N")));
  return n === 1 || n === 3 || n === 4 ? n : undefined;
}

function spaceComponentsOf(doc: PdfObjectsDocument, frame: Frame, name: string | undefined): number | undefined {
  const direct = name === undefined ? undefined : DEVICE_SPACE_COMPONENTS.get(name);
  if (direct !== undefined || name === undefined) return direct;
  const value = doc.resolve(doc.dictOf(frame.resources?.get("ColorSpace"))?.get(name));
  if (value?.kind === "name") return DEVICE_SPACE_COMPONENTS.get(value.value);
  return value?.kind === "array" ? arraySpaceComponentsOf(doc, value.items) : undefined;
}

/** The `#rrggbb` of `sc`/`scn` operands read in a space of `components` components, or `undefined` when the count does
 *  not match — then the colour stays UNKNOWN rather than being guessed. */
function colourInSpace(components: number | undefined, v: readonly number[]): string | undefined {
  if (components === undefined || v.length !== components) return undefined;
  if (components === 1) return greyHex(v[0]!);
  if (components === 3) return rgbHex(v[0]!, v[1]!, v[2]!);
  return cmykHex(v[0]!, v[1]!, v[2]!, v[3]!);
}

/** The fill colour a device colour operator sets (`g`, `rg`, `k`), as the `#rrggbb` string pdf.js carried. Any other
 *  operator, or a colour with the wrong number of components, sets nothing here: the caller keeps the colour it had.
 *  🔴 LIMIT, written: a colour in another space (ICCBased, Indexed, Separation, DeviceN, Pattern) is not converted, so
 *  `cs` and `sc` set nothing either. */
function fillColourOf(op: string, numbers: readonly (number | undefined)[], allNumbers: boolean): string | undefined {
  if (!allNumbers) return undefined;
  const v = numbers as number[];
  if (op === "g" && v.length === 1) return greyHex(v[0]!);
  if (op === "rg" && v.length === 3) return rgbHex(v[0]!, v[1]!, v[2]!);
  if (op === "k" && v.length === 4) return cmykHex(v[0]!, v[1]!, v[2]!, v[3]!);
  return undefined;
}

/** A plain JavaScript value of a content operand (what the walkers read): numbers, names as text, arrays as arrays. */
function plainValue(value: PdfValue): unknown {
  if (value.kind === "number") return value.value;
  if (value.kind === "name") return value.value;
  if (value.kind === "bool") return value.value;
  if (value.kind === "array") return value.items.map(plainValue);
  return undefined;
}
