/** What `styles.xml` declares that the page keeps: which paragraph styles are
 *  headings (and at what level), and the run marks and colours a paragraph style, a
 *  character style and direct formatting combine into.
 *  Decides: the style hierarchy each run property follows; colours and highlight are published since 10/11/2026,
 *  because a reading agent was seen to use them (see `colours`), and only those the FILE states.
 *  NOT here: fonts and spacing, which are never published (decided), nor walking the body (`docx-reader/body.ts`).
 *  Called by: `docx-reader/body.ts`, `docx-reader/index.ts`. */

import type { InlineMark } from "doc-ir/lib/ir";
import { isOnOff as isOnOffValue } from "../../lib/ooxml-bool";
import { attributeOf, findChild, findChildren, valOfChild, type XNode } from "../ooxml/xml";

interface StyleDefinition {
  readonly id: string;
  readonly type: string;
  readonly name: string | undefined;
  readonly basedOn: string | undefined;
  readonly pPr: XNode | undefined;
  readonly rPr: XNode | undefined;
}

/** What `styles.xml` declares, read once: every style by id, and the default paragraph and character styles. */
interface StyleSheet {
  readonly stylesById: ReadonlyMap<string, StyleDefinition>;
  readonly defaultParagraphStyleId: string | undefined;
  readonly defaultCharacterStyleId: string | undefined;
}

/** What a paragraph style makes of its paragraph. */
type ParagraphRole = { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6 } | { kind: "paragraph" };

export interface Styles {
  /** The role of a paragraph whose `w:pStyle` is `styleId` (absent: the
   *  default paragraph style). */
  role(styleId: string | undefined): ParagraphRole;
  /** The marks of a run: its paragraph's style, its character style
   *  (`w:rStyle`), then its own direct formatting (`rPr`). */
  marks(paragraphStyleId: string | undefined, rPr: XNode | undefined): InlineMark[];
  /** The colours of a run, as the FILE states them, under the same style hierarchy as `marks`. Empty when the file
   *  states none, or states them by a THEME reference (see `colours` below). */
  colours(paragraphStyleId: string | undefined, rPr: XNode | undefined): { color?: string; background?: string };
  /** Whether a run is HIDDEN text (w:vanish, a toggle property resolved like
   *  bold): the same hierarchy as `marks`. `rPr` may also be a paragraph
   *  mark's run properties (w:pPr/w:rPr). w:specVanish and w:webHidden are
   *  other properties and are not read. */
  hidden(paragraphStyleId: string | undefined, rPr: XNode | undefined): boolean;
  /** The first `w:pPr` child named `tag` along the paragraph style's basedOn
   *  chain (numbering declared by a style, for instance). */
  paragraphProperty(styleId: string | undefined, tag: string): XNode | undefined;
}

/**
 * An on/off element: `true`, `1`, `on` — and the attribute ABSENT — mean on; `false`, `0`, `off` mean off.
 * `<w:b w:val="0"/>` is an explicit "not bold", never a bold (held by `docx-reader.test.ts`, test « 05 »).
 */
export const onOff = (element: XNode): boolean => {
  return isOnOffValue(attributeOf(element, "w:val"), true);
};

/** The first child named `tag` of a parent that may be absent. */
const childOf = (parent: XNode | undefined, tag: string): XNode | undefined =>
  parent ? findChild(parent, tag) : undefined;

/** The `w:val` of a declaration that may be absent. */
const valAttributeOf = (declaration: XNode | undefined): string | undefined =>
  declaration ? attributeOf(declaration, "w:val") : undefined;

/** A toggle declaration's value; an absent declaration is off. */
const toggleValueOf = (declaration: XNode | undefined): boolean => (declaration ? onOff(declaration) : false);

/** Built-in style names (w:name) the page reads. The NAME identifies
 *  a built-in style whatever its id — a French Word writes `Titre1` for the
 *  style named `heading 1` — and is compared without case, since producers
 *  write both `heading 1` and `Heading 1`. */
