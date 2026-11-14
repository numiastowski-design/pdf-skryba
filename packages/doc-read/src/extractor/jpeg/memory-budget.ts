/** The memory a JPEG decode may allocate, counted on what is actually
 *  allocated, never on a size a header declares: every buffer proportional
 *  to the image is taken through here, and the one that would pass the guard
 *  is refused BEFORE it exists.
 *  NOT here: the guard's value (the callers' `JPEG_MAX_MEMORY_MB`,
 *  `extractor/image-reduction.ts`), what the buffers hold.
 *  Called by: `jpeg/decode.ts`, `jpeg/sequential-scan.ts`, `jpeg/idct.ts`, `jpeg/sequential-scan.test.ts`. */

import { refuse } from "./markers";

export class MemoryBudget {
  readonly maxBytes: number;
  #spent = 0;

  constructor(maxBytes: number) {
    // A caller's bug, not the stream's: NaN would compare false, i.e. no guard at all.
    if (!Number.isFinite(maxBytes) || maxBytes < 0) throw new Error("MemoryBudget: maxBytes must be a finite number >= 0");
    this.maxBytes = maxBytes;
  }

  /** Bytes allocated so far through this budget. */
  get spent(): number {
    return this.#spent;
  }

  #charge(bytes: number): void {
    if (this.#spent + bytes > this.maxBytes) throw refuse("image over the memory guard");
    this.#spent += bytes;
  }

  int32(length: number): Int32Array {
    this.#charge(length * 4);
    return new Int32Array(length);
  }

  uint8(length: number): Uint8Array {
    this.#charge(length);
    return new Uint8Array(length);
  }
}
