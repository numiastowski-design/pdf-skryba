/** What a CFB compound file IS, read from its directory stream names: an encrypted OOXML envelope, a legacy binary
 *  Office file, or neither. It only runs once the zip layer has already refused the bytes.
 *  Decides: encryption wins over legacy when both would match, because calling a protected file « unsupported » would
 *  hide the one thing the admin can act on (bias chosen and written); every inconsistency answers `other`, which keeps
 *  the « damaged » refusal.
 *  NOT here: the refusal itself (`ooxml/package.ts` composes it), nor any decryption — a protected document is
 *  refused, never opened.
 *  Called by: `ooxml/package.ts`. */

/**
 * WHY STREAM NAMES (28/09/2026: tell protected files apart from very old ones). A CFB is a directory of named streams;
 * an encrypted OOXML document and each legacy binary format are told apart by the names of their streams. The names
 * are pinned by `cfb.test.ts`, on fabricated containers and on one real protected document.
 *
 * Every walk is bounded: this runs on bytes that already failed to open as a zip, so hostile shapes are the norm.
 */

const SIGNATURE: readonly number[] = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;
/** The last value that is a sector NUMBER; every value above it is a marker (free, end of chain, FAT, DIFAT, reserved). */
const MAXREGSECT = 0xfffffffa;
const HEADER_DIFAT_ENTRIES = 109;
/** Ceilings on chain walks. A 50 MB file (T9, nothing larger is ever
 *  downloaded) holds < 102 400 sectors of 512 B; a directory or DIFAT chain
 *  longer than that is a loop, not a document. */
const MAX_CHAIN_SECTORS = 102_400;

export type CfbKind = "encrypted" | "legacy-binary" | "other";

const ENCRYPTED_STREAMS = new Set(["EncryptionInfo", "EncryptedPackage"]);
const LEGACY_STREAMS = new Set(["WordDocument", "Workbook", "Book", "PowerPoint Document"]);

/** A CFB whose header passed: its bytes, a view on them, and its sector size. */
interface CfbFile {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  readonly sectorSize: number;
}

/** The file, when its size, signature and sector shift are those of a CFB. */
function openCfb(bytes: Uint8Array): CfbFile | undefined {
  if (bytes.length < 512) return undefined;
  for (let byteIndex = 0; byteIndex < SIGNATURE.length; byteIndex++)
    if (bytes[byteIndex] !== SIGNATURE[byteIndex]) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sectorShift = view.getUint16(30, true);
  if (sectorShift !== 9 && sectorShift !== 12) return undefined; // v3 (512-byte sectors) or v4 (4096-byte sectors)
  return { bytes, view, sectorSize: 1 << sectorShift };
}

function sectorOffset(file: CfbFile, sectorNumber: number): number | undefined {
  const offset = file.sectorSize + sectorNumber * file.sectorSize; // sector 0 starts AFTER the 512-byte header, at one sector size
  return offset + file.sectorSize <= file.bytes.length ? offset : undefined;
}

// The FAT, through the header DIFAT then the DIFAT chain. Bounded TWO
// ways (review of 28/09/2026): a VISITED set stops any cycle at its second
// visit — the hop ceiling alone let a self-looping DIFAT accumulate ~105M
// array entries first — and `fatSectors` can never hold more than the file
// has sectors. The cost guard has no observable OUTCOME to pin (« other »
// before and after; only the work changes), so it is verified by
// construction here, not by a test.
// A DIFAT entry that is no sector number reads as an EMPTY one, wherever it sits (17/11/2026). Before, a marker other than
// « free » was kept as a sector: in the first entry it sent the walk out of the file (« other »), later it changed nothing
// (« encrypted »). One malformed file gave two answers by the place of one value; it now gives the one its owner can act on.
function readFatSectors(file: CfbFile): number[] | undefined {
  const { view, sectorSize } = file;
  const maxSectors = Math.ceil(file.bytes.length / sectorSize);
  const fatSectors: number[] = [];
  for (let entryIndex = 0; entryIndex < HEADER_DIFAT_ENTRIES; entryIndex++) {
    const fatSector = view.getUint32(76 + entryIndex * 4, true);
    if (fatSector <= MAXREGSECT) fatSectors.push(fatSector);
  }
  const seenDifatSectors = new Set<number>();
  let difatSector = view.getUint32(68, true);
  while (difatSector !== ENDOFCHAIN && difatSector !== FREESECT) {
    if (seenDifatSectors.has(difatSector) || seenDifatSectors.size >= MAX_CHAIN_SECTORS) return undefined;
    seenDifatSectors.add(difatSector);
    const difatOffset = sectorOffset(file, difatSector);
    if (difatOffset === undefined) return undefined;
    const fatSectorsPerDifatSector = sectorSize / 4 - 1;
    if (!readDifatSector(file, difatOffset, fatSectorsPerDifatSector, fatSectors, maxSectors)) return undefined;
    difatSector = view.getUint32(difatOffset + fatSectorsPerDifatSector * 4, true);
  }
  return fatSectors;
}

