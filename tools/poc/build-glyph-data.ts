/** Generates the DATA of the unicode layer into `src/extractor/pdf-fonts/glyph-data.ts`, **taking nothing from pdf.js**. DEVELOPMENT tool, outside the bundle.
 *  Decides: nothing. It transcribes four official sources, all in `tools/poc/data/` so that generation
 *  is reproducible offline:
 *  - `glyphlist.txt` — Adobe's glyph list (`agl-aglfn`, BSD-3-Clause, © 2002-2019 Adobe): name → text;
 *  - `afm/*.afm` — the metrics of Adobe's 14 standard fonts (© 1985-1997 Adobe, redistribution allowed provided
 *    `afm/MustRead.html`, Adobe's notice, travels with them),
 *    which ALSO give their internal encoding: `StandardEncoding` comes from `Helvetica.afm`, Symbol's from
 *    `Symbol.afm`, ZapfDingbats' from its own;
 *  - `CP1252.TXT` and `ROMAN.TXT` — the Unicode Consortium tables (Unicode License v3, `LICENSE-UNICODE.txt`), from which `WinAnsiEncoding` and
 *    `MacRomanEncoding` are derived (code → unicode, then unicode → name through Adobe's list reversed).
 *  WHY THIS DETOUR (31/10/2026): the first version took the four encodings from pdf.js, which made the measure
 *  "we say the same unicode as pdf.js" CIRCULAR on these tables — a transcription error would have been
 *  invisible there. `tools/poc/compare-encodings.ts` (deleted with pdf.js, see git history) checked our four tables
 *  against its own: two independent readings, and every gap was named.
 *  Called by: `npx tsx tools/poc/build-glyph-data.ts`. */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root, found from this file rather than from the working directory. */
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DATA = join(REPO, "tools/poc/data");
const OUT = join(REPO, "src/extractor/pdf-fonts/glyph-data.ts");

/** The 14 standard fonts (§9.6.2.2, Table 109), in the clause's order. */
const STANDARD_14 = [
  "Courier",
  "Courier-Bold",
  "Courier-BoldOblique",
  "Courier-Oblique",
  "Helvetica",
  "Helvetica-Bold",
  "Helvetica-BoldOblique",
  "Helvetica-Oblique",
  "Times-Roman",
  "Times-Bold",
  "Times-BoldItalic",
  "Times-Italic",
  "Symbol",
  "ZapfDingbats",
] as const;

