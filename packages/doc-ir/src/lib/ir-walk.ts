/** The ONE traversal of an IR block tree: which block kinds hold other blocks
 *  and which hold inlines. Every exhaustive switch below ends in `never`, so a
 *  container kind added to `IRBlock` (lib/ir.ts) fails to compile HERE instead
 *  of being silently skipped by a hand-written walk (the `columns` drift of
 *  07/10/2026: three walks enumerated the containers and missed it).
 *  NOT here: what a walk does with a block (each caller), nor the renderer's
 *  own recursion, which writes markup per kind (`renderer/storage.ts`).
 *  Called by: `pipeline/collect-links.ts`, `pipeline/normalize-links.ts`,
 *  `pipeline/detect-language.ts`, `orchestrator/document-facts.ts`,
 *  `extractor/docx-reader/image-refs.ts`, `extractor/docx-reader/body.ts`, `lib/table-width-cap.ts`. */

import type { Inline, IRBlock } from "./ir";

const assertNever = (b: never): never => {
  throw new Error(`Unhandled IR block kind: ${(b as { kind: string }).kind}`);
};

/** The block lists a block directly contains, in reading order. */
function childBlockLists(block: IRBlock): readonly (readonly IRBlock[])[] {
  switch (block.kind) {
    case "list":
      return block.items;
    case "table":
      return block.rows.flatMap((row) => row.cells.map((cell) => cell.blocks));
    case "footnote":
    case "section":
      return [block.blocks];
    case "columns":
      return block.cells;
    case "tabs":
      return block.tabs.map((tab) => tab.blocks);
    case "heading":
    case "paragraph":
    case "image":
    case "chart":
    case "equation":
    case "toc":
    case "diagramText":
      return [];
    default:
      return assertNever(block);
  }
}

/** The inline runs a block directly carries (not those of its children). */
function ownInlineLists(block: IRBlock): readonly (readonly Inline[])[] {
  switch (block.kind) {
    case "heading":
    case "paragraph":
      return [block.inlines];
    case "diagramText":
      return block.sections.map((section) => section.inlines);
    case "list":
    case "table":
    case "footnote":
    case "section":
    case "columns":
    case "tabs":
    case "image":
    case "chart":
    case "equation":
    case "toc":
      return [];
    default:
      return assertNever(block);
  }
}

/** Every block, depth first in reading order, containers before their content.
 *  `visit` returning `false` skips that block's children (a deliberate skip is
 *  written at the call site, with its reason). */
export function walkBlocks(blocks: readonly IRBlock[], visit: (block: IRBlock) => boolean | void): void {
  for (const block of blocks) {
    if (visit(block) === false) continue;
    for (const list of childBlockLists(block)) walkBlocks(list, visit);
  }
}

/** Every run of inlines (a paragraph's, a heading's, a diagram section's), containers entered, in reading order: the unit whose
 *  texts join with no separator, as the page reads them. */
export function walkInlineRuns(blocks: readonly IRBlock[], visit: (run: readonly Inline[]) => void): void {
  walkBlocks(blocks, (block) => {
    for (const list of ownInlineLists(block)) visit(list);
  });
}

/** Every inline of every block, containers entered, in reading order. */
export function walkInlines(blocks: readonly IRBlock[], visit: (inline: Inline) => void): void {
  walkBlocks(blocks, (block) => {
    for (const list of ownInlineLists(block)) for (const inline of list) visit(inline);
  });
}

/** `block` with each of its direct block lists replaced by `fn(list)`; a leaf comes back unchanged. */
export function mapBlockChildren(block: IRBlock, fn: (blocks: IRBlock[]) => IRBlock[]): IRBlock {
  switch (block.kind) {
    case "list":
      return { ...block, items: block.items.map(fn) };
    case "table":
      return { ...block, rows: block.rows.map((row) => ({ ...row, cells: row.cells.map((cell) => ({ ...cell, blocks: fn(cell.blocks) })) })) };
    case "footnote":
    case "section":
      return { ...block, blocks: fn(block.blocks) };
    case "columns":
      return { ...block, cells: block.cells.map(fn) };
    case "tabs":
      return { ...block, tabs: block.tabs.map((tab) => ({ ...tab, blocks: fn(tab.blocks) })) };
    case "heading":
    case "paragraph":
    case "image":
    case "chart":
    case "equation":
    case "toc":
    case "diagramText":
      return block;
    default:
      return assertNever(block);
  }
}

/** `block` with each of its OWN inline runs replaced by `fn(run)`; children untouched. */
function mapBlockInlines(block: IRBlock, fn: (inlines: Inline[]) => Inline[]): IRBlock {
  switch (block.kind) {
    case "heading":
    case "paragraph":
      return { ...block, inlines: fn(block.inlines) };
    case "diagramText":
      return { ...block, sections: block.sections.map((s) => ({ ...s, inlines: fn(s.inlines) })) };
    case "list":
    case "table":
    case "footnote":
    case "section":
    case "columns":
    case "tabs":
    case "image":
    case "chart":
    case "equation":
    case "toc":
      return block;
    default:
      return assertNever(block);
  }
}

/** A whole tree mapped: every block's own inlines through `fn`, every container entered. */
export function mapInlines(blocks: IRBlock[], fn: (inlines: Inline[]) => Inline[]): IRBlock[] {
  return blocks.map((b) => mapBlockChildren(mapBlockInlines(b, fn), (list) => mapInlines(list, fn)));
}
