/**
 * signal-separation — which signal really separates two populations?
 *
 * Given a PDF and its ground truth, it ranks candidate signals for one
 * question: is this line break a wrap, or a wanted paragraph end? One measure
 * ranks them all, instead of one written rule per signal to find which holds.
 *
 * The ranking criterion is not accuracy, on purpose. A wrong split cuts a
 * sentence in two and nobody notices; a missed end leaves a block everybody
 * sees. The tool first looks for the most generous threshold that produces no
 * wrong split, and reports recall only then. A signal with no such threshold is
 * declared unusable whatever its overall rate.
 *
 * Limit: a ranking built on one document ranks that document's habits. A
 * producer that spaces its paragraphs makes the vertical gap win; one that
 * spaces nothing makes the same threshold catch no end at all. It speeds the
 * search up; it is not a verdict.
 *
 *   npx tsx tools/signal-separation.ts <file.pdf>
 *
 * `<file>.expected.json` must sit next to the PDF: it carries the paragraphs as
 * they were written, before typesetting.
 *
 * From the monorepo root the path is `packages/reader/tools/signal-separation.ts`.
 */

import { readFileSync } from "node:fs";

import { type GlyphFragment } from "../src/extractor/glyph-positions";
import { readPdfSource, type PdfTextRun } from "../src/extractor/pdf-source";

/** One visual line, reduced to what the signals read. */
interface Ligne {
  y: number;
  left: number;
  right: number;
  size: number;
  text: string;
  hasEOL: boolean;
  /** Exact width of the first word: the sum of its glyph advances. */
  firstWordWidth: number;
}

/** One decision point: a line, the next one, and the truth. */
interface Cas {
  ligne: Ligne;
  suivante: Ligne;
  /** `true`: the line ends a paragraph, the break was wanted. */
  finDeParagraphe: boolean;
}

const norm = (t: string): string => t.replace(/\s+/gu, " ").trim();
const n2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : "—");

/** The candidate signals. Each returns a number expected to be larger when the
 *  break is wanted. */
const SIGNAUX: { nom: string; valeur: (cas: Cas, marge: number) => number }[] = [
  {
    nom: "reste / largeur du mot suivant",
    valeur: (c, marge) => (c.suivante.firstWordWidth > 0 ? (marge - c.ligne.right) / c.suivante.firstWordWidth : 0),
  },
  { nom: "reste absolu (pt)", valeur: (c, marge) => marge - c.ligne.right },
  {
    nom: "1 - remplissage de la ligne",
    valeur: (c, marge) => (marge > c.ligne.left ? 1 - (c.ligne.right - c.ligne.left) / (marge - c.ligne.left) : 0),
  },
  { nom: "écart vertical / corps", valeur: (c) => (c.ligne.size > 0 ? (c.ligne.y - c.suivante.y) / c.ligne.size : 0) },
  { nom: "hasEOL (1 = oui)", valeur: (c) => (c.ligne.hasEOL ? 1 : 0) },
];

/**
 * The most generous threshold with no wrong split, and what it catches.
 *
 * A threshold `t` declares a wanted break once the signal reaches it; no wrong
 * split means no wrap reaches `t`.
 */
const evaluer = (
  valeurs: { v: number; fin: boolean }[],
): { seuil: number; attrapees: number; total: number } | undefined => {
  const fins = valeurs.filter((x) => x.fin);
  const replis = valeurs.filter((x) => !x.fin);
  const plafondDesReplis = replis.length === 0 ? -Infinity : Math.max(...replis.map((x) => x.v));
  const candidats = fins.map((x) => x.v).filter((v) => v > plafondDesReplis);
  if (candidats.length === 0) return undefined;
  const seuil = Math.min(...candidats);
  return { seuil, attrapees: fins.filter((x) => x.v >= seuil).length, total: fins.length };
};

