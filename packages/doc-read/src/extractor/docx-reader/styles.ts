/** What `styles.xml` declares that the page keeps: which paragraph styles are
 *  headings (and at what level), and the run marks a paragraph style, a
 *  character style and direct formatting combine into.
 *  COLOURS AND HIGHLIGHT ARE PUBLISHED SINCE LE 10/11/2026 (Mikolaj : « du coup ne les jetons plus »), after his own
 *  Rovo trial of that day: asked which rules of a page were red or highlighted, Rovo returned all four, told text
 *  colour from background, and even named the shade. The paper « Silent Cue Loss » (arXiv:2610.30026) measures
 *  +0.302 of accuracy for highlighting and +0.262 for colour, bold/italic/strike ≈ 0. See `colours` below.
 *  NOT here: fonts, spacing — never published (decided,
 *  the docx reader (`extractor/docx-reader/`)) — nor walking the body
 *  (`docx-reader/body.ts`).
 *  Called by: `docx-reader/body.ts`, `docx-reader/index.ts`. */

import type { InlineMark } from "doc-ir/lib/ir";
import { isOnOff as isOnOffValue } from "../../lib/ooxml-bool";
import { attr, child, children, type XNode } from "../ooxml/xml";

interface StyleDef {
  id: string;
  type: string;
  name: string | undefined;
  basedOn: string | undefined;
  pPr: XNode | undefined;
  rPr: XNode | undefined;
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
 * ST_OnOff (ECMA-376 Part 1 §17.17.4): `true`, `1`, `on` — and the attribute
 * ABSENT — mean on; `false`, `0`, `off` mean off. `<w:b w:val="0"/>` is an
 * explicit "not bold", never a bold.
 */
export const onOff = (el: XNode): boolean => {
  return isOnOffValue(attr(el, "w:val"), true);
};

/** Built-in style names (w:name) the page reads. The NAME identifies
 *  a built-in style whatever its id — a French Word writes `Titre1` for the
 *  style named `heading 1` — and is compared without case, since producers
 *  write both `heading 1` and `Heading 1`. */
const roleByName = (name: string): ParagraphRole | "subtitle" | undefined => {
  const lower = name.trim().toLowerCase();
  const heading = /^heading ([1-6])$/.exec(lower);
  if (heading) return { kind: "heading", level: Number(heading[1]) as 1 | 2 | 3 | 4 | 5 | 6 };
  if (lower === "title") return { kind: "heading", level: 1 };
  // Subtitle: a plain paragraph, with no mark added for it (decided).
  if (lower === "subtitle") return "subtitle";
  return undefined;
};

/** Same reading from the id, for a style that declares no name at all. */
const roleById = (id: string): ParagraphRole | "subtitle" | undefined => {
  const heading = /^Heading([1-6])$/.exec(id);
  if (heading) return { kind: "heading", level: Number(heading[1]) as 1 | 2 | 3 | 4 | 5 | 6 };
  if (id === "Title") return { kind: "heading", level: 1 };
  if (id === "Subtitle") return "subtitle";
  return undefined;
};

const PLAIN: ParagraphRole = { kind: "paragraph" };

/** Toggle properties (§17.7.3) the page keeps, and their mark. */
const TOGGLES: [string, InlineMark][] = [
  ["w:b", "strong"],
  ["w:i", "em"],
  ["w:strike", "strike"],
];

const MARK_ORDER: InlineMark[] = ["strong", "em", "underline", "strike", "sup", "sub"];

/** 🔴 LES DEUX COULEURS DE TEXTE QU'ON NE PUBLIE JAMAIS, et c'est un biais choisi et écrit (10/11/2026).
 *  Ni l'une ni l'autre ne dit « ce passage ressort » — chacune est un défaut qu'un outil écrit en toutes lettres —
 *  et chacune EFFACE le texte sur un des deux thèmes de Confluence, ce qui en fait un mot perdu :
 *  - `#ffffff` : un auteur écrit en blanc sur une bannière ou une cellule colorée, et cette bannière nous ne la
 *    publions pas. MESURÉ : `10-lpc-invitation-to-tender` écrit son titre entier en blanc.
 *  - `#000000` : Google Docs pose un noir EXPLICITE sur chaque run de ses exports. MESURÉ : il est arrivé par un
 *    test du lecteur (`05-Essai-Annotations.docx`), et `07-moj-data-sharing-guidance` en portait sur tout son corps.
 *  CE QUE CE REFUS NE VOIT PAS, pour que personne n'en attende trop : un gris très clair ou très sombre passe
 *  encore. Aucun seuil de luminance n'est posé — ce serait une règle inventée, et aucune population ne l'a mesurée.
 *  Mikolaj, 15/09/2026 : « un texte illisible est un problème pour tout le monde ». */
const INVISIBLE_OR_DEFAULT = new Set(["#ffffff", "#000000"]);

export const readStyles = (root: XNode | undefined): Styles => {
  const byId = new Map<string, StyleDef>();
  let defaultParagraph: string | undefined;
  let defaultCharacter: string | undefined;
  for (const s of root ? children(root, "w:style") : []) {
    const id = attr(s, "w:styleId");
    if (id === undefined) continue;
    const type = attr(s, "w:type") ?? "paragraph";
    const nameEl = child(s, "w:name");
    const basedOnEl = child(s, "w:basedOn");
    byId.set(id, {
      id,
      type,
      name: nameEl ? attr(nameEl, "w:val") : undefined,
      basedOn: basedOnEl ? attr(basedOnEl, "w:val") : undefined,
      pPr: child(s, "w:pPr"),
      rPr: child(s, "w:rPr"),
    });
    if (isOnOffValue(attr(s, "w:default"), false)) {
      if (type === "paragraph") defaultParagraph ??= id;
      if (type === "character") defaultCharacter ??= id;
    }
  }
  const docDefaults = root ? child(root, "w:docDefaults") : undefined;
  const rPrDefaultHolder = docDefaults ? child(docDefaults, "w:rPrDefault") : undefined;
  const rPrDefault = rPrDefaultHolder ? child(rPrDefaultHolder, "w:rPr") : undefined;

  /** The style and its ancestors, nearest first; a basedOn cycle stops. */
  const chain = (id: string | undefined): StyleDef[] => {
    const out: StyleDef[] = [];
    const seen = new Set<string>();
    let current = id;
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const def = byId.get(current);
      if (!def) break;
      out.push(def);
      current = def.basedOn;
    }
    return out;
  };

