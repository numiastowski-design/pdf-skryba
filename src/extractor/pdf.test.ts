import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PDFDocument, StandardFonts, rgb } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";

import { ReaderError } from "doc-ir";
import { PdfObjectsRefusal } from "./pdf-objects/refusal";
import type { IRBlock } from "doc-ir";
import { extractPdf, hangsFromMarker, isCentredPair, isDeliberateBreak, startsNewItem, type Line } from "./pdf";
import { flattenPdfPages } from "./pdf-flat.test.support";
import { bandedSplit } from "./pdf-bands";
import { centredContainerReader, continuesCentredLine, valueColumnStarts } from "./pdf-line-breaks";
import { PAGE_SIZED_LIMITS } from "./pdf-page-caps.test.support";

// Real fixture from the golden corpus (MIKSUDOC « Spécification fonctionnelle » §8 item 5: "a structured
// digital PDF"). Structural expectations below were cross-checked
// against extractTextItems' raw line/gap geometry (line count, font sizes,
// gap ratios) before writing this test — never against the extracted prose,
// so no client content needed to travel through this session.
const here = dirname(fileURLToPath(import.meta.url));
const fixture = new Uint8Array(readFileSync(join(here, "../../fixtures/pdf/05a-Rapport-Annuel-Digital.pdf")));

describe("extractPdf (real corpus fixture)", () => {
  it("extracts both pages, no page flagged as scanned (this fixture is fully digital)", async () => {
    const { scannedPageIndices } = await extractPdf(fixture);
    expect(scannedPageIndices).toEqual([]);
  });

  it("groups same-paragraph line-wraps together and splits at real paragraph/heading breaks", async () => {
    const { pages } = await extractPdf(fixture);
    // Read off the real geometry (font-size changes + gap ratio, see pdf.ts's
    // module doc): page 1 is title / 2-line intro / heading / 3-line para /
    // heading / [4-line para, now a real "table" block — §8 jalon 2, see
    // this file's own dedicated test below] / heading / 3-line para = 8
    // blocks (same total count — one paragraph became a table, nothing
    // added or removed); page 2 is heading / 3-line para / 1-line footer
    // (smaller font, forces its own break even though its gap ratio alone
    // wouldn't) = 3 blocks.
    expect(pages.map((p) => p.length)).toEqual([8, 3]);
    const doc = flattenPdfPages(pages);
    // Since the heading rule (14/09/2026), title blocks come out as `heading`
    // and no longer as `paragraph`: the COUNT does not move, the type does.
    const lengths = doc.blocks.map((b) =>
      b.kind === "paragraph" || b.kind === "heading" ? (b.inlines[0]?.text.length ?? 0) : b.kind === "table" ? 1 : -1,
    );
    for (const len of lengths) expect(len).toBeGreaterThan(0);
  });

  it("multi-line paragraphs are joined with a single space, not run together or newline-broken", async () => {
    const { pages } = await extractPdf(fixture);
    for (const block of flattenPdfPages(pages).blocks) {
      if (block.kind !== "paragraph") continue;
      const text = block.inlines[0]?.text ?? "";
      expect(text).not.toMatch(/\n/);
      expect(text).not.toMatch(/ {2,}/);
    }
  });

  it("is deterministic: extracting the same bytes twice yields the same result", async () => {
    const a = await extractPdf(fixture);
    const b = await extractPdf(fixture);
    expect(a).toEqual(b);
  });

  it("EXTRACT_FAILED on bytes that aren't a valid PDF", async () => {
    await expect(extractPdf(new Uint8Array([1, 2, 3, 4, 5]))).rejects.toSatisfy(
      (error) => error instanceof ReaderError && error.code === "EXTRACT_FAILED",
    );
  });

  it("the failure message is ours, never a parser's own words nor its class name", async () => {
    await expect(extractPdf(new Uint8Array([1, 2, 3, 4, 5]))).rejects.toSatisfy(
      (error) => error instanceof ReaderError && error.message === "the file is damaged or is not a valid PDF",
    );
  });

  // 04/11/2026: four documents of the corpus failed and nothing could say WHY — `openOrRefuse` turned every refusal that is not
  // « encrypted » into this one message, so `xref-syntax`, `startxref-missing` and `stream-decode` were indistinguishable. The reason
  // is OUR OWN word, from a closed vocabulary (`pdf-objects/refusal.ts#PdfObjectsRefusalReason`), so it may travel: it rides on
  // `cause`, which never reaches the message. The displayed text is unchanged — the test above still pins it.
  it("carries OUR refusal reason on `cause`, so a tool can say why, with the displayed message unchanged", async () => {
    await expect(extractPdf(new Uint8Array([1, 2, 3, 4, 5]))).rejects.toSatisfy((error) => {
      const cause = (error as { cause?: unknown }).cause;
      return cause instanceof PdfObjectsRefusal && typeof cause.reason === "string" && cause.reason.length > 0;
    });
  });

  it("real finding (§8 jalon 2, discovered by this detector, not previously documented): page 1 has a genuine vector-drawn KPI table — NOW rendered as a real table, previously silently flattened to prose", async () => {
    const { pages, tableDetections } = await extractPdf(fixture);
    expect(tableDetections).toEqual([{ pageIndex: 0, origin: "vector-borders" }]);

    const kinds = pages[0]!.map((b) => b.kind);
    // Same total of 8 blocks as this file establishes above. Two changes
    // show here: the table (§8 milestone 2) in place of a wall of flattened text, and
    // the HEADING RULE (14/09/2026) — the document title and its three sections are
    // no longer bold paragraphs but real headings.
    expect(kinds).toEqual(["heading", "paragraph", "heading", "paragraph", "heading", "table", "heading", "paragraph"]);
    expect(pages[0]!.filter((b) => b.kind === "heading").map((b) => b.level)).toEqual([1, 1, 1, 1]);

    const table = pages[0]!.find((b) => b.kind === "table") as Extract<IRBlock, { kind: "table" }>;
    const rowTexts = table.rows.map((row) =>
      row.cells.map((c) => (c.blocks[0]?.kind === "paragraph" ? c.blocks[0].inlines[0]?.text : "")),
    );
    expect(rowTexts).toEqual([
      ["Indicateur", "2024", "2025", "Variation"],
      ["Chiffre d'affaires (k€)", "7 120", "7 815", "+9,8 %"],
      ["Résultat net (k€)", "612", "701", "+14,5 %"],
      ["Effectif moyen", "298", "326", "+9,4 %"],
    ]);
    expect(table.rows[0]!.cells.every((c) => c.header)).toBe(true); // first row = header, the no-AI default
    expect(table.rows.slice(1).every((row) => row.cells.every((c) => !c.header))).toBe(true);
  });
});

