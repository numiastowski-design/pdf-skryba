import { describe, expect, it } from "vitest";

import { detectPageFurniture, detectRepeatedHeadBlocks, type PageLine } from "./page-furniture";

/** A two-page document: the footer comes back at exactly the same point; the title comes back 0.2 pt apart in y but
 *  17 pt further in x. */
const footer = (): PageLine => ({ y: 29.0, x: 513.2, size: 5.04, text: "© Index Education 2024" });
const title = (x: number, y: number): PageLine => ({ y, x, size: 12.96, text: "Bulletin du 1er Trimestre" });

describe("detectPageFurniture", () => {
  it("reconnaît un pied de page : même texte, même taille, même position", () => {
    const flags = detectPageFurniture([
      [title(291.8, 799.0), footer()],
      [title(274.8, 799.2), footer()],
    ]);
    expect(flags[0]).toEqual([false, true]);
    expect(flags[1]).toEqual([false, true]);
  });

  it("🔴 L'ABSCISSE SAUVE LE TITRE — sans elle, il passerait pour de l'habillage", () => {
    // The two ordinates differ by 0.2 pt only: no reasonable tolerance separates them. The 17 pt in x do.
    const flags = detectPageFurniture([[title(291.8, 799.0)], [title(274.8, 799.2)]]);
    expect(flags[0]).toEqual([false]);
    expect(flags[1]).toEqual([false]);
  });

  it("neutralise les numéros de page", () => {
    const page = (n: number): PageLine => ({ y: 29, x: 300, size: 8, text: `${n} / 2` });
    const flags = detectPageFurniture([[page(1)], [page(2)]]);
    expect(flags.flat()).toEqual([true, true]);
  });

  /** Only a page number may change. Neutralising every number would make two numbered titles at the same point the
   *  same line, and the titles would disappear. */
  const twoPages = (text: (n: number) => string): boolean[] =>
    detectPageFurniture([
      [{ y: 29, x: 72, size: 8, text: text(1) }],
      [{ y: 29, x: 72, size: 8, text: text(2) }],
    ]).flat();

  it.each([
    ["nombre seul", (n: number) => `${n}`],
    ["nombre entre tirets", (n: number) => `- ${n} -`],
    ["n/N", (n: number) => `${n}/30`],
    ["n / N", (n: number) => `${n} / 30`],
    ["n sur N", (n: number) => `${n} sur 30`],
    ["n of N", (n: number) => `${n} of 30`],
    ["p n", (n: number) => `p ${n}`],
    ["p. n", (n: number) => `p. ${n}`],
    ["P n/N", (n: number) => `P ${n}/30`],
    ["Page n", (n: number) => `Page ${n}`],
    ["page n sur N", (n: number) => `page ${n} sur 30`],
    ["un mot de page dans une ligne plus longue", (n: number) => `Rapport annuel 2024 — Page ${n}`],
  ])("reconnaît un numéro de page : %s", (_label, text) => {
    expect(twoPages(text)).toEqual([true, true]);
  });

  it.each([
    ["un titre numéroté", (n: number) => `Annexe ${n}`],
    ["un n/N derrière un mot qui n'est pas un mot de page", (n: number) => `Annexe ${n}/3`],
    ["un autre nombre que le numéro de page", (n: number) => `Rapport annuel ${2023 + n} — Page ${n}`],
    ["« P1 » collé, qui n'est pas « p 1 »", (n: number) => `P${n}`],
  ])("garde une ligne qui change autrement que par un numéro de page : %s", (_label, text) => {
    expect(twoPages(text)).toEqual([false, false]);
  });

  it("une ligne DANS l'emprise d'un tableau n'est jamais de l'habillage", () => {
    // A table header repeats too: a document whose pages each start their table at the same ordinate would lose its
    // headers.
    const header = (): PageLine => ({ y: 700, x: 62.6, size: 6.48, text: "Matières Pos. Appréciations" });
    const bands = [[{ top: 707, bottom: 305 }], [{ top: 707, bottom: 305 }]];
    expect(detectPageFurniture([[header()], [header()]], bands).flat()).toEqual([false, false]);
    // Without the guard, the same input is furniture.
    expect(detectPageFurniture([[header()], [header()]]).flat()).toEqual([true, true]);
  });

  it("🔴 une ligne répétée au MILIEU de la page n'est JAMAIS de l'habillage", () => {
    // Without this constraint, a document whose two pages share a layout would see all its content removed as
    // furniture.
    const milieu = (): PageLine => ({ y: 400, x: 50, size: 10, text: "Ce paragraphe occupe toute la largeur" });
    const haut = (t: string): PageLine => ({ y: 780, x: 50, size: 10, text: t });
    // The two first lines do not repeat: they stop the walk from the top. (Numbering them "page 1" and "page 2"
    // would not do: neutralised digits would make them identical.)
    const flags = detectPageFurniture([
      [haut("sommaire"), milieu(), footer()],
      [haut("annexes"), milieu(), footer()],
    ]);
    expect(flags[0]).toEqual([false, false, true]);
    expect(flags[1]).toEqual([false, false, true]);
  });

  it("un habillage de PLUSIEURS lignes est reconnu en entier", () => {
    const l1 = (): PageLine => ({ y: 800, x: 50, size: 8, text: "Société Machin" });
    const l2 = (): PageLine => ({ y: 790, x: 50, size: 8, text: "12 rue des Lilas" });
    const corps = (t: string): PageLine => ({ y: 400, x: 50, size: 10, text: t });
    const flags = detectPageFurniture([
      [l1(), l2(), corps("contenu un")],
      [l1(), l2(), corps("contenu deux")],
    ]);
    expect(flags[0]).toEqual([true, true, false]);
  });

  it("un document d'UNE page n'a pas d'habillage — deux occurrences sont la preuve minimale", () => {
    expect(detectPageFurniture([[footer(), title(291.8, 799.0)]]).flat()).toEqual([false, false]);
  });

  it("deux occurrences sur la MÊME page ne prouvent rien", () => {
    expect(detectPageFurniture([[footer(), footer()], [title(274.8, 799.2)]]).flat()).toEqual([false, false, false]);
  });

  it("une taille différente n'est pas la même ligne", () => {
    const big: PageLine = { ...footer(), size: 9 };
    expect(detectPageFurniture([[footer()], [big]]).flat()).toEqual([false, false]);
  });

  /** The footer of fixture 47 (Caisse des dépôts loan contract, pages 5 to 25), measured on 13/10/2026: three lines
   *  repeat exactly, the fourth carries the page number glued to an address (« …example.org5/21 » here: the address is an example's). */
  const cdcFooter = (n: number): PageLine[] => [
    { y: 87.4, x: 56.7, size: 10, text: `body line ${n === 5 ? "one" : "two"}` },
    { y: 49.8, x: 56.7, size: 8, text: "Caisse des dépôts et consignations" },
    { y: 39.9, x: 56.7, size: 9, text: "60 rue de la Vallée - CS 91142 - 80011 Amiens cedex 1" },
    { y: 31.9, x: 28.0, size: 6, text: `PR0090-PR0068 V3.33 page ${n}/21Contrat de prêt n° 138624` },
    { y: 30.1, x: 56.7, size: 9, text: `hauts-de-france@example.org${n}/21` },
  ];

  it("a footer line that changes only by its digits belongs to a footer block that holds an exact repeat", () => {
    const flags = detectPageFurniture([cdcFooter(5), cdcFooter(6)]);
    expect(flags[0]).toEqual([false, true, true, true, true]);
    expect(flags[1]).toEqual([false, true, true, true, true]);
  });

  it("a line that changes only by its digits, alone at its edge, stays content (« Annexe 1 », fixture 19)", () => {
    const alone = (n: number): PageLine[] => [
      { y: 30.1, x: 56.7, size: 9, text: `hauts-de-france@example.org${n}/21` },
    ];
    expect(detectPageFurniture([alone(5), alone(6)]).flat()).toEqual([false, false]);
  });

  it("a block of lines that change only by their digits, with no exact repeat, stays content", () => {
    const block = (n: number): PageLine[] => [
      { y: 780, x: 72, size: 16, text: `Annexe ${n}` },
      { y: 765, x: 72, size: 11, text: `Version ${n}.0` },
    ];
    expect(detectPageFurniture([block(1), block(2)]).flat()).toEqual([false, false, false, false]);
  });

  it("the digit-only change does not let the edge walk cross a line that does not repeat", () => {
    const page = (n: number, body: string): PageLine[] => [
      { y: 60, x: 56.7, size: 9, text: body },
      { y: 49.8, x: 56.7, size: 8, text: "Caisse des dépôts et consignations" },
      { y: 39.9, x: 56.7, size: 9, text: `réf ${n}` },
    ];
    const flags = detectPageFurniture([page(1, "un paragraphe"), page(2, "un autre paragraphe")]);
    expect(flags[0]).toEqual([false, true, true]);
    expect(flags[1]).toEqual([false, true, true]);
  });

  /** Fixture 47, pages 29 to 40 (13/10/2026): the amortisation table's band runs from 779.33 down to 56.81, over the
   *  page's footer. */
  const tableFooterPage = (body: string): PageLine[] => [
    { y: 700, x: 62.6, size: 9, text: "N° d'échéance Date Total" },
    { y: 400, x: 62.6, size: 9, text: body },
    { y: 56.7, x: 156.2, size: 8, text: "CAISSE DES DÉPÔTS ET CONSIGNATIONS" },
    { y: 39.3, x: 570.0, size: 6, text: "Offre Contractuelle n° 138624" },
  ];
  const pageWideBand = [[{ top: 779.33, bottom: 56.81 }], [{ top: 779.33, bottom: 56.81 }]];

  it("a footer line in the lower half of a table band is furniture: a table header sits at the top of its table", () => {
    const flags = detectPageFurniture([tableFooterPage("rows one"), tableFooterPage("rows two")], pageWideBand);
    expect(flags[0]).toEqual([false, false, true, true]);
    expect(flags[1]).toEqual([false, false, true, true]);
  });

  it("inside a table band, a data row that changes only by its digits is never furniture, even next to the footer", () => {
    // Review of 13/10/2026: amortisation rows at a fixed pitch, same place on every page, only their figures differ.
    const page = (n: number): PageLine[] => [
      { y: 700, x: 62.6, size: 9, text: "N° d'échéance Date Total" },
      { y: 94, x: 62, size: 9, text: `1 23${n},50` },
      { y: 82, x: 62, size: 9, text: `2 34${n},10` },
      { y: 70, x: 62, size: 9, text: `3 45${n},00` },
      { y: 56.7, x: 156.2, size: 8, text: "CAISSE DES DÉPÔTS ET CONSIGNATIONS" },
      { y: 39.3, x: 570.0, size: 6, text: "Offre Contractuelle n° 138624" },
    ];
    const flags = detectPageFurniture([page(1), page(2)], pageWideBand);
    expect(flags[0]).toEqual([false, false, false, false, true, true]);
    expect(flags[1]).toEqual([false, false, false, false, true, true]);
  });

  it("the table header, in the upper half of the band, stays protected even when it is the page's first line", () => {
    const flags = detectPageFurniture([tableFooterPage("rows one"), tableFooterPage("rows two")], pageWideBand);
    expect(flags[0]![0]).toBe(false);
    expect(flags[1]![0]).toBe(false);
  });
});

