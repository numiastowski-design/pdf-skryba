/** What the small BITMAP markers of ONE page attach to: a character-sized picture the document puts in front of a label
 *  (the badges of a bulletin's legend). They are the document's own pixels, copied as they are.
 *  NOT here: reading those pictures off the page (`extractor/pdf-table-detector.ts`).
 *  NO COLOUR DISC IS PUBLISHED (07/10/2026): a word on a coloured disc or panel is plain text like any other.
 *  Colour carries nothing for Confluence search or Rovo, and the removed mechanism turned 58 words of a panel into pictures
 *  whose text lived only in the alt attribute (not searchable). Its code, its SVG renderer and their tests are deleted.
 *  Called by: `extractor/pdf.ts`. */

import type { ImageRef } from "doc-ir/lib/ir";
import { lineMiddle } from "doc-ir/layout/grid-band";
import type { ImageStore } from "./pdf-image-store";
import type { PositionedItem } from "./pdf-model";
import type { PdfTextRun } from "./pdf-source";
import type { InlineImage } from "./pdf-table-detector";

/** The MIME type of the pictures taken as they are from the document. */
const PNG_MIME = "image/png";

/** What a page hands to the layout stages: the marker predicate. */
export interface PageMarkers {
  markerBefore: (item: PositionedItem) => ImageRef | undefined;
}

export const pageMarkers = (
  store: ImageStore,
  page: {
    items: readonly PdfTextRun[];
    /** The character-sized pictures, already encoded. */
    inlineImages: readonly InlineImage[];
  },
): PageMarkers => {
  const { items: pageItems, inlineImages } = page;
  // A marker is placed in front of the FIRST item to its right on the same baseline. No distance, no tolerance: "first to
  // the right" is unambiguous, and a nearer item cannot exist by construction. Measured on the bulletin: the badge of
  // « Absent » ends at 322.4 and its label starts at 323.4. When no item follows on the line, the marker is not placed.
  const markerBefore = (item: PositionedItem): ImageRef | undefined => {
    if (inlineImages.length === 0 || item.text.trim().length === 0) return undefined;
    const cy = lineMiddle(item);
    const marker = inlineImages.find((d) => {
      if (cy < d.yMin || cy > d.yMax || item.x < d.xMax) return false;
      return !pageItems.some(
        (other) =>
          other.text.trim().length > 0 &&
          other.x < item.x &&
          other.x >= d.xMax &&
          lineMiddle(other) >= d.yMin &&
          lineMiddle(other) <= d.yMax,
      );
    });
    return marker === undefined ? undefined : store.collect(marker.png, PNG_MIME);
  };

  return { markerBefore };
};
