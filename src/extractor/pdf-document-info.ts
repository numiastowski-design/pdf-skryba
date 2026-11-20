/** The document's FICHE (producer, version, attachments, signatures…), read from OUR dictionary.
 *  Decides: the six values that the product shows on the fiche, and nothing else (no title, author, date).
 *  Source: ISO 32000-1:2008 §7.5.5 (trailer), §7.7.2 (catalog, /Version), §7.11.4 (embedded files tree),
 *  §12.7.2 (/AcroForm form), §12.8 (signatures). Strings go through `./pdf-text-string.ts`.
 *  NOT here: the display (`pdf-facts.ts`), the reading of the pages.
 *  Called by: `extractor/pdf-source.ts`, `pdf-document-info.test.ts`. */

import type { PdfObjectsDocument } from "./pdf-objects/document";
import { refKey, type PdfDict, type PdfValue } from "./pdf-objects/objects";
import { decodePdfTextString } from "./pdf-text-string";

/** What the fiche shows, and what we read. Each field is absent when our reading says nothing about it. */
export interface OurDocumentInfo {
  producer?: string;
  creator?: string;
  pdfVersion?: string;
  linearized?: true;
  form?: true;
  attachedFiles?: number;
  signatures?: number;
}

const nameOf = (value: PdfValue | undefined): string | undefined => (value?.kind === "name" ? value.value : undefined);

/** A text string of a dictionary, decoded, or nothing. */
function textOf(doc: PdfObjectsDocument, dict: PdfDict | undefined, key: string): string | undefined {
  const value = doc.resolve(dict?.get(key));
  return value?.kind === "string" ? decodePdfTextString(value.bytes) : undefined;
}

/** The format version, as pdf.js set it (removed since): the catalog's `/Version` when it has one (§7.7.2), otherwise the header
 *  `%PDF-x.y` (§7.5.2). No comparison: the catalog wins, even if older than the header. */
function formatVersion(doc: PdfObjectsDocument, catalog: PdfDict | undefined, bytes: Uint8Array): string | undefined {
  const declared = nameOf(doc.resolve(catalog?.get("Version")));
  if (declared !== undefined && declared.length > 0) return declared;
  const head = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
  const match = /%PDF-(\d\.\d)/.exec(head);
  return match === null ? undefined : match[1];
}

/** Is the file linearized? TWO things are needed (Annex F): a leading `/Linearized` object, and its `/L` equal to the
 *  real size of the file. An `/L` that no longer matches means the file was modified after
 *  linearization (incremental update): the linearization is then no longer valid. pdf.js made the same
 *  check. Measured on 3 files of the sample: `/Linearized` present, `/L` wrong, pdf.js answered "no". */
function isLinearized(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, 2048)).toString("latin1");
  const start = head.indexOf("/Linearized");
  if (start < 0) return false;
  // The dictionary's keys are not in a fixed order (/L may follow /H): we read /L in the same object.
  const end = head.indexOf("endobj", start);
  const match = /\/L\s+(\d+)/.exec(end < 0 ? head.slice(start) : head.slice(start, end));
  return match !== null && Number(match[1]) === bytes.length;
}

/** Levels of the field tree (`/Kids`, `/Parent`) and of the attachment name tree that are walked. Starting value to calibrate: real
 *  forms and name trees nest a handful of levels; ten was already the rule of `onlyInvisibleSignatures` and `fieldTypeOf`.
 *  🔴 WHY applied to the two other walks too (security review of 02/11/2026): `fieldsOf` and `attachmentCount` had no limit, so a
 *  chain of twelve thousand `/Kids` overflowed the stack with a bare `RangeError` that is not a refusal. Past it, the walk stops:
 *  what lies deeper is not counted. */
const MAX_FORM_TREE_DEPTH = 10;

/** Does the form field carry `/FT /Sig`, inheriting from its parent (§12.7.3.1)? Ten levels at most. */
function fieldTypeOf(doc: PdfObjectsDocument, field: PdfDict): string | undefined {
  let node: PdfDict | undefined = field;
  for (let depth = 0; node !== undefined && depth < MAX_FORM_TREE_DEPTH; depth += 1) {
    const type = nameOf(doc.resolve(node.get("FT")));
    if (type !== undefined) return type;
    node = doc.dictOf(node.get("Parent"));
  }
  return undefined;
}

/** Rule taken from pdf.js's `#hasOnlyDocumentSignatures` (removed since): each field is an INVISIBLE signature (rectangle all zero), and the
 *  fields that have children are examined in turn, ten levels at most. */