const roleByName = (name: string): ParagraphRole | "subtitle" | undefined => {
  const lowerCaseName = name.trim().toLowerCase();
  const headingMatch = /^heading ([1-6])$/.exec(lowerCaseName);
  if (headingMatch) return { kind: "heading", level: Number(headingMatch[1]) as 1 | 2 | 3 | 4 | 5 | 6 };
  if (lowerCaseName === "title") return { kind: "heading", level: 1 };
  // Subtitle: a plain paragraph, with no mark added for it (decided).
  if (lowerCaseName === "subtitle") return "subtitle";
  return undefined;
};

/** Same reading from the id, for a style that declares no name at all. */
const roleById = (styleId: string): ParagraphRole | "subtitle" | undefined => {
  const headingMatch = /^Heading([1-6])$/.exec(styleId);
  if (headingMatch) return { kind: "heading", level: Number(headingMatch[1]) as 1 | 2 | 3 | 4 | 5 | 6 };
  if (styleId === "Title") return { kind: "heading", level: 1 };
  if (styleId === "Subtitle") return "subtitle";
  return undefined;
};

const PLAIN_PARAGRAPH: ParagraphRole = { kind: "paragraph" };

/** The toggle properties the page keeps, and their mark. */
const TOGGLES: readonly (readonly [string, InlineMark])[] = [
  ["w:b", "strong"],
  ["w:i", "em"],
  ["w:strike", "strike"],
];

const MARK_ORDER: readonly InlineMark[] = ["strong", "em", "underline", "strike", "sup", "sub"];

/** 🔴 THE TWO TEXT COLOURS WE NEVER PUBLISH, a bias chosen and written (10/11/2026).
 *  Neither says « this passage stands out », and each ERASES the text on one of Confluence's two themes, which makes
 *  it a lost word:
 *  - `#ffffff`: white is written on a banner or a coloured cell that we do not publish, so it would come out white on
 *    white.
 *  - `#000000`: an explicit black is a producer's default on every run, not an author's mark.
 *  WHAT THIS REFUSAL DOES NOT SEE, so nobody expects too much: a very light or very dark grey still passes. No
 *  luminance threshold is set: it would be an invented rule, and no population has measured it.
 *  15/09/2026: « unreadable text is a problem for everyone ». */
const INVISIBLE_OR_DEFAULT = new Set(["#ffffff", "#000000"]);

/** Every style by id, and the first default paragraph and character styles. */
const readStyleSheet = (root: XNode | undefined): StyleSheet => {
  const stylesById = new Map<string, StyleDefinition>();
  let defaultParagraphStyleId: string | undefined;
  let defaultCharacterStyleId: string | undefined;
  for (const style of root ? findChildren(root, "w:style") : []) {
    const id = attributeOf(style, "w:styleId");
    if (id === undefined) continue;
    const type = attributeOf(style, "w:type") ?? "paragraph";
    stylesById.set(id, {
      id,
      type,
      name: valOfChild(style, "w:name"),
      basedOn: valOfChild(style, "w:basedOn"),
      pPr: findChild(style, "w:pPr"),
      rPr: findChild(style, "w:rPr"),
    });
    if (isOnOffValue(attributeOf(style, "w:default"), false)) {
      if (type === "paragraph") defaultParagraphStyleId ??= id;
      if (type === "character") defaultCharacterStyleId ??= id;
    }
  }
  return { stylesById, defaultParagraphStyleId, defaultCharacterStyleId };
};

/** The document's default run properties (`w:docDefaults/w:rPrDefault/w:rPr`). */
const readRunPropertiesDefault = (root: XNode | undefined): XNode | undefined =>
  childOf(childOf(childOf(root, "w:docDefaults"), "w:rPrDefault"), "w:rPr");

/** A hex the file states, or nothing: `auto` is « let the reader decide », and a theme slot is not a colour. */
const statedHex = (node: XNode | undefined, valueAttribute: string, themeAttribute: string): string | undefined => {
  if (node === undefined || attributeOf(node, themeAttribute) !== undefined) return undefined;
  const value = attributeOf(node, valueAttribute);
  return value !== undefined && /^[0-9A-Fa-f]{6}$/u.test(value) ? `#${value.toLowerCase()}` : undefined;
};

