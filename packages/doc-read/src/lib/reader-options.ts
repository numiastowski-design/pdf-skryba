/** What a CALLER may set on a reading, in one place (revue du 30/10/2026 : la porte `extractor/dispatch.ts` et le lecteur
 *  `extractor/pdf-scanned.ts` en portaient chacun une copie, champ pour champ — deux copies d'une option finissent par ne
 *  plus avoir les mêmes champs, et c'est le lecteur qui perd celui qu'on vient d'ajouter).
 *  Decides: rien. C'est une forme, et chaque champ y est facultatif : l'app en donne certains, la bibliothèque tous ou aucun.
 *  NOT here: ce que chaque champ veut dire (`lib/reader-limits.ts#ReaderLimits`, `lib/page-labels.ts#PageLabelOverride`), ni
 *  ce qu'une lecture en fait (`extractor/dispatch.ts`, les lecteurs).
 *  Called by: `extractor/dispatch.ts` (qui la ré-exporte pour ses appelants) et `extractor/pdf-scanned.ts`. */

import type { PageLabelOverride } from "doc-ir/lib/page-labels";
import type { PageLanguage } from "doc-ir/lib/reader-types";
import type { ReaderLimits } from "doc-ir/lib/reader-limits";

export interface ExtractOptions {
  /** The languages the AI reading may use, when the caller knows them. */
  languages?: string[];
  /** The ONE language the page's labels are written in. */
  pageLanguage?: PageLanguage;
  /** `false` forbids the AI reading of a scan outright. */
  ocr?: boolean;
  /** With `ocr: false`, a PDF every page of which is scanned is returned as page images instead of being refused
   *  (`SCANNED_PDF_NEEDS_AI_OCR`): the caller decides alone whether such a file is acceptable (the manual upload does, by page count). */
  scanAsImages?: boolean;
  /** Read every page, not only the first ones. */
  readAll?: boolean;
  /** The ceilings the caller moves (`lib/reader-limits.ts`). */
  limits?: ReaderLimits;
  /** The caller's own words in place of ours (`lib/page-labels.ts`). */
  labels?: PageLabelOverride;
}