// MIKSUDOC « Spécification technique » §5.4.1, régime 1 — synthetic fixtures
// only, pdf-lib, never the real bulletin or anything derived from it.
describe("extractPdf — table rendering (§8 jalon 2 régime 1, synthetic pdf-lib fixtures)", () => {
  async function pdfWithVectorGridTable(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 400]);
    page.drawText("Bulletin Trimestre 1", {
      x: 50,
      y: 340,
      size: 12,
      font: await doc.embedFont(StandardFonts.Helvetica),
    });
    for (const y of [300, 250, 200])
      page.drawLine({ start: { x: 50, y }, end: { x: 250, y }, thickness: 1, color: rgb(0, 0, 0) });
    for (const x of [50, 150, 250])
      page.drawLine({ start: { x, y: 200 }, end: { x, y: 300 }, thickness: 1, color: rgb(0, 0, 0) });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText("Matière", { x: 60, y: 270, size: 10, font });
    page.drawText("Note", { x: 160, y: 270, size: 10, font });
    page.drawText("Français", { x: 60, y: 220, size: 10, font });
    page.drawText("14", { x: 160, y: 220, size: 10, font });
    page.drawText("Fin du document", { x: 50, y: 150, size: 10, font });
    return doc.save();
  }

  it("renders a real 'table' IRBlock in place of flat paragraphs, with prose before/after untouched", async () => {
    const bytes = await pdfWithVectorGridTable();
    const { pages, tableDetections } = await extractPdf(bytes);
    const blocks = pages[0]!;

    expect(tableDetections).toEqual([{ pageIndex: 0, origin: "vector-borders" }]);

    const kinds = blocks.map((b) => b.kind);
    expect(kinds).toEqual(["paragraph", "table", "paragraph"]);

    const title = blocks[0] as Extract<IRBlock, { kind: "paragraph" }>;
    expect(title.inlines[0]?.text).toContain("Bulletin Trimestre");
    const footer = blocks[2] as Extract<IRBlock, { kind: "paragraph" }>;
    expect(footer.inlines[0]?.text).toContain("Fin du document");

    const table = blocks[1] as Extract<IRBlock, { kind: "table" }>;
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]?.cells[0]?.header).toBe(true); // first row = header, the sane no-AI default
    const cellText = (r: number, c: number) => {
      const b = table.rows[r]?.cells[c]?.blocks[0];
      return b?.kind === "paragraph" ? b.inlines[0]?.text : undefined;
    };
    expect(cellText(0, 0)).toBe("Matière");
    expect(cellText(0, 1)).toBe("Note");
    expect(cellText(1, 0)).toBe("Français");
    expect(cellText(1, 1)).toBe("14");
  });

  it("falls back to flat text (today's exact behavior) when a fragment ambiguously straddles a cell boundary — never a partial/wrong table (§8: violation → repli texte plat)", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 400]);
    for (const y of [300, 250, 200])
      page.drawLine({ start: { x: 50, y }, end: { x: 250, y }, thickness: 1, color: rgb(0, 0, 0) });
    for (const x of [50, 150, 250])
      page.drawLine({ start: { x, y: 200 }, end: { x, y: 300 }, thickness: 1, color: rgb(0, 0, 0) });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    // A fragment deliberately spanning both columns (a merged-cell-shaped
    // value) — straddles the x=150 boundary by design.
    page.drawText("Moyennes T1 et T2 combinées", { x: 55, y: 270, size: 10, font });
    page.drawText("Français", { x: 60, y: 220, size: 10, font });
    page.drawText("14", { x: 160, y: 220, size: 10, font });
    const bytes = await doc.save();

    const { pages, tableDetections } = await extractPdf(bytes);
    // The origin is still reported (never a silent signal loss)...
    expect(tableDetections).toEqual([{ pageIndex: 0, origin: "vector-borders" }]);
    // ...but nothing was rendered as a table: every block is plain flat
    // paragraph text, exactly the pre-jalon-2 behavior for this page.
    expect(pages[0]!.every((b) => b.kind === "paragraph")).toBe(true);
  });
});

