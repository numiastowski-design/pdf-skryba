/** The bytes of an XML part turned into the text our tokenizer reads
 *  (detachment of fast-xml-parser, `d2c-propositions/xml/plan.md`, tranche 2):
 *  UTF-8 or UTF-16, detected as XML 1.0 Appendix F says, or a legacy
 *  encoding the declaration names (option B, Mikolaj, 25/10/2026). The product
 *  decoded every part as UTF-8 before the switch of 26/10/2026, so a valid
 *  UTF-16 part reached fast-xml-parser as gibberish, then was refused (no root
 *  found), and a Windows-1252 part with an accent published U+FFFD: since then
 *  `ooxml/package.ts` hands this module the bytes.
 *  NOT here: whether the declaration agrees with the bytes (`tokenizer.ts`,
 *  given the encoding found here), anything about the zip.
 *  Called by: `xml/xml-parser.ts`, and `ooxml/xml.ts#parseXml`, which decodes a part once here, checks the DTD on the
 *  text and hands the reader that text with its encoding. */

import { canonicalEncoding, xmlRefusal, type XmlSourceEncoding } from "./tokenizer";

/**
 * Detection (XML 1.0 Fifth Edition, Appendix F.1):
 * - `FF FE` → UTF-16 little-endian, `FE FF` → UTF-16 big-endian (§4.3.3: "Entities encoded in UTF-16 MUST ... begin
 *   with the Byte Order Mark", so the mark is how a UTF-16 entity starts);
 * - `3C 00 3F 00` (`<?` little-endian) or `00 3C 00 3F` (big-endian) → UTF-16 without a mark (Appendix F.1 describes
 *   it, §4.3.3 forbids it): refused;
 * - anything else, `EF BB BF` included → UTF-8 (the default, §4.3.3), unless the declaration that opens the part names
 *   another encoding (Appendix F.2: the declaration is read once the family is known; an ASCII-compatible one here):
 *   then the bytes are decoded AS DECLARED. Why (ECMA-376 5th editions, read at the source on 25/10/2026): the « UTF-8
 *   or UTF-16 » rule of Part 2 (§6.2.5 a, 4th edition [M1.17]) binds the package's own parts only; Part 1 sets none for
 *   the format's parts, and §4.3.3 lets a processor read other encodings. A UTF-8 mark naming another encoding (except
 *   Windows-1252 over legal UTF-8: below), or ASCII-compatible bytes naming UTF-16, contradict themselves: refused. A name no decoder knows, or `x-user-defined`
 *   (not a text encoding: EVERY byte above 0x7F becomes a private-use character), is refused: « unknown encoding
 *   declared ». Vendor characters a real legacy encoding maps to the private-use area (Shift_JIS 0xF040…) are read, as
 *   every browser reads them. `us-ascii` and `ISO-8859-1` stand for `windows-1252` (WHATWG): a byte above 0x7F under
 *   `us-ascii` is read as its Windows-1252 character, not refused. A declaration that LIES (Windows-1252 named over
 *   UTF-8 bytes) is read as UTF-8 when the bytes are legal UTF-8 with an accent (`legalUtf8Text`, product owner 26/10/2026),
 *   the UTF-8 mark counting as the same evidence; the declared name is still the one returned. LIMIT, written: that rule
 *   covers only the label family windows-1252 / ISO-8859-1 / us-ascii (one WHATWG table). The other single-byte encodings
 *   (windows-1250, windows-1251, ISO-8859-2, ISO-8859-15, KOI8-R, macintosh) would deserve it too, 0 case measured, easy to
 *   extend. The multi-byte ones (Shift_JIS, GBK, Big5, EUC) are excluded on purpose: a genuine text there is legal UTF-8
 *   by chance far more often (GBK `C3 A9` is a real character AND « é »), the discriminant is undefined, so we do not
 *   decide: those parts are read as declared.
 * A UTF-32 mark (`FF FE 00 00`) is read as UTF-16LE and falls on U+0000, a forbidden character: refused.
 * Bytes not legal in the encoding found are a fatal error (§4.3.3): refused, never replaced by U+FFFD as the product's
 * non-fatal decoder does (no gibberish, rule of 25/10/2026). The mark is kept as U+FEFF (`ignoreBOM`), as the product
 * keeps it: the tokenizer skips it.
 */
