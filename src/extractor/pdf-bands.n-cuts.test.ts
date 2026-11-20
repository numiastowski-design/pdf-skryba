/**
 * A page is read on N cuts, not one: with a single abscissa a four-column page is read in two bands at best, and its
 * columns 1-2 and 3-4 stay interleaved.
 *
 * Recursion is the minimal form: the page is cut at the first abscissa, then each band is cut again on the next ones.
 * `bandedSplit` (its zones, its straddling lines, its abstention when a fragment crosses) is applied once more, on
 * fewer fragments.
 */
import { describe, expect, it } from "vitest";

import type { PositionedItem } from "./pdf-model";
import { MAX_BAND_ZONES_PER_PAGE, readingBands, readingSegments } from "./pdf-bands";

const item = (text: string, x: number, y: number): PositionedItem => ({ text, x, y, width: 50, fontSize: 10 });

/** Four columns of five lines, left edges at 0, 100, 200 and 300: every line straddles the three gutters. */
const quatreColonnes = (): PositionedItem[] =>
  [1, 2, 3, 4, 5].flatMap((line) =>
    [0, 100, 200, 300].map((x, c) => item(`c${String(c + 1)}l${String(line)}`, x, 110 - line * 10)),
  );

const read = (items: readonly PositionedItem[], cuts: readonly number[]): string[] =>
  readingSegments(items, cuts)
    .flat(2)
    .map((it) => it.text);

describe("une page à quatre colonnes se lit colonne par colonne", () => {
  it("🔴 les trois coupes rendent les quatre colonnes dans l'ordre", () => {
    expect(read(quatreColonnes(), [75, 175, 275])).toEqual([
      "c1l1",
      "c1l2",
      "c1l3",
      "c1l4",
      "c1l5",
      "c2l1",
      "c2l2",
      "c2l3",
      "c2l4",
      "c2l5",
      "c3l1",
      "c3l2",
      "c3l3",
      "c3l4",
      "c3l5",
      "c4l1",
      "c4l2",
      "c4l3",
      "c4l4",
      "c4l5",
    ]);
  });

  it("la contre-épreuve : UNE SEULE coupe laisse les colonnes tressées deux par deux", () => {
    // The left band holds columns 1 and 2, which share their baselines: each line read glues "c1l1" to "c2l1".
    expect(read(quatreColonnes(), [175])).toEqual([
      "c1l1",
      "c2l1",
      "c1l2",
      "c2l2",
      "c1l3",
      "c2l3",
      "c1l4",
      "c2l4",
      "c1l5",
      "c2l5",
      "c3l1",
      "c4l1",
      "c3l2",
      "c4l2",
      "c3l3",
      "c4l3",
      "c3l4",
      "c4l4",
      "c3l5",
      "c4l5",
    ]);
  });

  it("aucune coupe : la page entière en un seul segment, comme avant", () => {
    expect(read(quatreColonnes(), [])).toHaveLength(20);
    expect(read(quatreColonnes(), [])[1]).toBe("c2l1");
  });

  it("une coupe qui ne sépare rien n'empêche pas les autres de séparer", () => {
    // 600 is off the page: `bandedSplit` abstains on it.
    expect(read(quatreColonnes(), [75, 175, 275, 600])).toEqual(read(quatreColonnes(), [75, 175, 275]));
  });
});

/** Columns of five straddling lines, and one line alone in column 2, one point above the first row: a column that
 *  starts higher than its neighbours. */
const colonneQuiCommencePlusHaut = (columns: readonly number[]): PositionedItem[] => [
  item("c2l0", 100, 101),
  ...[1, 2, 3, 4, 5].flatMap((line) =>
    columns.map((x, c) => item(`c${String(c + 1)}l${String(line)}`, x, 110 - line * 10)),
  ),
];

