/** THE THREE SHAPES OF A CONSERVATION SOURCE, for a caller that takes any of them: what a declared format's second
 *  reading produces, what the PDF reader produces, and the named read failure.
 *
 *  WHY ITS OWN FILE. A union belongs to none of its members. Named in the declared formats' file
 *  (`conservation-source.ts`), it sent the PDF reader's declaration out with the `docs-scribe` package; named in the
 *  PDF's, it would pull the OOXML types into `skryba`. Either way the two published packages lost their boundary.
 *  Found on 09/11/2026 by the package guard, on the built artefact, the day the second package was born.
 *
 *  Decides: nothing — one type, read by the only two generic callers there are.
 *  NOT here: the shapes themselves (`conservation-source.ts` for the declared formats, `pdf-conservation-source.ts`
 *  for the PDF), nor what anyone does with them (`pipeline/declared-format-conservation.ts`, `conservation/`).
 *  Called by: `extractor/dispatch.ts` (what a format's reading hands back) and
 *  `conservation/publish-conservation.ts` (the control of a published page). */

import type { ConservationSourceReadFailure, DeclaredFormatConservationSource } from "./conservation-source";
import type { PdfConservationSource } from "./pdf-conservation-source";

export type ConservationSource = PdfConservationSource | DeclaredFormatConservationSource | ConservationSourceReadFailure;