  /** The nearest declaration of `tag` in a style's rPr along its basedOn
   *  chain: inside ONE style hierarchy a derived style overrides its base. */
  const nearestRunProperty = (id: string | undefined, tag: string): XNode | undefined => {
    for (const def of chain(id)) {
      const found = def.rPr ? child(def.rPr, tag) : undefined;
      if (found) return found;
    }
    return undefined;
  };

  const role = (styleId: string | undefined): ParagraphRole => {
    for (const def of chain(styleId ?? defaultParagraph)) {
      const found = def.name !== undefined ? roleByName(def.name) : roleById(def.id);
      if (found === "subtitle") return PLAIN;
      if (found) return found;
    }
    return PLAIN;
  };

  /** A toggle property's value for a run (§17.7.3). */
  const toggle = (tag: string, pStyle: string | undefined, cStyle: string | undefined, rPr: XNode | undefined): boolean => {
    const direct = rPr ? child(rPr, tag) : undefined;
    // Direct formatting sets the absolute value (§17.7.3).
    if (direct) return onOff(direct);
    // In the style hierarchy a toggle set to true INVERTS the value of the
    // level below and false leaves it (§17.7.3): bold from the paragraph
    // style plus bold from the character style is not bold.
    const base = rPrDefault ? child(rPrDefault, tag) : undefined;
    const fromParagraph = nearestRunProperty(pStyle, tag);
    const fromCharacter = nearestRunProperty(cStyle, tag);
    const on = (base ? onOff(base) : false) !== (fromParagraph ? onOff(fromParagraph) : false);
    return on !== (fromCharacter ? onOff(fromCharacter) : false);
  };