describe("une ligne seule dans sa colonne, au bord de la zone, appartient à sa colonne (05/11/2026)", () => {
  it("🔴 sur N coupes : la ligne haute de la colonne 2 se lit en tête de la colonne 2, pas au-dessus de tout", () => {
    expect(read(colonneQuiCommencePlusHaut([0, 100, 200]), [75, 175])).toEqual([
      "c1l1",
      "c1l2",
      "c1l3",
      "c1l4",
      "c1l5",
      "c2l0",
      "c2l1",
      "c2l2",
      "c2l3",
      "c2l4",
      "c2l5",
      "c3l1",
      "c3l2",
      "c3l3",
      "c3l4",
      "c3l5",
    ]);
  });

  it("🔴 sur UNE coupe (le chemin de la gouttière) : même lecture", () => {
    expect(read(colonneQuiCommencePlusHaut([0, 100]), [75])).toEqual([
      "c1l1",
      "c1l2",
      "c1l3",
      "c1l4",
      "c1l5",
      "c2l0",
      "c2l1",
      "c2l2",
      "c2l3",
      "c2l4",
      "c2l5",
    ]);
  });

  it("🔴 la dernière ligne COURTE d'un chapeau pleine largeur, dans la PREMIÈRE bande, reste au-dessus avec lui (fixture 16)", () => {
    // The lead crosses the cut on its first lines; its last line is short and fits in band 1. It is the lead's wrap,
    // not the head of column 1. A line alone in band 2 cannot be the wrap of a full-width paragraph, which always
    // returns to the margin.
    const items = [
      { text: "chapeau pleine largeur", x: 0, y: 121, width: 250, fontSize: 10 },
      item("tailles.", 0, 111),
      ...colonneQuiCommencePlusHaut([0, 100, 200]).slice(1),
    ];
    // The order says nothing here: what counts is the segment, because paragraphs are formed inside it.
    const segments = readingSegments(items, [75, 175]).map((lines) =>
      lines.map((line) => line.map((it) => it.text).join("")),
    );
    expect(segments[0]).toEqual(["chapeau pleine largeur", "tailles."]);
    expect(segments[1]![0]).toBe("c1l1");
  });

  it("une ligne qui TRAVERSE une coupe au-dessus de la zone reste au-dessus : elle ferme la suite", () => {
    const items = [
      { text: "titre pleine largeur", x: 0, y: 101, width: 250, fontSize: 10 },
      ...colonneQuiCommencePlusHaut([0, 100, 200]).slice(1),
    ];
    expect(read(items, [75, 175]).slice(0, 2)).toEqual(["titre pleine largeur", "c1l1"]);
  });
});

/** Two column zones one under the other, separated by a headline over two columns: the shape of a newspaper page. */
const deuxZones = (columns: readonly number[], headline: { x: number; width: number }): PositionedItem[] => [
  ...[1, 2, 3, 4, 5].flatMap((line) =>
    columns.map((x, c) => item(`h-c${String(c + 1)}l${String(line)}`, x, 210 - line * 10)),
  ),
  { text: "titre", x: headline.x, y: 150, width: headline.width, fontSize: 10 },
  // The lower zone is judged alone (`standsAloneAsZone`): its lines carry prose.
  ...[1, 2, 3, 4, 5].flatMap((line) =>
    columns.map((x, c) => prose(`b-c${String(c + 1)}l${String(line)}`, x, 150 - line * 10)),
  ),
];
/** A prose fragment: its label followed by four words. */
const prose = (label: string, x: number, y: number): PositionedItem => ({
  ...item(label, x, y),
  text: `${label} un deux trois quatre`,
});

