/** A .docx, .pptx or .xlsx opened as the package ECMA-376 Part 2 (Open
 *  Packaging Conventions) describes: the main document part found through the
 *  package relationships, each part's own relationships, content types, parts
 *  read as XML or bytes, under our own inflation ceilings. Also holds the shared "damaged file" error (worded for
 *  Word) and the image byte budget `IMAGE_MAX_TOTAL_BYTES`.
 *  NOT here: what any part says (`docx-reader/body.ts`, `pptx-reader/`,
 *  `extractor/xlsx-parts.ts`, `extractor/xlsx-cells.ts`), nor the XML tree
 *  (`ooxml/xml.ts`).
 *  Called by: `docx-reader/index.ts`, `pptx-reader/index.ts`,
 *  `extractor/xlsx-parts.ts`, `docx-reader/google-drawings.ts` (`openArchive`);
 *  `openPackage`, `readUnlessDamaged` and `resolveTarget` by `pipeline/source-reading-{package,pptx,xlsx}.ts`. */

import { posix } from "node:path";

import { MAX_PAYLOAD_BYTES } from "doc-ir/lib/reader-limits";
import { ReaderError } from "doc-ir/lib/reader-error";
import { PACKAGE_MAX_BYTES, PART_MAX_BYTES } from "doc-gate/extractor/ceilings";
import { openZip, ZipEntryRefusal } from "doc-gate/extractor/zip/zip-package";
import { classifyCfb } from "../docx-reader/cfb";
import { attributeOf, findChildren, parseXml, type XNode } from "./xml";

export interface Relationship {
  /** The relationship type's last path segment (`hyperlink`, `image`,
   *  `footnotes`…): one kind for the Transitional and Strict spellings of a type. */
  readonly kind: string;
  /** An archive path for an internal target, the raw URI for an external one. */
  readonly target: string;
  readonly external: boolean;
}

export interface OpcPackage {
  /** Archive path of the main document part (only the package relationships say which part it is). */
  readonly mainPart: string;
  /** Whether the archive holds this part — known without inflating it. */
  hasPart(path: string): boolean;
  /** The size the archive DECLARES for this part once inflated, known without inflating it (`undefined`: no such part).
   *  A hint only — a header may lie, reads stay capped on the bytes they really produce. */
  declaredSize(path: string): number | undefined;
  readXml(path: string): Promise<XNode | undefined>;
  /** `maxBytes`: a tighter ceiling than the per-part one for this read (a
   *  caller's own budget); past it the read is refused like any other. */
  readBytes(path: string, maxBytes?: number): Promise<Uint8Array | undefined>;
  relationships(partPath: string): Promise<Map<string, Relationship>>;
  contentType(path: string): string | undefined;
}

/** The first internal relationship of `kind` among a part's relationships. */
export const findRelationshipOfKind = (
  relationships: ReadonlyMap<string, Relationship>,
  kind: string,
): Relationship | undefined =>
  [...relationships.values()].find((relationship) => relationship.kind === kind && !relationship.external);

/** The part an INTERNAL relationship names, by id; `undefined` for an absent id, an unknown id or an external relationship. */
export const findInternalTarget = (
  relationships: ReadonlyMap<string, Relationship>,
  id: string | undefined,
): string | undefined => {
  const relationship = id === undefined ? undefined : relationships.get(id);
  return relationship && !relationship.external ? relationship.target : undefined;
};

export const createDamagedError = (): ReaderError =>
  new ReaderError("EXTRACT_FAILED", "the file is damaged or is not a valid Word document");

/** The refusal that blames ONE part's own content — a corrupt stream, an XML
 *  that does not parse — as opposed to the refusals no caller may ever soften:
 *  the inflation ceilings (a bomb is not a document) and an archive that does
 *  not open. A reader may catch THIS class to degrade an AUXILIARY part to its
 *  visible marker instead of refusing the whole document (arbitrage of
 *  28/09/2026, pptx: chart, picture, theme). Caught nowhere — every skeleton
 *  part, the whole docx path — it refuses exactly as before: same code, same
 *  message. */
export class PartDamagedError extends ReaderError {
  constructor(from: ReaderError) {
    super(from.code, from.message);
    this.name = "PartDamagedError";
  }
}

