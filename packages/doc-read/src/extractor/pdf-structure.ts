/** THE STRUCTURE TREE of a page (ISO 32000-1:2008 §14.7, §14.8.4.3), read from OUR dictionary: the declared order of
 *  the page's marked contents, and the contents under a `/Note` element (a footnote).
 *  Decides: that the page has a declared order (`declaredOrder`, undefined when there is nothing to walk), and which
 *  content identifiers are notes. The identifiers keep pdf.js's form: `p<num>R<gen>_mc<n>`.
 *  Rules of pdf.js (removed), measured (`fixtures/pdf/37-…`: `/ParentTree` absent ⇒ nothing to walk; a page without
 *  `/StructParents` ⇒ nothing): these are conditions of OUR reading, not pdf.js conventions.
 *  NOT here: the role of an element beyond `Note` (`./pdf-reading-order.ts`), the geometry of the notes.
 *  Called by: `extractor/pdf-source.ts`, `pdf-structure.test.ts`. */

import type { PdfObjectsDocument, PdfPageEntry } from "./pdf-objects/document";
import { refKey, type PdfDict, type PdfValue } from "./pdf-objects/objects";

/** The declared order of a page and its notes, as the product used to read them from pdf.js and now reads them from our dictionary. */
export interface DeclaredStructure {
  /** The page's content identifiers, in tree order (depth-first walk). */
  readonly declaredOrder: readonly string[];
  /** The content identifiers under a `/Note` element, at any depth. */
  readonly noteIds: ReadonlySet<string>;
}

const nameOf = (value: PdfValue | undefined): string | undefined => (value?.kind === "name" ? value.value : undefined);

/** The page's identifier prefix: `p` then the `refKey` of its object. */
const pageToken = (page: PdfPageEntry): string => `p${refKey(page.ref)}`;

/** What the structure declares for this page, or `undefined` when there is nothing to walk. A page without
 *  `/StructParents`, a document with neither `/StructTreeRoot` nor `/ParentTree`: pdf.js walked nothing either. */
export function declaredStructureOf(doc: PdfObjectsDocument, page: PdfPageEntry): DeclaredStructure | undefined {
  if (page.dict.get("StructParents") === undefined) return undefined;
  let all = STRUCTURES.get(doc);
  if (all === undefined) {
    all = walkStructureTree(doc);
    STRUCTURES.set(doc, all);
  }
  if (all === null) return undefined;
  return all.get(pageToken(page)) ?? NOTHING_DECLARED;
}

/** The structure of every page, walked once per document (it was walked once PER PAGE, pages × elements visits: 9 million for 300 pages and
 *  30 000 elements, performance review of 02/11/2026). `null`: nothing to walk. A page absent from the map has no content declared. */
const STRUCTURES = new WeakMap<PdfObjectsDocument, ReadonlyMap<string, DeclaredStructure> | null>();
const NOTHING_DECLARED: DeclaredStructure = { declaredOrder: [], noteIds: new Set() };

function walkStructureTree(doc: PdfObjectsDocument): ReadonlyMap<string, DeclaredStructure> | null {
  const catalog = doc.dictOf(doc.trailer().get("Root"));
  const root = doc.dictOf(catalog?.get("StructTreeRoot"));
  if (root === undefined || doc.dictOf(root.get("ParentTree")) === undefined) return null;

  const byPage = new Map<string, { declaredOrder: string[]; noteIds: Set<string> }>();
  // An element's role goes through `/RoleMap` (§14.7.3) down to a standard type: `Footnote` becomes `Note`. pdf.js did
  // the same, and a `Note` element is recognised only once translated. Ten steps at most: a cyclic table does not loop.
  const roleMap = doc.dictOf(root.get("RoleMap"));
  const roleOf = (name: string | undefined): string | undefined => {
    let current = name;
    for (let step = 0; step < 10 && current !== undefined; step += 1) {
      const next = nameOf(doc.resolve(roleMap?.get(current)));
      if (next === undefined || next === current) break;
      current = next;
    }
    return current;
  };
  // An element is visited once: a cyclic structure must not loop forever.
  const seen = new Set<PdfDict>();
  // So is every OBJECT reached by reference, array or dictionary: an array that lists the next array twice would double
  // the walk at each level (2^64 at the depth cap) from a few hundred bytes (security review of 02/11/2026).
  const seenRefs = new Set<string>();

  // A child with no `/Pg` inherits its parent's: the page of a content is that of its nearest `/Pg`.
  const visit = (node: PdfValue | undefined, inheritedPage: string | undefined, inNote: boolean, depth: number): void => {
    if (depth > 64) return;
    if (node?.kind === "ref") {
      const key = refKey(node);
      if (seenRefs.has(key)) return;
      seenRefs.add(key);
    }
    const resolved = doc.resolve(node);
    if (resolved === undefined) return;
    if (resolved.kind === "number") {
      if (inheritedPage !== undefined) pushContent(inheritedPage, resolved.value, inNote);
      return;
    }
    if (resolved.kind === "array") {
      for (const item of resolved.items) visit(item, inheritedPage, inNote, depth + 1);
      return;
    }
    const dict = structDictOf(resolved);
    if (dict === undefined || seen.has(dict)) return;
    seen.add(dict);
    visitElement(dict, inheritedPage, inNote, depth);
  };

  const visitElement = (dict: PdfDict, inheritedPage: string | undefined, inNote: boolean, depth: number): void => {
    const type = nameOf(doc.resolve(dict.get("Type")));
    // A marked-content reference (MCR) carries its identifier and, maybe, its page.
    if (type === "MCR") {
      const pg = pageOf(doc, dict) ?? inheritedPage;
      const mcid = doc.resolve(dict.get("MCID"));
      if (pg !== undefined && mcid?.kind === "number") pushContent(pg, mcid.value, inNote);
      return;
    }
    // An object reference (OBJR) is not text content: an annotation. It is not read.
    if (type === "OBJR") return;
    const role = roleOf(nameOf(doc.resolve(dict.get("S"))));
    const here = inNote || role === "Note";
    const pg = pageOf(doc, dict) ?? inheritedPage;
    visit(dict.get("K"), pg, here, depth + 1);
  };

  const pushContent = (token: string, mcid: number, inNote: boolean): void => {
    const id = `${token}_mc${mcid}`;
    const page = byPage.get(token) ?? { declaredOrder: [], noteIds: new Set<string>() };
    byPage.set(token, page);
    page.declaredOrder.push(id);
    if (inNote) page.noteIds.add(id);
  };

  visit(root.get("K"), undefined, false, 0);
  return byPage;
}

/** The dictionary of a structure node, or `undefined` when the node is neither a dictionary nor a stream. */
function structDictOf(value: PdfValue): PdfDict | undefined {
  if (value.kind === "dict") return value.entries;
  if (value.kind === "stream") return value.dict;
  return undefined;
}

/** The page of an element or a marking, by its `/Pg`, in the form `pageToken` uses. */
function pageOf(doc: PdfObjectsDocument, dict: PdfDict): string | undefined {
  const pg = dict.get("Pg");
  if (pg?.kind !== "ref") return undefined;
  return `p${refKey(pg)}`;
}
