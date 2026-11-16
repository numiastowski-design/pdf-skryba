/**
 * OOXML boolean attributes. Two families, both legitimate: xsd:boolean
 * (PresentationML, SpreadsheetML: "1" | "true") and ST_OnOff (WordprocessingML,
 * ECMA-376 Part 1 §17.17.4: "1" | "true" | "on").
 * NOT here: the independent second readings in `pipeline/source-reading-*.ts`, which keep their own copies on purpose.
 * Called by: the docx readers (`styles.ts`, `objects.ts`, `numbering.ts`), the pptx readers (`text.ts`, `geometry.ts`,
 * `shapes.ts`, `index.ts`) and `xlsx-cells.ts`.
 */

/** xsd:boolean true. Absent or anything else is false. */
export const isXsdTrue = (value: string | undefined): boolean => value === "1" || value === "true";

/** xsd:boolean false, written out ("0" | "false"); absent is neither true nor false. */
export const isXsdFalse = (value: string | undefined): boolean => value === "0" || value === "false";

/** ST_OnOff on. `whenAbsent` is the meaning of a missing attribute, which differs per property. */
export const isOnOff = (value: string | undefined, whenAbsent: boolean): boolean =>
  value === undefined ? whenAbsent : value === "1" || value === "true" || value === "on";

/** The « hidden » attribute of a drawing or shape (`wp:docPr`, `p:cNvPr`), read tolerantly: blanks and case ignored, "1" or "true".
 *  Only this flag is tolerant (12/10/2026); every other boolean stays at the norm above. */
export const isHiddenFlag = (value: string | undefined): boolean => {
  const v = value?.trim().toLowerCase();
  return v === "1" || v === "true";
};
