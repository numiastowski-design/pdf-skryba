/** Numeric OOXML attribute values: a finite number, or `undefined`.
 *  NOT here: the bounded integer of `pptx-reader/geometry.ts#integer` (it also refuses a blank value), nor any unit conversion.
 *  Called by: `docx-reader/body.ts`, `numbering.ts`, `objects.ts`, `shapes.ts`. */

/** A written number (`Number`): `undefined` when absent, blank or not finite (`Number("")` is 0, a number nobody wrote). */
export const finiteNumber = (raw: string | undefined): number | undefined => {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
};

/** A written integer (`parseInt`, leading digits only): `undefined` when absent or not a number. */
export const intAttr = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
};
