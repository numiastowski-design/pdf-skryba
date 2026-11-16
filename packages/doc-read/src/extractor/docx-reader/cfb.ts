/** What a CFB compound file ([MS-CFB]) IS, read from its directory stream
 *  names: an encrypted OOXML envelope, a legacy binary Office file, or
 *  neither. Decides nothing about zips — it only runs once the zip layer has
 *  already refused the bytes.
 *  NOT here: the refusal itself (`ooxml/package.ts` composes it), nor
 *  any decryption — a protected document is refused, never opened.
 *  Called by: `ooxml/package.ts`. */

/**
 * WHY STREAM NAMES, AND WHICH ONES (28/09/2026: « distingue par
 * rapport aux très vieux fichiers »). A CFB is a directory of named streams.
 * [MS-OFFCRYPTO] stores an encrypted OOXML document as the `EncryptionInfo`
 * and `EncryptedPackage` streams — the exact discriminant of Microsoft's own
 * `EncryptedPackageEnvelope.IsEncryptedPackageEnvelope` (« an OLE compound
 * file with an encrypted package stream »). The legacy binary formats name
 * their main stream instead: `WordDocument` ([MS-DOC]), `Workbook` — `Book`
 * before Excel 97 — ([MS-XLS]), `PowerPoint Document` ([MS-PPT]). The names
 * are pinned by `cfb.test.ts` on fabricated containers, not by this comment.
 *
 * Encryption wins over legacy when both would match: an OOXML envelope never
 * carries a legacy main stream in practice, and calling a protected file
 * « unsupported » would hide the one thing the admin can act on. Bias chosen
 * and written.
 *
 * Every walk is bounded and every inconsistency answers `other` — this runs
 * on bytes that already failed to open as a zip, so hostile shapes are the
 * norm, and `other` simply keeps the existing « damaged » refusal.
 */

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;
const HEADER_DIFAT_ENTRIES = 109;
/** Ceilings on chain walks. A 50 MB file (T9, nothing larger is ever
 *  downloaded) holds < 102 400 sectors of 512 B; a directory or DIFAT chain
 *  longer than that is a loop, not a document. */
const MAX_CHAIN_SECTORS = 102_400;

export type CfbKind = "encrypted" | "legacy-binary" | "other";

const ENCRYPTED_STREAMS = new Set(["EncryptionInfo", "EncryptedPackage"]);
const LEGACY_STREAMS = new Set(["WordDocument", "Workbook", "Book", "PowerPoint Document"]);

/** The directory-entry names of a CFB, or undefined when the bytes do not
 *  parse as one within bounds. */
function directoryNames(bytes: Uint8Array): string[] | undefined {
  if (bytes.length < 512) return undefined;
  for (let i = 0; i < SIGNATURE.length; i++) if (bytes[i] !== SIGNATURE[i]) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sectorShift = view.getUint16(30, true);
  if (sectorShift !== 9 && sectorShift !== 12) return undefined; // v3 or v4, nothing else exists
  const sectorSize = 1 << sectorShift;
  const sectorAt = (index: number): number | undefined => {
    const at = sectorSize + index * sectorSize; // sector 0 starts AFTER the 512-byte header, at one sector size
    return at + sectorSize <= bytes.length ? at : undefined;
  };

  // The FAT, through the header DIFAT then the DIFAT chain. Bounded TWO
  // ways (revue HIGH 28/09 soir, constat 1): a VISITED set stops any cycle
  // at its second visit — the hop ceiling alone let a self-looping DIFAT
  // accumulate ~105M array entries first — and `fatSectors` can never hold
  // more than the file has sectors. The cost guard has no observable
  // OUTCOME to pin (« other » before and after; only the work changes), so
  // it is verified by construction here, not by a test.
  const maxSectors = Math.ceil(bytes.length / sectorSize);
  const fatSectors: number[] = [];
  for (let i = 0; i < HEADER_DIFAT_ENTRIES; i++) {
    const s = view.getUint32(76 + i * 4, true);
    if (s < FREESECT - 1) fatSectors.push(s);
  }
  const seenDifat = new Set<number>();
  let difat = view.getUint32(68, true);
  while (difat !== ENDOFCHAIN && difat !== FREESECT) {
    if (seenDifat.has(difat) || seenDifat.size >= MAX_CHAIN_SECTORS) return undefined;
    seenDifat.add(difat);
    const at = sectorAt(difat);
    if (at === undefined) return undefined;
    const perSector = sectorSize / 4 - 1;
    for (let i = 0; i < perSector; i++) {
      const s = view.getUint32(at + i * 4, true);
      if (s < FREESECT - 1) {
        if (fatSectors.length >= maxSectors) return undefined; // more FAT than the file has sectors: not a document
        fatSectors.push(s);
      }
    }
    difat = view.getUint32(at + perSector * 4, true);
  }
  const fatEntry = (sector: number): number | undefined => {
    const perSector = sectorSize / 4;
    const holder = fatSectors[Math.floor(sector / perSector)];
    if (holder === undefined) return undefined;
    const at = sectorAt(holder);
    return at === undefined ? undefined : view.getUint32(at + (sector % perSector) * 4, true);
  };

  // The directory chain, entries of 128 bytes, stream and root names only —
  // same visited-set cycle guard as the DIFAT walk above.
  const names: string[] = [];
  const seenDir = new Set<number>();
  let sector = view.getUint32(48, true);
  while (sector !== ENDOFCHAIN && sector !== FREESECT) {
    if (seenDir.has(sector) || seenDir.size >= MAX_CHAIN_SECTORS) return undefined;
    seenDir.add(sector);
    const at = sectorAt(sector);
    if (at === undefined) return undefined;
    for (let entry = at; entry + 128 <= at + sectorSize; entry += 128) {
      const objectType = view.getUint8(entry + 66);
      if (objectType !== 2 && objectType !== 5) continue;
      const nameLength = view.getUint16(entry + 64, true);
      if (nameLength < 2 || nameLength > 64 || nameLength % 2 !== 0) continue;
      let name = "";
      for (let c = 0; c < nameLength / 2 - 1; c++) name += String.fromCharCode(view.getUint16(entry + c * 2, true));
      names.push(name);
    }
    const next = fatEntry(sector);
    if (next === undefined) return undefined;
    sector = next;
  }
  return names;
}

export function classifyCfb(bytes: Uint8Array): CfbKind {
  const names = directoryNames(bytes);
  if (names === undefined) return "other";
  if (names.some((n) => ENCRYPTED_STREAMS.has(n))) return "encrypted";
  if (names.some((n) => LEGACY_STREAMS.has(n))) return "legacy-binary";
  return "other";
}