/** `name;HEX HEX…` per line. */
function readAgl(): Map<string, string> {
  const table = new Map<string, string>();
  for (const line of readFileSync(join(DATA, "glyphlist.txt"), "utf8").split(/\r?\n/)) {
    if (line.startsWith("#") || line.trim() === "") continue;
    const [name, codes] = line.split(";");
    if (name === undefined || codes === undefined) continue;
    table.set(
      name,
      codes
        .trim()
        .split(" ")
        .map((hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
        .join(""),
    );
  }
  if (table.size < 4000) throw new Error(`glyph list too short (${table.size})`);
  return table;
}

interface Afm {
  /** Glyph name → advance, in thousandths of an em. */
  readonly widths: Map<string, number>;
  /** Internal-encoding code → glyph name (−1 in the AFM = not encoded). */
  readonly encoding: string[];
}

/** `C 32 ; WX 278 ; N space ; B … ;` — the code, the advance, the name. */
function readAfm(font: string): Afm {
  const widths = new Map<string, number>();
  const encoding = Array.from({ length: 256 }, () => "");
  for (const line of readFileSync(join(DATA, "afm", `${font}.afm`), "utf8").split(/\r?\n/)) {
    if (!line.startsWith("C ")) continue;
    const code = /^C\s+(-?\d+)\s*;/.exec(line);
    const width = /;\s*WX\s+(-?\d+)\s*;/.exec(line);
    const name = /;\s*N\s+(\S+)\s*;/.exec(line);
    if (code === null || width === null || name === null) continue;
    widths.set(name[1] as string, Number(width[1]));
    const at = Number(code[1]);
    if (at >= 0 && at < 256) encoding[at] = name[1] as string;
  }
  if (widths.size < 100) throw new Error(`${font}.afm: ${widths.size} glyphs, not the expected source`);
  return { widths, encoding };
}

/** `0x41\t0x0041\t# LATIN CAPITAL LETTER A` — the code, its unicode. */
function readMapping(file: string): (string | undefined)[] {
  const table: (string | undefined)[] = Array.from({ length: 256 }, () => undefined);
  for (const line of readFileSync(join(DATA, file), "utf8").split(/\r?\n/)) {
    const match = /^0x([0-9A-Fa-f]{2})\s+0x([0-9A-Fa-f]{4})/.exec(line);
    if (match === null) continue;
    table[Number.parseInt(match[1] as string, 16)] = String.fromCodePoint(Number.parseInt(match[2] as string, 16));
  }
  if (table.filter((entry) => entry !== undefined).length < 200) throw new Error(`${file}: too few entries`);
  return table;
}

/** The inverse of Adobe's list: text → name. One text often has SEVERAL names (`tilde` and `ilde`,
 *  `Euro` and `euro`, `periodcentered` and `middot`), so the order of preference matters and is written down:
 *  1. a name an Adobe encoding really USES (the AFMs), because it is the one producers
 *     write in a `/Differences`;
 *  2. otherwise the shortest, then the first alphabetically.
 *  Found by the comparison with pdf.js (31/10/2026): without rule 1, `U+02DC` was named "ilde". */
function reverseAgl(agl: Map<string, string>, preferred: ReadonlySet<string>): Map<string, string> {
  const reverse = new Map<string, string>();
  const ordered = [...agl].sort((left, right) => {
    const mine = preferred.has(left[0]) ? 0 : 1;
    const other = preferred.has(right[0]) ? 0 : 1;
    return mine - other || left[0].length - right[0].length || left[0].localeCompare(right[0]);
  });
  for (const [name, text] of ordered) if (!reverse.has(text)) reverse.set(text, name);
  return reverse;
}

/** §9.6.6.4: the two encodings the clause defines by their characters, derived from the Consortium's table.
 *  The four codes the PDF names differently from the Windows set are corrected here, with their reason. */
function encodingFromMapping(file: string, reverse: Map<string, string>, quirks: Record<number, string>): string[] {
  const unicodes = readMapping(file);
  const names = unicodes.map((text) => (text === undefined ? "" : (reverse.get(text) ?? "")));
  for (const [code, name] of Object.entries(quirks)) names[Number(code)] = name;
  return names;
}

const quote = (text: string): string => JSON.stringify(text);

function emitEncoding(lines: string[], constant: string, title: string, names: readonly string[]): void {
  lines.push(`/** ${title} An empty slot is a code the encoding does not name. */`);
  lines.push(`export const ${constant}: readonly string[] = [`);
  for (let row = 0; row < 256; row += 8)
    lines.push(
      `  ${names
        .slice(row, row + 8)
        .map(quote)
        .join(", ")},`,
    );
  lines.push("];");
  lines.push("");
}

/** The WinAnsi codes the PDF names differently from `CP1252.TXT`. */
function winAnsiQuirks(): Record<number, string> {
  // WHAT THE PDF NAMES DIFFERENTLY FROM THE VENDOR'S SET, found by checking our tables against pdf.js's
  // on 31/10/2026, and settled at Annex D:
  // - codes 0x00-0x1F are NOT named by Annex D, whereas `CP1252.TXT` maps them to the
  //   control characters U+0000-U+001F: leaving them named would publish control characters;
  // - `0xA0` is a no-break space and `0xAD` a soft hyphen at Microsoft; the PDF names them
  //   `space` and `hyphen`, and producers rely on it;
  // - Annex D notes that in WinAnsi "any unused code above 40 maps to the bullet character":
  //   those are 0x7F, 0x81, 0x8D, 0x8F, 0x90 and 0x9D.
  const winAnsiQuirks: Record<number, string> = { 0xa0: "space", 0xad: "hyphen" };
  for (let code = 0; code < 0x20; code += 1) winAnsiQuirks[code] = "";
  for (const code of [0x7f, 0x81, 0x8d, 0x8f, 0x90, 0x9d]) winAnsiQuirks[code] = "bullet";
  return winAnsiQuirks;
}

/** The MacRoman codes the PDF names differently from `ROMAN.TXT`. */
function macRomanQuirks(): Record<number, string> {
  // MacRoman: `0xCA` is a no-break space, named `space` by the PDF; and `0xDB` is `currency` at Annex
  // D whereas Apple's table, revised in 1998, puts the euro there — the clause wins, a PDF file is read
  // with the encoding the clause defines. The control codes are not named either.
  const macRomanQuirks: Record<number, string> = { 0xca: "space", 0xdb: "currency" };
  for (let code = 0; code < 0x20; code += 1) macRomanQuirks[code] = "";
  // 🔴 THE ONLY GAP WE KEEP AGAINST pdf.js (31/10/2026). Annex D names 0xBD "Omega", and Adobe's list
  // gives that name U+2126, the OHM SIGN; Apple's table puts U+03A9, the Greek omega, there. We publish
  // the Greek omega.
  // ⚠️ MY FIRST REASON WAS WRONG, and the trial said so: I had written that a Confluence search
  // for "Ω" would not find an ohm sign. TRIAL OF 31/10/2026, on a Confluence page:
  // Confluence KEEPS the two characters distinct in storage, and its SEARCH CONFLATES THEM — a word
  // written with the ohm sign is found by typing the Greek omega, and the reverse. Findability therefore settles nothing.
  // THE REASON THAT REMAINS, and it is enough: Unicode declares the ohm sign canonically equivalent to the Greek omega
  // and its use DISCOURAGED ("use is discouraged", chapter 22.2 of the standard). So we publish the letter, not
  // the deprecated symbol. pdf.js published the ohm sign.
  macRomanQuirks[0xbd] = "Omegagreek";
  return macRomanQuirks;
}

/** The generated file's header and its packed glyph list. */
function pushHeaderAndGlyphList(lines: string[], agl: Map<string, string>): void {
  const pairs = [...agl].map(
    ([name, text]) => `${name}:${[...text].map((char) => char.codePointAt(0)?.toString(16)).join(",")}`,
  );
  lines.push("/** GENERATED by `tools/poc/build-glyph-data.ts` — do not edit by hand.");
  lines.push(" *  The data of the unicode layer, and its FOUR sources, all official and NONE taken from");
  lines.push(' *  pdf.js — so that the measure "we say the same unicode as it does" was not circular:');
  lines.push(" *  - `GLYPH_LIST`: Adobe's glyph list (`agl-aglfn`, BSD-3-Clause, © 2002-2019 Adobe);");
  lines.push(" *  - `STANDARD_METRICS`: the metrics of the 14 standard fonts, from their AFM files (© 1985-1997");
  lines.push(" *    Adobe), by glyph NAME as §9.6.2.2 asks;");
  lines.push(" *  - `STANDARD_ENCODING`, `SYMBOL_ENCODING`, `ZAPF_ENCODING`: the INTERNAL encodings those same");
  lines.push(" *    AFMs declare (`Helvetica.afm`, `Symbol.afm`, `ZapfDingbats.afm`);");
  lines.push(" *  - `WINANSI_ENCODING`, `MACROMAN_ENCODING`: derived from the Unicode Consortium tables");
  lines.push(" *    (`CP1252.TXT`, `ROMAN.TXT`), code → unicode then unicode → name through Adobe's list");
  lines.push(" *    reversed, with the four gaps the PDF names differently, each written in the generator.");
  lines.push(
    " *  Checked against pdf.js's tables by `tools/poc/compare-encodings.ts` (both deleted with pdf.js, see git history):",
  );
  lines.push(" *  two independent readings, and every gap was named there.");
  lines.push(" *  Decides: nothing — this is data, and the generator decides (its comments carry");
  lines.push(" *  every gap settled at Annex D).");
  lines.push(" *  NOT here: the rules that use them (`./names.ts` for names, `./widths.ts` for");
  lines.push(" *  advances, `./to-unicode.ts` for a font's CMap), and the generator itself.");
  lines.push(" *  Called by: `./names.ts`, `./widths.ts`. */");
  lines.push("");
  lines.push("/** `name:code points in hexadecimal, separated by commas`, one per space. A string rather than");
  lines.push(" *  4 281 object entries: parsing at load costs a millisecond and the file stays readable. */");
  lines.push(`const GLYPH_LIST_PACKED = ${quote(pairs.join(" "))};`);
  lines.push("");
  lines.push("/** Glyph name → the text it paints (Adobe's list, as is). */");
  lines.push("export const GLYPH_LIST: ReadonlyMap<string, string> = new Map(");
  lines.push('  GLYPH_LIST_PACKED.split(" ").map((pair) => {');
  lines.push('    const colon = pair.indexOf(":");');
  lines.push("    const name = pair.slice(0, colon);");
  lines.push("    const text = pair");
  lines.push("      .slice(colon + 1)");
  lines.push('      .split(",")');
  lines.push("      .map((hex) => String.fromCodePoint(Number.parseInt(hex, 16)))");
  lines.push('      .join("");');
  lines.push("    return [name, text] as const;");
  lines.push("  }),");
  lines.push(");");
  lines.push("");
}

function main(): void {
  const agl = readAgl();
  const afms = new Map(STANDARD_14.map((font) => [font, readAfm(font)] as const));
  // The names Adobe's encodings really use: they are the ones a `/Differences` writes.
  const preferred = new Set([...afms.values()].flatMap((afm) => afm.encoding.filter((name) => name !== "")));
  const reverse = reverseAgl(agl, preferred);

  const lines: string[] = [];
  pushHeaderAndGlyphList(lines, agl);
  emitEncoding(
    lines,
    "STANDARD_ENCODING",
    "§9.6.6.2 / Annex D: the internal encoding `Helvetica.afm` declares.",
    (afms.get("Helvetica") as Afm).encoding,
  );
  emitEncoding(
    lines,
    "WINANSI_ENCODING",
    "§9.6.6.4 / Annex D: derived from the Unicode Consortium's `CP1252.TXT`.",
    encodingFromMapping("CP1252.TXT", reverse, winAnsiQuirks()),
  );
  emitEncoding(
    lines,
    "MACROMAN_ENCODING",
    "§9.6.6.4 / Annex D: derived from the Unicode Consortium's `ROMAN.TXT`.",
    encodingFromMapping("ROMAN.TXT", reverse, macRomanQuirks()),
  );
  emitEncoding(
    lines,
    "SYMBOL_ENCODING",
    "The internal encoding `Symbol.afm` declares (§9.6.6.1: a symbolic font has its own).",
    (afms.get("Symbol") as Afm).encoding,
  );
  emitEncoding(
    lines,
    "ZAPF_ENCODING",
    "The internal encoding `ZapfDingbats.afm` declares.",
    (afms.get("ZapfDingbats") as Afm).encoding,
  );

  lines.push("/** §9.6.2.2: the advances of the 14 standard fonts, BY glyph NAME — this is how the clause");
  lines.push(" *  defines them, and a standard font carries no `/Widths`. Packed `name=advance`, one per space. */");
  lines.push("const STANDARD_METRICS_PACKED: Readonly<Record<string, string>> = {");
  for (const font of STANDARD_14) {
    const afm = afms.get(font) as Afm;
    const packed = [...afm.widths].map(([name, width]) => `${name}=${width}`).join(" ");
    lines.push(`  ${quote(font)}: ${quote(packed)},`);
  }
  lines.push("};");
  lines.push("");
  lines.push("/** Standard font → (glyph name → advance). */");
  lines.push("export const STANDARD_METRICS: ReadonlyMap<string, ReadonlyMap<string, number>> = new Map(");
  lines.push("  Object.entries(STANDARD_METRICS_PACKED).map(([font, packed]) => [");
  lines.push("    font,");
  lines.push('    new Map(packed.split(" ").map((pair) => {');
  lines.push('      const equals = pair.indexOf("=");');
  lines.push("      return [pair.slice(0, equals), Number(pair.slice(equals + 1))] as const;");
  lines.push("    })),");
  lines.push("  ]),");
  lines.push(");");
  lines.push("");

  writeFileSync(OUT, lines.join("\n"), "utf8");
  console.log(`wrote ${OUT}: ${agl.size} names, 5 encodings, ${afms.size} standard fonts`);
}

main();
