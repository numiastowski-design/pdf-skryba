/** The EXACT colour a DrawingML fill writes, for the slide drawing only
 *  (`extractor/slide-svg.ts`): a `a:solidFill` whose one colour element,
 *  with no modifier child (but the four zero offsets), is an `a:srgbClr`, an `a:sysClr` (its `lastClr`,
 *  held exact: 25/09/2026) or an `a:schemeClr` (through the slide's
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

import { attributeOf, attributesOf, findChild, childNodesOf, qualifiedNameOf, type XNode } from "../ooxml/xml";

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
  readonly map: Readonly<Record<string, string>>;
  /** The theme's colour scheme, slot by slot (`dk1`, `lt1`, `accent1`…),
   *  the slots whose colour is exact only. */
  readonly scheme: Readonly<Record<string, Hex>>;
  /** The theme's `a:fmtScheme/a:fillStyleLst` entries, in order: what
   *  `a:fillRef idx` 1 to 999 names. */
  readonly fillStyles: readonly XNode[];
  /** Resolve the colour modifiers documented in ECMA-376 (`tint`, `shade`, `lumMod`, `lumOff`, `satMod`) instead of calling the colour
   *  unknown. Set for a SmartArt's saved drawing only (`extractor/smartart-drawing.ts`): the slides keep decision 12 of 25/09/2026. */
  readonly modifiers?: true;
}

/** The element children of a node, character data left out. */
export const elements = (node: XNode): XNode[] =>
  childNodesOf(node).filter((childNode) => {
    const tag = qualifiedNameOf(childNode);
    return tag !== undefined && tag !== "#text";
  });

const hexOf = (value: string | undefined): Hex | undefined =>
  value !== undefined && /^[0-9A-Fa-f]{6}$/.test(value) ? `#${value.toUpperCase()}` : undefined;

/** The four offsets Office writes on the colours of a SmartArt's saved drawing, always at 0 (`dsp:drawing`, seen on every colour of the
 *  9 drawings of the repository's fixtures). At 0 they change nothing: the colour stays exact (20/10/2026: without it every SmartArt comes out
 *  black on white). Any other modifier, or any of these at another value, still makes the colour unknown (decision 12 of 25/09/2026). */
const NEUTRAL_OFFSETS: ReadonlySet<string> = new Set(["a:hueOff", "a:satOff", "a:lumOff", "a:alphaOff"]);

const changesNothing = (modifier: XNode): boolean =>
  NEUTRAL_OFFSETS.has(qualifiedNameOf(modifier) ?? "") && Number(attributeOf(modifier, "val")) === 0;

