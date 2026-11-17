/** Une URL coupée d'une rangée à l'autre revient entière (30/10/2026 : « une url doit pas être coupée, voire
 *  même des lettres collées, ça se règle en regex non ? commençons juste par URL »).
 *  Decides: quand la dernière cellule d'une rangée finit sur une URL et que la rangée suivante n'a qu'une cellule qui la
 *  continue, les deux moitiés se rejoignent sans séparateur — et rien d'autre.
 *
 *  CE QUI EST MESURÉ, et c'est ce qui borne la règle (30/10/2026, 67 PDF des fixtures, 78 tableaux, 363 rangées) :
 *  92 rangées sont plus étroites que leur grille — un quart de nos rangées, donc « étroite » ne décide rien toute seule.
 *  Les 91 autres candidates collent des cellules indépendantes (« Signature: » + « Please ensure… », un en-tête de colonne
 *  + une ligne de tableau) : AUCUNE ne finit sur une URL. Le discriminant est donc l'URL, pas la rangée étroite.
 *  SA FAIBLESSE, ÉCRITE : sa population est de 1 (`38-SOP` page 6, « …/revalidation/my-db- » + « tool, for more
 *  information. »). Elle répare le défaut connu et ne peut mordre nulle part ailleurs sur le corpus ; on ne peut pas
 *  prouver qu'elle généralise. Arbitrage : on commence par les URL.
 *
 *  🔴 PRÉDICAT À ELLE, JAMAIS PARTAGÉ. Le 29/10/2026, un prédicat de trait d'union emprunté à `layout/cell-text.ts` a
 *  collé « Total - » à « 12,00 » — un nombre que le document ne porte pas. Une règle ne vaut que par ce que son APPELANT
 *  garantit : ici l'URL est la précondition, le trait d'union n'y entre pas (« quelque- » + « chose » ne joint pas).
 *  BIAIS CHOISI : une URL qu'un document écrirait vraiment en deux morceaux sortirait recollée. Laid et visible plutôt
 *  que coupé et introuvable.
 *
 *  NOT here: la jointure de deux lignes d'UNE cellule (`layout/cell-text.ts#wrapSeparator`), celle de deux lignes d'un
 *  paragraphe (`extractor/pdf-cell-paragraphs.ts#cutAcrossLines`), ni le recollage des paragraphes de la page publiée
 *  (`pipeline/cut-paragraph-repair.ts`, qui ne touche jamais un tableau).
 *  Called by: `extractor/pdf-table-render.ts`. */

import type { IRBlock } from "doc-ir/lib/ir";

/** Une URL qui finit la cellule, sans blanc après elle : un blanc final est un séparateur que le document a écrit. */
const URL_AT_END = /https?:\/\/\S*$/u;
/** La suite commence par un caractère qu'un chemin d'URL porte — jamais par un blanc. */
const URL_CONTINUES = /^[\p{L}\p{N}/\-._~%?#=&+]/u;

type TableBlock = Extract<IRBlock, { kind: "table" }>;
type Row = TableBlock["rows"][number];
type Cell = Row["cells"][number];

type Paragraph = Extract<IRBlock, { kind: "paragraph" }>;

const paragraphOf = (block: IRBlock | undefined): Paragraph | undefined =>
  block?.kind === "paragraph" ? block : undefined;
const textOf = (paragraph: Paragraph): string => paragraph.inlines.map((inline) => inline.text).join("");

/** Les deux moitiés d'une URL, de la dernière cellule d'une rangée à l'unique cellule de la suivante — RENDUES, pas
 *  seulement reconnues. La lecture qui DÉCIDE est celle qui sert ensuite : personne ne revérifie une précondition déjà
 *  tenue (revue du 30/10/2026 — la jointure relisait les deux blocs et portait une branche morte qui, atteinte, aurait
 *  fait disparaître la rangée au lieu de la joindre). */
const urlHalves = (
  above: Cell | undefined,
  alone: Cell | undefined,
): { end: Paragraph; start: Paragraph } | undefined => {
  const end = paragraphOf(above?.blocks[above.blocks.length - 1]);
  const start = paragraphOf(alone?.blocks[0]);
  if (end === undefined || start === undefined) return undefined;
  const text = textOf(end);
  if (text !== text.trimEnd() || !URL_AT_END.test(text) || !URL_CONTINUES.test(textOf(start))) return undefined;
  return { end, start };
};

/** La cellule du dessus, son dernier paragraphe prolongé par celui de la rangée d'une seule cellule, sans séparateur,
 *  puis les blocs restants de cette rangée. */
const extended = (above: Cell, alone: Cell, halves: { end: Paragraph; start: Paragraph }): Cell => ({
  ...above,
  blocks: [
    ...above.blocks.slice(0, -1),
    { ...halves.end, inlines: [...halves.end.inlines, ...halves.start.inlines] },
    ...alone.blocks.slice(1),
  ],
});

/** Les rangées d'un tableau, celles qui ne font que continuer une URL repliées dans la rangée du dessus.
 *  Pure : ne mute jamais son entrée. Rend le tableau TEL QUEL quand aucune rangée ne remplit la précondition. */
export function joinCutUrlRows(rows: readonly Row[]): Row[] {
  const out: Row[] = [];
  for (const row of rows) {
    const previous = out[out.length - 1];
    // Une rangée d'UNE SEULE cellule sous une rangée qui en a plusieurs : la seule forme que la règle regarde.
    const alone =
      row.cells.length === 1 && previous !== undefined && previous.cells.length > 1 ? row.cells[0] : undefined;
    const above = previous?.cells[previous.cells.length - 1];
    const halves = urlHalves(above, alone);
    if (previous === undefined || alone === undefined || above === undefined || halves === undefined) {
      out.push(row);
      continue;
    }
    const cells = [...previous.cells];
    cells[cells.length - 1] = extended(above, alone, halves);
    out[out.length - 1] = { ...previous, cells };
  }
  return out;
}