describe("une page à plusieurs zones de colonnes se lit zone par zone (05/11/2026)", () => {
  it("🔴 sur N coupes : la zone sous le titre se lit aussi colonne par colonne — et la colonne 1, que le titre ne touche pas, se lit ENTIÈRE (05/11/2026)", () => {
    // Cut 1, which nothing crosses, splits the page first: column 1 is read top to bottom, then the top of columns
    // 2-3, the headline, and their bottom.
    expect(read(deuxZones([0, 100, 200], { x: 100, width: 150 }), [75, 175])).toEqual([
      "h-c1l1",
      "h-c1l2",
      "h-c1l3",
      "h-c1l4",
      "h-c1l5",
      ...["b-c1l1", "b-c1l2", "b-c1l3", "b-c1l4", "b-c1l5"].map((l) => `${l} un deux trois quatre`),
      "h-c2l1",
      "h-c2l2",
      "h-c2l3",
      "h-c2l4",
      "h-c2l5",
      "h-c3l1",
      "h-c3l2",
      "h-c3l3",
      "h-c3l4",
      "h-c3l5",
      "titre",
      ...["b-c2l1", "b-c2l2", "b-c2l3", "b-c2l4", "b-c2l5", "b-c3l1", "b-c3l2", "b-c3l3", "b-c3l4", "b-c3l5"].map(
        (l) => `${l} un deux trois quatre`,
      ),
    ]);
  });

  it("🔴 une seule ligne à cheval sous la zone ne fait pas une zone : les étiquettes d'un graphique restent une ligne (fixture 11)", () => {
    // Under two columns and a full-width paragraph, axis labels spread on both sides of the cut. One straddling line
    // alone is one reading; a block of columns has at least MIN_SUBZONE_LINES of them.
    const items = [
      ...[1, 2, 3, 4, 5].flatMap((line) =>
        [0, 100].map((x, c) => item(`c${String(c + 1)}l${String(line)}`, x, 210 - line * 10)),
      ),
      { text: "paragraphe pleine largeur", x: 0, y: 150, width: 150, fontSize: 10 },
      item("2023", 0, 140),
      item("2024 2025", 100, 140),
    ];
    const segments = readingSegments(items, [75]).map((lines) =>
      lines.map((line) => line.map((it) => it.text).join(" ")),
    );
    expect(segments.at(-1)).toEqual(["paragraphe pleine largeur", "2023 2024 2025"]);
  });

  it("🔴 sur UNE coupe : même lecture", () => {
    expect(read(deuxZones([0, 100], { x: 0, width: 150 }), [75])).toEqual([
      "h-c1l1",
      "h-c1l2",
      "h-c1l3",
      "h-c1l4",
      "h-c1l5",
      "h-c2l1",
      "h-c2l2",
      "h-c2l3",
      "h-c2l4",
      "h-c2l5",
      "titre",
      ...["b-c1l1", "b-c1l2", "b-c1l3", "b-c1l4", "b-c1l5", "b-c2l1", "b-c2l2", "b-c2l3", "b-c2l4", "b-c2l5"].map(
        (l) => `${l} un deux trois quatre`,
      ),
    ]);
  });

  it("🔴 un tableau sans bordure sous la zone n'est pas une zone : libellés à gauche, nombres à droite (fixture 17)", () => {
    // Rows that straddle the cut, a label on one side, numbers on the other: read as columns, the rows lose their
    // line. The discriminant is the words per fragment of the poorer side (`MIN_WORDS_PER_ZONE_FRAGMENT`).
    const items = [
      ...[1, 2, 3, 4, 5].flatMap((line) =>
        [0, 100].map((x, c) => prose(`c${String(c + 1)}l${String(line)}`, x, 210 - line * 10)),
      ),
      { text: "paragraphe pleine largeur", x: 0, y: 150, width: 150, fontSize: 10 },
      ...["Chine", "Türkiye", "Maroc", "Irak", "Inde"].flatMap((label, r) => [
        item(label, 0, 140 - r * 10),
        item(`${String(255 - r)} 1 ${String(279 - r)} 1`, 100, 140 - r * 10),
      ]),
    ];
    const segments = readingSegments(items, [75]).map((lines) =>
      lines.map((line) => line.map((it) => it.text).join(" ")),
    );
    expect(segments.at(-1)).toEqual([
      "paragraphe pleine largeur",
      "Chine 255 1 279 1",
      "Türkiye 254 1 278 1",
      "Maroc 253 1 277 1",
      "Irak 252 1 276 1",
      "Inde 251 1 275 1",
    ]);
  });
});