describe("the document's bold, read from its fonts and rendered in the prose", () => {
  it("marks the headings of 05a `strong`, and leaves the body text regular", async () => {
    // THE MEASUREMENT THAT DECIDED THE SOURCE (10/09/2026): the aggregated items
    // of `unpdf` render `fontFamily = "sans-serif"` for EVERYTHING, bold included.
    // pdf.js, for its part, described the font itself — `name="Arial,Bold"`, `bold=true`.
    const bytes = new Uint8Array(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/pdf/05a-Rapport-Annuel-Digital.pdf")),
    );
    const { pages } = await extractPdf(bytes);
    const paragraphs = pages.flat().filter((b): b is Extract<IRBlock, { kind: "paragraph" }> => b.kind === "paragraph");
    // The title comes out as `heading` since the heading rule (14/09/2026). It keeps its
    // `strong`: the document paints it bold AND large, and we do not decide that
    // one makes the other superfluous.
    const headings = pages.flat().filter((b): b is Extract<IRBlock, { kind: "heading" }> => b.kind === "heading");

    const title = headings.find((h) =>
      h.inlines
        .map((i) => i.text)
        .join("")
        .startsWith("Rapport annuel 2025"),
    );
    expect(title?.level).toBe(1);
    expect(title?.inlines[0]?.marks).toEqual(["strong"]);

    const body = paragraphs.find((p) =>
      p.inlines
        .map((i) => i.text)
        .join("")
        .startsWith("Ce rapport présente"),
    );
    expect(body?.inlines.every((i) => i.marks === undefined)).toBe(true);
  });
});

describe("18 — the fixture that LAYS OUT: a wrap against a deliberate break", () => {
  /** The four short lines of the real report card, reproduced by a rendering
   *  engine: each is a true ending, none reaches the margin. This is the
   *  defect that the next-word rule corrects. */
  const paragraphTexts = async (): Promise<string[]> => {
    const bytes = new Uint8Array(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/pdf/18-Composition-Reelle.pdf")),
    );
    const { pages } = await extractPdf(bytes);
    return pages
      .flat()
      .filter((b): b is Extract<IRBlock, { kind: "paragraph" }> => b.kind === "paragraph")
      .map((b) => b.inlines.map((i) => i.text).join(""));
  };

  it("four successive short lines make FOUR paragraphs", async () => {
    const texts = await paragraphTexts();
    expect(texts).toContain("Absences : 6 demi-journées justifiées - Retards : 6 dont 2 sont non justifiés");
    expect(texts).toContain("Maîtrise des composantes du socle du Cycle 4 en fin de Trimestre 1");
    expect(texts).toContain("La principale adjointe");
  });

  it("a wrapped paragraph is NOT cut — the next word did not fit", async () => {
    const texts = await paragraphTexts();
    const ragged = texts.find((text) => text.startsWith("La numérisation vient après le classement"));
    expect(ragged).toContain("personne ne revient sur une image déjà produite.");
  });

  it("two distinct paragraphs of one ragged-right block stay distinct", async () => {
    const texts = await paragraphTexts();
    const first = texts.find((text) => text.startsWith("La numérisation vient après le classement"));
    expect(first).not.toContain("Un lot qui échoue");
    expect(texts.some((text) => text.startsWith("Un lot qui échoue"))).toBe(true);
  });
});

