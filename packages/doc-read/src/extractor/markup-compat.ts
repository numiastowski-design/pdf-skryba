/**
 * Markup Compatibility, `mc:AlternateContent` (ECMA-376 Part 3, Markup
 * Compatibility and Extensibility, AlternateContent; Microsoft Learn,
 * « Introduction to markup compatibility », 02/10/2026): a consumer takes the
 * FIRST `mc:Choice` whose `Requires` namespaces it ALL understands, else the
 * `mc:Fallback` — exactly ONE branch, never both. Word and PowerPoint render
 * that branch; so do we (02/10/2026: what Office DISPLAYS is
 * published, nothing else). A Choice whose branch this reader cannot read
 * yields nothing: its Fallback is for OLDER consumers, not what Office shows.
 *
 * `Requires` arrives rewritten by `ooxml/xml.ts#canonicalizeRequires`: a
 * namespace the reader knows is its canonical prefix, any other is
 * `?<prefix>` with the producer's own prefix. The Office extension
 * namespaces below are therefore named by their CONVENTIONAL prefix
 * (`?w14`…): a written limit — a producer binding `w14` to a foreign URI would
 * be taken for Word's. Rare, and the failure shows (one branch, readable).
 * NOT here: reading what a branch holds (`docx-reader/body.ts`,
 * `pptx-reader/shapes.ts`), nor the namespaces' canonical prefixes
 * (`ooxml/xml.ts`).
 * Called by: `docx-reader/objects.ts`, `pptx-reader/shapes.ts`. */
import { attributeOf, findChild, childNodesOf, hasMatchingNode, qualifiedNameOf, type XNode } from "./ooxml/xml";

const unknown = (prefixes: readonly string[]): string[] => prefixes.map((p) => `?${p}`);

const CHARTEX = ["cx", "cx1", "cx2", "cx3", "cx4", "cx5", "cx6", "cx7", "cx8"];

/** What Word understands: the namespaces this reader walks (canonical
 *  prefixes: WordprocessingML, relationships, the drawing frame, DrawingML
 *  and its pictures, Word 2010 shapes and groups, OMML, VML, markup
 *  compatibility) and the Office extensions Word reads (2010 and later:
 *  w14, w15, w16*, wp14, wpc canvas, wpi ink, wne, a14, chartex). */
export const WORD_UNDERSTOOD: ReadonlySet<string> = new Set([
  "w",
  "r",
  "wp",
  "a",
  "pic",
  "wps",
  "wpg",
  "m",
  "v",
  "mc",
  ...unknown([
    "w14",
    "w15",
    "w16",
    "w16se",
    "w16cid",
    "w16cex",
    "w16sdtdh",
    "w16sdtfl",
    "w16du",
    "wp14",
    "wpc",
    "wpi",
    "wne",
    "a14",
    ...CHARTEX,
  ]),
]);

/** What PowerPoint understands: PresentationML and DrawingML (canonical
 *  prefixes) and its Office extensions (2010 and later: p14, p15, p16, p188,
 *  a14, a16, 3D models, ink, decorative marks, chartex). Not Excel's `x14`,
 *  nor Word's `w14`/`wps`: a Choice requiring those goes to the Fallback. */
export const POWERPOINT_UNDERSTOOD: ReadonlySet<string> = new Set([
  "p",
  "a",
  "r",
  "pic",
  "dgm",
  "dsp",
  "c",
  "m",
  "v",
  "mc",
  ...unknown(["p14", "p15", "p16", "p188", "a14", "a16", "am3d", "aink", "ahyp", "adec", ...CHARTEX]),
]);

/** The one branch of an `mc:AlternateContent` the consumer renders: the first
 *  `mc:Choice` whose `Requires` names only understood namespaces, else the
 *  `mc:Fallback`. A Choice with NO `Requires` is non-conforming (Part 3
 *  makes the attribute required) and is never taken: the Fallback is the
 *  only variant whose meaning is certain (written limit, arbitrage of
 *  28/09/2026). */
export const renderedBranch = (alternate: XNode, understood: ReadonlySet<string>): XNode | undefined => {
  for (const choice of childNodesOf(alternate)) {
    if (qualifiedNameOf(choice) !== "mc:Choice") continue;
    const required = (attributeOf(choice, "Requires") ?? "").split(" ").filter((p) => p.length > 0);
    if (required.length > 0 && required.every((p) => understood.has(p))) return choice;
  }
  return findChild(alternate, "mc:Fallback");
};

const carries = (node: XNode, tags: ReadonlySet<string>): boolean =>
  hasMatchingNode(node, (n) => {
    const tag = qualifiedNameOf(n);
    return tag !== undefined && tags.has(tag);
  });

/** The `mc:Fallback` to read INSTEAD of a rendered `mc:Choice` this reader
 *  could not read (M16, 02/10/2026): published if and only if it
 *  carries NO text (`textTags`: no `w:t`, `a:t`, text box…) — then it is the
 *  same object Office draws, as images. A Fallback with text is never
 *  published (the trap: it stands for content Office does not show), and
 *  never alongside a Choice that gave anything: the caller asks only when the
 *  Choice yielded nothing. `undefined` when the rendered branch is already the
 *  Fallback, or there is none. */
export const imageOnlyFallback = (
  alternate: XNode,
  rendered: XNode,
  textTags: ReadonlySet<string>,
  isPixel: (relId: string) => boolean = () => false,
): XNode | undefined => {
  if (qualifiedNameOf(rendered) !== "mc:Choice") return undefined;
  const fallback = findChild(alternate, "mc:Fallback");
  if (!fallback || carries(fallback, textTags)) return undefined;
  // A Fallback whose pictures are ALL 1×1 pixels is the documented junk
  // (PLATFORM-STATUS §53: Google's transparent pixel), not content.
  const pictures = fallbackPictureIds(fallback);
  return pictures.length > 0 && pictures.every(isPixel) ? undefined : fallback;
};

/** The relationship ids of the pictures (`a:blip r:embed`) under a node. */
export const fallbackPictureIds = (node: XNode): string[] => {
  const own = qualifiedNameOf(node) === "a:blip" ? attributeOf(node, "r:embed") : undefined;
  return [...(own === undefined ? [] : [own]), ...childNodesOf(node).flatMap(fallbackPictureIds)];
};

/** The tags that make a Word Fallback a TEXT one. */
export const WORD_TEXT_TAGS: ReadonlySet<string> = new Set([
  "w:t",
  "w:txbxContent",
  "wps:txbx",
  "v:textbox",
  "m:t",
  "w:instrText",
]);

/** The tags that make a PowerPoint Fallback a TEXT one (a table holds text). */
export const POWERPOINT_TEXT_TAGS: ReadonlySet<string> = new Set(["a:t", "p:txBody", "a:tbl", "a:fld"]);