function onlyInvisibleSignatures(
  doc: PdfObjectsDocument,
  fields: PdfValue | undefined,
  depth = 0,
  seen = new Set<string>(),
): boolean {
  const list = doc.resolve(fields);
  if (list?.kind !== "array") return false;
  return list.items.every((item) => {
    // A field reached twice was judged the first time: a `false` would already have ended the `every`. Without this, nine
    // levels that each list the next one five times made 5^9 visits (security review of 02/11/2026).
    if (item.kind === "ref") {
      const key = refKey(item);
      if (seen.has(key)) return true;
      seen.add(key);
    }
    const field = doc.dictOf(item);
    if (field === undefined) return false;
    if (field.has("Kids"))
      return depth < MAX_FORM_TREE_DEPTH && onlyInvisibleSignatures(doc, field.get("Kids"), depth + 1, seen);
    const rect = doc.resolve(field.get("Rect"));
    const invisible =
      rect?.kind === "array" &&
      rect.items.every((v) => doc.resolve(v)?.kind === "number" && (doc.resolve(v) as { value: number }).value === 0);
    return fieldTypeOf(doc, field) === "Sig" && invisible;
  });
}

/** Is the form present, in the sense pdf.js had: fields, and not only invisible signatures. */
function hasAcroForm(doc: PdfObjectsDocument, acro: PdfDict | undefined): boolean {
  if (acro === undefined || acro.size === 0) return false;
  const fields = doc.resolve(acro.get("Fields"));
  const hasFields = fields?.kind === "array" && fields.items.length > 0;
  if (!hasFields) return false;
  const sigFlags = doc.resolve(acro.get("SigFlags"));
  const hasSignatures = sigFlags?.kind === "number" && (sigFlags.value & 1) !== 0;
  return !(hasSignatures && onlyInvisibleSignatures(doc, acro.get("Fields")));
}

/** The fields of a form, recursively (§12.7.3.1: /Kids). Each field visited once. */
function fieldsOf(doc: PdfObjectsDocument, acro: PdfDict | undefined): PdfDict[] {
  const out: PdfDict[] = [];
  const seen = new Set<PdfDict>();
  const visit = (list: PdfValue | undefined, depth: number): void => {
    const resolved = doc.resolve(list);
    if (resolved?.kind !== "array") return;
    for (const item of resolved.items) {
      const field = doc.dictOf(item);
      if (field === undefined || seen.has(field)) continue;
      seen.add(field);
      out.push(field);
      if (depth < MAX_FORM_TREE_DEPTH) visit(field.get("Kids"), depth + 1);
    }
  };
  visit(acro?.get("Fields"), 0);
  return out;
}

/** The signatures: `/FT /Sig` fields that carry a `/V` dictionary (§12.8). An empty field is not signed. */
function signatureCount(doc: PdfObjectsDocument, acro: PdfDict | undefined): number {
  return fieldsOf(doc, acro).filter(
    (field) => nameOf(doc.resolve(field.get("FT"))) === "Sig" && doc.dictOf(field.get("V")) !== undefined,
  ).length;
}

/** The attachments: leaves of the /Names /EmbeddedFiles tree (§7.11.4.2), name + specification pairs. */
function attachmentCount(doc: PdfObjectsDocument, names: PdfDict | undefined): number {
  const tree = doc.dictOf(names?.get("EmbeddedFiles"));
  if (tree === undefined) return 0;
  let count = 0;
  const seen = new Set<PdfDict>();
  const visit = (node: PdfDict | undefined, depth: number): void => {
    if (node === undefined || seen.has(node)) return;
    seen.add(node);
    const leaves = doc.resolve(node.get("Names"));
    if (leaves?.kind === "array") count += Math.floor(leaves.items.length / 2);
    const kids = doc.resolve(node.get("Kids"));
    if (kids?.kind === "array" && depth < MAX_FORM_TREE_DEPTH)
      for (const kid of kids.items) visit(doc.dictOf(kid), depth + 1);
  };
  visit(tree, 0);
  return count;
}

/** The document's fiche, as the product shows it. */
export function documentInfoOf(doc: PdfObjectsDocument, bytes?: Uint8Array): OurDocumentInfo {
  const info = doc.dictOf(doc.trailer().get("Info"));
  const catalog = doc.dictOf(doc.trailer().get("Root"));
  const acro = doc.dictOf(catalog?.get("AcroForm"));
  const names = doc.dictOf(catalog?.get("Names"));
  const out: OurDocumentInfo = {};
  const producer = textOf(doc, info, "Producer");
  const creator = textOf(doc, info, "Creator");
  if (producer !== undefined) out.producer = producer;
  if (creator !== undefined) out.creator = creator;
  if (bytes !== undefined) {
    const version = formatVersion(doc, catalog, bytes);
    if (version !== undefined) out.pdfVersion = version;
    if (isLinearized(bytes)) out.linearized = true;
  }
  if (hasAcroForm(doc, acro)) out.form = true;
  const attached = attachmentCount(doc, names);
  if (attached > 0) out.attachedFiles = attached;
  const signed = signatureCount(doc, acro);
  if (signed > 0) out.signatures = signed;
  return out;
}