describe("isDeliberateBreak — wrap or deliberate break, and abstention when unknown", () => {
  const lineEndingAt = (right: number, firstWordWidth = 0): Line => ({
    y: 700,
    fontSize: 10,
    text: "peu importe",
    runs: [{ text: "peu importe", bold: false }],
    left: 30,
    right,
    firstWordWidth,
    maxInnerGap: 0,
  });

  const MARGIN = 548;

  it("the next word WOULD have fitted: a deliberate break, the lines split", () => {
    // The measured shape: the legend line stops at 437, 111 pt remain,
    // and "Absences" measures 35.
    expect(isDeliberateBreak(lineEndingAt(437), lineEndingAt(261, 35), MARGIN)).toBe(true);
  });

  it("the next word would NOT have fitted: a wrap, the lines join", () => {
    // An ordinary wrap: the line almost touches the margin.
    expect(isDeliberateBreak(lineEndingAt(540), lineEndingAt(279, 35), MARGIN)).toBe(false);
  });

  it("the word fits EXACTLY in the room left: a wrap, the lines join (lot 32, 22/09/2026)", () => {
    // Until 22/09/2026 this pair split: the room left counted neither the space
    // before the word nor the overshoot of the widest line (group G1).
    expect(isDeliberateBreak(lineEndingAt(MARGIN - 35), lineEndingAt(200, 35), MARGIN)).toBe(false);
  });

  it("the word fits with less than 0.45 em to spare: a wrap (0000154 p1, 0.22 em)", () => {
    // Body 10 pt: 35 pt word, 37.2 pt room.
    expect(isDeliberateBreak(lineEndingAt(MARGIN - 37.2), lineEndingAt(200, 35), MARGIN)).toBe(false);
  });

  it("the word fits with 0.45 em to spare or more: a deliberate break, the lines split (0.47 em)", () => {
    expect(isDeliberateBreak(lineEndingAt(MARGIN - 39.7), lineEndingAt(200, 35), MARGIN)).toBe(true);
  });

  it("🔴 WITHOUT GLYPHS, WE ABSTAIN — a zero width means « I do not know »", () => {
    // Without this guard, a page whose operator reading failed
    // would see EVERY one of its lines become a paragraph: the remaining room
    // is always greater than or equal to zero.
    expect(isDeliberateBreak(lineEndingAt(100), lineEndingAt(200, 0), MARGIN)).toBe(false);
  });
});

describe("a list item and its continuation (16/09/2026)", () => {
  /** The shape measured on `29-Entra-Gestion-Applications`: the bullet starts at
   *  52.8, its continuation at 70.8, and both are 12 pt. */
  const lineAt = (left: number, right: number, text: string): Line => ({
    y: 500,
    fontSize: 12,
    text,
    runs: [{ text, bold: false }],
    left,
    right,
    firstWordWidth: 0,
    maxInnerGap: 0,
  });

  const bullet = lineAt(52.8, 516, "• Développer, ajouter ou connecter : vous prenez différents chemins");
  const continuation = lineAt(70.8, 499, "développez votre propre application, à l'aide d'une application");
  const nextBullet = lineAt(52.8, 488, "• Gérer l'accès : l'accès peut être géré");

  it("🔴 an OUTDENTED bullet opens an item — otherwise six items make one 972-character block", () => {
    // No other rule could separate them: same size, same line spacing,
    // and `isDeliberateBreak` abstains on this document, which delivers no
    // per-glyph advance.
    expect(startsNewItem(continuation, nextBullet)).toBe(true);
  });

  it("both conditions are needed TOGETHER", () => {
    // Without a marker, it is the classic indent — first line indented,
    // the following ones at the margin — and its continuation opens nothing.
    expect(startsNewItem(lineAt(70.8, 400, "première ligne"), lineAt(52.8, 400, "la suite du paragraphe"))).toBe(false);
    // Without an indent, it is a dash used as an aside. "Without an indent, it is not a
    // bullet" (16/09/2026).
    expect(startsNewItem(lineAt(52.8, 400, "une phrase"), lineAt(52.8, 400, "— dit-il en partant"))).toBe(false);
  });

  it("⚠️ an item and its continuation are NEVER a centred block", () => {
    // The false positive of `isCentredPair`: 18 pt gap on the left, 17 on the right
    // by ragged right, and centres 0.5 pt from each other. The item
    // was cut after its first line.
    expect(isCentredPair(bullet, continuation)).toBe(true);
    expect(hangsFromMarker(bullet, continuation)).toBe(true);
  });
});

