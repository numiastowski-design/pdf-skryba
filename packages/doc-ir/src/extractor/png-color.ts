/** The PNG colour types this code reads and writes (8 bits per channel), with their channel counts: grey, grey + alpha,
 *  RGB, RGB + alpha. Palette (type 3) and 16 bits are not here: the decoder refuses them and the encoder has none.
 *  NOT here: the byte stream itself (`extractor/png.ts`, `extractor/png-decode.ts`).
 *  Called by: `extractor/png.ts`, `extractor/png-decode.ts`, `extractor/image-reduction.ts`. */

export type PngChannels = 1 | 2 | 3 | 4;

const COLOR_TYPES: readonly { readonly type: number; readonly channels: PngChannels; readonly alpha: boolean }[] = [
  { type: 0, channels: 1, alpha: false },
  { type: 4, channels: 2, alpha: true },
  { type: 2, channels: 3, alpha: false },
  { type: 6, channels: 4, alpha: true },
];

/** The channel count of a colour type, or `undefined` for one this code does not handle. */
export const channelsOfColorType = (type: number): PngChannels | undefined =>
  COLOR_TYPES.find((c) => c.type === type)?.channels;

/** The colour type of a channel count. */
export const colorTypeOfChannels = (channels: PngChannels): number =>
  COLOR_TYPES.find((c) => c.channels === channels)!.type;

/** The last channel is an alpha channel (grey + alpha, RGB + alpha). */
export const hasAlphaChannel = (channels: PngChannels): boolean =>
  COLOR_TYPES.find((c) => c.channels === channels)!.alpha;
