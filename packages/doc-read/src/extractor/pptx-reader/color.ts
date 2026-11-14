/** The EXACT colour a DrawingML fill writes, for the slide drawing only
 *  (`extractor/slide-svg.ts`): a `a:solidFill` whose one colour element,
 *  with no modifier child (but the four zero offsets), is an `a:srgbClr`, an `a:sysClr` (its `lastClr`,
 *  held exact: Mikolaj, 25/09/2026) or an `a:schemeClr` (through the slide's
 *  colour map to its theme's colour scheme); and the colours a shape's
 *  `p:style` refers to (`a:fillRef` through the theme's fill styles;
 *  `a:fontRef` is read in `pptx-reader/text-color.ts`). Anything else is not known: a modifier (`lumMod`, `alpha`…)
 *  changes the colour, a gradient, a pattern or a picture has no single
 *  colour, `phClr` outside a style has none. What is not known is never
 *  approached (MIKSUDOC « Spécification fonctionnelle » §9.3.3, decision 12 of 25/09/2026).
 *  NOT here: where the fills are read (`pptx-reader/shapes.ts`,
 *  `pptx-reader/text.ts`, `pptx-reader/text-color.ts`), which parts give the colour map and the theme
 *  (`pptx-reader/index.ts`), nor what the drawing does with an unknown one.
 *  Called by: `pptx-reader/index.ts`, `pptx-reader/shapes.ts`,
 *  `pptx-reader/text-color.ts`. */

import { attr, attrs, child, kids, tagOf, type XNode } from "../ooxml/xml";

/** "#RRGGBB", uppercase. */
export type Hex = `#${string}`;

/** A shape's fill: its exact colour, none written (`a:noFill`), or one this
 *  reader does not know. */
export type PptxFill = Hex | "none" | "unknown";

/** What a slide's `a:schemeClr` resolves through. */
export interface ColorContext {
  /** The colour map in force (`bg1` → `lt1`…): the slide's
   *  `p:clrMapOvr/a:overrideClrMapping`, else its layout's, else the
   *  master's `p:clrMap`. */
  map: Readonly<Record<string, string>>;
  /** The theme's colour scheme, slot by slot (`dk1`, `lt1`, `accent1`…),
   *  the slots whose colour is exact only. */
  scheme: Readonly<Record<string, Hex>>;
  /** The theme's `a:fmtScheme/a:fillStyleLst` entries, in order: what
   *  `a:fillRef idx` 1 to 999 names. */
  fillStyles: readonly XNode[];
  /** Resolve the colour modifiers documented in ECMA-376 (`tint`, `shade`, `lumMod`, `lumOff`, `satMod`) instead of calling the colour
   *  unknown. Set for a SmartArt's saved drawing only (`extractor/smartart-drawing.ts`): the slides keep decision 12 of 25/09/2026. */
  modifiers?: true;
}

/** The element children of a node, character data left out. */
export const elements = (node: XNode): XNode[] =>
  kids(node).filter((k) => {
    const tag = tagOf(k);
    return tag !== undefined && tag !== "#text";
  });

const hexOf = (value: string | undefined): Hex | undefined =>
  value !== undefined && /^[0-9A-Fa-f]{6}$/.test(value) ? `#${value.toUpperCase()}` : undefined;

/** The four offsets Office writes on the colours of a SmartArt's saved drawing, always at 0 (`dsp:drawing`, seen on every colour of the
 *  9 drawings of the repository's fixtures). At 0 they change nothing: the colour stays exact (20/10/2026: without it every SmartArt comes out
 *  black on white). Any other modifier, or any of these at another value, still makes the colour unknown (decision 12 of 25/09/2026). */
const NEUTRAL_OFFSETS: ReadonlySet<string> = new Set(["a:hueOff", "a:satOff", "a:lumOff", "a:alphaOff"]);