/** A read that passed the allowance its CALLER set (`readBytes(path, maxBytes)` with `maxBytes` under the per-part
 *  ceiling), not a per-part or package ceiling. The bytes read stopped at the allowance, so it is as safe as a plain
 *  ceiling; the caller may leave that one entry out (pictures past `IMAGE_MAX_TOTAL_BYTES`, 14/10/2026, which
 *  revises « a ceiling is never degradable » for pictures only). Same code and message as the plain refusal. */
export class OverAllowanceError extends ReaderError {
  constructor(from: ReaderError) {
    super(from.code, from.message);
    this.name = "OverAllowanceError";
  }
}

/** Runs one AUXILIARY part's read and returns `undefined` when that part alone is damaged (a corrupt stream, an XML
 *  that does not parse): the caller leaves the part out and publishes the rest. Only `PartDamagedError` is caught —
 *  a ceiling refusal or any defect of ours still throws. */
export const readUnlessDamaged = async <T>(read: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof PartDamagedError)) throw error;
    return undefined;
  }
};

/** Like `readUnlessDamaged`, but the caller learns WHETHER the part was damaged, apart from a read that found nothing: `value` is
 *  `undefined` for both, `damaged` tells them apart. Only `PartDamagedError` is caught. */
export const readOrFlag = async <T>(read: () => Promise<T>): Promise<{ value: T | undefined; damaged: boolean }> => {
  try {
    return { value: await read(), damaged: false };
  } catch (error) {
    if (!(error instanceof PartDamagedError)) throw error;
    return { value: undefined, damaged: true };
  }
};

/** THE TWO CEILINGS LIVE IN THE GATE since 12/11/2026 (`doc-gate/extractor/ceilings`): the gate reads them before any reader
 *  opens the file, so it cannot import them from a reader. Re-exported here, where every OOXML reader already looks
 *  for them. */
export { PACKAGE_MAX_BYTES, PART_MAX_BYTES };

export interface PackageLimits {
  readonly partMaxBytes: number;
  readonly packageMaxBytes: number;
}

/** Inflated bytes all the pictures a document USES may reach together.
 *  Starting value to calibrate (MIKSUDOC « Spécification technique » T9). Measured
 *  14/10/2026 on a real Word report (d2c-corpus 043): four EMF pictures of 27 to 33 MB inflated, each deflated to
 *  ~1 %, so a picture ceiling cannot be derived from the archive size. Past
 *  the ceiling the docx reader publishes all the text and leaves out the pictures that no longer fit, in document
 *  order, counted in `image-missing` (14/10/2026, revising the 27-28/09 « refused as damaged » for pictures
 *  only). Reads still stop at what is left, so a bomb inflates no further than before. The package-wide ceiling
 *  (`PACKAGE_MAX_BYTES`) stays a refusal. ONE definition for both readers (docx 27/09, pptx by the arbitrage of
 *  28/09/2026). */
export const IMAGE_MAX_TOTAL_BYTES = MAX_PAYLOAD_BYTES;

const DEFAULT_LIMITS: PackageLimits = { partMaxBytes: PART_MAX_BYTES, packageMaxBytes: PACKAGE_MAX_BYTES };

const OFFICE_DOCUMENT_KIND = "officeDocument";

const extractLastSegment = (uri: string): string => uri.slice(uri.lastIndexOf("/") + 1);

/** OPC (ECMA-376 Part 2): a part's relationships live in `_rels/<name>.rels` beside it; the
 *  package's own in `/_rels/.rels`. */
const getRelationshipsPartPath = (partPath: string): string =>
  partPath === "" ? "_rels/.rels" : posix.join(posix.dirname(partPath), "_rels", `${posix.basename(partPath)}.rels`);

const decodeUriLeniently = (uri: string): string => {
  try {
    return decodeURIComponent(uri);
  } catch {
    // A malformed %-sequence: the raw target is the best reading there is.
    return uri;
  }
};

/** OPC: an internal target is a URI relative to the SOURCE part's folder, or
 *  absolute from the package root when it starts with `/`. */
export const resolveTarget = (sourcePart: string, target: string): string => {
  const decoded = decodeUriLeniently(target);
  if (decoded.startsWith("/")) return decoded.slice(1);
  const base = sourcePart === "" ? "" : posix.dirname(sourcePart);
  return posix.normalize(posix.join(base, decoded));
};

