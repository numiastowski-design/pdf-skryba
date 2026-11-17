/** One DrawingML paragraph (`a:p`) as the slide WRITES it: its runs, their
 *  marks (`a:rPr` `b`, `i`, `u`, `strike`, `baseline`) and external links
 *  (`a:hlinkClick`), its fields (`a:fld`), and its declared bullet and level
 *  (`a:pPr`); for the slide drawing only, each run's written size and exact
 *  colour, and the paragraph's alignment, level and line spacing (`a:lnSpc`).
 *  Close to the IR on purpose: marks are `InlineMark`s, a list
 *  place is `ordered` + `start` like the IR's `list` block.
 *  NOT here: formatting inherited from `a:lstStyle`, the layout or the master
 *  (never read: MIKSUDOC « Spécification fonctionnelle » §9.3.7; only the
 *  drawing's inherited colour is, in `pptx-reader/text-color.ts`, and the
 *  inherited bullet, in `pptx-reader/bullet.ts`), nor which
 *  shape the paragraph belongs to (`pptx-reader/shapes.ts`).
 *  Called by: `pptx-reader/shapes.ts`. */

import { type InlineMark } from "doc-ir/lib/ir";
import { isXsdTrue } from "../../lib/ooxml-bool";
import { isSymbolFont, symbolFontText } from "doc-ir/lib/symbol-font";
import { externalLinkTarget } from "doc-ir/lib/link-schemes";
import type { Relationship } from "../ooxml/package";
import {
  attributeOf,
  findChild,
  findChildren,
  childNodesOf,
  qualifiedNameOf,
  textContentOf,
  type XNode,
} from "../ooxml/xml";
import type { ColorContext, Hex } from "./color";
import { writtenTextColor } from "./text-color";

export interface PptxRun {
  /** As written; a line break (`a:br`) is a run of text "\n". Never empty. */
  readonly text: string;
  /** In `InlineMark` order; absent when none. */
  readonly marks?: InlineMark[];
  /** The external target of the run's `a:hlinkClick`, as the relationship
   *  writes it (a Drive link included: the product's link step rewrites it). */
  readonly href?: string;
  /** `a:rPr sz` in points (written in hundredths), when the run writes it
   *  (a line break's own `a:rPr` included); an inherited size is not read. Only the slide drawing uses it
   *  (`extractor/slide-svg.ts`); the page ignores sizes (§5). */
  readonly size?: number;
  /** The run's exact colour (`pptx-reader/color.ts`): `a:rPr/a:solidFill`,
   *  or, when `a:rPr` writes no fill, the one it inherits
   *  (`pptx-reader/text-color.ts`); absent when not known (a modifier, a
   *  gradient). Only the slide drawing uses it (`extractor/slide-svg.ts`);
   *  the page ignores colours (§5). */
  readonly color?: Hex;
}

/** A paragraph's declared bullet. `level` is `a:pPr lvl`, 0-based. `start`
 *  only for `ordered`, omitted when 1 (the IR's convention). */
export interface PptxListPlace {
  readonly ordered: boolean;
  readonly level: number;
  readonly start?: number;
}

export interface PptxParagraph {
  readonly runs: PptxRun[];
  /** Absent: `buNone`, or no bullet on the paragraph, written or inherited
   *  from the list styles (`pptx-reader/bullet.ts`). */
  readonly list?: PptxListPlace;
  /** `a:pPr algn` when it centres ("ctr") or right-aligns ("r"); absent for
   *  left, justified, distributed or not written. Only the slide drawing
   *  uses it (`extractor/slide-svg.ts`). */
  readonly align?: "ctr" | "r";
  /** `a:pPr lvl` when above 0, bullet or not: which level of
   *  `p:defaultTextStyle` gives a size the runs do not write (the level the
   *  inherited colour is read at, too). Only the slide
   *  drawing uses it (`extractor/slide-svg.ts`). */
  readonly level?: number;
  /** `a:pPr/a:lnSpc` as written: `spcPct` as a fraction of single spacing
   *  (115 000 thousandths of a percent, or "115%", is 1.15), or `spcPts` as
   *  the distance between baselines in points (written in hundredths).
   *  Absent: not written (an inherited spacing is not read, §8), or not a
   *  positive number. Only the slide drawing uses it (`extractor/slide-svg.ts`). */
  readonly lineSpacing?: { readonly percent: number } | { readonly points: number };
  /** `a:endParaRPr sz`, in points: the size the paragraph declares for the
   *  run that WOULD follow its last — the one WRITTEN size of a box whose
   *  runs carry none (a real deck's box lost its whole text from the
   *  drawing for it, the « Chatroom » case; arbitrage of 28/09/2026, 8b —
   *  a family, not a case: the mark is declared). Only the slide drawing
   *  uses it, as a fallback between the run's own size and the level's. */
  readonly endSize?: number;
}