const changesNothing = (modifier: XNode): boolean => NEUTRAL_OFFSETS.has(tagOf(modifier) ?? "") && Number(attr(modifier, "val")) === 0;

/** Channels stay unrounded (0..255) between modifiers: only the final colour is rounded. */
/** sRGB channel (0..255) to linear light (0..1), and back (IEC 61966-2-1). */
const toLinear = (c: number): number => {
  const v = c / 255;
  return v <= 0.040_45 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (l: number): number => {
  const v = l <= 0.003_130_8 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055;
  return Math.min(Math.max(v, 0), 1) * 255;
};

type Rgb = [number, number, number];

const rgbOf = (hex: Hex): Rgb => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as Rgb;
const hexFrom = ([r, g, b]: Rgb): Hex => `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("").toUpperCase()}`;

/** RGB (0..255) to hue (0..6), saturation and lightness (0..1): the HSL model `lumMod`, `lumOff` and `satMod` work in. */
const toHsl = ([r, g, b]: Rgb): Rgb => {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = d / (l > 0.5 ? 2 - max - min : max + min);
  if (max === R) return [(G - B) / d + (G < B ? 6 : 0), s, l];
  return [max === G ? (B - R) / d + 2 : (R - G) / d + 4, s, l];
};

/** One channel of `fromHsl`: `t` the hue shifted for that channel (in sixths of a turn), `p` and `q` the lightness bounds. */
const hslChannel = (t0: number, p: number, q: number): number => {
  const t = (t0 + 6) % 6;
  if (t < 1) return (p + (q - p) * t) * 255;
  if (t < 3) return q * 255;
  if (t < 4) return (p + (q - p) * (4 - t)) * 255;
  return p * 255;
};

const fromHsl = ([h, s, l]: Rgb): Rgb => {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hslChannel(h + 2, p, q), hslChannel(h, p, q), hslChannel(h - 2, p, q)];
};

const clamp01 = (v: number): number => Math.min(Math.max(v, 0), 1);

/** One modifier applied to a colour, or `undefined` for one this reader does not resolve (`alpha`, `hueMod`, `comp`…). `tint` and `shade`
 *  work in linear light (ECMA-376 §20.1.2.3.34 and §20.1.2.3.31; Office's PDF paints #CFD5EA for accent1 4472C4 at `tint 40000`). */
const modified = (rgb: Rgb, modifier: XNode): Rgb | undefined => {
  const val = Number(attr(modifier, "val")) / 100_000;
  if (!Number.isFinite(val)) return undefined;
  const [h, s, l] = toHsl(rgb);
  switch (tagOf(modifier)) {
    case "a:tint":
      return rgb.map((c) => fromLinear(1 - (1 - toLinear(c)) * val)) as Rgb;
    case "a:shade":
      return rgb.map((c) => fromLinear(toLinear(c) * val)) as Rgb;
    case "a:lumMod":
      return fromHsl([h, s, clamp01(l * val)]);
    case "a:lumOff":
      return fromHsl([h, s, clamp01(l + val)]);
    case "a:satMod":
      return fromHsl([h, clamp01(s * val), l]);
    default:
      return undefined;
  }
};

/** The modifiers of a colour element applied in order, when `context` resolves them; a zero offset changes nothing. */
const withModifiers = (base: Hex, color: XNode, context: ColorContext | undefined): Hex | undefined => {
  let rgb: Rgb = rgbOf(base);
  for (const modifier of elements(color)) {
    if (changesNothing(modifier)) continue;
    const next = context?.modifiers === true ? modified(rgb, modifier) : undefined;
    if (next === undefined) return undefined;
    rgb = next;
  }
  return hexFrom(rgb);
};