/** Channels stay unrounded (0..255) between modifiers: only the final colour is rounded. */
/** sRGB channel (0..255) to linear light (0..1), and back (IEC 61966-2-1). */
const toLinear = (channel: number): number => {
  const encoded = channel / 255;
  return encoded <= 0.040_45 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (linear: number): number => {
  const encoded = linear <= 0.003_130_8 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
  return Math.min(Math.max(encoded, 0), 1) * 255;
};

type Rgb = [number, number, number];

const rgbOf = (hex: Hex): Rgb => [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16)) as Rgb;
const hexFrom = ([r, g, b]: Rgb): Hex =>
  `#${[r, g, b]
    .map((channel) => Math.round(channel).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;

/** RGB (0..255) to hue (0..6), saturation and lightness (0..1): the HSL model `lumMod`, `lumOff` and `satMod` work in. */
const toHsl = ([r, g, b]: Rgb): Rgb => {
  const [red, green, blue] = [r / 255, g / 255, b / 255];
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  if (max === min) return [0, 0, lightness];
  const chroma = max - min;
  const saturation = chroma / (lightness > 0.5 ? 2 - max - min : max + min);
  if (max === red) return [(green - blue) / chroma + (green < blue ? 6 : 0), saturation, lightness];
  return [max === green ? (blue - red) / chroma + 2 : (red - green) / chroma + 4, saturation, lightness];
};

/** One channel of `fromHsl`: `shiftedHue` the hue shifted for that channel (in sixths of a turn), `lowBound` and `highBound` the lightness bounds. */
const hslChannel = (shiftedHue: number, lowBound: number, highBound: number): number => {
  const hue = (shiftedHue + 6) % 6;
  if (hue < 1) return (lowBound + (highBound - lowBound) * hue) * 255;
  if (hue < 3) return highBound * 255;
  if (hue < 4) return (lowBound + (highBound - lowBound) * (4 - hue)) * 255;
  return lowBound * 255;
};

const fromHsl = ([hue, saturation, lightness]: Rgb): Rgb => {
  if (saturation === 0) return [lightness * 255, lightness * 255, lightness * 255];
  const highBound = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
  const lowBound = 2 * lightness - highBound;
  return [
    hslChannel(hue + 2, lowBound, highBound),
    hslChannel(hue, lowBound, highBound),
    hslChannel(hue - 2, lowBound, highBound),
  ];
};

const clamp01 = (value: number): number => Math.min(Math.max(value, 0), 1);

/** One modifier applied to a colour, or `undefined` for one this reader does not resolve (`alpha`, `hueMod`, `comp`…). `tint` and `shade`
 *  work in linear light (ECMA-376 §20.1.2.3.34 and §20.1.2.3.31; Office's PDF paints #CFD5EA for accent1 4472C4 at `tint 40000`). */
const modified = (rgb: Rgb, modifier: XNode): Rgb | undefined => {
  const val = Number(attributeOf(modifier, "val")) / 100_000;
  if (!Number.isFinite(val)) return undefined;
  const [hue, saturation, lightness] = toHsl(rgb);
  switch (qualifiedNameOf(modifier)) {
    case "a:tint":
      return rgb.map((channel) => fromLinear(1 - (1 - toLinear(channel)) * val)) as Rgb;
    case "a:shade":
      return rgb.map((channel) => fromLinear(toLinear(channel) * val)) as Rgb;
    case "a:lumMod":
      return fromHsl([hue, saturation, clamp01(lightness * val)]);
    case "a:lumOff":
      return fromHsl([hue, saturation, clamp01(lightness + val)]);
    case "a:satMod":
      return fromHsl([hue, clamp01(saturation * val), lightness]);
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

const baseColorOf = (
  color: XNode,
  context: ColorContext | undefined,
  placeholder: Hex | undefined,
): Hex | undefined => {
  switch (qualifiedNameOf(color)) {
    case "a:srgbClr":
      return hexOf(attributeOf(color, "val"));
    case "a:sysClr":
      return hexOf(attributeOf(color, "lastClr"));
    case "a:schemeClr": {
      const val = attributeOf(color, "val");
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
export const writtenFillOf = (properties: XNode | undefined): XNode | undefined =>
  childNodesOf(properties ?? {}).find((childNode) => FILLS.has(qualifiedNameOf(childNode) ?? ""));

/** The fill `p:style/a:fillRef` gives: `idx` 0 and 1000 mean no fill
 *  (ECMA-376 Part 1 §20.1.4.2.10), "none"; 1 to 999, the theme's fill
 *  style of that rank, its `phClr` the reference's own colour. A solid
 *  style gives an exact colour or "unknown"; `a:noFill` "none"; any other
 *  style, a background style (`idx` 1001 and above) or a missing one
 *  "unknown". */
export const styleFill = (fillRef: XNode, context: ColorContext | undefined): PptxFill => {
  const idx = Number(attributeOf(fillRef, "idx"));
  if (idx === 0 || idx === 1000) return "none";
  const style = context === undefined || idx >= 1000 ? undefined : context.fillStyles[idx - 1];
  if (style === undefined) return "unknown";
  if (qualifiedNameOf(style) === "a:noFill") return "none";
  if (qualifiedNameOf(style) !== "a:solidFill") return "unknown";
  const own = elements(fillRef);
  const refColor = own.length === 1 ? exactColorOf(own[0]!, context) : undefined;
  return solidFillColor(style, context, refColor) ?? "unknown";
};

/** The slots of a theme's `a:clrScheme` whose colour is exact. */
export const schemeOf = (clrScheme: XNode | undefined): Record<string, Hex> => {
  const scheme: Record<string, Hex> = {};
  for (const slot of elements(clrScheme ?? {})) {
    const tag = qualifiedNameOf(slot);
    const colors = elements(slot);
    const hex = colors.length === 1 ? exactColorOf(colors[0]!) : undefined;
    if (tag !== undefined && tag.startsWith("a:") && hex !== undefined) scheme[tag.slice(2)] = hex;
  }
  return scheme;
};

/** A `p:clrMap` or `a:overrideClrMapping`'s attributes. */
export const colorMapOf = (node: XNode): Record<string, string> => ({ ...attributesOf(node) });

/** The `a:overrideClrMapping` of a slide or layout's `p:clrMapOvr`, if any
 *  (`a:masterClrMapping` keeps the mapping above). */
export const overrideMapOf = (part: XNode | undefined): Record<string, string> | undefined => {
  const override = findChild(findChild(part ?? {}, "p:clrMapOvr") ?? {}, "a:overrideClrMapping");
  return override === undefined ? undefined : colorMapOf(override);
};