describe("a sub-bullet under an item is not the item's continuation (26/10/2026)", () => {
  /** The shape read on `docx-reel/08-ontario-diu` p5 (Word 365): the bullet « • » at 67 is its own run, the item's text starts at 85;
   *  the sub-bullet « o » (Courier) at 103, its text at 121; 11 pt body. */
  const line = (left: number, text: string, lead?: { text: string; nextLeft: number }): Line => ({
    y: 434,
    fontSize: 11,
    text,
    runs: [{ text, bold: false }],
    left,
    right: left + 70,
    firstWordWidth: 7,
    maxInnerGap: 0,
    ...(lead !== undefined ? { lead } : {}),
  });
  const item = line(67, "• individuals1 in:", { text: "•", nextLeft: 85 });

  it("🔴 a line deeper than the item's TEXT that opens on one character and a tab is not hung from the item", () => {
    // FAILS WITH: true — « • individuals¹ in: o private schools » published as one paragraph.
    expect(hangsFromMarker(item, line(103, "o private schools", { text: "o", nextLeft: 121 }))).toBe(false);
  });

  it("the bullet item may carry its own blank (« • »)", () => {
    expect(
      hangsFromMarker(
        line(67, "• individuals1 in:", { text: "• ", nextLeft: 85 }),
        line(103, "o private schools", { text: "o", nextLeft: 121 }),
      ),
    ).toBe(false);
  });

  it("a continuation at the item's text indent still hangs from it", () => {
    expect(hangsFromMarker(item, line(85, "the rest of the item", { text: "the", nextLeft: 104 }))).toBe(true);
  });

  it("🔴 guard: a deeper line that opens on a word stays hung (a document of the measurement corpus, p2: a date wrapped under its reference)", () => {
    // FAILS WITH: false — « … Prevention » and « April 3, 2020 » split although they are one reference.
    expect(
      hangsFromMarker(line(90, "• Water and COVID-19 FAQs", { text: "•", nextLeft: 108 }), line(144, "April 3, 2020")),
    ).toBe(true);
  });

  it("🔴 guard: a one-letter word followed by an ordinary blank is a word, not a sub-bullet", () => {
    // FAILS WITH: false — a continuation opening on « a » cut from its item.
    expect(hangsFromMarker(item, line(103, "a word", { text: "a", nextLeft: 106 }))).toBe(true);
  });

  it("🔴 guard: a bullet in the body font (one text run « • text ») gives no item text start: unchanged", () => {
    // FAILS WITH: false — the rule applied without knowing where the item's text starts.
    expect(
      hangsFromMarker(
        line(67, "• individuals1 in:", { text: "• individuals1", nextLeft: 140 }),
        line(103, "o private schools", { text: "o", nextLeft: 121 }),
      ),
    ).toBe(true);
  });
});

/** A grid whose ONE cell holds a filled disc and, INSIDE it, its digit (the shape measured on a bulletin's « Pos. » column). */
async function makePdfWithDiscInCell(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const ys = [300, 250, 200];
  const xs = [50, 150, 250];
  for (const y of ys) page.drawLine({ start: { x: 50, y }, end: { x: 250, y }, thickness: 1, color: rgb(0, 0, 0) });
  for (const x of xs) page.drawLine({ start: { x, y: 200 }, end: { x, y: 300 }, thickness: 1, color: rgb(0, 0, 0) });
  page.drawCircle({ x: 200, y: 275, size: 15, color: rgb(0, 0.502, 0) });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("A", { x: 60, y: 270, size: 10, font });
  page.drawText("4", { x: 197, y: 271, size: 10, font, color: rgb(1, 1, 1) });
  page.drawText("C", { x: 60, y: 220, size: 10, font });
  page.drawText("D", { x: 160, y: 220, size: 10, font });
  return doc.save();
}

