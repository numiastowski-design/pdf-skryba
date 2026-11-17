/** Two facts about the boxes of a slide, before any layout decision: which
 *  picture is the slide's BACKGROUND (it covers the whole slide), and which
 *  item is POSED ON a picture (its centre lies in the box of a picture that
 *  is not a background: a digit or a letter placed on a screenshot,
 *  MIKSUDOC « Spécification fonctionnelle » §9.3.2). Integer coordinates, y downwards, no
 *  threshold: a background covers the slide exactly or more, a centre lies in
 *  a box or not.
 *  NOT here: where a box comes from (`extractor/pptx-reader/geometry.ts`),
 *  what the layout does with these facts — flow, table or diagram (step 6 of
 *  the slide-drawing step of the pptx reader lot, 25/09/2026) —, nor the PDF's own background test
 *  (`extractor/pdf-image-anchors.ts#figureLabelTest`), which looks at the
 *  text inside the picture instead.
 *  Called by: `layout/slide-layout.ts`, and `extractor/pptx-reader/` for the
 *  `Box` type. */

import { holdsRect, RECT_RULES, rawFromBox } from "doc-ir/layout/rect-rules";

/** An axis-aligned box: left, top, width, height, in integer units (EMU for a
 *  slide). */
export interface Box {
  x: number;
  y: number;
  cx: number;
  cy: number;
}

/** A width and a height, in the unit of the boxes. */
export interface Size {
  cx: number;
  cy: number;
}

/** A picture is the slide's background when its box covers the whole slide:
 *  every edge on or beyond the slide's. No tolerance: no picture of the USA
 *  and IT decks covers even half its slide (`pptx-reader.test.ts`, step 5),
 *  so no real background shows what a producer writes, and one EMU short is
 *  no background. A photo under half the slide is no background either
 *  (MIKSUDOC « Spécification fonctionnelle » §9.3.7). */
export const coversSlide = (box: Box, slide: Size): boolean =>
  box.x <= 0 && box.y <= 0 && box.x + box.cx >= slide.cx && box.y + box.cy >= slide.cy;

/** The centre of `inner` lies in `outer`, edges included. Compared at twice
 *  the scale, so a half-unit centre stays an integer. */
export const centreInside = (inner: Box, outer: Box): boolean =>
  holdsRect(RECT_RULES["centre-in-box"], rawFromBox(outer), rawFromBox(inner));

/** One item of a slide as these facts see it: its box (absent when unknown)
 *  and whether it is a picture. */
export interface SlideItem {
  box?: Box;
  picture: boolean;
}

/** For each item, in the order given: `background` when it is a picture
 *  covering the whole slide; `posedOnPicture` when its centre lies in the box
 *  of ANOTHER picture that is no background. An item without a box is
 *  neither. */
export const slideItemFlags = (
  items: readonly SlideItem[],
  slide: Size,
): { background: boolean; posedOnPicture: boolean }[] => {
  const background = items.map((item) => item.picture && item.box !== undefined && coversSlide(item.box, slide));
  return items.map((item, i) => {
    const box = item.box;
    return {
      background: background[i]!,
      posedOnPicture:
        box !== undefined &&
        items.some(
          (other, j) =>
            j !== i && other.picture && !background[j] && other.box !== undefined && centreInside(box, other.box),
        ),
    };
  });
};
