/** The FONT OBJECTS of a page, read by OUR reader: the five fields the product read from pdf.js (removed on 01/11/2026), and not
 *  one more (ISO 32000-1:2008 §9.6 simple fonts, §9.6.5 Type 3, §9.8 font descriptor).
 *  Decides: nothing of what is done with them. It returns what `pdf-source.ts` consumes, and what pdf.js's `commonObjs.get` returned —
 *  `name`, `bold`, `missingFile`, `isType3Font`, `fontMatrix` — from the font's DICTIONARY.
 *  🔴 AND NO FONT PROGRAM IS READ, contrary to what I had claimed (31/10/2026): the five
 *  fields are dictionary entries. `/BaseFont` gives the name, `/Subtype /Type3` the type, `/FontMatrix` the
 *  matrix, the absence of `/FontFile`, `/FontFile2` and `/FontFile3` in the descriptor says the file is missing,
 *  and the weight is a test on the NAME. No font program is read HERE — and that is all this header claims:
 *  the rule of 24/10/2026 which forbade it everywhere was LIFTED, narrowly, on 04/11/2026, for the cleartext
 *  `/Encoding` of a simple Type 1 font and nothing else (`pdf-fonts/type1-encoding.ts`).
 *  THE WEIGHT TAKES UP pdf.js'S RULE, TO THE LETTER: its `Font` did `this.bold = /bold/i.test(fontName)`, checked
 *  in the installed bundle on 31/10/2026, and it is also the product's fallback rule
 *  (`extractor/font-weight.ts#NAME_SAYS_BOLD`). The two readings therefore say the same thing by construction.
 *  THE NAME BRIDGE is NOT here: pdf.js named its fonts `g_d3_f1`, a page names them `/F1`. Today
 *  `extractor/pdf-font-bridge.ts` only keeps the "scope + name" key of our operators.
 *  NOT here: the weight deduced from them (`extractor/font-weight.ts`), the scale of a Type 3 and the detection of
 *  Symbol (`extractor/pdf-source.ts`), the text and the advance (`pdf-fonts/`), the name bridge.
 *  Called by: `extractor/pdf-font-bridge.ts`, and `pdf-font-objects.test.ts`. */

import type { PdfObjectsDocument } from "./pdf-objects/document";
import type { PdfDict, PdfValue } from "./pdf-objects/objects";
import { standardFontOf } from "./pdf-fonts/names";

/** What the product reads from a font object, and nothing else. Everything is optional, as with pdf.js formerly: describing
 *  less means depending on less (`extractor/font-weight.ts#FontLike`). */
export interface OurFontObject {
  /** The weight according to OUR reading (`ourWeightOf`): the descriptor's `/FontWeight` first, then the name (ISO 32000-1
   *  Table 122: 100 to 900; without it, the standard leaves the weight to the name). `bold` and `unknown` only, never
   *  "normal" on a mute name: that is not the same thing as "not bold". */
  readonly weight: "bold" | "normal" | "unknown";
  /** Italic according to OUR reading (`ourItalicOf`): the descriptor's `/Flags` bit 7 or `/ItalicAngle`, then the name
   *  (Italic, Oblique). `undefined` on a mute name without a descriptor: not the same thing as upright. */
  readonly italic?: boolean;
  readonly name?: string;
  readonly bold?: boolean;
  readonly missingFile?: boolean;
  readonly isType3Font?: boolean;
  readonly fontMatrix?: readonly number[] | undefined;
}

const nameOf = (value: PdfValue | undefined): string | undefined => (value?.kind === "name" ? value.value : undefined);

/** §9.8.1: the font program is embedded by one of these three descriptor keys, never elsewhere. */
const FONT_FILE_KEYS = ["FontFile", "FontFile2", "FontFile3"] as const;

/** A font's descriptor, that of its descendant for a Type0 (§9.7.4: it is the one that carries it). */
function descriptorOf(doc: PdfObjectsDocument, font: PdfDict): PdfDict | undefined {
  const descendants = doc.resolve(font.get("DescendantFonts"));
  const descendant = descendants?.kind === "array" ? doc.dictOf(descendants.items[0]) : undefined;
  return doc.dictOf((descendant ?? font).get("FontDescriptor"));
}