describe("a disc in a cell (07/10/2026: no colour disc is published)", () => {
  it("publishes the cell's digit as plain TEXT, never as a picture", async () => {
    const { pages } = await extractPdf(await makePdfWithDiscInCell());
    const table = pages[0]!.find((b): b is Extract<IRBlock, { kind: "table" }> => b.kind === "table")!;
    const paragraph = table.rows[0]!.cells[1]!.blocks[0]!;
    expect(paragraph.kind).toBe("paragraph");
    const inlines = (paragraph as Extract<IRBlock, { kind: "paragraph" }>).inlines;
    expect(inlines.map((i) => i.text).join("")).toBe("4");
    expect(inlines.every((i) => i.image === undefined)).toBe(true);
  });
});

/** A page of prose at two sizes in a ratio of 2.0: a title, then
 *  body. The shape measured on `05a`, reduced to what it exercises. */
async function makePdfWithOneHeading(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Rapport annuel", { x: 50, y: 350, size: 22, font });
  for (let i = 0; i < 6; i += 1) {
    page.drawText("Une ligne de prose ordinaire qui porte le corps du document", {
      x: 50,
      y: 300 - i * 18,
      size: 11,
      font,
    });
  }
  return doc.save();
}

/** The same page, but whose two sizes differ by only one point —
 *  ratio 1.09, under the threshold. It is fixture `18` in miniature. */
async function makePdfWithNoHeading(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Pas un titre", { x: 50, y: 350, size: 12, font });
  for (let i = 0; i < 6; i += 1) {
    page.drawText("Une ligne de prose ordinaire qui porte le corps du document", {
      x: 50,
      y: 300 - i * 18,
      size: 11,
      font,
    });
  }
  return doc.save();
}

describe("headings, drawn from the sizes alone", () => {
  it("gives a level-1 heading when the size ratio sets it apart from the body", async () => {
    const { pages } = await extractPdf(await makePdfWithOneHeading());
    const headings = pages[0]!.filter((b): b is Extract<IRBlock, { kind: "heading" }> => b.kind === "heading");
    expect(headings).toHaveLength(1);
    expect(headings[0]!.level).toBe(1);
    expect(headings[0]!.inlines.map((i) => i.text).join("")).toContain("Rapport annuel");
  });

  it("leaves the body as paragraphs, never as headings", async () => {
    const { pages } = await extractPdf(await makePdfWithOneHeading());
    expect(pages[0]!.filter((b) => b.kind === "paragraph").length).toBeGreaterThan(0);
  });

  it("makes NO heading when one point alone separates the two sizes", async () => {
    const { pages } = await extractPdf(await makePdfWithNoHeading());
    expect(pages[0]!.filter((b) => b.kind === "heading")).toHaveLength(0);
  });
});

describe("the 15-page cap per document (decision of 10/09/2026; ASKED FOR by the caller since 09/11/2026)", () => {
  it("REFUSES a 40-page PDF, by name, and extracts nothing", async () => {
    // `05b` is forty scanned pages: it is the typical document that the
    // product refuses. The refusal must be NAMED — a generic failure would
    // be confused with a broken extraction — and it must happen before any
    // work, otherwise the ceiling protects nothing.
    const bytes = new Uint8Array(readFileSync(join(here, "../../fixtures/pdf/05b-Archive-Scannee-40p.pdf")));
    await expect(extractPdf(bytes, "en", { limits: PAGE_SIZED_LIMITS })).rejects.toMatchObject({
      code: "DOCUMENT_TOO_MANY_PAGES",
    });
  });

  it("lets a document under the cap through", async () => {
    const bytes = new Uint8Array(readFileSync(join(here, "../../fixtures/pdf/05d-Dossier-Mixte.pdf")));
    const { pages } = await extractPdf(bytes);
    expect(pages.length).toBe(3);
  });
});