  const characterStyleOf = (rPr: XNode | undefined): string | undefined => {
    const rStyleEl = rPr ? child(rPr, "w:rStyle") : undefined;
    return (rStyleEl ? attr(rStyleEl, "w:val") : undefined) ?? defaultCharacter;
  };

  const hidden = (paragraphStyleId: string | undefined, rPr: XNode | undefined): boolean =>
    toggle("w:vanish", paragraphStyleId ?? defaultParagraph, characterStyleOf(rPr), rPr);

  /** The nearest declaration of a non-toggle run property: direct formatting, then the character style, then the
   *  paragraph style, then the document defaults. ONE hierarchy, named once: `marks` and `colours` both read it, and
   *  writing it twice would let the two drift apart. */
  const nearestOf = (pStyle: string | undefined, cStyle: string | undefined, rPr: XNode | undefined) => (tag: string): XNode | undefined =>
    (rPr ? child(rPr, tag) : undefined) ??
    nearestRunProperty(cStyle, tag) ??
    nearestRunProperty(pStyle, tag) ??
    (rPrDefault ? child(rPrDefault, tag) : undefined);

  const marks = (paragraphStyleId: string | undefined, rPr: XNode | undefined): InlineMark[] => {
    const pStyle = paragraphStyleId ?? defaultParagraph;
    const cStyle = characterStyleOf(rPr);
    const out = new Set<InlineMark>();

    for (const [tag, mark] of TOGGLES) {
      if (toggle(tag, pStyle, cStyle, rPr)) out.add(mark);
    }

    const nearest = nearestOf(pStyle, cStyle, rPr);

    // ST_Underline: `none` is the only value without a line.
    const u = nearest("w:u");
    const uVal = u ? attr(u, "w:val") : undefined;
    if (u && uVal !== undefined && uVal !== "none") out.add("underline");

    // ST_VerticalAlignRun: superscript, subscript, baseline.
    const va = nearest("w:vertAlign");
    const vaVal = va ? attr(va, "w:val") : undefined;
    if (vaVal === "superscript") out.add("sup");
    if (vaVal === "subscript") out.add("sub");

    return MARK_ORDER.filter((m) => out.has(m));
  };