describe("une coupe que RIEN ne traverse sépare la page d'abord, sur toute sa hauteur (une du journal, 05/11/2026)", () => {
  // A sidebar runs from top to bottom; to its right a headline crosses cuts 2 and 3, then three columns share the rest.
  // Nothing crosses cut 1. Cut in one go on the three cuts, the page took the headline for the bound of its zone: the
  // sidebar came out in two pieces, its top interleaved with the headline.
  const prose = (label: string, x: number, y: number, width = 50): PositionedItem => ({
    text: `${label} un deux trois quatre`,
    x,
    y,
    width,
    fontSize: 10,
  });
  const une = (): PositionedItem[] => [
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((l) => prose(`barre${String(l)}`, 0, 130 - l * 10)),
    prose("titre1", 100, 120, 200),
    prose("titre2", 100, 110, 200),
    ...[1, 2, 3, 4, 5].flatMap((l) =>
      [100, 170, 240].map((x, c) => prose(`c${String(c + 1)}l${String(l)}`, x, 100 - l * 10)),
    ),
  ];
  const labels = (lines: readonly (readonly PositionedItem[])[]): string[] =>
    lines.map((line) => line.map((it) => it.text.split(" ")[0]).join(" "));

  it("🔴 la barre sort entière et première, puis le titre en travers, puis les trois colonnes", () => {
    const segments = readingBands(une(), [75, 160, 230]).map((s) => ({ column: s.column, lines: labels(s.lines) }));
    expect(segments[0]).toEqual({
      column: true,
      lines: [
        "barre1",
        "barre2",
        "barre3",
        "barre4",
        "barre5",
        "barre6",
        "barre7",
        "barre8",
        "barre9",
        "barre10",
        "barre11",
        "barre12",
      ],
    });
    expect(segments.slice(1)).toEqual([
      { column: false, lines: ["titre1", "titre2"] },
      { column: true, lines: ["c1l1", "c1l2", "c1l3", "c1l4", "c1l5"] },
      { column: true, lines: ["c2l1", "c2l2", "c2l3", "c2l4", "c2l5"] },
      { column: true, lines: ["c3l1", "c3l2", "c3l3", "c3l4", "c3l5"] },
    ]);
  });
});

describe("le bord de colonne ne juge pas une bande qui sera encore coupée (Federal Register p1, 05/11/2026)", () => {
  // Three columns, cuts 75 and 175. Cut 1, which nothing crosses, splits the page first: the right band holds columns
  // 2 and 3. The column-edge rule (a line that starts before the edge and ends after it goes under the blocks) would
  // take the start of the fullest column, the third, for the edge, and line 4 of column 2, with no neighbour in
  // column 1, would cross it. A band that a remaining cut will still split has no single edge.
  const items = (): PositionedItem[] => [
    ...[1, 2, 3].map((l) => prose(`c1l${String(l)}`, 0, 110 - l * 10)),
    ...[1, 2, 3, 4].map((l) => prose(`c2l${String(l)}`, 100, 110 - l * 10)),
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((l) => prose(`c3l${String(l)}`, 200, 110 - l * 10)),
  ];

  it("🔴 la ligne des colonnes 2-3 sans voisine en colonne 1 reste dans sa colonne", () => {
    const segments = readingBands(items(), [75, 175]);
    expect(segments.filter((s) => !s.column)).toEqual([]);
    const column2 = segments.find((s) => s.lines.some((line) => line.some((it) => it.text.startsWith("c2l1"))));
    expect(column2?.lines.map((line) => line[0]!.text.split(" ")[0])).toEqual(["c2l1", "c2l2", "c2l3", "c2l4"]);
  });
});

/** A page of many stacked zones: a full-width headline, then four lines in two columns, again and again. */
const stackedZones = (zones: number): PositionedItem[] =>
  Array.from({ length: zones }, (_, z) => {
    const top = 10_000 - z * 100;
    const headline: PositionedItem = { text: `H${String(z)}`, x: 0, y: top, width: 400, fontSize: 10 };
    const rows = [1, 2, 3, 4].flatMap((r) => [
      item(`left ${String(z)}.${String(r)}`, 0, top - r * 10),
      item(`right ${String(z)}.${String(r)}`, 200, top - r * 10),
    ]);
    return [headline, ...rows];
  }).flat();

describe("le nombre de zones d'une page est borné (revue 06/11/2026, point 11)", () => {
  it("quelques zones : chacune se lit en colonnes", () => {
    const columns = readingBands(stackedZones(3), [150]).filter((s) => s.column);
    expect(columns).toHaveLength(6); // two columns per zone
  });

  it("🔴 au-delà du plafond, la page se lit sans nouvelles zones : le reste sort en pleine largeur, rien ne se perd", () => {
    const items = stackedZones(MAX_BAND_ZONES_PER_PAGE + 40);
    const segments = readingBands(items, [150]);
    expect(segments.filter((s) => s.column).length).toBeLessThanOrEqual(2 * (MAX_BAND_ZONES_PER_PAGE + 1));
    expect(segments.flatMap((s) => s.lines).flat()).toHaveLength(items.length);
  });
});