describe("headings and SIDE-BY-SIDE blocks (14/09/2026)", () => {
  /**
   * ⚠️ A TITLE BLOCK IS NOT A HEADING, and the rule already existed — it was
   * its application that was missing here.
   *
   * The repository had settled it on a report card: "a SIDE-BY-SIDE block carries
   * no heading, two bands at the top of a page are a title block, not a
   * section". The exclusion went through `columnCuts`, which requires
   * `looksLikeTextColumns` — measured false on `15` AND on `11`, yet real
   * two-column documents. This predicate does not answer the question the heading rule
   * asks.
   *
   * The gutter does: on `15` it is `[188 ; 340]`, and the header
   * OVERLAPS it — sender on the left, recipient on the right. "FACTURE", for its part,
   * sits on one side only.
   *
   * No threshold added: `detectColumnGutter` is an already measured signal, and
   * "overlaps" is a binary question.
   */
  it("15: « FACTURE » is a heading, the sender/recipient title block is not", async () => {
    const bytes = new Uint8Array(readFileSync(join(here, "../../fixtures/pdf/15-Facture-Libelle-Valeur.pdf")));
    const { pages } = await extractPdf(bytes);
    const headings = flattenPdfPages(pages).blocks.filter(
      (b): b is Extract<IRBlock, { kind: "heading" }> => b.kind === "heading",
    );
    expect(headings.map((h) => `h${h.level} ${h.inlines.map((i) => i.text).join("")}`)).toEqual(["h1 FACTURE"]);
  });

  it("17: the document's title is kept — it overlaps no gutter", async () => {
    const bytes = new Uint8Array(
      readFileSync(join(here, "../../fixtures/pdf/17-Tableau-Sans-Bordure-Cellules-Longues.pdf")),
    );
    const { pages } = await extractPdf(bytes);
    const headings = flattenPdfPages(pages).blocks.filter(
      (b): b is Extract<IRBlock, { kind: "heading" }> => b.kind === "heading",
    );
    expect(headings.map((h) => `h${h.level} ${h.inlines.map((i) => i.text).join("")}`)).toEqual([
      "h1 Registre des risques du chantier",
    ]);
  });
});

