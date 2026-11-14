/** THE ONE TABLE OF WHAT WE KNOWINGLY DO NOT RENDER, and what the page gets in its place (Mikolaj, 29/10/2026: « il faut
 *  pouvoir dire : ce truc on sait qu'on peut pas le gérer, donc espace » — « une table et basta »).
 *  Decides: for each such element, whether its neighbours keep a WORD BOUNDARY, and what the page gets in its place.
 *  NOT here: the notice a reader raises for an omission (`core/fidelity.ts#NOTICE_IS_OMISSION`), the limits of each reader
 *  (its own header), and HOW each one is recognised in its format (the readers).
 *  WHY IT EXISTS: a part we drop on purpose can SOLDER the two words around it, and nothing says so. Measured on
 *  `fixtures/docx-reel/12-normene-maths-tle-pro.docx` (public, issue #60): an equation between « vecteurs » and « et » gave
 *  « vecteursu » and « uet ». The letters were all published; the WORDS were gone, so Confluence search — the product's
 *  compass — could not find them.
 *  A `Record` over every kind, like `NOTICE_IS_OMISSION`: a new kind does not compile until someone decides its line.
 *  WHAT CONFLUENCE ITSELF CANNOT HOLD bounds what is worth rendering at all — an element the storage format has no native
 *  shape for (maths: no native block, the LaTeX macro is a Marketplace app) is excluded for good, where one we merely fail
 *  to READ is a possible chantier. That difference belongs on each line, in its `why`. A table of what their .docx IMPORTER
 *  loses was tried on 29/10/2026 and thrown away the same day (Mikolaj: « vire les docs, ils vont nous polluer »): their
 *  importer is a lossy converter, not the format's ceiling, and a line nobody measured would have been read as a fact.
 *  Lines enter here ONE AT A TIME, when we meet the case, with the measurement that decided them.
 *  Called by: `./docx-reader/body.ts`, `./skipped-elements.test.ts`. */

/** What the reader meets and knows it cannot draw as the source draws it. */
export type SkippedElement =
  /** An OMML equation (`m:oMath`, `m:oMathPara`): we publish its characters, never its mathematical layout. */
  | "equation";

/** `boundary`: does the page keep a word boundary on each side of it?
 *  - `true`  — proved by a test of this repository.
 *  - `false` — decided, and the two neighbours may touch: say WHY on the line.
 *  - `"unmeasured"` — nobody has looked. It is not a verdict, it is a hole, and it is here to be seen. */
export interface SkipRule {
  /** What the page gets in its place. */
  publishes: "its text" | "nothing";
  boundary: boolean | "unmeasured";
  /** One sentence: the decision, and its date when it was taken by hand. */
  why: string;
}

export const SKIPPED_ELEMENTS: Readonly<Record<SkippedElement, SkipRule>> = {
  equation: {
    publishes: "its text",
    boundary: true,
    why: "29/10/2026: its layout is beyond us and Confluence has no native maths, so only the characters go out — framed by a boundary, or « vecteurs » and « u » come back glued as one word nobody can search.",
  },
};

/** The text of a skipped element, framed as its line says. The caller passes what it could read and says on WHICH SIDES it
 *  has a neighbour to be separated from.
 *  Two cases take nothing, and both are measured by tests of this repository: a side with no neighbour (an equation alone in
 *  its paragraph must not gain a space it never had), and a side that already ends on a blank (a source that spaces its own
 *  equation stays untouched). A boundary is a separation between two things, never a decoration. */
export function framedSkippedText(kind: SkippedElement, text: string, sides: { left: boolean; right: boolean }): string {
  const rule = SKIPPED_ELEMENTS[kind];
  if (rule.boundary !== true) return text;
  // AN ELEMENT WHOSE TEXT WE READ AS EMPTY STILL LEAVES ITS BOUNDARY — one, not two (measured 29/10/2026 on the document of
  // issue #60: an equation holding nothing but a space joined « népérien » to « sont »; the element is dropped whole, and
  // the separation goes with it). Skipping a thing is not the same as it never having been there.
  if (text === "") return sides.left || sides.right ? " " : "";
  const left = sides.left && !/^\s/.test(text) ? " " : "";
  const right = sides.right && !/\s$/.test(text) ? " " : "";
  return `${left}${text}${right}`;
}