describe("detectRepeatedHeadBlocks", () => {
  /** Page 2 reopens with four lines that already exist on page 1, redrawn 17 pt further left. Page 1 keeps the lines
   *  in between: without them the repeated lines would be further apart than the contiguity bound, outside the head
   *  block. */
  const page1 = (): PageLine[] => [
    { y: 800.1, x: 119.9, size: 9.01, text: "en-tête du collège, ligne 1" },
    { y: 799.0, x: 291.8, size: 12.96, text: "Bulletin du 1er Trimestre" },
    { y: 791.7, x: 135.1, size: 6.96, text: "en-tête du collège, ligne 2" },
    { y: 783.7, x: 143.9, size: 6.96, text: "en-tête du collège, ligne 3" },
    { y: 779.7, x: 291.8, size: 9.96, text: "NOM Prénom de l'élève" },
    { y: 770.1, x: 291.8, size: 7.92, text: "identification, ligne 1" },
    { y: 768.4, x: 141.0, size: 6.0, text: "en-tête du collège, ligne 4" },
    { y: 761.4, x: 162.1, size: 6.0, text: "en-tête du collège, ligne 5" },
    { y: 743.2, x: 291.8, size: 9.96, text: "402" },
    { y: 733.6, x: 291.8, size: 7.92, text: "identification, ligne 2" },
    { y: 726.8, x: 28.3, size: 7.92, text: "Année scolaire : 2023/2024" },
  ];
  const page2 = (): PageLine[] => [
    { y: 803.4, x: 28.3, size: 8.04, text: "Année scolaire : 2023/2024" },
    { y: 799.2, x: 274.8, size: 12.96, text: "Bulletin du 1er Trimestre" },
    { y: 792.0, x: 28.3, size: 9.96, text: "402" },
    { y: 783.4, x: 274.8, size: 9.96, text: "NOM Prénom de l'élève" },
    { y: 700.0, x: 28.3, size: 9.0, text: "du contenu propre à la page 2" },
  ];

  it("jette la reprise en tête de la page 2, et ne touche pas la page 1", () => {
    const flags = detectRepeatedHeadBlocks([page1(), page2()]);
    expect(flags[0]).toEqual(page1().map(() => false));
    expect(flags[1]).toEqual([true, true, true, true, false]);
  });

  /** The same block redrawn at the head of a page: its two conditions. Comparing the text alone, a contents entry
   *  would condemn the section title that opens a later page, silently. */
  const sectionTitle = (): PageLine => ({ y: 770, x: 72, size: 14, text: "Conditions de retour" });
  const afterTitle = (): PageLine => ({ y: 748, x: 72, size: 11, text: "la prose de la section" });

  it("A — la première occurrence doit être dans le BLOC DE TÊTE de sa page", () => {
    const avant: PageLine[] = [
      { y: 770, x: 72, size: 20, text: "Contrat de service" },
      { y: 400, x: 72, size: 14, text: "Conditions de retour" }, // same size, but mid-page
    ];
    expect(detectRepeatedHeadBlocks([avant, [sectionTitle(), afterTitle()]])[1]).toEqual([false, false]);
  });

  it("B — la première occurrence doit avoir la MÊME TAILLE", () => {
    // The contents sit right under the title of page 1, hence inside its head block: A alone does not save the
    // section title; the size does.
    const avant: PageLine[] = [
      { y: 770, x: 72, size: 20, text: "Contrat de service" },
      { y: 730, x: 72, size: 14, text: "Sommaire" },
      { y: 708, x: 90, size: 11, text: "Objet du contrat" },
      { y: 692, x: 90, size: 11, text: "Conditions de retour" },
    ];
    expect(detectRepeatedHeadBlocks([avant, [sectionTitle(), afterTitle()]])[1]).toEqual([false, false]);
  });

  it("A et B réunies : la même ligne en tête, à la même taille, reste une reprise", () => {
    const avant: PageLine[] = [{ y: 770, x: 72, size: 14, text: "Conditions de retour" }];
    expect(detectRepeatedHeadBlocks([avant, [sectionTitle(), afterTitle()]])[1]).toEqual([true, false]);
  });

  it("s'arrête à la première ligne JAMAIS VUE — c'est ce qui borne le risque", () => {
    const lines = page2();
    lines[1] = { ...lines[1]!, text: "un titre inédit" };
    const flags = detectRepeatedHeadBlocks([page1(), lines]);
    expect(flags[1]).toEqual([true, false, false, false, false]);
  });

  it("une reprise AILLEURS qu'en tête de page est conservée", () => {
    const lines: PageLine[] = [
      { y: 800, x: 28, size: 9, text: "propre à la page 2" },
      { y: 780, x: 28, size: 9, text: "Bulletin du 1er Trimestre" },
    ];
    expect(detectRepeatedHeadBlocks([page1(), lines])[1]).toEqual([false, false]);
  });

  it("ne touche JAMAIS une ligne dans l'emprise d'un tableau", () => {
    const lines: PageLine[] = [{ y: 700, x: 28, size: 9, text: "402" }];
    expect(detectRepeatedHeadBlocks([page1(), lines], [[], [{ top: 707, bottom: 305 }]])[1]).toEqual([false]);
  });

  it("compare le texte EXACT : « 402 » n'est pas « 4 »", () => {
    // Neutralising digits belongs to furniture detection, not here: it would make a number match a lone digit.
    const avant: PageLine[] = [{ y: 500, x: 28, size: 9, text: "4" }];
    const apres: PageLine[] = [{ y: 800, x: 28, size: 9, text: "402" }];
    expect(detectRepeatedHeadBlocks([avant, apres])[1]).toEqual([false]);
  });
});

