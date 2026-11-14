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
 *  `openPackage`, `orDamaged` and `resolveTarget` by `pipeline/source-reading-{package,pptx,xlsx}.ts`. */

import { posix } from "node:path";

import { MAX_PAYLOAD_BYTES } from "doc-ir/lib/reader-limits";
import { ReaderError } from "doc-ir/lib/reader-error";
import { PACKAGE_MAX_BYTES, PART_MAX_BYTES } from "doc-gate/extractor/ceilings";
import { openZip, ZipEntryRefusal } from "doc-gate/extractor/zip/zip-package";
import { classifyCfb } from "../docx-reader/cfb";
import { attr, children, parseXml, type XNode } from "./xml";

export interface Relationship {
  /** The relationship type's last path segment (`hyperlink`, `image`,
   *  `footnotes`…): the transitional and Strict type URIs differ only in their
   *  base, never in this segment. */
  kind: string;
  /** An archive path for an internal target, the raw URI for an external one. */
  target: string;
  external: boolean;
}

export interface DocxPackage {
  /** Archive path of the main document part (`word/document.xml` in every
   *  file seen, but only the package relationships say so). */
  mainPart: string;
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
export const relationOfKind = (rels: ReadonlyMap<string, Relationship>, kind: string): Relationship | undefined =>
  [...rels.values()].find((r) => r.kind === kind && !r.external);

/** The part an INTERNAL relationship names, by id; `undefined` for an absent id, an unknown id or an external relationship. */
export const internalTarget = (rels: ReadonlyMap<string, Relationship>, id: string | undefined): string | undefined => {
  const rel = id === undefined ? undefined : rels.get(id);
  return rel && !rel.external ? rel.target : undefined;
};

export const damaged = (): ReaderError =>
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
 *  ceiling; the caller may leave that one entry out (pictures past `IMAGE_MAX_TOTAL_BYTES`, Mikolaj 14/10/2026, which
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
export const orDamaged = async <T>(read: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await read();
  } catch (e) {
    if (!(e instanceof PartDamagedError)) throw e;
    return undefined;
  }
};

/** Like `orDamaged`, but the caller learns WHETHER the part was damaged, apart from a read that found nothing: `value` is
 *  `undefined` for both, `damaged` tells them apart. Only `PartDamagedError` is caught. */
export const readOrFlag = async <T>(read: () => Promise<T>): Promise<{ value: T | undefined; damaged: boolean }> => {
  try {
    return { value: await read(), damaged: false };
  } catch (e) {
    if (!(e instanceof PartDamagedError)) throw e;
    return { value: undefined, damaged: true };
  }
};

/** THE TWO CEILINGS LIVE IN THE GATE since 12/11/2026 (`doc-gate/extractor/ceilings`): the gate reads them before any reader
 *  opens the file, so it cannot import them from a reader. Re-exported here, where every OOXML reader already looks
 *  for them. */
export { PACKAGE_MAX_BYTES, PART_MAX_BYTES };

export interface PackageLimits {
  partMaxBytes: number;
  packageMaxBytes: number;
}

/** Inflated bytes all the pictures a document USES may reach together.
 *  Starting value to calibrate: MIKSUDOC « Spécification technique » T9's 50 MB per downloaded binary. Measured
 *  14/10/2026 on a real Word report (d2c-corpus 043): four EMF pictures of 27 to 33 MB inflated, each deflated to
 *  ~1 % (Word writes raw bitmaps in EMF), so « pictures hardly compress » holds for PNG and JPEG, not for EMF. Past
 *  the ceiling the docx reader publishes all the text and leaves out the pictures that no longer fit, in document
 *  order, counted in `image-missing` (Mikolaj, 14/10/2026, revising the 27-28/09 « refused as damaged » for pictures
 *  only). Reads still stop at what is left, so a bomb inflates no further than before. The package-wide ceiling
 *  (`PACKAGE_MAX_BYTES`) stays a refusal. ONE definition for both readers (docx 27/09, pptx by the arbitrage of
 *  28/09/2026); the pptx reader still refuses past it. */
export const IMAGE_MAX_TOTAL_BYTES = MAX_PAYLOAD_BYTES;

const DEFAULT_LIMITS: PackageLimits = { partMaxBytes: PART_MAX_BYTES, packageMaxBytes: PACKAGE_MAX_BYTES };

const OFFICE_DOCUMENT = "officeDocument";

const lastSegment = (uri: string): string => uri.slice(uri.lastIndexOf("/") + 1);

/** OPC (ECMA-376 Part 2): a part's relationships live in `_rels/<name>.rels` beside it; the
 *  package's own in `/_rels/.rels`. */
const relsPathOf = (partPath: string): string =>
  partPath === "" ? "_rels/.rels" : posix.join(posix.dirname(partPath), "_rels", `${posix.basename(partPath)}.rels`);

/** OPC: an internal target is a URI relative to the SOURCE part's folder, or
 *  absolute from the package root when it starts with `/`. */
export const resolveTarget = (sourcePart: string, target: string): string => {
  let decoded = target;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    // A malformed %-sequence: the raw target is the best reading there is.
  }
  if (decoded.startsWith("/")) return decoded.slice(1);
  const base = sourcePart === "" ? "" : posix.dirname(sourcePart);
  return posix.normalize(posix.join(base, decoded));
};

/** An archive as the package layer reads it (`zip/zip-package.ts`, our own
 *  reader since jszip left on 05/10/2026): files only, a file known without
 *  inflating it, reads under `limits`. */
