/** The one « fold the blanks and trim » of the app: every run of whitespace (a non-breaking space included) becomes one
 *  space, then the ends are trimmed.
 *  NOT here: a fold that keeps line breaks apart (`extractor/pdf-scanned.ts`) nor the page-furniture key (`layout/page-furniture.ts`).
 *  Called by: the docx, pptx and SmartArt readers, `pipeline/cut-paragraph-repair.ts`, `extractor/pdf-letter-spacing.ts`, `extractor/pdf-facts.ts`. */
export const collapseBlanks = (text: string): string => text.replace(/\s+/g, " ").trim();
