/**
 * Characterisation (12/10/2026) of `groupItemsIntoLines`: items of empty text are dropped (a space is kept), a raised
 * smaller item is reseated onto the line below, and every line comes out sorted by x.
 */
import { describe, expect, it } from "vitest";
import { groupItemsIntoLines, linesFromGroups } from "./pdf-lines";

const item = (text: string, x: number, y: number, fontSize = 10) => ({ text, x, y, width: 10, fontSize });

describe("groupItemsIntoLines", () => {
  it("drops items of empty text, keeps a space", () => {
    const lines = groupItemsIntoLines([item("b", 20, 100), item("", 5, 100), item(" ", 12, 100), item("a", 0, 100)]);
    expect(lines.map((g) => g.map((i) => i.text))).toEqual([["a", " ", "b"]]);
  });

  it("reseats a raised, smaller item onto the line below, and sorts that line by x", () => {
    const lines = groupItemsIntoLines([item("e", 10, 103, 6.5), item("cd", 12, 100), item("ab", 0, 100)]);
    expect(lines.map((g) => g.map((i) => i.text))).toEqual([["ab", "e", "cd"]]);
  });

  it("lists the lines top to bottom", () => {
    const lines = groupItemsIntoLines([item("low", 0, 50), item("high", 0, 100)]);
    expect(lines.map((g) => g.map((i) => i.text))).toEqual([["high"], ["low"]]);
  });

  // MEASURED (06/11/2026, Alouette bulletin p2): the turned postal mark « 1000 LAUSANNE 12 » (12.5 pt, written upwards at
  // x 82, baseline y 280) and the 7.5 pt line « CCP 10-3056-2 Lausanne. » (y 287) of the masthead beside it came out as ONE
  // line — the smaller line, 6.6 pt above, was reseated onto the turned run as a superscript would be. A turned run belongs
  // to no horizontal line: it is a line of its own, at its height.
  it("🔴 un fragment TOURNÉ fait une ligne à lui seul, à sa hauteur ; la ligne horizontale voisine reste entière", () => {
    // The turned run's horizontal box (x 82..185, its length laid flat) covers the start of « CCP »: the reseating takes it for a host.
    const turned = { ...item("1000 LAUSANNE 12", 82, 280.4, 12.5), width: 102.5, rotated: true };
    const lines = groupItemsIntoLines([
      item("CCP", 131, 287, 7.5),
      turned,
      item("Lausanne.", 150, 287, 7.5),
      item("Abonnements", 131, 271, 7.5),
    ]);
    expect(lines.map((g) => g.map((i) => i.text))).toEqual([
      ["CCP", "Lausanne."],
      ["1000 LAUSANNE 12"],
      ["Abonnements"],
    ]);
  });
});

describe("linesFromGroups — whitespace-only items at the ends of a line", () => {
  it("contribute nothing at the start or the end, and stay between two letter items", () => {
    const [line] = linesFromGroups([
      [item(" ", 0, 100), item("ab", 10, 100), item(" ", 20, 100), item("cd", 30, 100), item(" ", 40, 100)],
    ]);
    expect(line!.text).toBe("ab cd");
    expect(line!.runs.map((r) => r.text).join("")).toBe("ab cd");
  });

  it("a line of blanks only keeps them", () => {
    const [line] = linesFromGroups([[item(" ", 0, 100)]]);
    expect(line!.text).toBe(" ");
  });
});

