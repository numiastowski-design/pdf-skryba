/** The colour a run INHERITS when its `a:rPr` writes none, for the slide
 *  drawing only (25/09/2026, decision 12 bis — MIKSUDOC « Spécification fonctionnelle » §9.3.3): the first
 *  step of the chain below that writes a fill decides. An exact colour
 *  (`pptx-reader/color.ts`) is taken; any other fill written (a modifier, a
 *  gradient, `a:noFill`…) stops the chain on "unknown", never read past.
 *
 *  The chain, per paragraph level (`a:pPr lvl`, 0-based → `a:lvl{n+1}pPr`,
 *  its `a:defRPr`; `a:defPPr` is not a level and is not read):
 *  1. the shape's own `p:txBody/a:lstStyle`;
 *  2. a PLACEHOLDER (`p:ph`): the layout's placeholder matched by `idx`,
 *     else by `type` (ECMA-376 Part 1 §19.3.1.36: `type` defaults to
 *     "obj"), its `a:lstStyle`; then the master's placeholder of that type,
 *     its `a:lstStyle`; then the master's `p:txStyles` (§19.3.1.52):
 *     `p:titleStyle` for title and ctrTitle; `p:otherStyle` for dt, ftr,
 *     hdr and sldNum; `p:bodyStyle` for every other type (body, obj,
 *     subTitle, pic, tbl…). The same mapping as Apache POI
 *     (`XSLFTextParagraph#getDefaultMasterStyle`). On the master a
 *     ctrTitle is looked up as "title", every body-like type as "body".
 *  3. a FREE shape (no `p:ph`): the colour of its `p:style/a:fontRef`, then
 *     `presentation.xml p:defaultTextStyle`. Not the master's
 *     `p:otherStyle`: ECMA-376 §19.3.1.35 gives it "text within a slide
 *     shape but not within a text box", and text boxes to `p:bodyStyle`;
 *     PowerPoint does neither, a text box and a shape both follow
 *     `p:defaultTextStyle` (Brandwares, "OOXML Hacking: Text Box Styles",
 *     2016), which the drawing already reads for the size.
 *  The page never reads any of it (MIKSUDOC « Spécification fonctionnelle » §9.3.7).
 *  NOT here: the run's own fill (`pptx-reader/text.ts`), how a colour
 *  element resolves (`pptx-reader/color.ts`), which parts are the slide's
 *  layout and master (`pptx-reader/index.ts`).
 *  Called by: `pptx-reader/shapes.ts`; its placeholder chain
 *  (`placeholderStyles`) by `pptx-reader/text-size.ts`; `writtenTextColor`
 *  by `pptx-reader/text.ts`. */

import { findChild, findChildren, qualifiedNameOf, type XNode } from "../ooxml/xml";
import { type ColorContext, elements, exactColorOf, type Hex, solidFillColor, writtenFillOf } from "./color";
import { placeholderOf, type PptxPlaceholder } from "./placeholder";

/** The parts a slide's text inherits from. */
export interface TextStyleSources {
  /** The slide's `p:sldLayout`. */
  layout?: XNode;
  /** Its `p:sldMaster`. */
  master?: XNode;
  /** `presentation.xml`'s `p:defaultTextStyle`. */
  defaultTextStyle?: XNode;
}

/** One step's answer: an exact colour, "unknown" (a fill written that is
 *  not exact: the chain stops), or `undefined` (nothing written: go on). */
type Step = Hex | "unknown" | undefined;

/** The colour a properties element (`a:rPr`, `a:defRPr`) writes. */
export const writtenTextColor = (props: XNode | undefined, context: ColorContext | undefined): Step => {
  const fill = writtenFillOf(props);
  if (fill === undefined) return undefined;
  return (qualifiedNameOf(fill) === "a:solidFill" ? solidFillColor(fill, context) : undefined) ?? "unknown";
};

