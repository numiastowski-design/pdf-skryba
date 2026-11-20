/** The shapes of the PDF objects the reader yields (ISO 32000-1 §7.3), as plain data.
 *  Decides: a null dictionary entry is simply absent from `entries`; a name is the latin1 view of its bytes; a stream
 *  holds the position and length of its data, never a copy.
 *  NOT here: decoding of stream data, resolution of references, any typed view of a dictionary.
 *  Also here: `refKey`, the one text form of an object reference, shared by every caller that names an object.
 *  Called by: `parse.ts` and the later slices of the object reader. */

export type PdfDict = ReadonlyMap<string, PdfValue>;

export interface PdfRef {
  readonly kind: "ref";
  readonly num: number;
  readonly gen: number;
}

/** The text name of an object: `<num>R`, then the generation only when it is not 0. */
export function refKey(ref: { readonly num: number; readonly gen: number }): string {
  return `${ref.num}R${ref.gen > 0 ? ref.gen : ""}`;
}

/** `start` is the offset of the first data byte, `length` the byte count (§7.3.8). */
export interface PdfStream {
  readonly kind: "stream";
  readonly dict: PdfDict;
  readonly start: number;
  readonly length: number;
}

export type PdfValue =
  | { readonly kind: "null" }
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "string"; readonly bytes: Uint8Array }
  | { readonly kind: "name"; readonly value: string }
  | { readonly kind: "array"; readonly items: readonly PdfValue[] }
  | { readonly kind: "dict"; readonly entries: PdfDict }
  | PdfRef
  | PdfStream;