/** ST_TextFontScalePercentOrPercentString and ST_TextSpacingPercentOrPercentString:
 *  thousandths of a percent ("62500"), or a percent string ("62.5%") in
 *  Strict; as a fraction of 1. `undefined` when absent or not a number. */
export const fractionOf = (raw: string | undefined): number | undefined => {
  if (raw === undefined || raw.trim() === "") return undefined;
  const percent = raw.endsWith("%") ? Number(raw.slice(0, -1)) : Number(raw) / 1000;
  return Number.isFinite(percent) ? percent / 100 : undefined;
};

/** `a:lnSpc`: ST_TextSpacingPercentOrPercentString (thousandths of a
 *  percent, or a percent string in Strict) or ST_TextSpacingPoint
 *  (hundredths of a point). */
const lineSpacingOf = (pPr: XNode | undefined): PptxParagraph["lineSpacing"] => {
  const lnSpc = pPr === undefined ? undefined : findChild(pPr, "a:lnSpc");
  if (!lnSpc) return undefined;
  const spcPctVal = attributeOf(findChild(lnSpc, "a:spcPct") ?? {}, "val");
  if (spcPctVal !== undefined && spcPctVal.trim() !== "") {
    const fraction = fractionOf(spcPctVal);
    return fraction !== undefined && fraction > 0 ? { percent: fraction } : undefined;
  }
  const spcPtsVal = Number(attributeOf(findChild(lnSpc, "a:spcPts") ?? {}, "val") ?? Number.NaN);
  return Number.isFinite(spcPtsVal) && spcPtsVal > 0 ? { points: spcPtsVal / 100 } : undefined;
};

/** xsd:boolean: "1" or "true". Shared with `pptx-reader/table.ts`. */
export const isTrue = isXsdTrue;

/** ST_TextUnderlineType: every value but "none" draws a line. */
const isUnderlined = (value: string | undefined): boolean => value !== undefined && value !== "none";

/** ST_TextStrikeType: "sngStrike" and "dblStrike" strike; "noStrike" does not. */
const isStruck = (value: string | undefined): boolean => value !== undefined && value !== "noStrike";

const marksOf = (rPr: XNode | undefined): InlineMark[] => {
  if (!rPr) return [];
  const marks: InlineMark[] = [];
  if (isTrue(attributeOf(rPr, "b"))) marks.push("strong");
  if (isTrue(attributeOf(rPr, "i"))) marks.push("em");
  if (isUnderlined(attributeOf(rPr, "u"))) marks.push("underline");
  if (isStruck(attributeOf(rPr, "strike"))) marks.push("strike");
  // ST_Percentage: thousandths of a percent ("30000"), or "30%" in Strict;
  // only the sign matters here.
  const baseline = Number.parseInt(attributeOf(rPr, "baseline") ?? "", 10);
  if (baseline > 0) marks.push("sup");
  if (baseline < 0) marks.push("sub");
  return marks;
};

/** An external target, RAW since the arbitrage of 28/09/2026 — the scheme
 *  guard is the renderer's (`lib/link-schemes.ts#PUBLISHED_SCHEME`). Refused here:
 *  an action (`ppaction://`, a jump to a slide or to the next one), an
 *  internal part, and OUR internal href forms a file cannot legitimately
 *  declare (`lib/ir.ts#INTERNAL_HREF_FORM` — provenance, which the door
 *  cannot know). */
