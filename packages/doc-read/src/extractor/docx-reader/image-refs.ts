/** Every picture reference of a block tree rewritten in place of its owner:
 *  the ONE walk of the block kinds that carry an `image` block, shared by the
 *  embedded pictures' resolution and by a drawing's (`docx-reader/index.ts`).
 *  A carrier not listed here keeps its refs untouched — and
 *  `docx-reader/index.ts#assertNoPendingRef` then refuses a pending one.
 *  NOT here: what a ref stands for (`docx-reader/index.ts`).
 *  Called by: `docx-reader/index.ts`. */

import type { ImageRef, IRBlock } from "doc-ir/lib/ir";
import { mapBlockChildren } from "doc-ir/lib/ir-walk";

export const mapImageRefs = (blocks: IRBlock[], patch: (ref: ImageRef) => ImageRef | undefined): IRBlock[] =>
  blocks.flatMap((b): IRBlock[] => [mapOne(b, patch)].filter((x): x is IRBlock => x !== undefined));

/** `patch` returning `undefined` drops the image block (a picture whose part is damaged). */
const mapOne = (b: IRBlock, patch: (ref: ImageRef) => ImageRef | undefined): IRBlock | undefined => {
  if (b.kind === "image") {
    const ref = patch(b.ref);
    return ref === undefined ? undefined : { ...b, ref };
  }
  return mapBlockChildren(b, (list) => mapImageRefs(list, patch));
};