describe("detectPageFurniture: page counters the grammar missed (corpus-local 14/10/2026)", () => {
  const at = (text: string, y = 29): PageLine => ({ y, x: 72, size: 8, text });
  const pair = (a: string, b: string): boolean[] => detectPageFurniture([[at(a)], [at(b)]]).flat();

  it.each([
    ["Page | 1 (002)", "UNCLASSIFIED Page | 1", "UNCLASSIFIED Page | 2"],
    ["Strona n z N (092)", "Strona 1 z 11", "Strona 2 z 11"],
    ["Pagina n (085)", "Pagina 1", "Pagina 2"],
    ["Seite n von N", "Seite 1 von 9", "Seite 2 von 9"],
    ["Página n de N", "Página 1 de 9", "Página 2 de 9"],
    [
      "Roman numerals (113, 116, 132)",
      "Controlled Unclassified Information Page ii",
      "Controlled Unclassified Information Page iii",
    ],
    ["capital Roman numerals", "Report Page IV", "Report Page V"],
    ["str. n", "str. 4", "str. 5"],
  ])("neutralises %s", (_label, a, b) => {
    expect(pair(a, b)).toEqual([true, true]);
  });

  it.each([
    ["a word that only starts like a Roman numeral", "Page mix", "Page mixed"],
    ["a page word without a number", "Page break", "Page breaks"],
    ["a longer word that starts with a page word", "Paginate 1", "Paginate 2"],
  ])("keeps %s as content", (_label, a, b) => {
    expect(pair(a, b)).toEqual([false, false]);
  });

  /** 084 (« …AWS Schweiz 2 »), 064 (« …STUDENTS 3 »), 063 (« … 1 / 7 October 7, 2025 / HB »), 037 (« 1 | G l o s s a i r e »). */
  const footer = (n: number): PageLine => at(`Registration form Training and Education AWS Switzerland ${n}`, 36);
  const body = (t: string): PageLine => ({ y: 400, x: 72, size: 10, text: t });

  it("a number glued to the end of a long footer line, rising with the page index, makes the line furniture", () => {
    const flags = detectPageFurniture([
      [body("one"), footer(2)],
      [body("two"), footer(3)],
      [body("three"), footer(4)],
    ]);
    expect(flags).toEqual([
      [false, true],
      [false, true],
      [false, true],
    ]);
  });

  it("a counter in the MIDDLE of the line counts too (063: « file.docx 1 / 7 October 7, 2025 / HB »)", () => {
    // The total after the slash is the document's own page count (7 pages here).
    const line = (n: number): PageLine => at(`063-form-final.docx ${n} / 7 October 7, 2025 / HB`, 18);
    const pages = Array.from({ length: 7 }, (_, i) => [body(`p${i}`), line(i + 1)]);
    expect(detectPageFurniture(pages)).toEqual(pages.map(() => [false, true]));
  });

  it("the number must follow the page index: a figure that does not rise stays content", () => {
    const flags = detectPageFurniture([
      [body("one"), footer(7)],
      [body("two"), footer(3)],
      [body("three"), footer(4)],
    ]);
    expect(flags.flat()).toEqual([false, false, false, false, false, false]);
  });

  it("a figure that is a year stays content even if it changes by one per page (« Rapport annuel 2024 »)", () => {
    const year = (n: number): PageLine => at(`Rapport annuel de la societe ${2023 + n}`, 36);
    expect(
      detectPageFurniture([
        [body("one"), year(1)],
        [body("two"), year(2)],
      ]).flat(),
    ).toEqual([false, false, false, false]);
  });

  it("a figure glued to letters (« …org5/21 ») is not a counter: it needs an exact anchor next to it", () => {
    const glued = (n: number): PageLine => at(`hauts-de-france@example.org${n}/21`, 36);
    expect(
      detectPageFurniture([
        [body("one"), glued(5)],
        [body("two"), glued(6)],
      ]).flat(),
    ).toEqual([false, false, false, false]);
  });

  it("a short title (« Annexe technique 1 », two words of text) is never a counter even if it rises with the page", () => {
    const title = (n: number): PageLine => at(`Annexe technique ${n}`, 36);
    expect(
      detectPageFurniture([
        [body("one"), title(1)],
        [body("two"), title(2)],
      ]).flat(),
    ).toEqual([false, false, false, false]);
  });

  it("a one-per-page title with a rising figure in the MIDDLE is content, never a counter (review 14/10/2026)", () => {
    const article = (n: number): PageLine => at(`Article ${n} : Dispositions generales du reglement`, 36);
    expect(
      detectPageFurniture([
        [body("one"), article(1)],
        [body("two"), article(2)],
      ]).flat(),
    ).toEqual([false, false, false, false]);
    const step = (n: number): PageLine => at(`Step ${n} of 3 Choose your plan`, 36);
    expect(
      detectPageFurniture([
        [body("a"), step(1)],
        [body("b"), step(2)],
        [body("c"), step(3)],
      ]).flat(),
    ).toEqual([false, false, false, false, false, false]);
  });

  it("« n of TOTAL » closing the line counts when TOTAL is the page count (243, 240); « Step n of 3 Choose your plan » does not", () => {
    const line = (n: number): PageLine => at(`doi.org/10.5281/zenodo.7890337 - ${n} of 3`, 36);
    const pages = [1, 2, 3].map((n) => [body(`p${n}`), line(n)]);
    expect(detectPageFurniture(pages)).toEqual(pages.map(() => [false, true]));
    const wrongTotal = [1, 2].map((n) => [body(`p${n}`), line(n)]);
    expect(detectPageFurniture(wrongTotal).flat()).toEqual([false, false, false, false]);
  });

  it("a figure at the START of the line counts (037: « 1 | Glossaire »)", () => {
    const line = (n: number): PageLine => at(`${n} | Glossaire of the registration form`, 36);
    expect(
      detectPageFurniture([
        [body("a"), line(1)],
        [body("b"), line(2)],
      ]),
    ).toEqual([
      [false, true],
      [false, true],
    ]);
  });

  it("a letter-spaced line keeps its word count: « N | G l o s s a i r e » is still a counter (review 15/10/2026)", () => {
    expect(pair("1 | G l o s s a i r e", "2 | G l o s s a i r e")).toEqual([true, true]);
  });

  it("two lines of one page sharing the pattern disqualify the group (no unique counter)", () => {
    const g = (n: number): PageLine[] => [
      at(`Registration form Training and Education AWS Switzerland ${n}`, 36),
      at(`Registration form Training and Education AWS Switzerland ${n + 5}`, 36.2),
    ];
    expect(detectPageFurniture([g(1), g(2)]).flat()).toEqual([false, false, false, false]);
  });
});