describe("une lettrine ouvre la première ligne qu'elle surplombe (05/11/2026)", () => {
  // A drop cap sits on the baseline of the third line of its paragraph, so the first two, indented to its right,
  // read before it. A drop cap is a glyph of one or two letters, at least `MIN_DROP_CAP_RATIO` times as high as the
  // body of the lines it overhangs: it opens the highest of them.
  const cap = { text: "C’", x: 207, y: 456, width: 39, fontSize: 36.4 };
  const paragraph = () => [
    item("est devenu un ri-", 245, 475, 9),
    item("tuel. Une semaine", 245, 466, 9),
    cap,
    item("du mois de mars", 245, 456, 9),
    item("est consacrée à la langue fran-", 207, 447, 9),
  ];
  const texts = (lines: { text: string }[][]) => lines.map((line) => line.map((it) => it.text));

  it("🔴 « C' » passe en tête de la première ligne qu'il surplombe, sa propre ligne continue sans lui", () => {
    expect(texts(groupItemsIntoLines(paragraph()))).toEqual([
      ["C’", "est devenu un ri-"],
      ["tuel. Une semaine"],
      ["du mois de mars"],
      ["est consacrée à la langue fran-"],
    ]);
  });

  it("un grand glyphe sans ligne en retrait au-dessus de lui (un numéro de section) reste où il est", () => {
    const items = [
      item("Chapitre précédent, dernière ligne", 100, 475, 9),
      { text: "1", x: 100, y: 456, width: 14, fontSize: 24 },
      item("Titre du chapitre", 120, 456, 24),
    ];
    expect(texts(groupItemsIntoLines(items))).toEqual([
      ["Chapitre précédent, dernière ligne"],
      ["1", "Titre du chapitre"],
    ]);
  });

  it("🔴 « Le » de « Le Monde » en 30 pt, sous un surtitre en 12 pt, est un mot de titre : il ne remonte pas (revue 06/11/2026, point 8)", () => {
    const items = [
      item("SURTITRE", 100, 700, 12),
      { text: "Le", x: 50, y: 680, width: 30, fontSize: 30 },
      { text: "Monde", x: 90, y: 680, width: 90, fontSize: 30 },
    ];
    expect(texts(groupItemsIntoLines(items))).toEqual([["SURTITRE"], ["Le", "Monde"]]);
  });

  it("une lettrine de DEUX lettres (« Un »), dont la ligne ne porte que du corps, remonte comme « C’ »", () => {
    const items = [
      item("est devenu un ri-", 245, 475, 9),
      { text: "Un", x: 207, y: 456, width: 39, fontSize: 36 },
      item("du mois de mars", 245, 456, 9),
    ];
    expect(texts(groupItemsIntoLines(items))).toEqual([["Un", "est devenu un ri-"], ["du mois de mars"]]);
  });

  it("un mot entier en grand corps n'est pas une lettrine", () => {
    const items = [
      item("ligne au-dessus en retrait", 260, 475, 9),
      { text: "GRAND", x: 207, y: 456, width: 50, fontSize: 36 },
      item("suite", 260, 456, 9),
    ];
    expect(texts(groupItemsIntoLines(items))).toEqual([["ligne au-dessus en retrait"], ["GRAND", "suite"]]);
  });
});

/**
 * A drop cap is published in bold, and nothing else. Tried and set aside: bringing it to the body size and gluing
 * it to its word; a visual line crosses every column of the page, so the letter went to another column.
 */
describe("une lettrine se publie en gras, à sa taille et à sa place (12/11/2026, soir)", () => {
  it("🔴 le « L » de 30 pt qui ouvre une ligne de corps 10 pt sort en gras, sans changer de taille ni de place", () => {
    const cap = { text: "L", x: 60, y: 456, width: 28, fontSize: 30 };
    const [line] = linesFromGroups([[cap, item("a Suisse romande", 90, 456, 10)]]);
    expect(line!.runs.map((r) => [r.text, r.bold === true])).toEqual([
      ["L", true],
      ["a Suisse romande", false],
    ]);
    expect([cap.fontSize, cap.x]).toEqual([30, 60]);
  });

  it("un mot entier en grand corps n'est pas une lettrine et ne passe pas en gras", () => {
    const [line] = linesFromGroups([
      [{ text: "GRAND", x: 207, y: 456, width: 50, fontSize: 36 }, item("suite", 260, 456, 9)],
    ]);
    expect(line!.runs.every((r) => r.bold !== true)).toBe(true);
  });

  it("une lettre PLUS PETITE que le corps reste comme elle est : c'est un appel de note", () => {
    const [line] = linesFromGroups([
      [{ text: "a", x: 60, y: 456, width: 3, fontSize: 6 }, item("Le texte de la note", 64, 456, 10)],
    ]);
    expect(line!.runs.every((r) => r.bold !== true)).toBe(true);
  });
});

describe("linesFromGroups — l'italique d'un item passe à son morceau (05/11/2026)", () => {
  const styled = (text: string, x: number, italic: boolean) => ({
    ...item(text, x, 100),
    ...(italic ? { italic: true } : {}),
  });

  it("🔴 un item en italique fait un morceau en italique, et deux items du même style se fondent", () => {
    const [line] = linesFromGroups([
      [
        styled("Elle est", 0, false),
        styled("Adieu", 60, true),
        styled("à Terminus", 100, true),
        styled("et", 160, false),
      ],
    ]);
    // The word-break space leads the piece that follows it, as it does for a bold piece.
    expect(line!.runs.map((r) => `${r.italic === true ? "em:" : ""}${r.text}`)).toEqual([
      "Elle est",
      "em: Adieu à Terminus",
      " et",
    ]);
  });
});