/** Appends to `fatSectors` the FAT sector numbers one DIFAT sector lists; `false` once they would outnumber the file's
 *  `maxSectors`. */
function readDifatSector(
  file: CfbFile,
  difatOffset: number,
  fatSectorsPerDifatSector: number,
  fatSectors: number[],
  maxSectors: number,
): boolean {
  for (let entryIndex = 0; entryIndex < fatSectorsPerDifatSector; entryIndex++) {
    const fatSector = file.view.getUint32(difatOffset + entryIndex * 4, true);
    if (fatSector <= MAXREGSECT) {
      if (fatSectors.length >= maxSectors) return false; // more FAT than the file has sectors: not a document
      fatSectors.push(fatSector);
    }
  }
  return true;
}

function fatEntry(file: CfbFile, fatSectors: readonly number[], sector: number): number | undefined {
  const entriesPerFatSector = file.sectorSize / 4;
  const fatSector = fatSectors[Math.floor(sector / entriesPerFatSector)];
  if (fatSector === undefined) return undefined;
  const fatOffset = sectorOffset(file, fatSector);
  return fatOffset === undefined
    ? undefined
    : file.view.getUint32(fatOffset + (sector % entriesPerFatSector) * 4, true);
}

/** The name of the 128-byte directory entry at `entryOffset`, or undefined when it is neither a stream nor the root, or its name length is out of bounds. */
function entryName(view: DataView, entryOffset: number): string | undefined {
  const objectType = view.getUint8(entryOffset + 66);
  if (objectType !== 2 && objectType !== 5) return undefined;
  const nameLength = view.getUint16(entryOffset + 64, true);
  if (nameLength < 2 || nameLength > 64 || nameLength % 2 !== 0) return undefined;
  let name = "";
  for (let charIndex = 0; charIndex < nameLength / 2 - 1; charIndex++)
    name += String.fromCharCode(view.getUint16(entryOffset + charIndex * 2, true));
  return name;
}

/** The directory-entry names of a CFB, or undefined when the bytes do not
 *  parse as one within bounds. */
function directoryNames(bytes: Uint8Array): string[] | undefined {
  const file = openCfb(bytes);
  if (file === undefined) return undefined;
  const fatSectors = readFatSectors(file);
  if (fatSectors === undefined) return undefined;

  // The directory chain, entries of 128 bytes, stream and root names only —
  // same visited-set cycle guard as the DIFAT walk above.
  const names: string[] = [];
  const seenDirectorySectors = new Set<number>();
  let sector = file.view.getUint32(48, true);
  while (sector !== ENDOFCHAIN && sector !== FREESECT) {
    if (seenDirectorySectors.has(sector) || seenDirectorySectors.size >= MAX_CHAIN_SECTORS) return undefined;
    seenDirectorySectors.add(sector);
    const directoryOffset = sectorOffset(file, sector);
    if (directoryOffset === undefined) return undefined;
    for (
      let entryOffset = directoryOffset;
      entryOffset + 128 <= directoryOffset + file.sectorSize;
      entryOffset += 128
    ) {
      const name = entryName(file.view, entryOffset);
      if (name !== undefined) names.push(name);
    }
    const nextSector = fatEntry(file, fatSectors, sector);
    if (nextSector === undefined) return undefined;
    sector = nextSector;
  }
  return names;
}

export function classifyCfb(bytes: Uint8Array): CfbKind {
  const names = directoryNames(bytes);
  if (names === undefined) return "other";
  if (names.some((name) => ENCRYPTED_STREAMS.has(name))) return "encrypted";
  if (names.some((name) => LEGACY_STREAMS.has(name))) return "legacy-binary";
  return "other";
}
