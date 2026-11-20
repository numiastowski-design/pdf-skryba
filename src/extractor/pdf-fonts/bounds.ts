/** The ceilings of the font layer: how many codes a `/ToUnicode` CMap may map, and how long the text of one code
 *  may be. They exist so that a hostile CMap costs a bounded amount of work and a named refusal, never a huge
 *  allocation.
 *  NOT here: the reading itself (`./to-unicode.ts`), the refusal type (`../pdf-objects/refusal.ts`), the register
 *  fiches (`core/bounds.ts`).
 *  Called by: `./to-unicode.ts` and its test. */

/** Codes one `/ToUnicode` CMap may map. A 2-byte CMap cannot name more (65 536 codes), and §9.7.6.2 allows at
 *  most four bytes per code — but a four-byte CMap that mapped everything would be 4 billion entries, which is
 *  what this ceiling refuses. */
export const MAX_TOUNICODE_ENTRIES = 65_536;

/** UTF-16 units the text of ONE code may take. Starting value to calibrate: the longest real destination is a
 *  ligature or a decomposed accent, two to four units; eight is twice what any specimen of the corpus carries
 *  (measured on 31/10/2026: at most 2). */
export const MAX_TOUNICODE_UNITS = 8;

/** Advances that a CID font's `/W` may place, the WHOLE array taken together (§9.7.4.3).
 *  A CID fits on two bytes, so a font cannot have more than 65 536; this budget exists so that
 *  the COST no longer depends on the file size multiplied by 65 536 (security review of 31/10/2026:
 *  `0 65535 500` fits in fourteen bytes and placed 65 536 advances, as many times as it is repeated). */
export const MAX_CID_WIDTH_ENTRIES = 65_536;

/** Bytes that a CMap WORD may take (`begincmap`, `beginbfrange`, `endcmap`, a number).
 *  🔴 WHY (security review of 31/10/2026): this scanner was the only one of the four without this ceiling — `parse.ts`
 *  and `content.ts` have one of 64 bytes, `xref.ts` of 32. A CMap that decompresses 64 MB without a single blank,
 *  `<` or `[` made ONE 64 MB copy and ONE 64 MB latin1 string, i.e. ~130 MB of peak for a 65 KB bomb,
 *  only to be compared with "beginbfchar".
 *  ARBITRARY threshold: sixty-four bytes, the same figure as the two other scanners of this reader. The longest
 *  word of the clause is thirteen (`endcodespacerange`, seventeen). */
export const MAX_CMAP_TOKEN_BYTES = 64;

/** Entries of `/ToUnicode` and CID `/W` tables a whole DOCUMENT may keep, all its fonts taken together.
 *  🔴 WHY (security review of 02/11/2026): each table was capped at 65 536 entries and shared between fonts naming the same
 *  object, but two distinct objects are two tables, so a hundred fonts with a sixty-byte CMap each kept about six and a half
 *  million entries (300 to 600 MB) for a few kilobytes of file, on a runtime that has 512 MB.
 *  Starting value to calibrate, two populations measured on 02/11/2026: the 80 files of `fixtures/pdf` keep at most 202 755
 *  entries in all (three full tables, four safedocs files above 135 000), the 251 documents of the corpus at most 1 628, none
 *  refused. The ceiling is five times the first and six hundred times the second. Cost of an entry measured the same day:
 *  30 to 55 bytes in a `Map`, so the ceiling holds about 30 to 100 MB. Accepted price: a document that keeps more than a
 *  million entries is refused (`font-tables-too-many`) instead of attempted. */
export const MAX_FONT_TABLE_ENTRIES_PER_DOCUMENT = 1_000_000;

/** Codes that a `/ToUnicode` CMap may place, ALL its `bfrange` and `bfchar` taken together.
 *  Same reason: the per-range ceiling did not bound the number of ranges, and `<0000> <FFFF> <0041>` fits in
 *  twenty bytes (security review of 31/10/2026). Four times the number of codes that a CMap can name lets
 *  any honest redefinition through. */
export const MAX_TOUNICODE_PLACED = 4 * MAX_TOUNICODE_ENTRIES;

/** Bytes of a Type 1 font program's CLEARTEXT head that we read, looking for its built-in `/Encoding`
 *  (`./type1-encoding.ts`). The reading stops at `eexec` — where the outlines start being encrypted and where we
 *  never go — so this ceiling only matters for a program that has NO `eexec` at all, honest or hostile: without it,
 *  such a file would be scanned whole, however large.
 *  Starting value to calibrate, measured on 04/11/2026 on the Computer Modern subsets of
 *  `sd-7133949.pdf` (the LaTeX document that published 214 words of 4 019): `eexec` sits at 893, 975 and 1 011
 *  bytes, and the whole programs weigh 3 590 to 5 103 bytes. A custom encoding that named all 256 codes would
 *  take about 4 600 bytes of `dup <code> /<name> put` lines plus its header. The ceiling is therefore about
 *  three times the largest honest head we can construct, and sixteen times the heads we measured. */
export const TYPE1_CLEARTEXT_LIMIT = 16_384;
