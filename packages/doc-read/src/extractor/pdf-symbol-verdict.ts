/** The "Symbol font" verdict of a page's font, read from the font DICTIONARY (`/BaseFont`), and not from
 *  the object pdf.js exposed (historical) — whose `name` field was always empty (measured on 31/10/2026: 0 fonts out of 633).
 *  Decides: that a font is Symbol when its `/BaseFont` says so (subset and style included), and nothing else.
 *  The verdict is a pure function of the dictionary: it reads no font program.
 *  NOT here: the translation of private-use points (`lib/symbol-font.ts`), the name bridge (`./pdf-font-bridge.ts`), the
 *  font objects (`./pdf-font-objects.ts`), and the boundary that chooses (`./pdf-source.ts`).
 *  Called by: `extractor/pdf-source.ts`, `pdf-symbol-verdict.test.ts`. */

import { isSymbolFont } from "doc-ir/lib/symbol-font";
import type { OurFontObject } from "./pdf-font-objects";

export type { OurFontObject };

/** True when our dictionary says the font is the Symbol font. A font without `/BaseFont` is not
 *  Symbol: it is ignorance, and so nothing is translated from it. */
export function symbolVerdictOf(font: OurFontObject | undefined): boolean {
  return isSymbolFont(font?.name);
}