describe("detectPageFurniture: a repeated block at the page edge inside a table band (074 Geneva form)", () => {
  const H = 842;
  const head = (): PageLine[] => [
    { y: 818.9, x: 56.6, size: 9, text: "REPUBLIQUE ET CANTON DE GENEVE" },
    { y: 808.6, x: 56.6, size: 9, text: "Departement de l'instruction publique" },
    { y: 798.1, x: 56.6, size: 9, text: "Office de l'enfance et de la jeunesse" },
  ];
  const page = (body: string): PageLine[] => [...head(), { y: 500, x: 60, size: 10, text: body }];
  const bands = [[{ top: 836.3, bottom: 779.8 }], [{ top: 836.3, bottom: 779.8 }]];

  it("is furniture when the page heights say the repeat sits at the page edge", () => {
    expect(detectPageFurniture([page("a"), page("b")], bands, [H, H]).flat()).toEqual([
      true,
      true,
      true,
      false,
      true,
      true,
      true,
      false,
    ]);
  });

  it("stays protected without page heights (legacy behaviour)", () => {
    expect(detectPageFurniture([page("a"), page("b")], bands).flat()).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("a repeated table header AT the page edge (narrow margins), with data rows below it in the band, stays: its words are never lost (review 14/10/2026)", () => {
    const longTable = (row: string): PageLine[] => [
      { y: 800, x: 62.6, size: 9, text: "N° d'échéance Date Total" },
      { y: 780, x: 62.6, size: 9, text: row },
      { y: 400, x: 72, size: 10, text: `after ${row}` },
    ];
    const b = [[{ top: 810, bottom: 760 }], [{ top: 810, bottom: 760 }]];
    expect(detectPageFurniture([longTable("row one"), longTable("row two")], b, [H, H]).flat()).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("a page-wide frame (its band reaches the page edge) is no table: the banner inside it is furniture (docx-reel/06 cover, review 14/10/2026)", () => {
    const cover = (t: string): PageLine[] => [
      { y: 817.4, x: 56, size: 10, text: "OFFICIAL" },
      { y: 793.6, x: 56, size: 16, text: t },
      { y: 400, x: 56, size: 12, text: `body ${t}` },
    ];
    const frame = [[{ top: 844.9, bottom: 0.3 }], [{ top: 844.9, bottom: 0.3 }]];
    expect(detectPageFurniture([cover("a"), cover("b")], frame, [H, H])[0]).toEqual([true, false, false]);
  });

  it("a band holding ONLY repeated edge lines is still a banner (074), whatever the row count", () => {
    const one = (t = "x"): PageLine[] => [
      { y: 800, x: 62.6, size: 9, text: "Departement de l'instruction publique" },
      { y: 400, x: 72, size: 10, text: t },
    ];
    const b = [[{ top: 810, bottom: 790 }], [{ top: 810, bottom: 790 }]];
    expect(detectPageFurniture([one("a"), one("b")], b, [H, H])[0]).toEqual([true, false]);
  });

  it("a repeated table header far from the page edge stays protected even with heights", () => {
    const tableHeader = (body: string): PageLine[] => [
      { y: 700, x: 62.6, size: 9, text: "N° d'échéance Date Total" },
      { y: 400, x: 62.6, size: 9, text: body },
    ];
    const b = [[{ top: 779.33, bottom: 300 }], [{ top: 779.33, bottom: 300 }]];
    expect(detectPageFurniture([tableHeader("a"), tableHeader("b")], b, [H, H]).flat()).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });
});

describe("detectPageFurniture: a banner above a lone page number (094 Polish form)", () => {
  const page = (n: number, gap: number): PageLine[] => [
    { y: 400, x: 72, size: 10, text: `corps ${n}` },
    { y: 380, x: 72, size: 10, text: `suite ${n}` },
    { y: 360, x: 72, size: 10, text: `fin ${n}` },
    { y: 84.1, x: 106.9, size: 9, text: "Projekt wspolfinansowany ze srodkow Unii Europejskiej" },
    { y: 73.2, x: 214.1, size: 9, text: "Program Operacyjny Wiedza Edukacja Rozwoj" },
    { y: 73.2 - gap, x: 519, size: 11, text: `${n}` },
  ];

  it("the run crosses a 34.8 pt gap to reach the repeated banner", () => {
    expect(detectPageFurniture([page(1, 34.8), page(2, 34.8)]).flat()).toEqual([
      false,
      false,
      false,
      true,
      true,
      true,
      false,
      false,
      false,
      true,
      true,
      true,
    ]);
  });

  it("a gap beyond the bound still stops the run", () => {
    expect(detectPageFurniture([page(1, 120), page(2, 120)]).flat()).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
  });

  it("a page whose lines mostly repeat (the same layout twice, fixture 11) never lets a run cross a gap", () => {
    const twin = (): PageLine[] => [
      { y: 700, x: 72, size: 10, text: "Etape 1 : ouvrir le dossier" },
      { y: 650, x: 72, size: 10, text: "Regle A : jamais de doublon" },
      { y: 600, x: 72, size: 10, text: "Etape 2 : verifier" },
      { y: 90, x: 72, size: 9, text: "pied" },
    ];
    const near = (): PageLine[] => [...twin().slice(0, 3), { y: 560, x: 72, size: 10, text: "pied" }];
    // Legacy: the first and last lines are furniture; the 40 pt gap (<= 6 sizes) is NOT crossed to the exact lines above.
    expect(detectPageFurniture([near(), near()]).flat()).toEqual([true, false, false, true, true, false, false, true]);
  });

  it("the line beyond the gap must repeat EXACTLY: a line that repeats only by its digits does not join", () => {
    const p = (n: number): PageLine[] => [
      { y: 400, x: 72, size: 10, text: `corps ${n}` },
      { y: 84.1, x: 106.9, size: 9, text: `Note ${n === 1 ? 7 : 3} de bas de page` },
      { y: 38.4, x: 519, size: 11, text: `${n}` },
    ];
    expect(detectPageFurniture([p(1), p(2)]).flat()).toEqual([false, false, true, false, false, true]);
  });
});

describe("detectPageFurniture: a run never swallows the page (024 hydralabplus p6-p7)", () => {
  // Two template pages whose 23 lines differ only by a digit: every line is loose-equal across the pages.
  const tpl = (n: number): PageLine[] =>
    Array.from({ length: 23 }, (_, i) => ({
      y: 756.9 - i * 18,
      x: 72,
      size: 10,
      text: i === 0 ? `${n} Instrumentation NAME${n}` : `${n}.${i} item text ${n}`,
    }));
  // A header line that repeats exactly anchors the walk, then 22 loose lines follow.
  const anchored = (n: number): PageLine[] => [{ y: 780, x: 72, size: 10, text: "Template header" }, ...tpl(n)];

  it("refuses a run that covers more than half of a long page", () => {
    const flags = detectPageFurniture([anchored(3), anchored(4)]);
    expect(flags[0]!.filter(Boolean)).toHaveLength(0);
    expect(flags[1]!.filter(Boolean)).toHaveLength(0);
  });

  it("still removes a short page that is only furniture (a blank page with its number)", () => {
    const blank = (n: number): PageLine[] => [{ y: 40, x: 300, size: 9, text: `${n}` }];
    expect(detectPageFurniture([blank(1), blank(2)]).flat()).toEqual([true, true]);
  });
});

describe("detectRepeatedHeadBlocks: only at the page edge (054 p6, 120 p7, 047 p5)", () => {
  const H = 842;
  const text = "(i) the cumulative amount of payments the partner requests as reimbursement of actual";
  const first: PageLine[] = [{ y: 700, x: 127.6, size: 12, text }];
  // The clause opens page 3, but 130 pt under the top edge.
  const later: PageLine[] = [
    { y: 709.9, x: 127.6, size: 12, text },
    { y: 690, x: 72, size: 12, text: "other text" },
  ];
  const cover: PageLine[] = [{ y: 750, x: 1, size: 12, text: "cover" }];

  it("without page heights the legacy rule applies", () => {
    expect(detectRepeatedHeadBlocks([cover, first, later])[2]).toEqual([true, false]);
  });

  it("a text repeated at the head of a page but away from the edge band is content", () => {
    expect(detectRepeatedHeadBlocks([cover, first, later], [], [H, H, H])[2]).toEqual([false, false]);
  });

  it("a repeat inside the top edge band is still dropped (the bulletin keeps its behaviour)", () => {
    const one: PageLine[] = [
      { y: 799, x: 291.8, size: 12.96, text: "Bulletin du 1er Trimestre" },
      { y: 700, x: 1, size: 9, text: "x" },
    ];
    const two: PageLine[] = [
      { y: 799.2, x: 274.8, size: 12.96, text: "Bulletin du 1er Trimestre" },
      { y: 700, x: 1, size: 9, text: "y" },
    ];
    expect(detectRepeatedHeadBlocks([one, two], [], [H, H])[1]).toEqual([true, false]);
  });
});

describe("pages whose view does not start at y = 0 (print PDFs with bleed: CropBox [0, 28, 595, 814])", () => {
  // Page height 786, bottom 28: the top edge band (7 %) starts at raw y = 28 + 786 * 0.93 = 759.
  const HEIGHTS = [786, 786];
  const BOTTOMS = [28, 28];

  it("keeps a head repeated at 8 % from the TOP edge (it is text, not a redrawn header)", () => {
    const head = (): PageLine => ({ y: 28 + 786 * 0.92, x: 28, size: 9, text: "Clause reopened on each page" });
    const body = (n: number): PageLine => ({ y: 600, x: 28, size: 9, text: `body ${n}` });
    const flags = detectRepeatedHeadBlocks(
      [
        [head(), body(1)],
        [head(), body(2)],
      ],
      [],
      HEIGHTS,
      BOTTOMS,
    );
    expect(flags[1]).toEqual([false, false]);
  });

  it("still drops a head repeated inside the top band of such a page", () => {
    const head = (): PageLine => ({ y: 28 + 786 * 0.97, x: 28, size: 9, text: "Redrawn header" });
    const body = (n: number): PageLine => ({ y: 600, x: 28, size: 9, text: `body ${n}` });
    const flags = detectRepeatedHeadBlocks(
      [
        [head(), body(1)],
        [head(), body(2)],
      ],
      [],
      HEIGHTS,
      BOTTOMS,
    );
    expect(flags[1]).toEqual([true, false]);
  });

  it("a long table reaching the top band is not a page frame: its repeated header stays", () => {
    const header = (): PageLine => ({ y: 795, x: 40, size: 8, text: "Item Quantity Price" });
    const row = (n: number): PageLine => ({ y: 700, x: 40, size: 8, text: `row ${n}` });
    const bands = [[{ top: 800, bottom: 300 }], [{ top: 800, bottom: 300 }]];
    const flags = detectPageFurniture(
      [
        [header(), row(1)],
        [header(), row(2)],
      ],
      bands,
      HEIGHTS,
      BOTTOMS,
    );
    expect(flags.flat()).toEqual([false, false, false, false]);
  });
});

describe("detectPageFurniture: a page counter in the middle of a short edge line (corpus-local 15/10/2026: 122, 157, 176, 165, 177, 179, 181, 264)", () => {
  const H = 792;
  const WORDS = ["alpha", "bravo", "charlie", "delta", "echo"];
  const body = (n: number): PageLine => ({ y: 400, x: 72, size: 12, text: `body paragraph ${WORDS[n]}` });
  const edge = (text: string, y: number, x = 77.4): PageLine => ({ y, x, size: 9, text });
  const run = (pages: number, make: (n: number) => PageLine, first = 1): boolean[][] =>
    detectPageFurniture(
      Array.from({ length: pages }, (_, i) => [body(i), make(first + i)].sort((a, b) => b.y - a.y)),
      [],
      Array.from({ length: pages }, () => H),
    );

  it("122: « September 2021 N SY 2021-22 » at the bottom edge, four pages, is furniture", () => {
    expect(run(4, (n) => edge(`September 2021 ${n} SY 2021-22`, 51))).toEqual([
      [false, true],
      [false, true],
      [false, true],
      [false, true],
    ]);
  });

  it("264: « 14/10/2026 0078.docx N » (one word of text) is furniture", () => {
    expect(run(3, (n) => edge(`14/10/2026 0078.docx ${n}`, 38, 56.6))).toEqual([
      [false, true],
      [false, true],
      [false, true],
    ]);
  });

  it("165: « 430 - N » (no word at all) is furniture", () => {
    expect(run(3, (n) => edge(`430 - ${n}`, 746.6, 72))).toEqual([
      [true, false],
      [true, false],
      [true, false],
    ]);
  });

  it("0000523: a printed web page's footer « URL…b9N/3 » (the counter glued to the URL's last letter, total 3 of a 3-page attachment) is furniture", () => {
    const url = (n: number): PageLine =>
      edge(`https://edge.example.org/openDiscViewer.do?edge_no=ca727a853dc3ce645d542af6f1e997b9${n}/3`, 17, 26.4);
    expect(run(3, url)).toEqual([
      [false, true],
      [false, true],
      [false, true],
    ]);
    expect(
      run(3, (n) => ({ ...url(n), y: 300 }))
        .flat()
        .some(Boolean),
    ).toBe(false);
  });

  it("a figure glued to a word with no « /total » behind it is not a counter (« fr5 » style references)", () => {
    expect(
      run(3, (n) =>
        edge(`https://edge.example.org/openDiscViewer.do?edge_no=ca727a853dc3ce645d542af6f1e997b9${n}`, 17, 26.4),
      )
        .flat()
        .some(Boolean),
    ).toBe(false);
  });

  it("two pages are not enough for the relaxed counter", () => {
    expect(run(2, (n) => edge(`September 2021 ${n} SY 2021-22`, 51)).flat()).toEqual([false, false, false, false]);
  });

  it("the same line in the middle of the page is never furniture", () => {
    expect(
      run(4, (n) => edge(`September 2021 ${n} SY 2021-22`, 300))
        .flat()
        .some(Boolean),
    ).toBe(false);
  });

  it("a one-per-page title at the edge with no other figure stays (« Annexe N », fixture 19)", () => {
    expect(
      run(4, (n) => edge(`Annexe ${n}`, 760))
        .flat()
        .some(Boolean),
    ).toBe(false);
  });

  it("a one-per-page title BIGGER than the body (« Question N of 20 », « 15 October 2026 ») stays: page furniture is body-sized or smaller", () => {
    const big = (text: (n: number) => string): boolean[][] =>
      run(4, (n) => ({ y: 760, x: 72, size: 18, text: text(n) }));
    expect(
      big((n) => `Question ${n} of 20`)
        .flat()
        .some(Boolean),
    ).toBe(false);
    expect(
      big((n) => `${14 + n} October 2026`)
        .flat()
        .some(Boolean),
    ).toBe(false);
  });

  it("39: a footer one point larger than the body (11 over 10) is still furniture; only a clearly bigger line is a title", () => {
    const small = (n: number): PageLine => ({
      y: 400,
      x: 72,
      size: 10,
      text: `body paragraph ${WORDS[n]} `.repeat(12),
    });
    const pages = [1, 2, 3, 4].map((n) =>
      [small(n - 1), edge(`MENJ - Fiche technique de la note de service du 21 juin 2023 ${n} / 6`, 48.9, 34.6)].map(
        (l) => (l.y === 48.9 ? { ...l, size: 11 } : l),
      ),
    );
    expect(
      detectPageFurniture(
        pages,
        [],
        Array.from({ length: 4 }, () => H),
      ),
    ).toEqual(pages.map(() => [false, true]));
  });

  it("a page word AFTER the figure after a bar is a counter: « N | Page » (206), also letter-spaced « N | P a g e »", () => {
    const pages = (text: (n: number) => string): boolean[][] => run(3, (n) => edge(text(n), 17.5, 501));
    expect(pages((n) => `${n} | Page`)).toEqual([
      [false, true],
      [false, true],
      [false, true],
    ]);
    expect(pages((n) => `${n} | P a g e`)).toEqual([
      [false, true],
      [false, true],
      [false, true],
    ]);
  });

  it("177: a duplex layout swaps the margin page by page (« 388 - N » at x=509 then x=72): still one counter", () => {
    expect(run(3, (n) => edge(`388 - ${n}`, 746.6, n % 2 === 1 ? 509 : 72))).toEqual([
      [true, false],
      [true, false],
      [true, false],
    ]);
  });

  it("122: lower-case Roman front matter (« September 2021 ii SY 2021-22 ») counts as the same counter", () => {
    const roman = ["i", "ii", "iii", "iv"];
    expect(run(4, (n) => edge(`September 2021 ${roman[n - 1]} SY 2021-22`, 51))).toEqual([
      [false, true],
      [false, true],
      [false, true],
      [false, true],
    ]);
  });

  it("a Roman numeral that does not follow the page index stays (« Part ii » / « Part v » / « Part iii »)", () => {
    const part = ["ii", "v", "iii"];
    expect(
      run(3, (n) => edge(`2021 Part ${part[n - 1]} report`, 51))
        .flat()
        .some(Boolean),
    ).toBe(false);
  });
});

describe("detectPageFurniture: a repeated block at the top of a page is furniture only if it is repeated enough (080, 024, 189; 15/10/2026)", () => {
  const H = 842;
  const heights = (n: number): number[] => Array.from({ length: n }, () => H);
  const line = (text: string, y: number): PageLine => ({ y, x: 70.9, size: 12, text });
  const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
  /** A 4-line section opening that two sections of a 6-page document share (« Titre de niveau 1 » + a Lorem ipsum paragraph). */
  const opening = (): PageLine[] => [
    line("Titre de niveau 1", 754),
    line("Lorem ipsum dolor sit amet, consetetur sadipscing elitr, sed diam nonumy eirmod", 738),
    line("tempor invidunt ut labore et dolore magna aliquyam erat, sed diam voluptua. At vero", 723),
    line("accusam et justo duo dolores et ea rebum.", 708),
  ];
  const own = (n: number): PageLine => line(`unique body ${WORDS[n]}`, 400);
  const pageNumber = (n: number): PageLine => ({ y: 38, x: 518.5, size: 12, text: String(n + 1) });

  it("a 4-line block that opens only 2 pages of 6 stays: those are two sections that share their first lines", () => {
    const pages = [0, 1, 2, 3, 4, 5].map((n) =>
      n === 1 || n === 4
        ? [...opening(), own(n), pageNumber(n)]
        : [line(`Heading ${WORDS[n]}`, 754), own(n), pageNumber(n)],
    );
    const flags = detectPageFurniture(pages, [], heights(6));
    expect(flags[1]).toEqual([false, false, false, false, false, true]);
    expect(flags[4]).toEqual([false, false, false, false, false, true]);
  });

  it("the same block on 3 pages is a running header (starting value, 3 pages)", () => {
    const pages = [0, 1, 2, 3].map((n) =>
      n < 3 ? [...opening(), own(n), pageNumber(n)] : [line("Last page", 754), own(n), pageNumber(n)],
    );
    const flags = detectPageFurniture(pages, [], heights(4));
    expect(flags[0]).toEqual([true, true, true, true, false, true]);
  });

  it("a document of two pages cannot offer more than two: its repeated 4-line header is still furniture", () => {
    const pages = [0, 1].map((n) => [...opening(), own(n)]);
    const flags = detectPageFurniture(pages, [], heights(2));
    expect(flags[1]).toEqual([true, true, true, true, false]);
  });

  it("08 Ontario p5, p8: a 4-line footnote shared by two pages stays, but the page counter right under it is still removed", () => {
    const note = (): PageLine[] => [
      line("1 Identifiable Indigenous data was not included in this project to allow time for", 110),
      line("the development of Indigenous data governance approaches to inform future", 98),
      line("iterations of the report.", 86),
      line("(footnote continued from the previous section of the report)", 74),
    ];
    const counter = (n: number): PageLine => ({ y: 40, x: 300, size: 12, text: `Page ${n + 1} of 6` });
    const pages = [0, 1, 2, 3, 4, 5].map((n) =>
      n === 1 || n === 4 ? [own(n), ...note(), counter(n)] : [own(n), counter(n)],
    );
    const flags = detectPageFurniture(pages, [], heights(6));
    expect(flags[1]).toEqual([false, false, false, false, false, true]);
    expect(flags[4]).toEqual([false, false, false, false, false, true]);
    expect(flags[0]).toEqual([false, true]);
  });

  it("a long run that covers EVERY line of its page is a template, not a header: refused", () => {
    const template = (): PageLine[] => [...opening(), line("Fin du gabarit repete", 693)];
    const flags = detectPageFurniture([template(), template(), template()], [], heights(3));
    expect(flags.flat().some(Boolean)).toBe(false);
  });

  it("074: a 4-line footer whose right-aligned counter moves with its digit count (x=489 then x=485) is still one block", () => {
    const footer = (n: number): PageLine[] => [
      line("Service de la pedagogie specialisee, Office de l'enfance", 90),
      line("OEJ - SPS Rue des Granges 7 1204 Geneve telephone secretariat", 78),
      line("sps-eval@example.org https://www.ge.ch/organisation/secretariat", 66),
      { y: 54, x: n < 3 ? 489.3 : 484.8, size: 12, text: `Page ${n} sur 5` },
    ];
    const pages = [1, 2, 3, 4, 5].map((n) => [own(n - 1), ...footer(n)]);
    const flags = detectPageFurniture(pages, [], heights(5));
    for (const page of flags) expect(page).toEqual([false, true, true, true, true]);
  });

  it("a page with no text does not count: a 4-line header on pages 1 and 3 of a 3-page document with an image-only page 2 is furniture", () => {
    const pages = [[...opening(), own(0)], [], [...opening(), own(2)]];
    const flags = detectPageFurniture(pages, [], heights(3));
    expect(flags[0]).toEqual([true, true, true, true, false]);
    expect(flags[2]).toEqual([true, true, true, true, false]);
  });

  it("an even-page footer block on pages 2 and 4 of a 5-page document is furniture: the parity is the evidence", () => {
    const footer = (): PageLine[] => [
      line("Even page footer line one", 90),
      line("Even page footer line two", 78),
      line("Even page footer line three", 66),
      line("Even page footer line four", 54),
    ];
    const pages = [0, 1, 2, 3, 4].map((n) => (n % 2 === 1 ? [own(n), ...footer()] : [own(n)]));
    const flags = detectPageFurniture(pages, [], heights(5));
    expect(flags[1]).toEqual([false, true, true, true, true]);
    expect(flags[3]).toEqual([false, true, true, true, true]);
  });

  it("letter-spaced letters are not words for the block test: three short spaced lines on 2 pages of 6 are furniture", () => {
    const spaced = (): PageLine[] => [
      line("A B C D E F G H I J", 90),
      line("K L M N O P Q R S T", 78),
      line("U V W X Y Z A B C D", 66),
    ];
    const pages = [0, 1, 2, 3, 4, 5].map((n) => (n === 1 || n === 4 ? [own(n), ...spaced()] : [own(n)]));
    const flags = detectPageFurniture(pages, [], heights(6));
    expect(flags[1]).toEqual([false, true, true, true]);
  });

  it("a 4-line block that opens pages 1 and 2 only of a 4-page document stays on both (the parity must be repeated on ITS pages, not borrowed from the other)", () => {
    const pages = [0, 1, 2, 3].map((n) =>
      n < 2 ? [...opening(), own(n)] : [line(`Heading ${WORDS[n]}`, 754), own(n)],
    );
    const flags = detectPageFurniture(pages, [], heights(4));
    expect(flags.flat().some(Boolean)).toBe(false);
  });

  it("ACCEPTED COST, pinned: in a 4-page document a real 4-line block on pages 1 and 3 only reads as a mirrored odd-page header and is removed", () => {
    const pages = [0, 1, 2, 3].map((n) =>
      n % 2 === 0 ? [...opening(), own(n)] : [line(`Heading ${WORDS[n]}`, 754), own(n)],
    );
    const flags = detectPageFurniture(pages, [], heights(4));
    expect(flags[0]).toEqual([true, true, true, true, false]);
    expect(flags[2]).toEqual([true, true, true, true, false]);
  });
});

describe("detectPageFurniture: a label closer to its body than to the header is content (02-jvmalin p6, p9, p12; 15/10/2026)", () => {
  const header = (): PageLine => ({ y: 797.3, x: 260, size: 9, text: "Guide d'integration" });
  const label = (): PageLine => ({ y: 756.5, x: 72, size: 14, text: "Description" });
  const body = (text: string): PageLine => ({ y: 725.5, x: 72, size: 11, text: text });
  const pageWith = (text: string): PageLine[] => [header(), label(), body(text)];
  const H = 842;

  it("keeps a label that repeats at the page top when the body follows closer than the header precedes", () => {
    const plain = (text: string): PageLine[] => [header(), { y: 750, x: 72, size: 11, text }];
    const pages = [
      pageWith("Ce webservice a"),
      plain("x y"),
      plain("z w"),
      pageWith("Ce webservice b"),
      plain("u v"),
      plain("t s"),
      pageWith("Ce webservice c"),
      plain("r q"),
    ];
    const flags = detectPageFurniture(
      pages,
      [],
      pages.map(() => H),
    );
    expect(flags[0]).toEqual([true, false, false]);
    expect(flags[3]).toEqual([true, false, false]);
    expect(flags[6]).toEqual([true, false, false]);
  });

  it("still removes a two-line header whose second line sits at ordinary line spacing from the first and far from the body", () => {
    const second = (): PageLine => ({ y: 785, x: 260, size: 9, text: "Confidential" });
    const page = (text: string): PageLine[] => [header(), second(), { y: 725.5, x: 72, size: 11, text }];
    const flags = detectPageFurniture([page("a b"), page("c d"), page("e f")], [], [H, H, H]);
    expect(flags[0]).toEqual([true, true, false]);
  });
});

describe("detectPageFurniture: guards of the body-label drop (review 15/10/2026)", () => {
  const H = 842;
  const top = (): PageLine => ({ y: 797.3, x: 260, size: 9, text: "Guide" });
  it("keeps a stacked footer above a page counter although it sits closer to the body", () => {
    const page = (n: number): PageLine[] => [
      { y: 92, x: 72, size: 11, text: ["alpha beta", "gamma delta", "kappa omega", "sigma theta"][n - 1]! },
      { y: 70, x: 72, size: 10, text: "Acme Confidential" },
      { y: 45, x: 72, size: 9, text: `Quarterly report summary ${n}` },
    ];
    const flags = detectPageFurniture([page(1), page(2), page(3), page(4)], [], [H, H, H, H]);
    expect(flags[0]).toEqual([false, true, true]);
  });
  it("ACCEPTED BIAS: a header subtitle close to the body that repeats on few pages is published once per page, not removed", () => {
    // Indistinguishable from a body label by gap and support; a size guard lost real body lines (measured), so the subtitle stays visible.
    const sub = (): PageLine => ({ y: 772, x: 72, size: 9, text: "Chapter subtitle" });
    const body = (t: string): PageLine => ({ y: 755, x: 72, size: 11, text: t });
    const plain = (t: string): PageLine[] => [top(), { y: 750, x: 72, size: 11, text: t }];
    const pages = [
      [top(), sub(), body("a b")],
      plain("c d"),
      plain("e f"),
      [top(), sub(), body("g h")],
      plain("i j"),
      plain("k l"),
      [top(), sub(), body("m n")],
      plain("o p"),
    ];
    const flags = detectPageFurniture(
      pages,
      [],
      pages.map(() => H),
    );
    expect(flags[0]).toEqual([true, false, false]);
  });
  it("does not drop a line whose next line is on the same baseline", () => {
    const left = (): PageLine => ({ y: 756.5, x: 72, size: 14, text: "Description" });
    const right = (t: string): PageLine => ({ y: 756.5, x: 300, size: 11, text: t });
    const plain = (t: string): PageLine[] => [top(), { y: 750, x: 72, size: 11, text: t }];
    const pages = [
      [top(), left(), right("a")],
      plain("c d"),
      plain("e f"),
      [top(), left(), right("b")],
      plain("i j"),
      plain("k l"),
      [top(), left(), right("c")],
      plain("o p"),
    ];
    const flags = detectPageFurniture(
      pages,
      [],
      pages.map(() => H),
    );
    expect(flags[0]![1]).toBe(true);
  });
});