interface ZipArchive {
  names: readonly string[];
  has(path: string): boolean;
  sizeOf(path: string): number | undefined;
  readBytes(path: string, maxBytes?: number): Promise<Uint8Array | undefined>;
}

/** `undefined` when the bytes are no archive we read. Refusals mapped to this
 *  layer's two classes: past a ceiling is the plain refusal no caller may
 *  soften, an entry's own damage is `PartDamagedError`. Anything that is not
 *  our `ReaderError` propagates on purpose: a bug of ours must not read as « the
 *  file is damaged » (review of 27/09/2026 evening, finding 4). */
const openZipArchive = (bytes: Uint8Array, onDamaged: () => ReaderError, limits: PackageLimits): ZipArchive | undefined => {
  let zip: ReturnType<typeof openZip>;
  try {
    zip = openZip(bytes, limits);
  } catch (e) {
    if (e instanceof ReaderError) return undefined;
    throw e;
  }
  return {
    names: zip.names,
    has: (path) => zip.has(path),
    sizeOf: (path) => zip.sizeOf(path),
    readBytes: async (path, maxBytes) => {
      try {
        return await zip.readBytes(path, maxBytes);
      } catch (e) {
        if (e instanceof ZipEntryRefusal) {
          if (e.kind !== "ceiling") throw new PartDamagedError(onDamaged());
          const ownAllowance = e.reason === "read" && maxBytes !== undefined && maxBytes < limits.partMaxBytes;
          throw ownAllowance ? new OverAllowanceError(onDamaged()) : new ReaderError("FILE_UNSAFE", "the file inflates past its size ceiling");
        }
        throw e;
      }
    },
  };
};

/** `onDamaged` names the format in the error the user sees: the package
 *  layer is shared by the Word and PowerPoint readers. `limits` is the
 *  inflation ceilings; the defaults everywhere but in tests. */
export const openPackage = async (
  bytes: Uint8Array,
  onDamaged: () => ReaderError = damaged,
  limits: PackageLimits = DEFAULT_LIMITS,
): Promise<DocxPackage> => {
  const zip = openZipArchive(bytes, onDamaged, limits);
  if (!zip) {
    // Not a zip. A CFB container in its place is named for what it is
    // (28/09/2026, Mikolaj): a protected document is not damaged, and the
    // admin can act on « password-protected » — never on « damaged ». Both
    // refusals are definitive and shared by every reader of this layer, so
    // they bypass `onDamaged` on purpose.
    const kind = classifyCfb(bytes);
    if (kind === "encrypted") throw new ReaderError("DOCUMENT_PASSWORD_PROTECTED", "this document is protected by a password");
    if (kind === "legacy-binary") throw new ReaderError("UNSUPPORTED_TYPE", "this is a legacy binary Office file (.doc, .xls or .ppt), not supported");
    throw onDamaged();
  }

  const readBytes = zip.readBytes;
  const readXml = async (path: string): Promise<XNode | undefined> => {
    // The part's BYTES, not text decoded as UTF-8: the reader finds the encoding as XML 1.0 Appendix F says (UTF-16 with its
    // mark, a declared legacy encoding), refuses a declaration the bytes contradict, and keeps a UTF-8 mark out of the text.
    const bytes = await readBytes(path);
    if (bytes === undefined) return undefined;
    // Every XML part of both readers is parsed here, so this is the one place
    // where the parser's own words ("Pi Tag is not closed.") are dropped for
    // our message (CLAUDE.md, errors composed by us).
    try {
      return parseXml(bytes);
    } catch {
      throw new PartDamagedError(onDamaged());
    }
  };

  const relsCache = new Map<string, Map<string, Relationship>>();
  const relationships = async (partPath: string): Promise<Map<string, Relationship>> => {
    const cached = relsCache.get(partPath);
    if (cached) return cached;
    const map = new Map<string, Relationship>();
    const root = await readXml(relsPathOf(partPath));
    for (const rel of root ? children(root, "rel:Relationship") : []) {
      const id = attr(rel, "Id");
      const type = attr(rel, "Type");
      const target = attr(rel, "Target");
      if (id === undefined || type === undefined || target === undefined) continue;
      const external = attr(rel, "TargetMode") === "External";
      map.set(id, { kind: lastSegment(type), target: external ? target : resolveTarget(partPath, target), external });
    }
    relsCache.set(partPath, map);
    return map;
  };

  // OPC: a part's content type is its Override, else the Default for
  // its extension (compared case-insensitively).
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  const types = await readXml("[Content_Types].xml");
  if (types) {
    for (const d of children(types, "ct:Default")) {
      const ext = attr(d, "Extension");
      const type = attr(d, "ContentType");
      if (ext !== undefined && type !== undefined) defaults.set(ext.toLowerCase(), type);
    }
    for (const o of children(types, "ct:Override")) {
      const name = attr(o, "PartName");
      const type = attr(o, "ContentType");
      if (name !== undefined && type !== undefined) overrides.set(name.replace(/^\//, "").toLowerCase(), type);
    }
  }
  const contentType = (path: string): string | undefined => {
    const override = overrides.get(path.toLowerCase());
    if (override) return override;
    const dot = path.lastIndexOf(".");
    return dot < 0 ? undefined : defaults.get(path.slice(dot + 1).toLowerCase());
  };

  const main = [...(await relationships("")).values()].find((r) => r.kind === OFFICE_DOCUMENT && !r.external);
  if (!main || !zip.has(main.target)) throw onDamaged();

  return {
    mainPart: main.target,
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