/** An archive as the package layer reads it (`zip/zip-package.ts`, our own
 *  reader): files only, a file known without inflating it, reads under `limits`. */
interface ZipArchive {
  names: readonly string[];
  has(path: string): boolean;
  sizeOf(path: string): number | undefined;
  // A function property, not a method: `openPackage` hands it on unbound, and the implementation reads no `this`.
  readBytes: (path: string, maxBytes?: number) => Promise<Uint8Array | undefined>;
}

/** `undefined` when the bytes are no archive we read. Refusals mapped to this
 *  layer's two classes: past a ceiling is the plain refusal no caller may
 *  soften, an entry's own damage is `PartDamagedError`. Anything that is not
 *  our `ReaderError` propagates on purpose: a bug of ours must not read as « the
 *  file is damaged » (review of 27/09/2026 evening, finding 4). */
const openZipArchive = (
  bytes: Uint8Array,
  onDamaged: () => ReaderError,
  limits: PackageLimits,
): ZipArchive | undefined => {
  let zip: ReturnType<typeof openZip>;
  try {
    zip = openZip(bytes, limits);
  } catch (error) {
    if (error instanceof ReaderError) return undefined;
    throw error;
  }
  return {
    names: zip.names,
    has: (path) => zip.has(path),
    sizeOf: (path) => zip.sizeOf(path),
    readBytes: async (path, maxBytes) => {
      try {
        return await zip.readBytes(path, maxBytes);
      } catch (error) {
        throw createPackageError(error, maxBytes, onDamaged, limits);
      }
    },
  };
};

/** The error to throw for what an archive entry's read threw: this layer's own class for an entry refusal, the error itself otherwise. */
const createPackageError = (
  error: unknown,
  maxBytes: number | undefined,
  onDamaged: () => ReaderError,
  limits: PackageLimits,
): unknown => {
  if (!(error instanceof ZipEntryRefusal)) return error;
  if (error.kind !== "ceiling") return new PartDamagedError(onDamaged());
  const isCallerAllowance = error.reason === "read" && maxBytes !== undefined && maxBytes < limits.partMaxBytes;
  return isCallerAllowance
    ? new OverAllowanceError(onDamaged())
    : new ReaderError("FILE_UNSAFE", "the file inflates past its size ceiling");
};

/** Throws the refusal for bytes that are not a zip archive.
 *  A CFB container in its place is named for what it is (28/09/2026): a protected document is not damaged, and the
 *  admin can act on « password-protected » — never on « damaged ». Both refusals are definitive and shared by every
 *  reader of this layer, so they bypass `onDamaged` on purpose. */
function refuseNonZip(bytes: Uint8Array, onDamaged: () => ReaderError): never {
  const cfbKind = classifyCfb(bytes);
  if (cfbKind === "encrypted")
    throw new ReaderError("DOCUMENT_PASSWORD_PROTECTED", "this document is protected by a password");
  if (cfbKind === "legacy-binary")
    throw new ReaderError(
      "UNSUPPORTED_TYPE",
      "this is a legacy binary Office file (.doc, .xls or .ppt), not supported",
    );
  throw onDamaged();
}

/** The relationships a `.rels` part declares, by id; those without an id, a type or a target are left out. */
const parseRelationships = (root: XNode | undefined, sourcePart: string): Map<string, Relationship> => {
  const relationshipsById = new Map<string, Relationship>();
  if (root === undefined) return relationshipsById;
  for (const relationshipElement of findChildren(root, "rel:Relationship")) {
    const id = attributeOf(relationshipElement, "Id");
    const relationshipType = attributeOf(relationshipElement, "Type");
    const target = attributeOf(relationshipElement, "Target");
    if (id === undefined || relationshipType === undefined || target === undefined) continue;
    const external = attributeOf(relationshipElement, "TargetMode") === "External";
    relationshipsById.set(id, {
      kind: extractLastSegment(relationshipType),
      target: external ? target : resolveTarget(sourcePart, target),
      external: external,
    });
  }
  return relationshipsById;
};