  /**
   * THE COLOURS A RUN CARRIES, AND ONLY THOSE THE FILE STATES (Mikolaj, 10/11/2026 : « du coup ne les jetons plus »,
   * après son propre essai Rovo du même jour — Rovo rend les quatre règles colorées d'une page, et distingue la
   * couleur du texte de celle du fond).
   *
   * 🔴 LEFT OUT FOR NOW, AND IT IS A LIMIT, NOT A PRINCIPLE. A `w:themeColor` / `w:themeFill` names a slot of the
   * document's theme (« accent1 »), not a colour, so nothing is published for it yet.
   * THE REASON FIRST WRITTEN HERE WAS WRONG, and Mikolaj caught it the same day: « et on pourrait le faire sur chaque
   * doc à chaque fois ? ». Yes. Resolving it means opening `theme1.xml`, which is INSIDE the .docx, and reading
   * `<a:accent1><a:srgbClr val="…"/></a:accent1>` — the FILE stating its colour, like it states its text. That is not
   * the correspondence table Mikolaj refused on 14/09/2026 (« je veux pas de table de correspondance pour les
   * couleurs »): a table is a dictionary WE would write and maintain. Even `w:themeTint`/`w:themeShade` is arithmetic
   * the standard defines (ECMA-376 Part 1), not a choice of ours.
   * So this is a SCOPE limit of the first lot, to be lifted by reading the theme part — not a decision against it.
   *
   * `w:color` and `w:shd/@w:fill` give a hex; `w:highlight` gives a NAME of its own closed list (ECMA-376 Part 1
   * §17.18.40, ST_HighlightColor), handed on in lower case as the CSS keyword it already is — a case fold, not a
   * table. `auto` and `none` state « no colour » and publish nothing.
   */
  const colours = (paragraphStyleId: string | undefined, rPr: XNode | undefined): { color?: string; background?: string } => {
    const nearest = nearestOf(paragraphStyleId ?? defaultParagraph, characterStyleOf(rPr), rPr);

    /** A hex the file states, or nothing: `auto` is « let the reader decide », and a theme slot is not a colour. */
    const statedHex = (node: XNode | undefined, valueAttr: string, themeAttr: string): string | undefined => {
      if (node === undefined || attr(node, themeAttr) !== undefined) return undefined;
      const value = attr(node, valueAttr);
      return value !== undefined && /^[0-9A-Fa-f]{6}$/u.test(value) ? `#${value.toLowerCase()}` : undefined;
    };

    // 🔴 LA COULEUR DU TEXTE NE SE PREND QUE SUR LE RUN LUI-MÊME, jamais héritée d'un style (Mikolaj, 10/11/2026 :
    // « fais le 2 »). MESURÉ le même jour sur quatre documents réels, avant la décision : en suivant la hiérarchie
    // des styles, `01-Guide-Onboarding-Atria` sortait 15 inlines sur 43 au bleu standard du style « Titre 1 » de Word
    // (#2e74b5), `07-moj-data-sharing-guidance` 315 sur 345 dont un `#000000` explicite sur tout son corps de texte,
    // et `10-lpc-invitation-to-tender` un `#ffffff` sur son titre — du blanc posé sur une bannière que nous ne
    // publions pas, donc du BLANC SUR BLANC : un texte présent et illisible, le pire défaut de ce produit.
    // Une couleur de style dit le look du document ; une couleur posée sur le run dit l'intention de l'auteur sur CE
    // passage, et c'est elle seule que le papier « Silent Cue Loss » mesure.
    // 🔴 LE BLANC EST REFUSÉ, ET C'EST UN BIAIS CHOISI. Un auteur qui écrit en blanc le pose sur une bannière ou une
    // cellule colorée ; cette bannière, nous ne la publions pas. Publier le blanc donnerait donc du BLANC SUR BLANC :
    // un texte présent et illisible, soit un mot perdu — la priorité numéro un de Mikolaj. Mesuré le 10/11/2026 :
    // `01-Guide-Onboarding-Atria` en a 5 (des en-têtes de tableau), `10-lpc-invitation-to-tender` son titre entier.
    // Laid et visible plutôt que faux et invisible. CE QUE CE REFUS NE VOIT PAS, écrit pour que personne n'en attende
    // trop : un gris très clair passe encore. Aucun seuil de luminance n'est posé ici — ce serait une règle inventée,
    // et aucune population ne l'a mesurée.
    const stated = statedHex(rPr ? child(rPr, "w:color") : undefined, "w:val", "w:themeColor");
    const color = stated !== undefined && INVISIBLE_OR_DEFAULT.has(stated) ? undefined : stated;
    // Même raison pour la trame : celle d'un style de tableau habille, elle ne signale pas.
    const shading = statedHex(rPr ? child(rPr, "w:shd") : undefined, "w:fill", "w:themeFill");
    // Le SURLIGNAGE garde la hiérarchie : personne ne surligne par habillage, et un style de caractère « Surligné »
    // reste un geste d'auteur. C'est aussi le plus gros gain mesuré du papier (+0,302 contre +0,262).
    const highlight = nearest("w:highlight");
    const highlightValue = highlight ? attr(highlight, "w:val") : undefined;
    // The highlight wins over the shading when both are stated: it is the mark a reader of the document sees.
    const background = highlightValue !== undefined && highlightValue !== "none" ? highlightValue.toLowerCase() : shading;

    return { ...(color !== undefined ? { color } : {}), ...(background !== undefined ? { background } : {}) };
  };

  const paragraphProperty = (styleId: string | undefined, tag: string): XNode | undefined => {
    for (const def of chain(styleId ?? defaultParagraph)) {
      const found = def.pPr ? child(def.pPr, tag) : undefined;
      if (found) return found;
    }
    return undefined;
  };

  return { role, marks, colours, hidden, paragraphProperty };
};
