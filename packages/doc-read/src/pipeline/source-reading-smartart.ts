/** The words of one SmartArt, read INDEPENDENTLY of the extractor (`extractor/smartart.ts`), straight off the parts: the data
 *  model's points (ECMA-376 Part 1 §21.4: `dgm:dataModel` > `dgm:ptLst` > `dgm:pt` > `dgm:t`, the part a frame's `dgm:relIds r:dm`
 *  names). EVERY point with text counts, the tree or not (transitions and presentation points included): the page publishes them
 *  all, in an order this check does not need, so there is no tree walk and no point bound (a model of any size costs one pass).
 *  A model with no text names the drawing cache Office last rendered (`dsp:dataModelExt relId`, [MS-ODRAWXML]): the shapes' texts
 *  of that cache are read instead, as the page does. A model that cannot be read gives NOTHING (chosen bias): the page then pairs a
 *  cache with its frame by position (`cachesWithoutModel`), a guess this check does not repeat, so the page may carry more words
 *  than expected, never fewer. A refusal of the byte budget is not a damaged part: it still throws, an abstention.
 *  Since 20/10/2026 a SECOND reading, `smartArtDrawingPieces`, always reads the shapes' texts of that saved drawing, model or not: they are what
 *  the published picture draws, the repository's tests compare them to the SVG's own `<text>`. The expected
 *  words stay the model's (a drawing's extra text is not the document's); the extractor's `extractor/smartart-drawing.ts` is imported by neither.
 *  NOT here: where a frame stands or whether it is shown (hidden, off page: `source-reading-docx.ts`, `source-reading-pptx.ts`).
 *  Called by: `source-reading-docx.ts` and `source-reading-pptx.ts`. */

import { attrOf, first, kidsOf, stylesOrAbsent, tagOf, textOf, type N } from "./source-reading-package";

/** The archive path a relationship id names, when internal and present; `undefined` otherwise. */
export type PartOfRelId = (relId: string | undefined) => string | undefined;

/** Every descendant tagged `tag`, in document order; a match is not searched inside. */
const allOf = (n: N, tag: string, out: N[] = []): N[] => {
  for (const c of kidsOf(n)) {
    if (tagOf(c) === tag) out.push(c);
    else allOf(c, tag, out);
  }
  return out;
};

/** One text body (`dgm:t`, `dsp:txBody`) as one line: the text of its runs and fields, a line break as a space, paragraphs apart. */
const lineOf = (body: N | undefined): string => {
  if (!body) return "";
  const paragraphs = kidsOf(body)
    .filter((p) => tagOf(p) === "a:p")
    .map((p) =>
      kidsOf(p)
        .map((k) => {
          const tag = tagOf(k);
          if (tag === "a:br") return " ";
          return tag === "a:r" || tag === "a:fld" ? allOf(k, "a:t").map(textOf).join("") : "";
        })
        .join(""),
    );
  return paragraphs.join(" ").trim();
};

/** The `r:dm` relationship ids of the `dgm:relIds` frames under `node`; the subtrees tagged in `skip` are not entered. */
export const smartArtRelIds = (node: N, skip: ReadonlySet<string> = new Set(), out: string[] = []): string[] => {
  for (const c of kidsOf(node)) {
    const tag = tagOf(c);
    if (skip.has(tag)) continue;
    if (tag === "dgm:relIds") {
      const id = attrOf(c, "r:dm");
      if (id !== undefined) out.push(id);
    } else smartArtRelIds(c, skip, out);
  }
  return out;
};

/** The words (one string per point or per cache shape, not yet split) of the SmartArt whose data model is the part `dataPart`.
 *  `partOf` resolves the relationships of the part that holds the frame (where the model's extension names its cache). */
export const smartArtPieces = async (
  xmlOf: (path: string) => Promise<N | undefined>,
  dataPart: string | undefined,
  partOf: PartOfRelId,
): Promise<string[]> => {
  const data = dataPart === undefined ? undefined : await stylesOrAbsent(() => xmlOf(dataPart));
  if (!data) return [];
  const points = allOf(data, "dgm:pt")
    .map((pt) => lineOf(first(pt, "dgm:t")))
    .filter((t) => t !== "");
  if (points.length > 0) return points;
  return cachePiecesOf(xmlOf, data, partOf);
};

/** The shapes' texts (one string per `dsp:sp` with text, document order) of the drawing cache the data model `data` names. */
const cachePiecesOf = async (xmlOf: (path: string) => Promise<N | undefined>, data: N, partOf: PartOfRelId): Promise<string[]> => {
  const extension = allOf(data, "dsp:dataModelExt")[0];
  const cachePart = extension ? partOf(attrOf(extension, "relId")) : undefined;
  const cache = cachePart === undefined ? undefined : await stylesOrAbsent(() => xmlOf(cachePart));
  if (!cache) return [];
  return allOf(cache, "dsp:sp")
    .map((sp) => lineOf(first(sp, "dsp:txBody")))
    .filter((t) => t !== "");
};

/** The texts the SAVED DRAWING of the SmartArt whose data model is `dataPart` holds, whether or not the model has text: what its
 *  published picture is expected to draw (a shape the drawer leaves out is a defect the tests name). `[]` for an unreadable or absent model. */
export const smartArtDrawingPieces = async (
  xmlOf: (path: string) => Promise<N | undefined>,
  dataPart: string | undefined,
  partOf: PartOfRelId,
): Promise<string[]> => {
  const data = dataPart === undefined ? undefined : await stylesOrAbsent(() => xmlOf(dataPart));
  return data ? cachePiecesOf(xmlOf, data, partOf) : [];
};