/** The style and its ancestors, nearest first; a basedOn cycle stops. */
const basedOnChainOf = (
  stylesById: ReadonlyMap<string, StyleDefinition>,
  styleId: string | undefined,
): StyleDefinition[] => {
  const chainedStyles: StyleDefinition[] = [];
  const seen = new Set<string>();
  let current = styleId;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const style = stylesById.get(current);
    if (!style) break;
    chainedStyles.push(style);
    current = style.basedOn;
  }
  return chainedStyles;
};

/** The marks of the non-toggle properties, from their nearest declaration: underline, superscript, subscript. */
const addNonToggleMarks = (nearest: (tag: string) => XNode | undefined, foundMarks: Set<InlineMark>): void => {
  // Every underline value but `none` draws a line (held by `docx-reader.test.ts`, test « 05 »).
  const underlineValue = valAttributeOf(nearest("w:u"));
  if (underlineValue !== undefined && underlineValue !== "none") foundMarks.add("underline");

  const vertAlignValue = valAttributeOf(nearest("w:vertAlign"));
  if (vertAlignValue === "superscript") foundMarks.add("sup");
  if (vertAlignValue === "subscript") foundMarks.add("sub");
};

export const readStyles = (root: XNode | undefined): Styles => {
  const { stylesById, defaultParagraphStyleId, defaultCharacterStyleId } = readStyleSheet(root);
  const rPrDefault = readRunPropertiesDefault(root);
  const basedOnChain = (styleId: string | undefined): StyleDefinition[] => basedOnChainOf(stylesById, styleId);

  /** The nearest declaration of `tag` in a style's rPr along its basedOn
   *  chain: inside ONE style hierarchy a derived style overrides its base. */
  const nearestRunProperty = (styleId: string | undefined, tag: string): XNode | undefined => {
    for (const style of basedOnChain(styleId)) {
      const found = childOf(style.rPr, tag);
      if (found) return found;
    }
    return undefined;
  };

  const role = (styleId: string | undefined): ParagraphRole => {
    for (const style of basedOnChain(styleId ?? defaultParagraphStyleId)) {
      const found = style.name !== undefined ? roleByName(style.name) : roleById(style.id);
      if (found === "subtitle") return PLAIN_PARAGRAPH;
      if (found) return found;
    }
    return PLAIN_PARAGRAPH;
  };

  /** A toggle property's value for a run. Held by `docx-reader.test.ts` (« styles toggle »). */
  const toggle = (
    tag: string,
    paragraphStyleId: string | undefined,
    characterStyleId: string | undefined,
    rPr: XNode | undefined,
  ): boolean => {
    const direct = childOf(rPr, tag);
    // Direct formatting sets the absolute value.
    if (direct) return onOff(direct);
    // In the style hierarchy a toggle set to true INVERTS the value of the
    // level below and false leaves it: bold from the paragraph
    // style plus bold from the character style is not bold.
    const documentDefault = childOf(rPrDefault, tag);
    const fromParagraph = nearestRunProperty(paragraphStyleId, tag);
    const fromCharacter = nearestRunProperty(characterStyleId, tag);
    const valueAfterParagraphStyle = toggleValueOf(documentDefault) !== toggleValueOf(fromParagraph);
    return valueAfterParagraphStyle !== toggleValueOf(fromCharacter);
  };

  const characterStyleOf = (rPr: XNode | undefined): string | undefined =>
    valOfChild(rPr, "w:rStyle") ?? defaultCharacterStyleId;

  const hidden = (paragraphStyleId: string | undefined, rPr: XNode | undefined): boolean =>
    toggle("w:vanish", paragraphStyleId ?? defaultParagraphStyleId, characterStyleOf(rPr), rPr);

  /** The nearest declaration of a non-toggle run property: direct formatting, then the character style, then the
   *  paragraph style, then the document defaults. ONE hierarchy, named once: `marks` and `colours` both read it, and
   *  writing it twice would let the two drift apart. */
  const nearestOf =
    (paragraphStyleId: string | undefined, characterStyleId: string | undefined, rPr: XNode | undefined) =>
    (tag: string): XNode | undefined =>
      childOf(rPr, tag) ??
      nearestRunProperty(characterStyleId, tag) ??
      nearestRunProperty(paragraphStyleId, tag) ??
      childOf(rPrDefault, tag);

  const marks = (paragraphStyleId: string | undefined, rPr: XNode | undefined): InlineMark[] => {
    const effectiveParagraphStyleId = paragraphStyleId ?? defaultParagraphStyleId;
    const characterStyleId = characterStyleOf(rPr);
    const foundMarks = new Set<InlineMark>();

    for (const [tag, mark] of TOGGLES) {
      if (toggle(tag, effectiveParagraphStyleId, characterStyleId, rPr)) foundMarks.add(mark);
    }

    addNonToggleMarks(nearestOf(effectiveParagraphStyleId, characterStyleId, rPr), foundMarks);
    return MARK_ORDER.filter((mark) => foundMarks.has(mark));
  };

  /**
   * THE COLOURS A RUN CARRIES, AND ONLY THOSE THE FILE STATES (10/11/2026: a reading agent, asked which rules of a
   * page were coloured or highlighted, found them all and told text colour from background).
   *
   * 🔴 LEFT OUT FOR NOW, AND IT IS A LIMIT, NOT A PRINCIPLE. A `w:themeColor` / `w:themeFill` names a slot of the
   * document's theme (« accent1 »), not a colour, so nothing is published for it yet. The reason first written here
   * was wrong: resolving it means reading the theme part INSIDE the .docx — the FILE stating its colour, like it
   * states its text — not a correspondence table WE would write and maintain (refused on 14/09/2026). So this is a
   * SCOPE limit of the first lot, to be lifted by reading the theme part, not a decision against it.
   *
   * `w:highlight` gives a NAME, handed on in lower case as a CSS keyword: a case fold, not a table. `auto` and `none`
   * state « no colour » and publish nothing.
   */
  const colours = (
    paragraphStyleId: string | undefined,
    rPr: XNode | undefined,
  ): { color?: string; background?: string } => {
    const nearest = nearestOf(paragraphStyleId ?? defaultParagraphStyleId, characterStyleOf(rPr), rPr);

    // 🔴 THE TEXT COLOUR IS TAKEN FROM THE RUN ITSELF ONLY, never inherited from a style (10/11/2026). A style's colour
    // says the document's look; a colour set on the run says the author's intent on THIS passage. Following the style
    // hierarchy painted most of the inlines of real documents in a heading style's default blue or an explicit black.
    // White and black are refused (`INVISIBLE_OR_DEFAULT`).
    const stated = statedHex(childOf(rPr, "w:color"), "w:val", "w:themeColor");
    const color = stated !== undefined && INVISIBLE_OR_DEFAULT.has(stated) ? undefined : stated;
    // Same reason for the shading: a table style's shading dresses, it does not signal.
    const shading = statedHex(childOf(rPr, "w:shd"), "w:fill", "w:themeFill");
    // The HIGHLIGHT keeps the hierarchy: nobody highlights to dress a page, and a « Highlighted » character style is
    // still an author's gesture.
    const highlightValue = valAttributeOf(nearest("w:highlight"));
    // The highlight wins over the shading when both are stated: it is the mark a reader of the document sees.
    const background =
      highlightValue !== undefined && highlightValue !== "none" ? highlightValue.toLowerCase() : shading;

    return { ...(color !== undefined ? { color } : {}), ...(background !== undefined ? { background } : {}) };
  };

  const paragraphProperty = (styleId: string | undefined, tag: string): XNode | undefined => {
    for (const style of basedOnChain(styleId ?? defaultParagraphStyleId)) {
      const found = childOf(style.pPr, tag);
      if (found) return found;
    }
    return undefined;
  };

  return { role, marks, colours, hidden, paragraphProperty };
};