/** The colour a list style (`a:lstStyle`, `p:bodyStyle`…) writes at `level`. */
const levelColor = (listStyle: XNode | undefined, level: number, context: ColorContext | undefined): Step =>
  writtenTextColor(findChild(findChild(listStyle ?? {}, `a:lvl${level + 1}pPr`) ?? {}, "a:defRPr"), context);

/** The colour `p:style/a:fontRef` writes: its one colour element, when it has one. */
const fontRefColor = (element: XNode, context: ColorContext | undefined): Step => {
  const fontRef = findChild(findChild(element, "p:style") ?? {}, "a:fontRef");
  const colors = elements(fontRef ?? {});
  if (colors.length === 0) return undefined;
  return (colors.length === 1 ? exactColorOf(colors[0]!, context) : undefined) ?? "unknown";
};

type Placeholder = PptxPlaceholder;

/** The text shapes of a layout or master that are placeholders. */
const placeholdersOf = (part: XNode | undefined): { sp: XNode; ph: Placeholder }[] =>
  findChildren(findChild(findChild(part ?? {}, "p:cSld") ?? {}, "p:spTree") ?? {}, "p:sp").flatMap((sp) => {
    const ph = placeholderOf(sp);
    return ph === undefined ? [] : [{ sp, ph }];
  });

const OTHER_TYPES = new Set(["dt", "ftr", "hdr", "sldNum"]);

/** How the master names a placeholder type (see the header). */
const masterType = (type: string | undefined): string => {
  if (type === "title" || type === "ctrTitle") return "title";
  return type !== undefined && OTHER_TYPES.has(type) ? type : "body";
};

const txStyleOf = (type: string | undefined): string => {
  const kind = masterType(type);
  return kind === "title" ? "p:titleStyle" : kind === "body" ? "p:bodyStyle" : "p:otherStyle";
};

const lstStyleOf = (sp: XNode | undefined): XNode | undefined => findChild(findChild(sp ?? {}, "p:txBody") ?? {}, "a:lstStyle");

/** The list styles a placeholder inherits, nearest first (the chain's step
 *  2, above). Shared with the inherited SIZE (`pptx-reader/text-size.ts`). */
export const placeholderStyles = (ph: Placeholder, sources: TextStyleSources): (XNode | undefined)[] => {
  const layoutPhs = placeholdersOf(sources.layout);
  const type = ph.type ?? "obj";
  const onLayout =
    (ph.idx === undefined ? undefined : layoutPhs.find((p) => p.ph.idx === ph.idx)) ??
    layoutPhs.find((p) => (p.ph.type ?? "obj") === type);
  const kind = onLayout?.ph.type ?? ph.type;
  const onMaster = placeholdersOf(sources.master).find((p) => masterType(p.ph.type) === masterType(kind));
  const txStyles = findChild(sources.master ?? {}, "p:txStyles");
  return [lstStyleOf(onLayout?.sp), lstStyleOf(onMaster?.sp), findChild(txStyles ?? {}, txStyleOf(kind))];
};

/** For one text shape (`p:sp` and its `p:txBody`): the colour a run writing
 *  none takes at each paragraph level, `undefined` when not known. */
export const inheritedTextColor = (
  element: XNode,
  body: XNode,
  sources: TextStyleSources,
  context: ColorContext | undefined,
): ((level: number) => Hex | undefined) => {
  const own = findChild(body, "a:lstStyle");
  const ph = placeholderOf(element);
  const inherited = ph === undefined ? undefined : placeholderStyles(ph, sources);
  const byLevel = new Map<number, Hex | undefined>();
  const resolve = (level: number): Hex | undefined => {
    const steps: (() => Step)[] = [
      () => levelColor(own, level, context),
      ...(inherited === undefined
        ? [() => fontRefColor(element, context), () => levelColor(sources.defaultTextStyle, level, context)]
        : inherited.map((style) => () => levelColor(style, level, context))),
    ];
    for (const step of steps) {
      const color = step();
      if (color !== undefined) return color === "unknown" ? undefined : color;
    }
    return undefined;
  };
  return (level) => {
    if (!byLevel.has(level)) byLevel.set(level, resolve(level));
    return byLevel.get(level);
  };
};
