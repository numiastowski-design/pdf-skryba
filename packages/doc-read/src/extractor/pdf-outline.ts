/** The BOOKMARKS of a PDF (ISO 32000-1:2008 §12.3.3: /Outlines, /First, /Next, /Title), read by OUR reader, and
 *  flattened in reading order with their depth. Decides: the bounds (2 000 nodes, 300 characters per title),
 *  the normalisation of a title, and the abstention on a structure that cannot be read.
 *  Rewritten on 31/10/2026: the reading used to go through pdf.js's `getOutline()`. Our reading gives the same titles on
 *  the 10 documents that have bookmarks (`tools/poc/outline-shadow.ts` (deleted, see git history)), once the title is decoded according to the standard
 *  (`./pdf-text-string.ts`): latin1 lost the "’" of 0x90.
 *  NOT here: the decoding of a string (`./pdf-text-string.ts`), the use of the titles (`./pdf-false-headings.ts`).
 *  Called by: `extractor/pdf-source.ts`, `pdf-outline.test.ts`. */

import { decodePdfTextString } from "./pdf-text-string";
import type { PdfObjectsDocument } from "./pdf-objects/document";
import type { PdfDict, PdfValue } from "./pdf-objects/objects";

/** One bookmark of the PDF's outline (/Outlines, ISO 32000-1 §12.3.3): its title and its depth (1 = top level). The
 *  title is client text: it stays in memory, only compared with the headings read (`pdf-false-headings.ts`). */
export interface PdfOutlineEntry {
  title: string;
  depth: number;
}

/** Bookmarks read at most. Starting value to calibrate: Word writes one per heading, and a 15-page document holds
 *  well under a hundred; beyond the cap the outline is dropped whole (a partial list would wrongly demote headings). */
export const OUTLINE_READ_MAX_ENTRIES = 2_000;

/** Characters kept of a bookmark title: one indirect string can be shared by every bookmark, and 2000 copies of a
 *  multi-megabyte title would be gigabytes. Same value as `TITLE_MAX_CHARS` (`pdf-false-headings.ts`): a longer title
 *  names no line of a page. Starting value to calibrate: the longest true heading of the 169 Word PDFs is 235. */
export const OUTLINE_TITLE_MAX_CHARS = 300;

/** A node of the bookmark tree: its title if it has one, and its children. */
export interface OutlineNode {
  title?: unknown;
  items?: OutlineNode[];
}

/** Title of a bookmark: cut, normalised, then cut (normalisation can lengthen or shorten). */
const bookmarkTitle = (raw: string): string =>
  raw.trim().slice(0, 2 * OUTLINE_TITLE_MAX_CHARS).normalize("NFKC").trim().slice(0, OUTLINE_TITLE_MAX_CHARS);

/** The tree flattened in reading order. A tree that is too large (or has no title) gives `undefined`: a partial list
 *  would demote real headings. Every node counts, titled or not, so that a hostile tree stays bounded. */
export function flattenOutline(tree: readonly OutlineNode[] | null | undefined): PdfOutlineEntry[] | undefined {
  if (tree === null || tree === undefined) return undefined;
  const entries: PdfOutlineEntry[] = [];
  let visited = 0;
  const stack: { node: OutlineNode; depth: number }[] = tree.map((node) => ({ node, depth: 1 })).reverse();
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    if (++visited > OUTLINE_READ_MAX_ENTRIES) return undefined;
    const title = typeof next.node.title === "string" ? bookmarkTitle(next.node.title) : "";
    if (title.length > 0) entries.push({ title, depth: next.depth });
    const children = next.node.items ?? [];
    for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i]!, depth: next.depth + 1 });
  }
  return entries.length > 0 ? entries : undefined;
}

/** The bookmark tree of our document, read from the dictionary. A structure we cannot follow gives
 *  `undefined`: no bookmarks, hence no comparison — an ignorance, never a verdict. */
export function outlineTreeOf(doc: PdfObjectsDocument): OutlineNode[] | undefined {
  const catalog = doc.dictOf(doc.trailer().get("Root"));
  const root = doc.dictOf(catalog?.get("Outlines"));
  if (root === undefined) return undefined;
  // Is a node already seen? A bookmark does not repeat, and a /Next loop must not turn forever.
  const seen = new Set<PdfDict>();
  let count = 0;
  const readSiblings = (first: PdfValue | undefined): OutlineNode[] | undefined => {
    const out: OutlineNode[] = [];
    let node = doc.dictOf(first);
    while (node !== undefined && !seen.has(node)) {
      seen.add(node);
      count += 1;
      // Beyond the bound, the tree will not be flattened: no point building it.
      if (count > OUTLINE_READ_MAX_ENTRIES) return undefined;
      const titleValue = doc.resolve(node.get("Title"));
      const title = titleValue?.kind === "string" ? decodePdfTextString(titleValue.bytes) : undefined;
      const children = readSiblings(node.get("First"));
      if (children === undefined) return undefined;
      out.push({ title, items: children });
      node = doc.dictOf(node.get("Next"));
    }
    return out;
  };
  return readSiblings(root.get("First"));
}

/** The bookmarks of a document, flattened (titles and depths), or `undefined` when it has none, has too many,
 *  or our reader cannot follow them. */
export function outlineOfDocument(doc: PdfObjectsDocument): PdfOutlineEntry[] | undefined {
  return flattenOutline(outlineTreeOf(doc));
}
