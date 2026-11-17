/** Every picture reference of a block tree rewritten in place of its owner: the ONE walk of the block kinds that carry
 *  an `image` block, shared by the embedded pictures' resolution and by a drawing's.
 *  Decides: a `patch` that answers `undefined` drops the image block. A carrier this walk does not reach keeps its
 *  refs untouched, and `docx-reader/index.ts#assertNoPendingRef` then refuses a pending one.
 *  NOT here: what a ref stands for (`docx-reader/index.ts`).
 *  Called by: `docx-reader/index.ts`. */

import type { ImageRef, IRBlock } from "doc-ir/lib/ir";
import { mapBlockChildren } from "doc-ir/lib/ir-walk";

export const mapImageRefs = (blocks: IRBlock[], patch: (ref: ImageRef) => ImageRef | undefined): IRBlock[] =>
  blocks.flatMap((block): IRBlock[] => {
    const mapped = mapOne(block, patch);
    return mapped === undefined ? [] : [mapped];
  });

/** `patch` returning `undefined` drops the image block (a picture whose part is damaged). */
const mapOne = (block: IRBlock, patch: (ref: ImageRef) => ImageRef | undefined): IRBlock | undefined => {
  if (block.kind === "image") {
    const ref = patch(block.ref);
    return ref === undefined ? undefined : { ...block, ref };
  }
  return mapBlockChildren(block, (children) => mapImageRefs(children, patch));
};