describe("a centred line wrapped by the layout engine (defect 4, 21/09/2026)", () => {
  /** A line of the given edges; `estimate` is the next line's first-word estimate. */
  const line = (left: number, right: number, estimate?: number): Line => ({
    y: 700,
    fontSize: 16,
    text: "irrelevant",
    runs: [{ text: "irrelevant", bold: false }],
    left,
    right,
    firstWordWidth: 0,
    ...(estimate !== undefined ? { firstWordEstimate: estimate } : {}),
    maxInnerGap: 0,
  });

  it("the next word fits less than twice in the free room: a wrap, the lines join (ratio 0.82, the MFA title)", () => {
    // Container 100, line 91.8 wide: 8.2 pt free for a 10 pt word.
    expect(continuesCentredLine(line(4.1, 95.9), line(40, 60, 10), 100)).toBe(true);
  });

  it("the next word fits largely: a deliberate break, the lines split (ratio 7.62, the bulletin header box)", () => {
    // Container 100, line 23.8 wide: 76.2 pt free for a 10 pt word.
    expect(continuesCentredLine(line(38.1, 61.9), line(40, 60, 10), 100)).toBe(false);
  });

  it("without a word estimate or a container, it splits — the behaviour before this rule", () => {
    expect(continuesCentredLine(line(4.1, 95.9), line(40, 60), 100)).toBe(false);
    expect(continuesCentredLine(line(4.1, 95.9), line(40, 60, 10), undefined)).toBe(false);
  });

  it("the container is the innermost closed box, else the column side of the WHOLE segment, else the text area", () => {
    const area = { left: 70, right: 520 };
    const a = { ...line(80, 200), y: 500 };
    const b = { ...line(90, 190), y: 488 };
    const boxes = [
      { left: 60, right: 530, bottom: 400, top: 600 },
      { left: 75, right: 250, bottom: 450, top: 550 },
    ];
    expect(centredContainerReader(boxes, undefined, area)(a, b, [a, b])).toBe(175);
    expect(centredContainerReader([], { cut: 290 }, area)(a, b, [a, b])).toBe(220);
    // One line of the segment crosses the cut: the column does not hold, the area does.
    const wide = { ...line(80, 400), y: 470 };
    expect(centredContainerReader([], { cut: 290 }, area)(a, b, [a, b, wide])).toBe(450);
  });

  const blockTexts = async (file: string, page: number): Promise<string[]> => {
    const { pages } = await extractPdf(new Uint8Array(readFileSync(join(here, "../../fixtures/pdf", file))));
    const out: string[] = [];
    const walk = (x: unknown): void => {
      if (Array.isArray(x)) x.forEach(walk);
      else if (x !== null && typeof x === "object") {
        const b = x as { kind?: string; level?: number; inlines?: { text?: string }[] };
        if (b.inlines !== undefined)
          out.push(`${b.kind === "heading" ? `h${b.level}` : "p"} ${b.inlines.map((i) => i.text ?? "").join("")}`);
        for (const [k, v] of Object.entries(x)) if (k !== "inlines") walk(v);
      }
    };
    walk(pages[page - 1]);
    return out;
  };

  describe("the value column of a label/value layout (21/09/2026)", () => {
    const at = (left: number, valueStart?: number) => ({ left, ...(valueStart !== undefined ? { valueStart } : {}) });

    it("a column needs values aligned on two lines AND a wrapped value line starting there", () => {
      expect(valueColumnStarts([at(120, 248.3), at(178, 244.6), at(120, 248.3), at(248.3)])).toEqual([248.3]);
    });

    it("the readings disagree — aligned values, no wrapped line; or one value alone — no column", () => {
      expect(valueColumnStarts([at(120, 248.3), at(120, 248.3), at(72)])).toEqual([]);
      expect(valueColumnStarts([at(120, 248.3), at(248.3)])).toEqual([]);
    });

    it("a line whose value starts at the column is anchored at its label: all the room is on the right", () => {
      const area = { left: 42.6, right: 543.5 };
      const labelled = { ...line(119.3, 518.6), valueStart: 248.3 };
      const wrapped = { ...line(248.3, 473.7), y: 688 };
      expect(centredContainerReader([], undefined, area, [248.3])(labelled, wrapped, [labelled, wrapped])).toBeCloseTo(
        543.5 - 119.3,
      );
    });

    it("the next line starts left of the column — a new label, the pair shares no container", () => {
      const area = { left: 42.6, right: 543.5 };
      const labelled = { ...line(119.3, 543.5), valueStart: 248.3 };
      const nextLabel = { ...line(177.8, 457.5), y: 688, valueStart: 244.6 };
      expect(
        centredContainerReader([], undefined, area, [248.3])(labelled, nextLabel, [labelled, nextLabel]),
      ).toBeUndefined();
    });
  });

  describe("words the PDF separates stay separated (21/09/2026)", () => {
    it("🔴 a real space item between two band halves is kept (`bandedSplit`)", () => {
      // ⚠️ THIS CASE HAS NO REAL DOCUMENT ANYMORE SINCE LOT "39", and it must be
      // said: `0000713` p1 and `0000944` p2, the two that exercised it, are no longer
      // read in bands — their gutter separates LABELS from a value, not two
      // columns. The test that named them would therefore have kept a rule that nothing
      // touches anymore. It now targets `bandedSplit` itself, with the shape
      // they had: two words of one half separated by a REAL space item,
      // and the gutter fill at both ends.
      const at = (text: string, x: number, y: number, width: number) => ({ text, x, y, width, fontSize: 10 });
      const page = [
        at("EUROCONTROL*", 40, 700, 60),
        at(" ", 100, 700, 4),
        at("est", 104, 700, 16),
        at("   ", 120, 700, 160),
        at("une organisation", 300, 700, 80),
        at("comptant 41", 40, 688, 60),
        at("États membres", 300, 688, 80),
        at("et 2 États", 40, 676, 60),
        at("ayant conclu", 300, 676, 80),
      ];
      const split = bandedSplit(page, 280);
      expect(split).toBeDefined();
      expect(split!.left[0]!.map((r) => r.text).join("")).toBe("EUROCONTROL* est");
      expect(split!.right[0]!.map((r) => r.text).join("")).toBe("une organisation");
    });

    it("two items with a wide gap and no space item between them get a space (fixtures 15, 17, 18, 11)", async () => {
      expect(await blockTexts("15-Facture-Libelle-Valeur.pdf", 1)).toContain("p 75003 Paris 8 avenue Victor Hugo");
      const t17 = (await blockTexts("17-Tableau-Sans-Bordure-Cellules-Longues.pdf", 1)).join("\n");
      expect(t17).toContain("et la Cote provisoire");
      expect(t17).toContain("table de tri le recensement");
      expect((await blockTexts("18-Composition-Reelle.pdf", 1)).join("\n")).toContain("se prépare L'instrument");
      expect(await blockTexts("11-Brochure-Deux-Colonnes.pdf", 1)).toContain("p 2023 2024 2025");
    });
  });
});