/** The `[Content_Types].xml` entries tagged `tag`, keyed by their `keyAttribute` as `normalizeKey` writes it. */
const readContentTypeEntries = (
  root: XNode | undefined,
  tag: string,
  keyAttribute: string,
  normalizeKey: (key: string) => string,
): Map<string, string> => {
  const typesByKey = new Map<string, string>();
  if (root === undefined) return typesByKey;
  for (const entry of findChildren(root, tag)) {
    const key = attributeOf(entry, keyAttribute);
    const declaredContentType = attributeOf(entry, "ContentType");
    if (key !== undefined && declaredContentType !== undefined) typesByKey.set(normalizeKey(key), declaredContentType);
  }
  return typesByKey;
};

/** OPC: a part's content type is its Override, else the Default for its extension (compared case-insensitively). */
const createContentTypeResolver = (contentTypesRoot: XNode | undefined): ((path: string) => string | undefined) => {
  const defaultTypesByExtension = readContentTypeEntries(contentTypesRoot, "ct:Default", "Extension", (extension) =>
    extension.toLowerCase(),
  );
  const overrideTypesByPartName = readContentTypeEntries(contentTypesRoot, "ct:Override", "PartName", (name) =>
    name.replace(/^\//, "").toLowerCase(),
  );
  return (path) => {
    const override = overrideTypesByPartName.get(path.toLowerCase());
    if (override) return override;
    const dot = path.lastIndexOf(".");
    return dot < 0 ? undefined : defaultTypesByExtension.get(path.slice(dot + 1).toLowerCase());
  };
};

/** `onDamaged` names the format in the error the user sees: the package
 *  layer is shared by the Word and PowerPoint readers. `limits` is the
 *  inflation ceilings; the defaults everywhere but in tests. */
export const openPackage = async (
  bytes: Uint8Array,
  onDamaged: () => ReaderError = createDamagedError,
  limits: PackageLimits = DEFAULT_LIMITS,
): Promise<OpcPackage> => {
  const zip = openZipArchive(bytes, onDamaged, limits);
  if (!zip) refuseNonZip(bytes, onDamaged);

  const readBytes = zip.readBytes;
  const readXml = async (path: string): Promise<XNode | undefined> => {
    // The part's BYTES, not text decoded as UTF-8: the reader finds the encoding as XML 1.0 Appendix F says (UTF-16 with its
    // mark, a declared legacy encoding), refuses a declaration the bytes contradict, and keeps a UTF-8 mark out of the text.
    const partBytes = await readBytes(path);
    if (partBytes === undefined) return undefined;
    // Every XML part of both readers is parsed here, so this is the one place
    // where the parser's own words are dropped for our message (CLAUDE.md,
    // errors composed by us).
    try {
      return parseXml(partBytes);
    } catch {
      throw new PartDamagedError(onDamaged());
    }
  };

  const relationshipsCache = new Map<string, Map<string, Relationship>>();
  const relationships = async (partPath: string): Promise<Map<string, Relationship>> => {
    const cached = relationshipsCache.get(partPath);
    if (cached) return cached;
    const relationshipsById = parseRelationships(await readXml(getRelationshipsPartPath(partPath)), partPath);
    relationshipsCache.set(partPath, relationshipsById);
    return relationshipsById;
  };

  const contentType = createContentTypeResolver(await readXml("[Content_Types].xml"));

  const mainRelationship = findRelationshipOfKind(await relationships(""), OFFICE_DOCUMENT_KIND);
  if (!mainRelationship || !zip.has(mainRelationship.target)) throw onDamaged();

  return {
    mainPart: mainRelationship.target,
    hasPart: (path) => zip.has(path),
    declaredSize: (path) => zip.sizeOf(path),
    readXml,
    readBytes,
    relationships,
    contentType,
  };
};

/** An archive that is NOT an Office package (no main part, no content
 *  types): its parts read as bytes under `limits`, or `undefined` when it is
 *  not a zip at all. The same inflation ceilings as `openPackage`, never a
 *  second reading of them. */
export const openArchive = async (
  bytes: Uint8Array,
  onDamaged: () => ReaderError,
  limits: PackageLimits,
): Promise<{ names: readonly string[]; readBytes: (path: string) => Promise<Uint8Array | undefined> } | undefined> => {
  const zip = openZipArchive(bytes, onDamaged, limits);
  if (!zip) return undefined;
  return { names: zip.names, readBytes: (path) => zip.readBytes(path) };
};
