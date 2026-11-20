/**
 * list-map — can lists be found without a model?
 *
 * The bullet character is often missing from the text layer, so the marker
 * alone is the wrong signal. The rule rests on indent and repetition first:
 * left indents cluster, one item is not a list but a run of items at the same
 * indent is, and the marker only confirms.
 *
 * Rule kept: a list item is a line set off the body indent, in a run of at
 * least two, with readable markers on at least half as many lines as are set
 * off. Tried and dropped: the marker alone (a leading dash, a reference number
 * or a date such as "12." carries one without being a list) and the indent
 * alone (it also catches tables, headings and quotations).
 *
 * Chosen bias: the rule under-detects. A missed list loses no text; an invented
 * one lies about the structure.
 *
 * Set the witness before measuring: a document whose bullets are literal
 * characters, on which the tool must find every one.
 *
 *   npx tsx tools/list-map.ts <file.pdf> [...]
 *   SAMPLE=1 also prints the first lines of each run.
 *
 * From the monorepo root the path is `packages/reader/tools/list-map.ts`.
 */

import { readFileSync } from "node:fs";

import { readPdfSource, type PdfTextRun } from "../src/extractor/pdf-source";

interface Ligne {
  text: string;
  left: number;
  y: number;
  page: number;
}

/** Indents are quantised: lines at 71.8 and 72.1 are at the same level. */
const QUANTUM_PT = 3;
/** Fewer set-off lines than this is an indented paragraph, not a list. */
const MIN_ITEMS = 2;

const MARQUEUR = /^\s*([•▪◦‣·•▪●]|[-–—]\s|\d{1,2}[.)]\s|[a-z][.)]\s|[IVX]{1,4}[.)]\s)/u;

function lignesOf(runs: readonly PdfTextRun[], page: number): Ligne[] {
  const sorted = [...runs].filter((r) => r.text.trim().length > 0).sort((a, b) => b.y - a.y || a.x - b.x);
  const groupes: PdfTextRun[][] = [];
  for (const run of sorted) {
    const last = groupes[groupes.length - 1];
    const ref = last?.[0];
    if (ref !== undefined && Math.abs(ref.y - run.y) <= 1) last!.push(run);
    else groupes.push([run]);
  }
  return groupes.map((g) => ({
    text: g
      .map((r) => r.text)
      .join("")
      .replace(/\s+/g, " ")
      .trim(),
    left: Math.min(...g.map((r) => r.x)),
    y: g[0]!.y,
    page,
  }));
}

const quantise = (x: number): number => Math.round(x / QUANTUM_PT) * QUANTUM_PT;

interface Suite {
  retrait: number;
  lignes: Ligne[];
  avecMarqueur: number;
}

/**
 * A run survives this many consecutive lines at the body indent. Tried and
 * dropped: a strict run, which an item's continuation line, back at the body
 * indent, closed after every item.
 */
const MAX_CONTINUATION = 3;

function suitesOf(lignes: readonly Ligne[]): { corps: number; suites: Suite[] } {
  const counts = new Map<number, number>();
  for (const l of lignes) counts.set(quantise(l.left), (counts.get(quantise(l.left)) ?? 0) + 1);
  let corps = 0;
  let best = 0;
  for (const [x, n] of counts) {
    if (n > best) {
      best = n;
      corps = x;
    }
  }

  const suites: Suite[] = [];
  let courante: Ligne[] = [];
  let depuisMarqueur = 0;
  const fermer = (): void => {
    const marques = courante.filter((l) => quantise(l.left) !== corps);
    const marqueurs = courante.filter((l) => MARQUEUR.test(l.text)).length;
    if (marques.length >= MIN_ITEMS && marqueurs >= Math.ceil(marques.length / 2)) {
      suites.push({
        retrait: quantise(marques[0]!.left),
        lignes: courante,
        avecMarqueur: courante.filter((l) => MARQUEUR.test(l.text)).length,
      });
    }
    courante = [];
    depuisMarqueur = 0;
  };
  for (const l of lignes) {
    const item = quantise(l.left) !== corps;
    if (item) {
      courante.push(l);
      depuisMarqueur = 0;
      continue;
    }
    if (courante.length === 0) continue;
    depuisMarqueur += 1;
    if (depuisMarqueur > MAX_CONTINUATION) fermer();
    else courante.push(l);
  }
  fermer();
  return { corps, suites };
}

async function main(): Promise<void> {
  const files = process.argv.slice(2);
  let totalSuites = 0;
  let totalItems = 0;
  let avecMarqueur = 0;

  for (const file of files) {
    try {
      const src = await readPdfSource(new Uint8Array(readFileSync(file)));
      const lignes = src.pages.flatMap((page, i) => lignesOf(page.runs, i));
      const { corps, suites } = suitesOf(lignes);
      totalSuites += suites.length;
      for (const s of suites) {
        totalItems += s.lignes.length;
        avecMarqueur += s.avecMarqueur;
      }
      const nom = (file.split(/[\\/]/).pop() ?? file).slice(0, 38).padEnd(38);
      console.log(
        `${nom} corps à x=${corps}, ${suites.length} suite(s), ${suites.reduce((n, s) => n + s.lignes.length, 0)} ligne(s)`,
      );
      if (process.env.SAMPLE === "1") {
        for (const s of suites.slice(0, 4)) {
          console.log(`    x=${s.retrait} · ${s.lignes.length} lignes · ${s.avecMarqueur} avec marqueur`);
          for (const l of s.lignes.slice(0, 3)) console.log(`        ${l.text.slice(0, 64)}`);
        }
      }
    } catch (error) {
      console.log(`${file.split(/[\\/]/).pop()} échec: ${String(error).slice(0, 50)}`);
    }
  }

  console.log("");
  console.log(
    `${totalSuites} suite(s) candidates, ${totalItems} lignes, dont ${avecMarqueur} portent un marqueur lisible.`,
  );
  console.log("");
  console.log("Une suite SANS marqueur reste une liste candidate : le marqueur est souvent PEINT,");
  console.log("pas écrit — et nous savons déjà détecter les disques peints (pastilles d'un bulletin).");
}

void main();
