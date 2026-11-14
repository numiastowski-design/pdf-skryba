/** The labels the readers write INTO the document they read: a presentation's tab (« Slide N » / « Diapositive N »), a PDF's tab
 *  (« Page N »), a Word note call (« [N] »), in the page language (`PageLanguage`, French or English) — or IN THE CALLER'S OWN
 *  WORDS: `resolveLabels` lets whoever calls the reading replace any of the three, in a language we do not carry (étape 8 de
 *  docs/PLAN-BIBLIOTHEQUE.md; the app gives none, so its pages do not move). They are IR text the reader
 *  composes (`extractor/pptx.ts`, `extractor/pdf-page-tabs.ts`, `extractor/docx-reader/body.ts`) and the second reading
 *  composes again (`pipeline/source-reading-pptx.ts`), so the library owns them; the renderer writes the same strings through
 *  `core/page-messages.ts`, which builds its tables FROM these, so the page and the check can never drift apart.
 *  Decides: our two tables, and that a caller's override is taken FIELD BY FIELD (what it did not give stays in the page language).
 *  NOT here: the labels only the app writes onto a page (the native tabs node title, the chart axis line: `core/page-messages.ts`),
 *  the choice of the page language (`core/page-messages.ts#pageLanguageFor`, the app's), the dashboard's texts, nor a document's
 *  per-occurrence facts (`lib/reader-types.ts#DocumentNotice`). A LEAF module: its one import is a type.
 *  Called by: `extractor/pptx.ts`, `extractor/pdf-page-tabs.ts`, `extractor/docx-reader/body.ts`, `pipeline/source-reading-pptx.ts`;
 *  `core/page-messages.ts` (the app's tables extend these). */

import type { PageLanguage } from "./reader-types";

/** The labels of one language. `noteCallLabel` carries digits only but sits in both tables: the inventory of page labels stays complete. */
export interface PageLabels {
  /** A presentation's tab and conservation-unit label. */
  slideTabTitle: (number: number) => string;
  /** A PDF's tab label: the rank of the tab among the published tabs (not the printed folio). */
  pdfPageTabTitle: (number: number) => string;
  /** Note-call superscript, digits only (A6 of
   *  docs/CONCEPTION-CARTE-ET-REMARQUES.md, 29/09/2026: kept, WITH its
   *  brackets). */
  noteCallLabel: (n: number) => string;
}

const noteCallLabelOf: PageLabels["noteCallLabel"] = (n) => `[${n}]`;

const EN: PageLabels = {
  slideTabTitle: (number) => `Slide ${number}`,
  pdfPageTabTitle: (number) => `Page ${number}`,
  noteCallLabel: noteCallLabelOf,
};

const FR: PageLabels = {
  slideTabTitle: (number) => `Diapositive ${number}`,
  pdfPageTabTitle: (number) => `Page ${number}`,
  noteCallLabel: noteCallLabelOf,
};

export const pageLabels = (language: PageLanguage): PageLabels => (language === "fr" ? FR : EN);

/** What a CALLER of the library may give instead of our words: any subset of the labels, so a third party writes « Folie N » or
 *  « (1) » in a language we do not carry, and keeps our table for the rest. The app gives none — its pages stay as they are. */
export type PageLabelOverride = Partial<PageLabels>;

/** The labels one reading writes, the caller's where it gave any, ours in the page language elsewhere (`PLAN-BIBLIOTHEQUE.md` step 8).
 *  Field by field on purpose: a label added to `PageLabels` fails to compile HERE instead of silently staying ours. */
export const resolveLabels = (language: PageLanguage, override?: PageLabelOverride): PageLabels => {
  if (override === undefined) return pageLabels(language);
  const ours = pageLabels(language);
  return {
    slideTabTitle: override.slideTabTitle ?? ours.slideTabTitle,
    pdfPageTabTitle: override.pdfPageTabTitle ?? ours.pdfPageTabTitle,
    noteCallLabel: override.noteCallLabel ?? ours.noteCallLabel,
  };
};

/** Note-call label, language-free (digits and brackets: both tables agree, `core/page-messages.test.ts`) — so `docx-reader/body.ts` needs no language. */
export const noteCallLabel = (n: number): string => EN.noteCallLabel(n);