export const decodeXmlPart = (bytes: Uint8Array): { text: string; encoding: XmlSourceEncoding } => {
  const declared = encodingOf(bytes);
  if (declared !== "windows-1252") return { text: decodeAs(bytes, declared), encoding: declared };
  // A Windows-1252 declaration whose bytes are ALSO legal UTF-8 with an accent: the text is read as UTF-8 (product owner,
  // 26/10/2026) but the DECLARED name is returned, so the tokenizer's agreement check (declared name against the encoding
  // found here) still passes: returning "UTF-8" would refuse the part and the rule would never apply (review, 26/10/2026).
  const utf8Text = legalUtf8Text(bytes);
  if (utf8Text !== undefined) return { text: utf8Text, encoding: declared };
  // A UTF-8 mark is evidence of UTF-8 too, so bytes that are not legal UTF-8 contradict the mark: refused.
  if (hasUtf8Mark(bytes)) throw xmlRefusal("declared encoding does not match the bytes");
  return { text: decodeAs(bytes, declared), encoding: declared };
};

const hasUtf8Mark = (bytes: Uint8Array): boolean => bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;

const encodingOf = (bytes: Uint8Array): XmlSourceEncoding => {
  const [b0, b1, b2, b3] = bytes;
  if ((b0 === 0x3c && b1 === 0x00 && b2 === 0x3f && b3 === 0x00) || (b0 === 0x00 && b1 === 0x3c && b2 === 0x00 && b3 === 0x3f)) {
    throw xmlRefusal("UTF-16 without a byte-order mark");
  }
  if (b0 === 0xff && b1 === 0xfe) return "UTF-16LE";
  if (b0 === 0xfe && b1 === 0xff) return "UTF-16BE";
  return declaredLegacyEncoding(bytes) ?? "UTF-8";
};

/** `ignoreBOM`: the text keeps its U+FEFF, as `decodeAs` keeps it (the tokenizer skips it). */
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The text of bytes that are legal UTF-8 AND hold an accent, under a declaration of Windows-1252, or `undefined` when they
 *  are not (pure ASCII, or illegal UTF-8): the declaration lies, and the part
 *  is read as UTF-8 (product owner, 26/10/2026, « préférer l'UTF-8 » — the two readings are both legal and nothing in the
 *  bytes says which is meant, so we take the one that is almost always right, as fast-xml-parser did by ignoring the
 *  declaration entirely). Real Windows-1252 text is almost never legal UTF-8 beyond ASCII (« Ã© » is the pair a UTF-8 « é »
 *  becomes), so such a part is UTF-8 whose declaration lies; read as declared it would publish « Ã© » for « é ».
 *  Bias, written: the rare Windows-1252 text that does spell such a pair comes out as the UTF-8 it also is. Tried and
 *  dropped the same day: refusing it (« laid et visible »), which would have failed a document that publishes today for a
 *  case measured at 0 on 18 682 parts. Cost: a scan for a byte above 0x7F (`some`, stops at the first; a pure ASCII part
 *  is read to its end), then ONE strict decode whose string is returned and used as the part's text, never decoded a second
 *  time; it stops at the first byte that makes UTF-8 illegal, and `decodeXmlPart` then goes on to the Windows-1252 table
 *  (or refuses, under a UTF-8 mark).
 *  Only Windows-1252 (and its labels ISO-8859-1, us-ascii): in a multi-byte encoding legal UTF-8 by chance is far
 *  likelier. A remedy if this ever bites, not written for zero cases: the OTHER parts of the same package are UTF-8, a
 *  second independent reading from the document itself. */
const legalUtf8Text = (bytes: Uint8Array): string | undefined => {
  if (!bytes.some((byte) => byte > 0x7f)) return undefined;
  try {
    return STRICT_UTF8.decode(bytes);
  } catch {
    return undefined;
  }
};

/** The bytes decoded from `encoding`: Windows-1252 by our own row (below), every other one by a FATAL decoder. */
const decodeAs = (bytes: Uint8Array, encoding: XmlSourceEncoding): string => {
  if (encoding === "windows-1252") return decodeWindows1252(bytes);
  try {
    return new TextDecoder(encoding.toLowerCase(), { ignoreBOM: true, fatal: true }).decode(bytes);
  } catch {
    throw xmlRefusal("bytes not legal in their encoding");
  }
};