const baseColorOf = (color: XNode, context: ColorContext | undefined, placeholder: Hex | undefined): Hex | undefined => {
  switch (tagOf(color)) {
    case "a:srgbClr":
      return hexOf(attr(color, "val"));
    case "a:sysClr":
      return hexOf(attr(color, "lastClr"));
    case "a:schemeClr": {
      const val = attr(color, "val");
      if (val === undefined) return undefined;
      if (val === "phClr") return placeholder;
      if (context === undefined) return undefined;
      return context.scheme[context.map[val] ?? val];
    }
    default:
      return undefined;
  }
};

/** The exact colour of one colour element (`a:srgbClr`…), or `undefined`.
 *  `phClr` is `placeholder` when given (inside a theme fill style). */
export const exactColorOf = (color: XNode, context?: ColorContext, placeholder?: Hex): Hex | undefined => {
  const base = baseColorOf(color, context, placeholder);
  return base === undefined ? undefined : withModifiers(base, color, context);
};

/** The exact colour of a `a:solidFill`, or `undefined`. */
export const solidFillColor = (solidFill: XNode, context?: ColorContext, placeholder?: Hex): Hex | undefined => {
  const colors = elements(solidFill);
  return colors.length === 1 ? exactColorOf(colors[0]!, context, placeholder) : undefined;
};

/** The fill tags a properties element (`p:spPr`, `a:rPr`) may write. A
 *  group fill (`a:grpFill`) counts as none written, as it always has for
 *  the shape's edge (`pptx-reader/shapes.ts`). */
const FILLS = new Set(["a:noFill", "a:solidFill", "a:gradFill", "a:blipFill", "a:pattFill"]);

/** The fill a properties element writes, or `undefined` when it writes none. */
export const writtenFillOf = (props: XNode | undefined): XNode | undefined =>
  kids(props ?? {}).find((k) => FILLS.has(tagOf(k) ?? ""));

/** The fill `p:style/a:fillRef` gives: `idx` 0 and 1000 mean no fill
 *  (ECMA-376 Part 1 §20.1.4.2.10), "none"; 1 to 999, the theme's fill
 *  style of that rank, its `phClr` the reference's own colour. A solid
 *  style gives an exact colour or "unknown"; `a:noFill` "none"; any other
 *  style, a background style (`idx` 1001 and above) or a missing one
 *  "unknown". */
export const styleFill = (fillRef: XNode, context: ColorContext | undefined): PptxFill => {
  const idx = Number(attr(fillRef, "idx"));
  if (idx === 0 || idx === 1000) return "none";
  const style = context === undefined || idx >= 1000 ? undefined : context.fillStyles[idx - 1];
  if (style === undefined) return "unknown";
  if (tagOf(style) === "a:noFill") return "none";
  if (tagOf(style) !== "a:solidFill") return "unknown";
  const own = elements(fillRef);
  const refColor = own.length === 1 ? exactColorOf(own[0]!, context) : undefined;
  return solidFillColor(style, context, refColor) ?? "unknown";
};

/** The slots of a theme's `a:clrScheme` whose colour is exact. */
export const schemeOf = (clrScheme: XNode | undefined): Record<string, Hex> => {
  const scheme: Record<string, Hex> = {};
  for (const slot of elements(clrScheme ?? {})) {
    const tag = tagOf(slot);
    const colors = elements(slot);
    const hex = colors.length === 1 ? exactColorOf(colors[0]!) : undefined;
    if (tag !== undefined && tag.startsWith("a:") && hex !== undefined) scheme[tag.slice(2)] = hex;
  }
  return scheme;
};

/** A `p:clrMap` or `a:overrideClrMapping`'s attributes. */
export const colorMapOf = (node: XNode): Record<string, string> => ({ ...attrs(node) });

/** The `a:overrideClrMapping` of a slide or layout's `p:clrMapOvr`, if any
 *  (`a:masterClrMapping` keeps the mapping above). */
export const overrideMapOf = (part: XNode | undefined): Record<string, string> | undefined => {
  const override = child(child(part ?? {}, "p:clrMapOvr") ?? {}, "a:overrideClrMapping");
  return override === undefined ? undefined : colorMapOf(override);
};