const hrefOf = (rPr: XNode | undefined, relationships: ReadonlyMap<string, Relationship>): string | undefined => {
  const hlinkClick = rPr ? findChild(rPr, "a:hlinkClick") : undefined;
  if (!hlinkClick) return undefined;
  if (attributeOf(hlinkClick, "action")?.startsWith("ppaction://")) return undefined;
  const relationshipId = attributeOf(hlinkClick, "r:id");
  const relationship =
    relationshipId === undefined || relationshipId === "" ? undefined : relationships.get(relationshipId);
  return externalLinkTarget(relationship);
};

/** ST_TextFontSize: an integer from 100 to 400 000, hundredths of a point. */
export const sizeOf = (rPr: XNode | undefined): number | undefined => {
  const raw = rPr === undefined ? undefined : attributeOf(rPr, "sz");
  const hundredths = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  return Number.isInteger(hundredths) && hundredths >= 100 && hundredths <= 400_000 ? hundredths / 100 : undefined;
};

/** How a run's colour is read: the slide's colour map and theme, and the
 *  colour a run writing no fill takes at a paragraph level
 *  (`pptx-reader/text-color.ts`). */
export interface RunColors {
  readonly context?: ColorContext;
  readonly inherited?: (level: number) => Hex | undefined;
  /** The bullet a paragraph writing none (and no `a:buNone`) inherits at its
   *  level (`pptx-reader/bullet.ts`). */
  readonly inheritedBullet?: (level: number) => PptxListPlace | undefined;
  /** The number PowerPoint displays for a `slidenum` field of this slide (the field itself stores a placeholder such as « ‹#› »). */
  readonly slideNumber?: number;
}

/** A run whose `a:rPr` sets the Symbol font for its symbols (`a:sym`, ECMA-376 Part 1 §21.1.2.3.10) or, when it writes no `a:sym`, for all
 *  its text (`a:latin`): its private-use points are published as the characters they draw (`lib/symbol-font.ts`, 26/10/2026). A written
 *  `a:sym` decides alone: `a:latin` Symbol with `a:sym` Wingdings keeps its points (counter-review of 26/10/2026). */
export const isSymbolRun = (rPr: XNode | undefined): boolean => {
  if (rPr === undefined) return false;
  const sym = findChild(rPr, "a:sym");
  return isSymbolFont(attributeOf(sym ?? findChild(rPr, "a:latin") ?? {}, "typeface"));
};

/** A run's colour: the exact one its `a:rPr` writes, else the one it inherits at `level`; none when the written fill is not exact. */
const runColorOf = (rPr: XNode | undefined, colors: RunColors, level: number): Hex | undefined => {
  const written = writtenTextColor(rPr, colors.context);
  if (written === undefined) return colors.inherited?.(level);
  return written === "unknown" ? undefined : written;
};

const readRun = (
  runNode: XNode,
  relationships: ReadonlyMap<string, Relationship>,
  colors: RunColors,
  level: number,
  shown?: string,
): PptxRun[] => {
  const rPr = findChild(runNode, "a:rPr");
  const raw =
    shown ??
    findChildren(runNode, "a:t")
      .map((textElement) => textContentOf(textElement))
      .join("");
  const text = isSymbolRun(rPr) ? symbolFontText(raw) : raw;
  if (text === "") return [];
  const marks = marksOf(rPr);
  const href = hrefOf(rPr, relationships);
  const size = sizeOf(rPr);
  const color = runColorOf(rPr, colors, level);
  return [
    {
      text,
      ...(marks.length > 0 ? { marks } : {}),
      ...(href === undefined ? {} : { href }),
      ...(size === undefined ? {} : { size }),
      ...(color === undefined ? {} : { color }),
    },
  ];
};

/** `a:pPr lvl` as a positive integer; 0 when absent or unreadable. */
const levelOf = (pPr: XNode | undefined): number => {
  const lvl = Number.parseInt(attributeOf(pPr ?? {}, "lvl") ?? "0", 10);
  return Number.isInteger(lvl) && lvl > 0 ? lvl : 0;
};