/** §9.6.5: a Type 3's matrix, six numbers. Returned as is, as pdf.js returned it. */
function matrixOf(doc: PdfObjectsDocument, font: PdfDict): readonly number[] | undefined {
  const matrix = doc.resolve(font.get("FontMatrix"));
  if (matrix?.kind !== "array") return undefined;
  const numbers = matrix.items
    .map((item) => doc.resolve(item))
    .map((item) => (item?.kind === "number" ? item.value : Number.NaN));
  return numbers.length === 6 && numbers.every((value) => Number.isFinite(value)) ? numbers : undefined;
}

/** The weight of a font, from OUR dictionary. Order: the descriptor's `/FontWeight` (Table 122, 100 to 900; from
 *  600, bold), then the `/BaseFont` name (Bold, Black, Heavy) when the descriptor says nothing. Bit 19 of
 *  `/Flags` (ForceBold) does NOT count: the standard reserves it for rendering small sizes, and forbids using it to
 *  fix the weight (Table 331). A mute name gives "unknown", not "normal". */
export function ourWeightOf(weightValue: number | undefined, name: string | undefined): "bold" | "normal" | "unknown" {
  if (weightValue !== undefined && Number.isFinite(weightValue) && weightValue >= 100 && weightValue <= 900) {
    return weightValue >= 600 ? "bold" : "normal";
  }
  if (name === undefined) return "unknown";
  if (/bold|black|heavy/iu.test(name)) return "bold";
  // A base font (the fourteen of the standard, Table 9) with no "Bold" in its name is regular: that is a fact,
  // not an absence of answer. Any other font with a mute name stays "unknown".
  return standardFontOf(name) !== undefined ? "normal" : "unknown";
}

/** ITALIC, FROM OUR DICTIONARY (05/11/2026 : « à faire oui ») — explicit in the PDF three times over. Order:
 *  the descriptor's `/Flags` bit 7 (value 64, ISO 32000-1 Table 123 « Italic »), its `/ItalicAngle` when not zero
 *  (Table 122), then the `/BaseFont` name (Italic, Oblique). A base font of the standard (Table 9) with none of these is
 *  upright: a fact. Any other mute name stays `undefined`, never « upright ». */
export function ourItalicOf(
  flags: number | undefined,
  italicAngle: number | undefined,
  name: string | undefined,
): boolean | undefined {
  if (flags !== undefined && Number.isFinite(flags) && (flags & 64) !== 0) return true;
  if (italicAngle !== undefined && Number.isFinite(italicAngle) && italicAngle !== 0) return true;
  if (name === undefined) return undefined;
  if (/italic|oblique/iu.test(name)) return true;
  return standardFontOf(name) !== undefined || flags !== undefined ? false : undefined;
}

/** The font object of a font dictionary. */
export function ourFontObject(doc: PdfObjectsDocument, font: PdfDict): OurFontObject {
  const base = nameOf(doc.resolve(font.get("BaseFont")));
  const type3 = nameOf(doc.resolve(font.get("Subtype"))) === "Type3";
  const descriptor = descriptorOf(doc, font);
  const embedded =
    descriptor !== undefined && FONT_FILE_KEYS.some((key) => doc.resolve(descriptor.get(key)) !== undefined);
  const weightValue = doc.resolve(descriptor?.get("FontWeight"));
  const numberOf = (key: string): number | undefined => {
    const value = doc.resolve(descriptor?.get(key));
    return value?.kind === "number" ? value.value : undefined;
  };
  const italic = ourItalicOf(numberOf("Flags"), numberOf("ItalicAngle"), base);
  return {
    weight: ourWeightOf(weightValue?.kind === "number" ? weightValue.value : undefined, base),
    ...(italic === undefined ? {} : { italic }),
    ...(base === undefined ? {} : { name: base }),
    missingFile: !embedded,
    isType3Font: type3,
    ...(type3 ? { fontMatrix: matrixOf(doc, font) } : {}),
  };
}