async function main(): Promise<void> {
  const file = process.argv[2];
  if (file === undefined) {
    console.error("usage: npx tsx tools/signal-separation.ts <fichier.pdf>  (avec son .expected.json à côté)");
    process.exitCode = 1;
    return;
  }

  const truth = JSON.parse(readFileSync(file.replace(/\.pdf$/u, ".expected.json"), "utf8")) as {
    blocs: { paragraphes: string[] }[];
  };
  const paragraphes = truth.blocs.flatMap((b) => b.paragraphes.map(norm));

  // Reads through the reader's own entry: a measuring tool that opens the
  // document another way measures something else.
  const source = await readPdfSource(new Uint8Array(readFileSync(file)), { wantGlyphs: () => true });

  const cas: Cas[] = [];
  let marge = 0;

  for (const page of source.pages) {
    const pageItems: readonly PdfTextRun[] = page.runs;
    const glyphs: readonly GlyphFragment[] = page.glyphs;
    const premierMot = (y: number): number => {
      let w = 0;
      for (const g of glyphs.filter((f: GlyphFragment) => Math.abs(f.y - y) <= 1).sort((a, b) => a.x - b.x)) {
        if (g.isSpace || g.text.trim().length === 0) break;
        w += g.width;
      }
      return w;
    };

    const parY = new Map<number, Ligne>();
    for (const it of pageItems.filter((i) => i.text.trim().length > 0)) {
      const y = Math.round(it.y * 2) / 2;
      const e = parY.get(y);
      if (e === undefined) {
        parY.set(y, {
          y,
          left: it.x,
          right: it.x + it.width,
          size: it.fontSize,
          text: it.text,
          hasEOL: it.hasEOL,
          firstWordWidth: 0,
        });
      } else {
        e.left = Math.min(e.left, it.x);
        e.right = Math.max(e.right, it.x + it.width);
        e.text += it.text;
        e.hasEOL = e.hasEOL || it.hasEOL;
      }
    }
    const lignes = [...parY.values()].sort((a, b) => b.y - a.y).map((l) => ({ ...l, firstWordWidth: premierMot(l.y) }));
    marge = Math.max(marge, ...lignes.map((l) => l.right));

    for (const [i, ligne] of lignes.entries()) {
      const suivante = lignes[i + 1];
      if (suivante === undefined) continue;
      // Only pairs of the same block are judged: a change of font size is
      // already a break, and the signal adds nothing there.
      if (Math.abs(ligne.size - suivante.size) > 0.01) continue;
      const t = norm(ligne.text);
      cas.push({ ligne, suivante, finDeParagraphe: t.length > 12 && paragraphes.some((p) => p.endsWith(t)) });
    }
  }

  const fins = cas.filter((c) => c.finDeParagraphe).length;
  console.log(
    `${file}\n${cas.length} points de décision — ${fins} vraies fins, ${cas.length - fins} replis. Marge droite : ${marge.toFixed(1)}\n`,
  );
  console.log("signal                          | replis (min→max)   | fins (min→max)     | seuil sans faux | rappel");
  console.log("-".repeat(112));

  for (const signal of SIGNAUX) {
    const valeurs = cas.map((c) => ({ v: signal.valeur(c, marge), fin: c.finDeParagraphe }));
    const replis = valeurs.filter((x) => !x.fin).map((x) => x.v);
    const finsV = valeurs.filter((x) => x.fin).map((x) => x.v);
    const verdict = evaluer(valeurs);
    const plage = (xs: number[]): string => (xs.length === 0 ? "—" : `${n2(Math.min(...xs))} → ${n2(Math.max(...xs))}`);
    console.log(
      `${signal.nom.padEnd(32)}| ${plage(replis).padEnd(19)}| ${plage(finsV).padEnd(19)}| ${(verdict ? n2(verdict.seuil) : "AUCUN").padStart(15)} | ${
        verdict ? `${verdict.attrapees}/${verdict.total}` : "inutilisable"
      }`,
    );
  }

  const legende = [
    "",
    "« seuil sans faux » = le seuil le plus généreux qui ne produit AUCUN découpage à tort.",
    "« AUCUN » veut dire que les deux populations se recouvrent jusqu'en haut : le signal ne décide pas seul.",
    "",
    "ATTENTION — ce classement vaut pour CE document. Un producteur qui espace ses paragraphes fait gagner",
    "l'écart vertical ; un autre, qui n'espace rien, le fait perdre à zéro. Croiser au moins deux producteurs",
    "différents avant de conclure quoi que ce soit d'un seuil.",
  ];
  for (const l of legende) console.log(l);
}

void main();
