/** The words of a SmartArt, read from its DATA MODEL.
 *
 *  Source: ECMA-376 Part 1 §21.4 (DrawingML Diagrams): `dgm:dataModel`
 *  (§21.4.2.10) holds `dgm:ptLst` (the points, the text in each `dgm:pt`'s
 *  `dgm:t`) and `dgm:cxnLst` (§21.4.3.3) of `dgm:cxn` (§21.4.3.2), a
 *  connection from `srcId` to `destId`. A connection with no `type` is
 *  `parOf` (the schema's default): the parent-child tree of the diagram's
 *  text, the children of a parent in `srcOrd` order.
 *
 *  Chosen order, in this order of preference:
 *  1. the TREE of `parOf` connections, from the `doc` point (or the points
 *     with no parent), children by `srcOrd`, each point once;
 *  2. the document order of the points when the relations are absent or do
 *     not form a tree (a point with two parents, a cycle, a missing end).
 *  Points the tree does not reach (`parTrans`, `sibTrans`, `pres`) come last,
 *  in document order, when they carry text: no word is ever dropped.
 *
 *  Why the data model and not the drawing cache: the data model is what the
 *  author typed and what the schema defines; the cache (`dsp:drawing`, a
 *  Microsoft extension, [MS-ODRAWXML]) is what Office last RENDERED, with
 *  the layout's own placement. It is read only when the data model is
 *  missing or holds no text (a producer that wrote the cache alone).
 *
 *  No character is added: one piece per point (its paragraphs joined by a
 *  space), the caller separates the pieces.
 *
 *  Each piece carries its LEVEL in the tree, counted from the shallowest text
 *  actually published (the `doc` point carries none, so its children are 0).
 *  The page publishes a SmartArt as the nested bullet list Word stores behind
 *  the drawing (29/10/2026); a model that is not a tree gives every piece
 *  level 0, so the list stays flat and invents no structure.
 *  NOT here: where the words go (`extractor/pptx.ts`, `docx-reader/body.ts`),
 *  nor the list itself (`renderer/storage.ts#renderOutline`).
 *  Called by: `pptx-reader/index.ts`, `docx-reader/index.ts`. */

import { collapseBlanks } from "doc-ir/lib/blanks";
import { internalTarget, orDamaged, type DocxPackage, type Relationship } from "./ooxml/package";
import { attr, child, children, descendants, kids, tagOf, textOf, type XNode } from "./ooxml/xml";

/** One text body (`dgm:t` or `dsp:txBody`) as one line: its paragraphs'
 *  runs (`a:t`, a field's included), a line break (`a:br`) as a space,
 *  paragraphs joined by a space. Ends trimmed, nothing else touched. */
const lineOf = (body: XNode): string => {
  const paragraph = (p: XNode): string =>
    kids(p)
      .map((k) => {
        const tag = tagOf(k);
        if (tag === "a:br") return " ";
        if (tag === "a:r" || tag === "a:fld") return descendants(k, "a:t").map(textOf).join("");
        return "";
      })
      .join("");
  return collapseBlanks(children(body, "a:p").map(paragraph).join(" "));
};

/** Starting value to calibrate: the most points, and the most connections,
 *  of a data model whose TREE is walked. The SmartArts of the repo's
 *  fixtures hold tens of points; a model of 40 000 points cost 14 s and a
 *  chain of 20 000 overflowed the stack. Past it the document order of the
 *  points stands (every word published, only the order is today's). */
const MAX_SMARTART_POINTS = 5_000;

interface Point {
  id: string | undefined;
  text: string;
}

/** One text of a data model and its depth in the `parOf` tree, counted from
 *  the shallowest text actually published: the `doc` point carries no text,
 *  so its children are level 0. A model whose relations are not a tree gives
 *  every text level 0 — a flat list invents no structure. */
export interface Piece {
  text: string;
  level: number;
}

