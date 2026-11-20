/**
 * gutter-map — counts the pages that carry a gutter no painted line announces.
 *
 * Per page it asks whether a gutter exists: a vertical band no fragment
 * crosses, with enough fragments on each side to be a column layout and not
 * chance. The answer uses no painted line. Text read across such a gutter is
 * braided: it makes sentences that exist in neither column.
 *
 * It decides nothing. Its count is an order of magnitude, not a figure: the
 * discriminant is not defined, and each threshold moves the result several-fold.
 * It is also an upper bound: a gutter appears between the columns of a
 * borderless table too, so "two vertical blocks of text" is not "two reading
 * columns".
 *
 * Rerun it on a page known to hold two columns after any change: a measure that
 * finds nothing must first prove it can find.
 *
 *   npx tsx tools/gutter-map.ts <file.pdf> [...]
 *   SAMPLE=1 also prints the first fragments on each side of every gutter.
 *
 * From the monorepo root the path is `packages/reader/tools/gutter-map.ts`.
 */

import { readFileSync } from "node:fs";

import { readPdfSource, type PdfTextRun } from "../src/extractor/pdf-source";

interface Ligne {
  left: number;
  right: number;
  y: number;
}

/**
 * Measured on fragments, not on visual lines. Tried and dropped: grouping into
 * visual lines first. Two columns share their baselines, so grouping by ordinate
 * merges them into one line that spans the page, and every gutter is already
 * closed.
 */
function lignesOf(runs: readonly PdfTextRun[]): Ligne[] {
  return runs.filter((r) => r.text.trim().length > 0).map((r) => ({ left: r.x, right: r.x + r.width, y: r.y }));
}

/**
 * Starting values to calibrate.
 *
 *   MIN_GOUTTIERE_PT   a gutter narrower than a word is not one
 *   MIN_FRAGMENTS      per side; below it an image and three words make a gutter by chance,
 *                      above it a small page loses its real one
 *   MASQUE_TRANSVERSE  in median fragment widths; looser, a full-width line closes the gutter
 *   ECART_GOUTTIERES   two closer boundaries describe the same blank
 */
const MIN_GOUTTIERE_PT = 8;
const MIN_FRAGMENTS = 4;
const MASQUE_TRANSVERSE = 1.5;
const ECART_GOUTTIERES = 20;

function gouttieresOf(toutes: readonly Ligne[]): { x: number; gauche: number; droite: number; largeur: number }[] {
  if (toutes.length < MIN_FRAGMENTS * 2) return [];
  // Crossing elements are masked first. Nearly every two-column page carries a
  // title or a banner astride: requiring zero crossings without setting them
  // aside misses most real column layouts.
  const largeurs = [...toutes.map((l) => l.right - l.left)].sort((a, b) => a - b);
  const mediane = largeurs[Math.floor(largeurs.length / 2)] ?? 0;
  const lignes = mediane > 0 ? toutes.filter((l) => l.right - l.left <= mediane * MASQUE_TRANSVERSE) : toutes;
  if (lignes.length < MIN_FRAGMENTS * 2) return [];

  const bords = [...new Set(lignes.flatMap((l) => [l.left, l.right]))].sort((a, b) => a - b);
  const trouvees: { x: number; gauche: number; droite: number; largeur: number }[] = [];
  for (let i = 0; i < bords.length - 1; i++) {
    const debut = bords[i]!;
    const fin = bords[i + 1]!;
    const largeur = fin - debut;
    if (largeur < MIN_GOUTTIERE_PT) continue;
    const x = (debut + fin) / 2;
    if (lignes.some((l) => l.left < x && l.right > x)) continue;
    const gauche = lignes.filter((l) => l.right <= x).length;
    const droite = lignes.filter((l) => l.left >= x).length;
    if (gauche < MIN_FRAGMENTS || droite < MIN_FRAGMENTS) continue;
    trouvees.push({ x, gauche, droite, largeur });
  }
  return trouvees.filter((g, i) => i === 0 || g.x - trouvees[i - 1]!.x > ECART_GOUTTIERES);
}

async function main(): Promise<void> {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("usage: npx tsx tools/gutter-map.ts <fichier.pdf> [...]");
    process.exitCode = 1;
    return;
  }

  const echantillons: string[] = [];
  let pagesTotal = 0;
  let pagesGouttiere = 0;
  let pagesGrille = 0;
  const parDocument: string[] = [];

  for (const file of files) {
    try {
      const src = await readPdfSource(new Uint8Array(readFileSync(file)));
      let n = 0;
      const detail: string[] = [];
      src.pages.forEach((page, index) => {
        pagesTotal += 1;
        const gs = gouttieresOf(lignesOf(page.runs));
        if (gs.length === 0) return;
        const g = gs[0]!;
        // One gutter is a candidate column layout; several are a grid, a
        // borderless table.
        if (gs.length > 1) {
          pagesGrille += 1;
          return;
        }
        n += 1;
        pagesGouttiere += 1;
        detail.push(`p${index} (${g.gauche}g/${g.droite}d, ${g.largeur.toFixed(0)}pt)`);
        if (process.env.SAMPLE === "1") {
          // Look before discriminating: the count mixes prose columns and
          // borderless tables, and no criterion separates them before seeing
          // what each looks like.
          const toutes = lignesOf(page.runs);
          const g_ = toutes.filter((l) => l.right <= g.x).sort((a, b) => b.y - a.y);
          const d_ = toutes.filter((l) => l.left >= g.x).sort((a, b) => b.y - a.y);
          const mot = (l: Ligne): string =>
            page.runs
              .find((r) => r.x === l.left && r.y === l.y)
              ?.text.trim()
              .slice(0, 26) ?? "";
          echantillons.push(
            `  ${(file.split(/[\/]/).pop() ?? "").slice(0, 26).padEnd(26)} p${index}` +
              `
      GAUCHE : ${g_
        .slice(0, 3)
        .map(mot)
        .filter((t) => t.length > 0)
        .join(" | ")}` +
              `
      DROITE : ${d_
        .slice(0, 3)
        .map(mot)
        .filter((t) => t.length > 0)
        .join(" | ")}`,
          );
        }
      });
      if (n > 0)
        parDocument.push(
          `${(file.split(/[\\/]/).pop() ?? file).padEnd(36)} ${n} page(s) : ${detail.slice(0, 4).join(", ")}`,
        );
    } catch (error) {
      parDocument.push(`${file.split(/[\\/]/).pop()} échec: ${String(error).slice(0, 50)}`);
    }
  }

  for (const l of parDocument) console.log(l);
  if (echantillons.length > 0) {
    console.log("");
    console.log("ÉCHANTILLONS — de quoi ces gouttières sont-elles faites ?");
    for (const e of echantillons) console.log(e);
  }
  console.log("");
  console.log(
    `${pagesGouttiere} page(s) sur ${pagesTotal} portent UNE SEULE gouttière — ${Math.round((pagesGouttiere / pagesTotal) * 100)} % : le gisement du tressage.`,
  );
  console.log(
    `${pagesGrille} page(s) en portent PLUSIEURS — une grille, donc un tableau sans bordures, pas une mise en colonnes.`,
  );
  console.log("");
  console.log("C'est le GISEMENT du tressage : ces pages sont lues en zigzag dès qu'aucun trait peint");
  console.log("ne donne la coupe. Un compte proche de zéro dirait que la primitive attend.");
}

void main();
