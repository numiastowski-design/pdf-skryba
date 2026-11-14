/** Consecutive list items turned into nested IR lists: a deeper level opens a
 *  list inside the previous item, a shallower one returns to its level, and a
 *  different `key` (a docx `numId`) or a switch between ordered and
 *  unordered at the same level starts a new list. An item with no `list`
 *  ends every open list.
 *  The two readers that build lists from declared levels (docx, pptx) differ
 *  in ONE thing, kept as the explicit `emptyItem` option: an item with no
 *  block is not published, and `"restart"` (docx) also closes the lists at
 *  its level so the next item reopens with its true number as `start`, while
 *  `"skip"` (pptx) ignores it altogether — the PowerPoint behaviour is not
 *  verified against an official source, so it is left as it was.
 *  NOT here: how a level, a number or a key is read from a file (each
 *  reader), nor the PDF's lists, found by marker and indent
 *  (`extractor/pdf-paragraphs.ts`).
 *  Called by: `extractor/docx-reader/body.ts`, `extractor/pptx.ts`. */

import type { IRBlock } from "doc-ir/lib/ir";

type ListBlock = Extract<IRBlock, { kind: "list" }>;

export interface NestItem {
  /** `undefined`: not a list item, its blocks stand on their own. */
  list?: {
    level: number;
    ordered: boolean;
    /** The counter's value at this item; used only when it opens an ordered list. */
    start?: number;
    /** Items of one list share it; a change at the same level starts a new list. */
    key?: string | number;
  };
  blocks: readonly IRBlock[];
}

export const nestLists = (items: readonly NestItem[], options: { emptyItem: "restart" | "skip" }): IRBlock[] => {
  const out: IRBlock[] = [];
  let open: { level: number; ordered: boolean; key: string | number | undefined; block: ListBlock }[] = [];
  for (const item of items) {
    const place = item.list;
    if (item.blocks.length === 0 && options.emptyItem === "skip") continue;
    if (!place) {
      open = [];
      out.push(...item.blocks);
      continue;
    }
    if (item.blocks.length === 0) {
      open = open.filter((o) => o.level < place.level);
      continue;
    }
    while (open.length > 0 && open[open.length - 1]!.level > place.level) open.pop();
    const top = open[open.length - 1];
    if (top && top.level === place.level && (top.key !== place.key || top.ordered !== place.ordered)) open.pop();
    const parent = open[open.length - 1];
    if (!parent || parent.level < place.level) {
      const block: ListBlock = {
        kind: "list",
        ordered: place.ordered,
        items: [],
        ...(place.ordered && place.start !== undefined ? { start: place.start } : {}),
      };
      const parentItem = parent?.block.items[parent.block.items.length - 1];
      if (parentItem) parentItem.push(block);
      else out.push(block);
      open.push({ level: place.level, ordered: place.ordered, key: place.key, block });
    }
    open[open.length - 1]!.block.items.push([...item.blocks]);
  }
  return out;
};