/** The pieces of text of a data model, in the order described above. */
export const dataModelPieces = (root: XNode): Piece[] => {
  const points: Point[] = children(child(root, "dgm:ptLst") ?? {}, "dgm:pt").map((pt) => ({
    id: attr(pt, "modelId"),
    text: lineOf(child(pt, "dgm:t") ?? {}),
  }));
  const inDocumentOrder = (): Piece[] => points.filter((p) => p.text !== "").map((p) => ({ text: p.text, level: 0 }));

  const byId = new Map<string, number>();
  points.forEach((p, i) => {
    if (p.id !== undefined) byId.set(p.id, i);
  });
  const edges = children(child(root, "dgm:cxnLst") ?? {}, "dgm:cxn")
    .filter((c) => (attr(c, "type") ?? "parOf") === "parOf")
    .map((c, order) => ({ from: byId.get(attr(c, "srcId") ?? ""), to: byId.get(attr(c, "destId") ?? ""), srcOrd: Number(attr(c, "srcOrd") ?? "0"), order }));
  if (edges.length === 0 || points.length > MAX_SMARTART_POINTS || edges.length > MAX_SMARTART_POINTS) return inDocumentOrder();
  // A tree: every end is a point, a point has at most one parent.
  const parentOf = new Map<number, number>();
  for (const e of edges) {
    if (e.from === undefined || e.to === undefined || parentOf.has(e.to)) return inDocumentOrder();
    parentOf.set(e.to, e.from);
  }
  const kidsOf = new Map<number, typeof edges>();
  for (const e of edges) {
    const same = kidsOf.get(e.from!);
    if (same === undefined) kidsOf.set(e.from!, [e]);
    else same.push(e);
  }
  for (const list of kidsOf.values()) list.sort((a, b) => a.srcOrd - b.srcOrd || a.order - b.order);
  const doc = children(child(root, "dgm:ptLst") ?? {}, "dgm:pt").findIndex((pt) => attr(pt, "type") === "doc");
  const roots = doc >= 0 ? [doc] : points.map((_, i) => i).filter((i) => !parentOf.has(i));
  const seen = new Set<number>();
  const out: Piece[] = [];
  let cyclic = false;
  // Pre-order walk with an explicit stack: a deep chain must not overflow the call stack.
  const stack: { list: typeof edges; k: number }[] = [];
  const visit = (i: number): void => {
    if (seen.has(i)) {
      cyclic = true;
      return;
    }
    seen.add(i);
    const text = points[i]?.text ?? "";
    // The depth is the height of the stack at the moment of the visit: the walk already knows it, and threw it away.
    if (text !== "") out.push({ text, level: stack.length });
    stack.push({ list: kidsOf.get(i) ?? [], k: 0 });
  };
  for (const r of roots) {
    visit(r);
    while (stack.length > 0 && !cyclic) {
      const frame = stack[stack.length - 1]!;
      if (frame.k >= frame.list.length) stack.pop();
      else visit(frame.list[frame.k++]!.to!);
    }
  }
  // A cycle has no root: its points are unreached, or visited twice.
  if (cyclic) return inDocumentOrder();
  // Counted from the shallowest text, not from the roots: a `doc` point carries no text, so without this its children
  // would be level 1 and the published list would start one notch in. `reduce` and not `Math.min(...)`: the spread of a
  // model of thousands of points is one more way to overflow the stack, which this walk exists to avoid.
  const base = out.reduce((least, p) => Math.min(least, p.level), Number.MAX_SAFE_INTEGER);
  const pieces = out.map((p) => ({ text: p.text, level: p.level - base }));
  // A point the tree does not reach has no depth: it goes at level 0, never nested under a text it is not a child of.
  points.forEach((p, i) => {
    if (!seen.has(i) && p.text !== "") pieces.push({ text: p.text, level: 0 });
  });
  return pieces;
};

/** The drawing cache's pieces: one per shape (`dsp:sp`) with text, in
 *  document order. */
export const drawingPieces = (root: XNode): string[] =>
  descendants(root, "dsp:sp")
    .map((sp) => lineOf(child(sp, "dsp:txBody") ?? {}))
    .filter((t) => t !== "");

