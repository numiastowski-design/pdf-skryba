/** Generates the code → CID tables of the predefined CMaps we hold, one source file per collection:
 *  `src/extractor/pdf-fonts/cns-cmap-data.ts` and `jis-cmap-data.ts`. DEVELOPMENT tool, outside the bundle.
 *  Decides: nothing. It transcribes Adobe's own resources, kept in `tools/poc/data/` so that generation is
 *  reproducible offline — `UniCNS-UCS2-H` (collection Adobe-CNS1) and `UniJIS-UCS2-H` (Adobe-Japan1), from
 *  `adobe-type-tools/cmap-resources`, BSD-3-Clause, © 1990-2019 Adobe.
 *  WHY THEY EXIST (03/11/2026, both tables decided by the maintainer). A composite font whose `/Encoding`
 *  is one of these gives its TEXT by identity — the code IS the Unicode code point — but its ADVANCE needs the CID,
 *  which only these tables give: `/W` is indexed by CID (§9.7.4.3). Without them `widths.ts` falls back on `/DW`, one
 *  uniform width, and a real file published "PhrmolgyFNue15tfnEd" where the viewer shows
 *  "Basic Pharmacology For Nurses". WHY THESE TWO AND NO OTHER: measured on 415 real files, they are the only
 *  predefined CMaps that appear (one document each, both English spam PDFs whose template draws Latin letters with a
 *  CJK font); the other collections (GB, KS) and the legacy mixed-byte encodings are not held.
 *  THE FORM, and why: three `Uint16Array` of equal length — the first code of a range, its last, and the CID of its
 *  first code — base64 in the generated file. These CMaps hold no `cidchar` at all and no `usecmap`, so nothing is
 *  inherited from another file (verified at generation, loudly). Separate columns rather than interleaved triples
 *  because each compresses on its own neighbours, which is what the bundle's deflate eats.
 *  Run: `npx tsx tools/poc/build-cns-cmap.ts`. */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

interface Collection {
  /** The CMap resource, as Adobe names it. */
  readonly cmap: string;
  /** The CID collection it maps into. */
  readonly collection: string;
  /** The prefix of the generated constants, and the stem of the generated file. */
  readonly prefix: string;
}

const COLLECTIONS: readonly Collection[] = [
  { cmap: "UniCNS-UCS2-H", collection: "Adobe-CNS1", prefix: "CNS" },
  { cmap: "UniJIS-UCS2-H", collection: "Adobe-Japan1", prefix: "JIS" },
];

/** `<lo> <hi> cid` triples of every `begincidrange` block. The file is read as DATA: its syntax is PostScript, and
 *  nothing here executes it. */
function rangesOf(text: string, cmap: string): [number, number, number][] {
  const out: [number, number, number][] = [];
  // EVERY non-empty line of a cidrange block must be read: a line the regex does not know (a trailing comment, an
  // `endcidrange` on the same line, hex outside the class) used to be skipped without a word, which is a HOLE in the
  // table -- exactly what the two refusals below prevent (reviews of 03/11/2026). Zero line skipped today, measured.
  let lines = 0;
  for (const block of text.split("begincidrange").slice(1)) {
    const body = block.split("endcidrange")[0] ?? "";
    for (const line of body.split("\n")) {
      if (line.trim() === "") continue;
      lines++;
      const match = /^<([0-9a-f]+)>\s+<([0-9a-f]+)>\s+(\d+)\s*$/i.exec(line.trim());
      if (match === null)
        throw new Error(`${cmap}: line of a cidrange block this generator cannot read: ${line.trim()}`);
      out.push([Number.parseInt(match[1]!, 16), Number.parseInt(match[2]!, 16), Number(match[3])]);
    }
  }
  // These two would be data we silently drop, so they are refused loudly instead of making a hole in the table.
  if (text.includes("begincidchar"))
    throw new Error(`${cmap}: begincidchar block found, this generator only reads cidrange`);
  if (text.includes("usecmap")) throw new Error(`${cmap}: usecmap found, half the mapping would live in another file`);
  if (out.length !== lines) throw new Error(`${cmap}: ${lines} lines read, ${out.length} ranges kept`);
  return out.sort((a, b) => a[0] - b[0]);
}

for (const { cmap, collection, prefix } of COLLECTIONS) {
  const ranges = rangesOf(readFileSync(join(here, "data", cmap), "latin1"), cmap);
  if (ranges.length === 0) throw new Error(`${cmap}: no cidrange read — the source is not the expected resource`);
  // THE ONE INVARIANT THE READER DEPENDS ON: its binary search needs sorted and DISJOINT ranges. An overlap would give
  // a wrong CID in silence, which no test of the reader could catch (logic and security reviews of 03/11/2026).
  for (let at = 1; at < ranges.length; at++) {
    if (ranges[at]![0] <= ranges[at - 1]![1])
      throw new Error(`${cmap}: ranges overlap: ${ranges[at - 1]!.join(" ")} then ${ranges[at]!.join(" ")}`);
  }
  for (const [lo, hi, cid] of ranges) {
    if (lo > hi || hi > 0xffff || cid > 0xffff || cid + (hi - lo) > 0xffff)
      throw new Error(`${cmap}: range out of sixteen bits: ${lo} ${hi} ${cid}`);
  }
  // LITTLE-ENDIAN BY HAND, never through a `Uint16Array`'s buffer: that takes the MACHINE's order, and the reader used
  // to do the same -- the two agreed by coincidence, and no test could see it since both run on the same host. The
  // reader (`predefined-cmaps.ts#columnOf`) reads the pairs little-endian; this writes them so (reviews of 03/11/2026,
  // the counter-review catching that only HALF of this change had been applied).
  const column = (pick: (range: [number, number, number]) => number): string => {
    const bytes = Buffer.allocUnsafe(ranges.length * 2);
    ranges.forEach((range, at) => bytes.writeUInt16LE(pick(range), at * 2));
    return bytes.toString("base64");
  };
  const points = ranges.reduce((n, [lo, hi]) => n + (hi - lo + 1), 0);
  const body = `/** The code → CID table of the \`${cmap}\` CMap (collection ${collection}), GENERATED by
 *  \`tools/poc/build-cns-cmap.ts\` from Adobe's own resource (\`adobe-type-tools/cmap-resources\`, BSD-3-Clause,
 *  © 1990-2019 Adobe). DO NOT EDIT BY HAND: run the generator.
 *  Decides: nothing. It is data — ${ranges.length} ranges covering ${points} code points of the basic multilingual
 *  plane, each giving the CID of its first code; the CIDs of a range follow its codes one for one.
 *  NOT here: what a CID is worth (\`./widths.ts\` reads \`/W\` with it), nor the text of a code
 *  (\`./predefined-cmaps.ts\`, which reads it by identity).
 *  Called by: \`./predefined-cmaps.ts\`. */

/** The first code of each range, its last, and the CID of its first code — three columns, base64 of \`Uint16Array\`. */
export const ${prefix}_RANGE_FIRST_CODE = "${column((r) => r[0])}";
export const ${prefix}_RANGE_LAST_CODE = "${column((r) => r[1])}";
export const ${prefix}_RANGE_FIRST_CID = "${column((r) => r[2])}";
`;
  const target = join(here, "..", "..", "src", "extractor", "pdf-fonts", `${prefix.toLowerCase()}-cmap-data.ts`);
  writeFileSync(target, body, "utf8");
  console.log(
    `${cmap} → ${prefix.toLowerCase()}-cmap-data.ts: ${ranges.length} ranges, ${points} code points, ${(body.length / 1024).toFixed(1)} KB of source`,
  );
}