/** Windows-1252 0x80-0x9F (WHATWG index-windows-1252; 0x81, 0x8D, 0x8F, 0x90 and 0x9D unassigned, the C1 control of the
 *  same value). Written here because Node 22.13 to 22.22 decode `windows-1252` as Latin-1 (nodejs/node#60888): this
 *  row would come out as C1 controls, « € » lost in silence, and Forge's runtime minor version (`nodejs24.x` since 26/10/2026) is not ours. Every
 *  other byte is its own code point. `us-ascii` and `ISO-8859-1` resolve to this decoder too (`canonicalEncoding`).
 *  The set of decodable encoding LABELS depends on the runtime's ICU too (production runs `nodejs24.x`), measured on 26/10/2026: of the
 *  38 WHATWG labels, 36 keep XML's ASCII bytes identical, `utf-16be`/`utf-16le` differ (refused elsewhere), none is missing on Node 24,
 *  whereas `iso-8859-16` was missing on Node 22.22. */
const WINDOWS_1252_HIGH = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ";

/** Each byte's UTF-16 code unit: its own value, but the 0x80-0x9F row from `WINDOWS_1252_HIGH`. */
const WINDOWS_1252_UNITS = Uint16Array.from({ length: 256 }, (_, b) => (b >= 0x80 && b <= 0x9f ? WINDOWS_1252_HIGH.charCodeAt(b - 0x80) : b));
const UTF16LE = new TextDecoder("utf-16le");

/** One table lookup per byte into UTF-16 code units, decoded once (review of tranche 4, Fable, 25/10/2026: a per-byte
 *  `replace` callback cost 36.6 s and 2.26 GB on 64 MB of that row; this pass, about 0.7 s and 570 MB). No `Buffer`:
 *  the public library may run outside Node. */
const decodeWindows1252 = (bytes: Uint8Array): string => {
  const units = new Uint16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) units[i] = WINDOWS_1252_UNITS[bytes[i]!]!;
  return UTF16LE.decode(units);
};

/** Our ceiling on an opening declaration, in bytes: three values of at most 64 characters (`tokenizer.ts`) and white
 *  space. A declaration not closed within it is refused, its own literal (« ours alone »: it may be well-formed). */
export const DECLARATION_MAX_BYTES = 4096;
const DECLARED_ENCODING = /^<\?xml\s[^>]*?\bencoding\s*=\s*(["'])([A-Za-z][\w.-]*)\1/;

/** The WHATWG name of the legacy encoding the opening declaration names, or `undefined` for none or UTF-8. Reads the
 *  declaration to its `?>`, at most `DECLARATION_MAX_BYTES`, as Latin-1 (it is ASCII in every ASCII-compatible encoding). */
const declaredLegacyEncoding = (bytes: Uint8Array): string | undefined => {
  const marked = hasUtf8Mark(bytes);
  const from = marked ? 3 : 0;
  const head = new TextDecoder("latin1").decode(bytes.subarray(from, from + DECLARATION_MAX_BYTES));
  if (!/^<\?xml\s/.test(head)) return undefined;
  const end = head.indexOf("?>");
  // Not closed: past our ceiling, our own refusal; a shorter part is merely cut, the tokenizer says « malformed ».
  if (end < 0) {
    if (head.length >= DECLARATION_MAX_BYTES) throw xmlRefusal("XML declaration too long");
    return undefined;
  }
  const label = DECLARED_ENCODING.exec(head.slice(0, end + 2))?.[2];
  if (label === undefined) return undefined;
  const name = canonicalEncoding(label);
  if (name === undefined || name === "x-user-defined") throw xmlRefusal("unknown encoding declared");
  if (name === "utf-8") return undefined;
  if (name.startsWith("utf-16")) throw xmlRefusal("declared encoding does not match the bytes");
  // A mark over another legacy encoding is refused here, except Windows-1252: `decodeXmlPart` weighs the mark against the bytes.
  if (marked && name !== "windows-1252") throw xmlRefusal("declared encoding does not match the bytes");
  return name;
};