/** The data-model part a `dgm:relIds` element names (`r:dm`), when internal. */
export const smartArtDataPart = (rels: ReadonlyMap<string, Relationship>, relIds: XNode): string | undefined => {
  return internalTarget(rels, attr(relIds, "r:dm"));
};

export interface SmartArtRead {
  words: string[];
  /** The level of each word's piece in the model's tree, one per `words` entry, 0 when the model is not a tree or the
   *  words come from the drawing cache (which has no tree). The published list nests on it. */
  levels: number[];
  /** The drawing-cache part the data model names (`dsp:dataModelExt relId`,
   *  [MS-ODRAWXML]), whether or not its text was used: the cache is THAT
   *  frame's, and no model-less frame may be given it. */
  claimed?: string;
}

/** A SmartArt's words, from its data-model part. `rels`: the relationships
 *  of the part that holds the frame (slide or document), where the data
 *  model's own extension names the drawing cache. `undefined`: no data-model
 *  part (the caller may look for a cache nobody claimed,
 *  `cachesWithoutModel`). */
export const readSmartArt = async (pkg: DocxPackage, rels: ReadonlyMap<string, Relationship>, dataPart: string | undefined): Promise<SmartArtRead | undefined> => {
  const data = dataPart === undefined ? undefined : await pkg.readXml(dataPart);
  if (!data) return undefined;
  const ext = descendants(data, "dsp:dataModelExt")[0];
  const relId = ext ? attr(ext, "relId") : undefined;
  const cachePart = internalTarget(rels, relId);
  const fromModel = dataModelPieces(data);
  if (fromModel.length > 0 || cachePart === undefined)
    return { words: fromModel.map((p) => p.text), levels: fromModel.map((p) => p.level), ...(cachePart === undefined ? {} : { claimed: cachePart }) };
  // A model with no text: the cache is the only source, and it holds no tree — a flat list.
  const cache = await pkg.readXml(cachePart);
  const words = cache ? drawingPieces(cache) : [];
  return { words, levels: words.map(() => 0), claimed: cachePart };
};

/** The number in a part name (`drawing12.xml` gives 12); parts without one sort last. */
export const partNumberOf = (path: string): number => Number(/(\d{1,15})\.xml$/.exec(path)?.[1] ?? Number.MAX_SAFE_INTEGER);

/** The words of the SmartArts that have NO data model, `frames` of them in
 *  reading order, from the drawing caches no model claimed: the part's
 *  `diagramDrawing` relationships (type
 *  `http://schemas.microsoft.com/office/2007/relationships/diagramDrawing`),
 *  in the order of their part names' numbers. A frame names only its data
 *  model (`dgm:relIds` has no cache attribute), so a cache cannot be tied to
 *  its frame by the file: as many caches as frames → one each, in order;
 *  otherwise ALL of their words go to the first frame (chosen bias: an
 *  extra place is better than a lost word, never a word that is not the
 *  file's own). */
export const cachesWithoutModel = async (
  pkg: DocxPackage,
  rels: ReadonlyMap<string, Relationship>,
  claimed: ReadonlySet<string>,
  frames: number,
): Promise<string[][]> => {
  if (frames === 0) return [];
  const numberOf = partNumberOf;
  const targets = [...new Set([...rels.values()].filter((r) => r.kind === "diagramDrawing" && !r.external).map((r) => r.target))]
    .filter((t) => !claimed.has(t))
    .sort((a, b) => numberOf(a) - numberOf(b) || a.localeCompare(b));
  const read: string[][] = [];
  for (const target of targets) {
    // A cache whose XML cannot be read gives no words; a ceiling refusal or any other error still propagates.
    const root = await orDamaged(() => pkg.readXml(target));
    read.push(root ? drawingPieces(root) : []);
  }
  if (read.length === frames) return read;
  return Array.from({ length: frames }, (_, i) => (i === 0 ? read.flat() : []));
};
