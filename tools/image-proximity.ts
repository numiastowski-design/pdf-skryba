/**
 * image-proximity — which text goes with which image, and from what distance
 * the question stops arising.
 *
 * It measures the distance from each text line to the box of the nearest image,
 * on both axes, zero when the line is inside. A distance to the box gives the
 * "laid on top" case for free, where a distance between centres penalises a
 * large image whose own edge is far from its centre.
 *
 * It does not look for captions: without a "Figure 1" marker nothing tells one.
 * It only informs an order: this line reads with that image.
 *
 * It decides nothing. It gives the two populations, the text that touches an
 * image and the text that does not, so that a ceiling is a measured figure and
 * not a preference.
 *
 * Set the witness before measuring: TEMOIN=1 on a page with several images whose
 * right answers are known by eye.
 *
 *   npx tsx tools/image-proximity.ts <file.pdf> [...]
 *   TEMOIN=1 npx tsx tools/image-proximity.ts <file.pdf>
 *
 * From the monorepo root the path is `packages/reader/tools/image-proximity.ts`.
 */

import { readFileSync } from "node:fs";

import { detectPdfPageSignals } from "../src/extractor/pdf-table-detector";
import { readPdfSource, type PdfTextRun } from "../src/extractor/pdf-source";

interface Boite {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

interface Ligne {
  text: string;
  xMin: number;
  xMax: number;
  y: number;
}

const distance = (l: Ligne, b: Boite): number => {
  const dx = Math.max(0, b.xMin - l.xMax, l.xMin - b.xMax);
  const dy = Math.max(0, b.yMin - l.y, l.y - b.yMax);
  return Math.hypot(dx, dy);
};

function lignesOf(runs: readonly PdfTextRun[]): Ligne[] {
  const sorted = [...runs].filter((r) => r.text.trim().length > 0).sort((a, b) => b.y - a.y || a.x - b.x);
  const out: Ligne[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && Math.abs(last.y - r.y) <= 1) {
      last.text += r.text;
      last.xMin = Math.min(last.xMin, r.x);
      last.xMax = Math.max(last.xMax, r.x + r.width);
    } else out.push({ text: r.text, xMin: r.x, xMax: r.x + r.width, y: r.y });
  }
  return out;
}

async function main(): Promise<void> {
  const seuils = [0, 5, 10, 20, 40, 80, 160];
  const paliers = new Array(seuils.length + 1).fill(0) as number[];
  let lignesTotal = 0;
  let lignesAvecImage = 0;
  let pagesAvecPlusieursImages = 0;

  for (const file of process.argv.slice(2)) {
    try {
      const bytes = new Uint8Array(readFileSync(file));
      // The source is not shared. Tried and dropped: handing over an already
      // read source, which returned no image on a document that carries some.
      // The file is opened twice, which a measuring tool can afford.
      const source = await readPdfSource(bytes);
      const signals = await detectPdfPageSignals(bytes);
      source.pages.forEach((page, index) => {
        const boites = (signals.blockImagesByPage.get(index) ?? []).map((b) => ({
          xMin: b.xMin,
          xMax: b.xMax,
          yMin: b.yMin,
          yMax: b.yMax,
        }));
        if (boites.length > 1) pagesAvecPlusieursImages += 1;
        const lignes = lignesOf(page.runs);
        lignesTotal += lignes.length;
        if (boites.length === 0) return;
        for (const ligne of lignes) {
          const d = Math.min(...boites.map((b) => distance(ligne, b)));
          lignesAvecImage += 1;
          const rang = seuils.findIndex((s) => d <= s);
          paliers[rang === -1 ? seuils.length : rang]! += 1;
          if (process.env.TEMOIN === "1" && d <= 160 && ligne.text.trim().length <= 20) {
            const meilleure = boites.reduce((a, b) => (distance(ligne, a) <= distance(ligne, b) ? a : b));
            console.log(
              `  « ${ligne.text.trim().padEnd(12)} » d=${d.toFixed(0).padStart(3)} → image x=${meilleure.xMin.toFixed(0)}→${meilleure.xMax.toFixed(0)} y=${meilleure.yMin.toFixed(0)}→${meilleure.yMax.toFixed(0)}` +
                `   (les autres : ${boites
                  .filter((b) => b !== meilleure)
                  .map((b) => distance(ligne, b).toFixed(0))
                  .join(", ")})`,
            );
          }
        }
      });
    } catch (error) {
      console.log(`${file.split(/[\/]/).pop()} échec: ${String(error).slice(0, 60)}`);
    }
  }

  console.log("");
  console.log(`${lignesTotal} lignes au total, dont ${lignesAvecImage} sur une page qui porte au moins une image.`);
  console.log(
    `${pagesAvecPlusieursImages} page(s) portent PLUSIEURS images — le seul cas où la question se pose vraiment.`,
  );
  console.log("");
  console.log("Distance à la boîte de l'image la plus proche :");
  seuils.forEach((s, i) => {
    const n = paliers[i]!;
    const part = lignesAvecImage > 0 ? ((n / lignesAvecImage) * 100).toFixed(1) : "0";
    console.log(
      `  ${i === 0 ? "dedans (0)" : `≤ ${s} pt`.padEnd(10)}  ${String(n).padStart(5)}  ${part.padStart(5)} %`,
    );
  });
  console.log(
    `  au-delà      ${String(paliers[seuils.length]!).padStart(5)}  ${((paliers[seuils.length]! / Math.max(1, lignesAvecImage)) * 100).toFixed(1).padStart(5)} %`,
  );
}

void main();
