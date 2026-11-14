// Declarations for the vendored jpeg-js decoder (`jpeg-js-decoder.cjs`), so the TypeScript side is typed.
// The implementation is jpeg-js 0.4.4's decoder (Copyright 2011 notmasteryet, Apache-2.0; the jpeg-js package,
// BSD-3-Clause), with one addition: `decodeRaw`. See packages/reader/THIRD-PARTY.md.

/** The raw components of a JPEG: `numComponents` bytes per pixel, before any colour conversion. */
export interface RawJpeg {
  width: number;
  height: number;
  numComponents: number;
  /** Four components with a colour transform: the data are YCCK, to convert to CMYK with the constants of the conversion pdf.js used (kept, for byte-identical output). */
  ycck: boolean;
  /** Three components: true when a YCbCr -> RGB conversion is due (jpeg-js decides it); the data is then YCbCr. */
  transform: boolean;
  data: Uint8Array;
}

export interface DecodeOptions {
  colorTransform?: boolean;
  /** The size the picture is drawn at: the components are resampled to it (jpeg-js getData). Default: the JPEG's own. */
  width?: number;
  height?: number;
  maxResolutionInMP?: number;
  maxMemoryUsageInMB?: number;
}

declare function decode(jpegData: Uint8Array | Buffer, opts?: DecodeOptions): unknown;
declare namespace decode {
  function decodeRaw(jpegData: Uint8Array | Buffer, opts?: DecodeOptions): RawJpeg;
}
export = decode;