/** The bullet a paragraph-properties element writes at `level`: a place, `"none"` for
 *  `a:buNone`, `undefined` when it writes none. Reads `a:pPr` and the
 *  `a:lvlNpPr` of a list style alike. */
export const bulletOf = (pPr: XNode | undefined, level: number): PptxListPlace | "none" | undefined => {
  if (!pPr) return undefined;
  // EG_TextBullet: at most one of buNone, buAutoNum, buChar, buBlip.
  const autoNum = findChild(pPr, "a:buAutoNum");
  if (autoNum) {
    // ECMA-376 ST_TextBulletStartAtNum: 1..32767, clamped at the read — a
    // written "-2147483648" or "999999999" crossed into the IR as `start`.
    const startAt = Number.parseInt(attributeOf(autoNum, "startAt") ?? "1", 10);
    const start = Number.isInteger(startAt) ? Math.min(Math.max(startAt, 1), 32_767) : 1;
    return { ordered: true, level, ...(start === 1 ? {} : { start }) };
  }
  // A picture bullet (`buBlip`) is a bullet like a character one.
  if (findChild(pPr, "a:buChar") || findChild(pPr, "a:buBlip")) return { ordered: false, level };
  return findChild(pPr, "a:buNone") ? "none" : undefined;
};

/** The runs one child of an `a:p` gives: a run, a field or a line break; nothing for any other child. */
const paragraphChildRuns = (
  childNode: XNode,
  relationships: ReadonlyMap<string, Relationship>,
  colors: RunColors,
  level: number,
): PptxRun[] => {
  switch (qualifiedNameOf(childNode)) {
    case "a:r":
      return readRun(childNode, relationships, colors, level);
    case "a:fld":
      // Every field (date, custom text) keeps the text it displays; the slide
      // number stores a placeholder, so the number PowerPoint shows is published (19/10/2026).
      return readRun(
        childNode,
        relationships,
        colors,
        level,
        attributeOf(childNode, "type") === "slidenum" ? colors.slideNumber?.toString() : undefined,
      );
    case "a:br": {
      // A break writes its own `a:rPr`: its size is the height of the
      // line it ends when that line is empty (IT 3 writes sz 900 on it).
      const size = sizeOf(findChild(childNode, "a:rPr"));
      return [{ text: "\n", ...(size === undefined ? {} : { size }) }];
    }
    default:
      return [];
  }
};

/** A paragraph's list place: the bullet its `a:pPr` writes (`a:buNone`: none), else, when it has runs, the one it inherits.
 *  An empty paragraph inherits no bullet: nothing is published for it, and it ends no list (`extractor/pptx.ts`). */
const listPlaceOf = (
  pPr: XNode | undefined,
  level: number,
  hasRuns: boolean,
  colors: RunColors,
): PptxListPlace | undefined => {
  const written = bulletOf(pPr, level);
  if (written === "none") return undefined;
  if (written !== undefined) return written;
  return hasRuns ? colors.inheritedBullet?.(level) : undefined;
};

export const readParagraph = (
  paragraph: XNode,
  relationships: ReadonlyMap<string, Relationship>,
  colors: RunColors = {},
): PptxParagraph => {
  const pPr = findChild(paragraph, "a:pPr");
  const writtenLevel = levelOf(pPr);
  const level = writtenLevel || undefined;
  const runs = childNodesOf(paragraph).flatMap((childNode) =>
    paragraphChildRuns(childNode, relationships, colors, writtenLevel),
  );
  const list = listPlaceOf(pPr, writtenLevel, runs.length > 0, colors);
  const algn = pPr === undefined ? undefined : attributeOf(pPr, "algn");
  const align = algn === "ctr" || algn === "r" ? algn : undefined;
  const lineSpacing = lineSpacingOf(pPr);
  const endSize = sizeOf(findChild(paragraph, "a:endParaRPr"));
  return {
    runs,
    ...(list === undefined ? {} : { list }),
    ...(align === undefined ? {} : { align }),
    ...(level === undefined ? {} : { level }),
    ...(lineSpacing === undefined ? {} : { lineSpacing }),
    ...(endSize === undefined ? {} : { endSize }),
  };
};
