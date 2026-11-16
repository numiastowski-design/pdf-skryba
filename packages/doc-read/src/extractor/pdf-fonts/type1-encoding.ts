/** The BUILT-IN encoding of a Type 1 font program, read from the CLEARTEXT head of that program
 *  (Adobe, *Adobe Type 1 Font Format*, 1990 — §2.3 for the cleartext/`eexec` split, §10 for the `/Encoding` array;
 *  ISO 32000-1:2008 §9.6.6.1 for when a PDF font has no `/Encoding` of its own).
 *  WHY IT EXISTS: a SYMBOLIC Type 1 font with no `/Encoding` dictionary carries its encoding nowhere else, so
 *  `./names.ts` abstained and the text was lost. Measured on 04/11/2026: `sd-7133949.pdf`, a LaTeX report, published
 *  **214 words of 4 019** — everything we published came from its included figures, and all of its body text, set in
 *  Computer Modern subsets, was gone. It alone held 52 % of the measured word losses of the corpus.
 *  🔴 THE RULE OF 24/10/2026 — « we will never read a font program » — IS LIFTED, NARROWLY, on
 *  04/11/2026, and the narrowness is the point: we read the PostScript header UP TO `eexec` and not one byte
 *  beyond. The outlines stay closed, so no glyph is ever interpreted, and nothing is decrypted.
 *  Decides: the 256 glyph NAMES a program declares; that reading stops at `eexec` (`./bounds.ts#TYPE1_CLEARTEXT_LIMIT`
 *  bounds a program that has none); that a code outside 0-255 is ignored rather than growing the array; and that
 *  anything we cannot read is an ABSTENTION (`undefined`), never a fallback — a wrong encoding would invent words,
 *  which is worse than losing them.
 *  NOT here: what a name means (`./names.ts#textOfGlyphName`), the `/Encoding` DICTIONARY of a PDF font
 *  (`./names.ts#encodingNames`), `/ToUnicode` (`./to-unicode.ts`), the widths, the outlines — which we still never read.
 *  Called by: `./font-text.ts`, and `type1-encoding.test.ts`. */

import { TYPE1_CLEARTEXT_LIMIT } from "./bounds";
import { STANDARD_ENCODING } from "./glyph-data";

const NOTDEF = ".notdef";

/** The encodings a Type 1 header may name. Only this one: the others (`ExpertEncoding`…) have no table here, and
 *  naming one we do not hold is an abstention, not an excuse to apply Standard. */
const NAMED_ENCODINGS: Readonly<Record<string, readonly string[]>> = { StandardEncoding: STANDARD_ENCODING };

/** `/Encoding` followed by a bare name and `def`, the whole clause (§10): `/Encoding StandardEncoding def`. */
const NAMED_CLAUSE = /^\s+([A-Za-z]+)\s+def/;

/** One entry of a custom array: `dup <code> /<name> put`. A PostScript name stops at a blank or a delimiter. */
const DUP_ENTRY = /dup\s+(-?\d+)\s*\/([^\s/()<>[\]{}%]+)\s+put/g;

/** The head of the program we are allowed to read: up to `eexec`, and never more than the ceiling. */
function cleartextHead(program: Uint8Array): string {
  const head = program.subarray(0, Math.min(program.length, TYPE1_CLEARTEXT_LIMIT));
  // latin1: the cleartext part of a Type 1 program is ASCII (§2.3), and latin1 maps every byte to one character,
  // so no byte can be lost or merged on the way in.
  const text = Buffer.from(head).toString("latin1");
  const eexec = text.indexOf("eexec");
  return eexec < 0 ? text : text.slice(0, eexec);
}

/** The 256 glyph names a Type 1 program declares, or `undefined` when it declares none we can read. */
export function builtInType1Encoding(program: Uint8Array): readonly string[] | undefined {
  const head = cleartextHead(program);
  const at = head.indexOf("/Encoding");
  if (at < 0) return undefined;
  const after = head.slice(at + "/Encoding".length);

  const named = NAMED_CLAUSE.exec(after);
  if (named !== null) {
    const table = NAMED_ENCODINGS[named[1]!];
    return table === undefined ? undefined : [...table];
  }

  const names: string[] = Array.from({ length: 256 }, () => NOTDEF);
  let placed = 0;
  DUP_ENTRY.lastIndex = 0;
  for (let hit = DUP_ENTRY.exec(after); hit !== null; hit = DUP_ENTRY.exec(after)) {
    const code = Number(hit[1]);
    if (!Number.isInteger(code) || code < 0 || code > 255) continue;
    // A later `put` on the same code wins, as the language says.
    names[code] = hit[2]!;
    placed += 1;
  }
  return placed === 0 ? undefined : names;
}
