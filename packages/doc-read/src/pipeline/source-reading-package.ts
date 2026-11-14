/** How the three OOXML second readings (`source-reading-{docx,pptx,xlsx}.ts`)
 *  open their parts: through the extractor's own BOUNDED bytes layer
 *  (`extractor/ooxml/package.ts#openPackage`) — each part inflated as a
 *  stream counted chunk by chunk against `PART_MAX_BYTES`/`PACKAGE_MAX_BYTES`,
 *  then parsed by the shared hardened parser (depth ceiling, entity limits,
 *  DTD refused). Every refusal throws; each caller turns a throw into an
 *  abstention (`readFailed`), never a reason not to publish. Tags come back
 *  canonicalised by namespace URI (`w:`, `a:`, `p:`, `rel:`; the EMPTY prefix
 *  for spreadsheetml).
 *  NOT here: what any part MEANS — every reading rule stays its own
 *  reading's, so an extractor bug cannot pass its own check (only the
 *  bytes-and-parse layer is shared, `core/import-boundaries.test.ts` allows
 *  exactly `ooxml/package`).
 *  Also holds the node accessors (`tagOf`, `kidsOf`, `attrOf`, `first`, `textOf`) and `pushAll`, the spread-free way to append a list of unbounded
 *  length (a spread into call arguments throws a RangeError past ~100 000).
 *  Called by: `source-reading-docx.ts`, `source-reading-pptx.ts`,
 *  `source-reading-xlsx.ts`. */

import { ReaderError } from "doc-ir/lib/reader-error";
import { openPackage, orDamaged } from "../extractor/ooxml/package";

/** One node of the `preserveOrder` tree: `{ [tag]: children, ":@": attributes }`. */
export type SourceNode = Record<string, unknown>;

/** Node accessors over the `preserveOrder` tree: pure shape readers, no reading rule (each reading's rules stay its own). */
export type N = SourceNode;
export const tagOf = (n: N): string => Object.keys(n).find((k) => k !== ":@") ?? "";
export const kidsOf = (n: N): N[] => {
  const v = n[tagOf(n)];
  return Array.isArray(v) ? (v as N[]) : [];
};
export const attrOf = (n: N, name: string): string | undefined => (n[":@"] as Record<string, string> | undefined)?.[name];
export const first = (n: N | undefined, tag: string): N | undefined => (n ? kidsOf(n).find((c) => tagOf(c) === tag) : undefined);
export const textOf = (n: N): string => kidsOf(n).map((c) => (typeof c["#text"] === "string" ? c["#text"] : "")).join("");

export const openSourceParts = async (bytes: Uint8Array): Promise<{ xmlOf: (path: string) => Promise<SourceNode | undefined> }> => {
  const pkg = await openPackage(bytes);
  return { xmlOf: async (path) => (await pkg.readXml(path)) as SourceNode | undefined };
};

/** A STYLES part read tolerantly: unreadable (corrupt stream, XML that does not parse) comes back as absent, as the extractors
 *  publish such a file with default formatting (08/10/2026) and this check must not abstain on a document that is published. */
export const stylesOrAbsent = (read: () => Promise<SourceNode | undefined>): Promise<SourceNode | undefined> => orDamaged(read);

/** Runs a read that ONLY the structure control makes (never the words): when the part is refused (damaged, over a ceiling: a `ReaderError`, which covers
 *  `PartDamagedError` and the inflation ceilings) the structure is `unreadable` and the document's words stay checked as they were; a defect of our own
 *  code is no `ReaderError` and is thrown through. Limit: the package's cumulative inflation budget (`PACKAGE_MAX_BYTES`) is shared with the words: a
 *  structure-only part read BEFORE a word part can use up what the word part needed, so these reads come after the words wherever the walk allows. */
export const structureOnly = async <T>(read: () => Promise<T>): Promise<{ value: T } | { unreadable: true }> => {
  try {
    return { value: await read() };
  } catch (e) {
    if (!(e instanceof ReaderError)) throw e;
    return { unreadable: true };
  }
};

/** `target.push(...items)` without the spread. */
export const pushAll = <T>(target: T[], items: readonly T[]): void => {
  for (const item of items) target.push(item);
};
