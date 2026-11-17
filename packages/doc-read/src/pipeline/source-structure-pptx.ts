/** The list-item rule of the pptx second reading (`docs/CONCEPTION-CONTROLE-STRUCTURE.md` section 3.2, choice C3): whether a paragraph is a list item,
 *  by the bullet it WRITES (`a:pPr` holding `a:buChar`, `a:buBlip` or `a:buAutoNum`; `a:buNone` is no list) or, when it writes none, the bullet it
 *  INHERITS (ECMA-376 Part 1 §19.3.1.36 placeholders, §21.1.2.4.2 list styles): per level (`a:pPr lvl`, 0-based, read as `a:lvl{n+1}pPr`), the first
 *  bullet written along the shape's own `a:lstStyle`, the layout's placeholder, the master's placeholder and the master's `p:txStyles`. A title
 *  and a free shape (no `p:ph`) inherit none. The layout and the master of a slide are read ONCE per part (memo by path), never once per paragraph.
 *  Written from the specification, not from the extractor (`extractor/pptx-reader/bullet.ts`).
 *  NOT here: walking the slide (`source-reading-pptx.ts`), the words, comparing with the page (`pipeline/structure-conservation.ts`).
 *  Called by: `pipeline/source-reading-pptx.ts`. */

import { resolveTarget } from "../extractor/ooxml/package";
import { attrOf, first, kidsOf, tagOf, type N } from "./source-reading-package";

type XmlOf = (path: string) => Promise<N | undefined>;

interface Placeholder {
  type: string | undefined;
  idx: string | undefined;
}

interface PlaceholderShape {
  sp: N;
  ph: Placeholder;
}

/** A shape's placeholder (`p:nvSpPr/p:nvPr/p:ph`), `undefined` for a free shape. */
export const placeholderOfShape = (sp: N): Placeholder | undefined => {
  const ph = first(first(first(sp, "p:nvSpPr"), "p:nvPr"), "p:ph");
  return ph === undefined ? undefined : { type: attrOf(ph, "type"), idx: attrOf(ph, "idx") };
};

const placeholdersOf = (part: N | undefined): PlaceholderShape[] =>
  kidsOf(first(first(part, "p:cSld"), "p:spTree") ?? {}).flatMap((sp) => {
    const ph = tagOf(sp) === "p:sp" ? placeholderOfShape(sp) : undefined;
    return ph === undefined ? [] : [{ sp, ph }];
  });

const OTHER_TYPES = new Set(["dt", "ftr", "hdr", "sldNum"]);

/** How the master names a placeholder type: a title, one of the footer-like kinds, else the body. */
const masterKind = (type: string | undefined): string => {
  if (type === "title" || type === "ctrTitle") return "title";
  return type !== undefined && OTHER_TYPES.has(type) ? type : "body";
};

const TX_STYLE_TAGS: Readonly<Record<string, string>> = { title: "p:titleStyle", body: "p:bodyStyle" };

const txStyleTag = (type: string | undefined): string => TX_STYLE_TAGS[masterKind(type)] ?? "p:otherStyle";

const lstStyleOf = (sp: N | undefined): N | undefined => first(first(sp, "p:txBody"), "a:lstStyle");

/** What a `a:pPr` or `a:lvlNpPr` says of the bullet: `true` a bullet, `false` none, `undefined` nothing written. */
const writtenBullet = (props: N | undefined): boolean | undefined => {
  if (props === undefined) return undefined;
  if (
    first(props, "a:buChar") !== undefined ||
    first(props, "a:buBlip") !== undefined ||
    first(props, "a:buAutoNum") !== undefined
  )
    return true;
  return first(props, "a:buNone") !== undefined ? false : undefined;
};

/** `a:pPr lvl` as a non-negative integer; 0 when absent or unreadable. */
const levelOfParagraph = (pPr: N | undefined): number => {
  const lvl = Number.parseInt(attrOf(pPr ?? {}, "lvl") ?? "0", 10);
  return Number.isInteger(lvl) && lvl > 0 ? lvl : 0;
};

/** The part a relationship of `partPath` of the given type (its last path segment, e.g. `slideLayout`) points to. */
const relatedPart = async (xmlOf: XmlOf, partPath: string, type: string): Promise<string | undefined> => {
  const cut = partPath.lastIndexOf("/");
  const rels = await xmlOf(`${partPath.slice(0, cut)}/_rels/${partPath.slice(cut + 1)}.rels`);
  for (const rel of rels ? kidsOf(rels) : []) {
    const target = attrOf(rel, "Target");
    if (
      target !== undefined &&
      attrOf(rel, "TargetMode") !== "External" &&
      (attrOf(rel, "Type") ?? "").endsWith(`/${type}`)
    )
      return resolveTarget(partPath, target);
  }
  return undefined;
};

/** Whether a paragraph written in `sp` is a list item. */
export type IsListParagraph = (sp: N | undefined, paragraph: N) => boolean;

/** The reader of the bullets of a deck: `forSlide(slidePath)` gives the rule for that slide. Layout and master parts are memoised by path. */
export const createBulletReader = (xmlOf: XmlOf): { forSlide: (slidePath: string) => Promise<IsListParagraph> } => {
  const parts = new Map<string, Promise<N | undefined>>();
  const partOf = (path: string | undefined): Promise<N | undefined> => {
    if (path === undefined) return Promise.resolve(undefined);
    if (!parts.has(path)) parts.set(path, xmlOf(path));
    return parts.get(path)!;
  };
  return {
    forSlide: async (slidePath) => {
      const layoutPath = await relatedPart(xmlOf, slidePath, "slideLayout");
      const layout = await partOf(layoutPath);
      const masterPath = layoutPath === undefined ? undefined : await relatedPart(xmlOf, layoutPath, "slideMaster");
      const master = await partOf(masterPath);
      const layoutPhs = placeholdersOf(layout);
      const masterPhs = placeholdersOf(master);
      const txStyles = first(master, "p:txStyles");
      // The list styles a placeholder inherits, nearest first: its layout placeholder (by idx, else by type), the master's, the master's txStyles.
      const inheritedStyles = (ph: Placeholder): (N | undefined)[] => {
        const type = ph.type ?? "obj";
        const onLayout =
          (ph.idx === undefined ? undefined : layoutPhs.find((p) => p.ph.idx === ph.idx)) ??
          layoutPhs.find((p) => (p.ph.type ?? "obj") === type);
        const kind = onLayout?.ph.type ?? ph.type;
        const onMaster = masterPhs.find((p) => masterKind(p.ph.type) === masterKind(kind));
        return [lstStyleOf(onLayout?.sp), lstStyleOf(onMaster?.sp), first(txStyles, txStyleTag(kind))];
      };
      const styleChains = new Map<N, (N | undefined)[]>();
      return (sp, paragraph) => {
        const pPr = first(paragraph, "a:pPr");
        const written = writtenBullet(pPr);
        if (written !== undefined) return written;
        const ph = sp === undefined ? undefined : placeholderOfShape(sp);
        if (sp === undefined || ph === undefined || ph.type === "title" || ph.type === "ctrTitle") return false;
        if (!styleChains.has(sp)) styleChains.set(sp, [lstStyleOf(sp), ...inheritedStyles(ph)]);
        const level = levelOfParagraph(pPr);
        for (const style of styleChains.get(sp)!) {
          const found = writtenBullet(first(style, `a:lvl${level + 1}pPr`));
          if (found !== undefined) return found;
        }
        return false;
      };
    },
  };
};
