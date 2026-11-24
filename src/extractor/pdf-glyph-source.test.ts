/**
 * The GLYPHS a page paints, read by OUR reader — the contract that `extractor/pdf-source.ts` consumes at the
 * switch-over. ISO 32000-1:2008 §9.4.3 (text operators), §9.3.3 (word space), §8.4.1 Table 52 (the font is in
 * the graphics state), §8.10 (XObject forms), §7.7.3.3 (an array of content streams reads as ONE stream).
 * What this file pins down, born from the security review of 31/10/2026:
 *   - reading is PAGE BY PAGE, on demand: rendering all pages at once retained the whole document;
 *   - a page carries at most `MAX_SHOWN_GLYPHS_PER_PAGE` glyphs, otherwise one object per painted byte was
 *     bounded by nothing;
 *   - two fonts that name the SAME `/ToUnicode` share its table, otherwise five hundred fonts on a single
 *     sixty-byte object retained five hundred tables.
 */
import { describe, expect, it } from "vitest";

import { MAX_SHOWN_GLYPHS_PER_PAGE, openOurGlyphs } from "./pdf-glyph-source";
import { PdfObjectsRefusal } from "./pdf-objects/refusal";

const enc = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "latin1"));

/** A minimal PDF whose every page carries the content stream it is given. */
function buildPdf(bodies: readonly string[]): Uint8Array {
  let file = "%PDF-1.4\n";
  const offsets: number[] = [];
  bodies.forEach((body, i) => {
    offsets.push(file.length);
    file += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = file.length;
  let table = `xref\n0 ${bodies.length + 1}\n0000000000 65535 f\r\n`;
  for (const offset of offsets) table += `${String(offset).padStart(10, "0")} 00000 n\r\n`;
  return enc(`${file}${table}trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
}

const stream = (data: string): string => `<< /Length ${data.length} >>\nstream\n${data}\nendstream`;

/** A simple WinAnsi font, which can therefore tell the text of each code. */
const WINANSI_FONT = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

/** A one-page document, whose content and resources are given. */
function onePage(content: string, resources = "<< /Font << /F1 5 0 R >> >>"): Uint8Array {
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>",
    `<< /Type /Page /Parent 2 0 R /Resources ${resources} /Contents 4 0 R >>`,
    stream(content),
    WINANSI_FONT,
  ]);
}

function refusalOf(fn: () => unknown): PdfObjectsRefusal {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PdfObjectsRefusal);
    return error as PdfObjectsRefusal;
  }
  throw new Error("expected a PdfObjectsRefusal, nothing was thrown");
}

describe("openOurGlyphs: the three fields the position layer reads", () => {
  it("returns one array per text operator, in stream order", () => {
    const source = openOurGlyphs(onePage("BT /F1 12 Tf (Hi) Tj (there) Tj ET"));
    const ops = source.glyphsOfPage(0);
    expect(ops.length).toBe(2);
    expect(ops[0]?.map((g) => g.unicode).join("")).toBe("Hi");
    expect(ops[1]?.map((g) => g.unicode).join("")).toBe("there");
  });

  it("marks isSpace on code 32 of a ONE-byte font, and on it alone (§9.3.3)", () => {
    const glyphs = openOurGlyphs(onePage("BT /F1 12 Tf (a b) Tj ET")).glyphsOfPage(0)[0];
    expect(glyphs?.map((g) => g.isSpace)).toEqual([false, true, false]);
  });

  it("gives the advance of each code from the standard font's metrics", () => {
    const glyphs = openOurGlyphs(onePage("BT /F1 12 Tf (A) Tj ET")).glyphsOfPage(0)[0];
    // Helvetica, "A": 667 thousandths of an em (Adobe AFM).
    expect(glyphs?.[0]?.width).toBe(667);
  });

  it("abstains when nothing says what a code paints, instead of inventing", () => {
    // A Type0 `Identity-H` without `/ToUnicode`: its codes are glyph numbers, and only its font program
    // could speak (31/10/2026: "we abstain").
    const resources = "<< /Font << /F1 5 0 R >> >>";
    const bytes = buildPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>",
      `<< /Type /Page /Parent 2 0 R /Resources ${resources} /Contents 4 0 R >>`,
      stream("BT /F1 12 Tf <0041> Tj ET"),
      "<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [6 0 R] >>",
      "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /X /DW 500 >>",
    ]);
    expect(openOurGlyphs(bytes).glyphsOfPage(0)[0]?.[0]?.unicode).toBeUndefined();
  });

  it("keeps the font across q/Q, because it is in the graphics state (Table 52)", () => {
    const ops = openOurGlyphs(onePage("/F1 12 Tf q Q BT (Hi) Tj ET")).glyphsOfPage(0);
    expect(ops[0]?.map((g) => g.unicode).join("")).toBe("Hi");
  });
});

describe("openOurGlyphs: the DEFAULT font is the one pdf.js used", () => {
  /** A page that paints with a name its resources do NOT declare — what pdf-lib's `pushOperators` produces, and
   *  what made a whole sentence disappear before the default font (31/10/2026). */
  const undeclared = (painted: string): Uint8Array =>
    buildPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>",
      "<< /Type /Page /Parent 2 0 R /Resources << /Font << >> >> /Contents 4 0 R >>",
      stream(`BT /Helvetica 10 Tf ${painted} Tj ET`),
    ]);

  it("reads the text instead of losing it, when the page declares no font under that name", () => {
    const glyphs = openOurGlyphs(undeclared("(Chiens)")).glyphsOfPage(0)[0];
    expect(glyphs?.map((g) => g.unicode).join("")).toBe("Chiens");
  });

  it("marks these glyphs as coming from the DEFAULT, so that they can be counted", () => {
    const glyphs = openOurGlyphs(undeclared("(A)")).glyphsOfPage(0)[0];
    expect(glyphs?.[0]?.read).toBe("default-font");
  });

  it("🔴 IT IS WinAnsiEncoding, NOT StandardEncoding — the external fact this test holds", () => {
    // The discriminant is chosen, not picked at random: code 0xE9 is "é" (U+00E9) in WinAnsi and the glyph
    // `Oslash` ("Ø") in StandardEncoding. pdf.js took Helvetica + WinAnsiEncoding as its fallback font
    // (`fallbackFontDict`, checked in the installed bundle on 31/10/2026); we keep that choice, and this test pins it:
    // changing it will require a decision, instead of discovering it on a document.
    const glyphs = openOurGlyphs(undeclared("<E9>")).glyphsOfPage(0)[0];
    expect(glyphs?.[0]?.unicode).toBe("é");
  });

  it("and it is a SIMPLE font: one byte per code, never two", () => {
    const glyphs = openOurGlyphs(undeclared("<4142>")).glyphsOfPage(0)[0];
    expect(glyphs?.map((g) => g.unicode)).toEqual(["A", "B"]);
  });

  it("also gives Helvetica's advance, so that the line does not shift", () => {
    const glyphs = openOurGlyphs(undeclared("(A)")).glyphsOfPage(0)[0];
    expect(glyphs?.[0]?.width).toBe(667);
  });

  it("a DECLARED font is never marked as coming from the default", () => {
    const glyphs = openOurGlyphs(onePage("BT /F1 12 Tf (A) Tj ET")).glyphsOfPage(0)[0];
    expect(glyphs?.[0]?.read).toBe("ours");
  });
});

describe("openOurGlyphs: an emoji written on TWO neighbouring codes is recomposed", () => {
  // 🔴 31/10/2026: "we have to do it ourselves", for emojis. A producer can write the UTF-16 units
  // as CIDs — FreeMono and DejaVuSans via LibreOffice do —, so an emoji occupies TWO neighbouring painted
  // codes, each carrying an isolated half-pair. Taken alone each is refused; together they spell a
  // real character, and this layer is the only one to see the SEQUENCE of codes.
  // Measured before: 10 glyphs of a third-party PDF of the measurement corpus (safedocs 0000340) lost on our side, and pdf.js rendered
  // an emoji PLUS an invented astral character (U+B0000, U+38C00 — code points that nothing carries).
  /** A Type0 `Identity-H` whose CMap is the identity: the painted code IS the UTF-16 unit. */
  const emojiDoc = (painted: string): Uint8Array => {
    const cmap = `/CIDInit /ProcSet findresource begin
begincmap
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
1 beginbfrange
<0000> <ffff> <0000>
endbfrange
endcmap
end`;
    return buildPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>",
      "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
      stream(`BT /F1 12 Tf <${painted}> Tj ET`),
      "<< /Type /Font /Subtype /Type0 /BaseFont /AAAAAC+FreeMono /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>",
      "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /AAAAAC+FreeMono /DW 1000 >>",
      stream(cmap),
    ]);
  };

  it("returns the emoji on the FIRST of the two glyphs", () => {
    // D83D DC00 spells U+1F400.
    const glyphs = openOurGlyphs(emojiDoc("D83DDC00")).glyphsOfPage(0)[0];
    expect(glyphs?.[0]?.unicode).toBe("\u{1F400}");
  });

  it("and publishes NOTHING on the second, which is only the low half", () => {
    const glyphs = openOurGlyphs(emojiDoc("D83DDC00")).glyphsOfPage(0)[0];
    expect(glyphs?.[1]?.unicode).toBe("");
  });

  it("keeps BOTH glyphs, with their advances: the geometry does not move", () => {
    const glyphs = openOurGlyphs(emojiDoc("D83DDC00")).glyphsOfPage(0)[0];
    expect(glyphs?.length).toBe(2);
    expect(glyphs?.map((g) => g.width)).toEqual([1000, 1000]);
  });

  it("does NOT pair a high half-pair followed by something else", () => {
    // D83D then 0041 ("A"): the high half stays isolated, hence abstention, and the "A" is published.
    const glyphs = openOurGlyphs(emojiDoc("D83D0041")).glyphsOfPage(0)[0];
    expect(glyphs?.map((g) => g.unicode)).toEqual(["", "A"]);
  });

  it("nor pairs a LOW half-pair that comes first", () => {
    const glyphs = openOurGlyphs(emojiDoc("DC00D83D")).glyphsOfPage(0)[0];
    expect(glyphs?.map((g) => g.unicode)).toEqual(["", ""]);
  });

  it("pairs TWO emojis in a row, without mixing their halves", () => {
    // D83D DC00 then D83D DC01: U+1F400 and U+1F401.
    const glyphs = openOurGlyphs(emojiDoc("D83DDC00D83DDC01")).glyphsOfPage(0)[0];
    expect(glyphs?.map((g) => g.unicode)).toEqual(["\u{1F400}", "", "\u{1F401}", ""]);
  });

  it("does not pair across the end of a text operator", () => {
    // The high half ends one `Tj`, the low one starts the next: nothing says they are the same letters,
    // and pairing across two separate paintings would invent a character.
    const bytes = buildPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>",
      "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
      stream("BT /F1 12 Tf <D83D> Tj <DC00> Tj ET"),
      "<< /Type /Font /Subtype /Type0 /BaseFont /AAAAAC+FreeMono /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>",
      "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /AAAAAC+FreeMono /DW 1000 >>",
      stream(
        "/CIDInit /ProcSet findresource begin\nbegincmap\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n1 beginbfrange\n<0000> <ffff> <0000>\nendbfrange\nendcmap\nend",
      ),
    ]);
    const ops = openOurGlyphs(bytes).glyphsOfPage(0);
    expect(ops.map((glyphs) => glyphs.map((g) => g.unicode))).toEqual([[""], [""]]);
  });
});

describe("openOurGlyphs: a PREDEFINED CMap we cannot read, and we SAY so", () => {
  /** A Type0 whose `/Encoding` is a predefined, non-embedded Adobe CMap — the case of safedocs
   *  `0000316` and `0000877`, which write their English body in `MSungStd-Light-Acro-UniCNS-UCS2-H`. */
  const predefined = (encoding: string, w = ""): Uint8Array =>
    buildPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>",
      "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
      stream("BT /F1 12 Tf <00410042> Tj ET"),
      `<< /Type /Font /Subtype /Type0 /BaseFont /MSungStd-Light /Encoding /${encoding} /DescendantFonts [6 0 R] >>`,
      `<< /Type /Font /Subtype /CIDFontType0 /BaseFont /MSungStd-Light /DW 1000${w} >>`,
    ]);

  it("🔴 UniCNS-UCS2-H IS READ, because its code IS the Unicode code point", () => {
    // 🔴 31/10/2026: "yes, if you do it properly tonight". And it is clean AND small, because a
    // `UniXXX-UCS2-[HV]` CMap needs no table: its code space is `0x0000–0xD7FF & 0xE000–0xFFFF`, so
    // the code is the character (checked in `adobe-type-tools/cmap-resources`, see `./pdf-fonts/predefined-cmaps.ts`).
    // These are the two safedocs that lost their English body: 1,050 words expected, 72 read.
    const glyphs = openOurGlyphs(predefined("UniCNS-UCS2-H")).glyphsOfPage(0)[0];
    expect(glyphs?.map((g) => g.unicode)).toEqual(["A", "B"]);
    expect(glyphs?.map((g) => g.read)).toEqual(["ours", "ours"]);
  });

  it("🔴 and its ADVANCE is EXACT since 03/11/2026: the CID comes from Adobe's table", () => {
    // `/W` is indexed by CID, and a UCS2 code is not the CID: Adobe's table gives it. Without the table every advance
    // was undefined and all the letters landed on one point.
    // The fixture needs a `/W`: with `/DW 1000` alone, the table and the fallback both give 1000 and the test proves
    // nothing. "A" and "B" are CIDs 34 and 35 of Adobe-CNS1.
    const glyphs = openOurGlyphs(predefined("UniCNS-UCS2-H", " /W [34 [600 700]]")).glyphsOfPage(0)[0];
    expect(glyphs?.map((g) => g.width)).toEqual([600, 700]);
    // Without a table (the Korean collection is not embedded), `/DW` answers.
    expect(
      openOurGlyphs(predefined("UniKS-UCS2-H", " /W [34 [600 700]]"))
        .glyphsOfPage(0)[0]
        ?.map((g) => g.width),
    ).toEqual([1000, 1000]);
  });

  it("a predefined CMap whose table we do NOT have keeps the `/DW` fallback, never nothing", () => {
    // ISO 32000-1 §9.7.4.3 makes `/DW` the default width of every unlisted CID: evenly spaced letters, ugly and
    // visible, where `undefined` put them all on one point.
    const glyphs = openOurGlyphs(predefined("UniKS-UCS2-H")).glyphsOfPage(0)[0];
    expect(glyphs?.map((g) => g.width)).toEqual([1000, 1000]);
  });

  it("a /ToUnicode PREVAILS over the identity, as §9.10.2 orders", () => {
    const bytes = buildPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>",
      "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
      stream("BT /F1 12 Tf <0041> Tj ET"),
      "<< /Type /Font /Subtype /Type0 /BaseFont /MSungStd-Light /Encoding /UniCNS-UCS2-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>",
      "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /MSungStd-Light /DW 1000 >>",
      stream(
        "/CIDInit /ProcSet findresource begin\nbegincmap\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n1 beginbfchar\n<0041> <005A>\nendbfchar\nendcmap\nend",
      ),
    ]);
    expect(openOurGlyphs(bytes).glyphsOfPage(0)[0]?.[0]?.unicode).toBe("Z");
  });

  it('🔴 an INHERITED encoding returns `read: "not-ours"` instead of abstaining — it is IGNORANCE, not a verdict', () => {
    // 🔴 THIS CASE COST THE 31/10/2026 MEASUREMENT: my tool only read the files DIRECTLY in
    // `fixtures/pdf`, never its subfolders, so the 20 safedocs of the measurement corpus, living in a subfolder, were outside the
    // population — and I announced "100% agreement" on a corpus that excluded precisely what breaks.
    // The full `check` said so: 1,050 words expected, 72 read.
    // `90ms-RKSJ-H` is MIXED-byte and its code says nothing about the character: it needs Adobe's table, which we
    // do not embed (`pdf-fonts/predefined-cmaps.ts`). The glyph therefore stays unread (`not-ours`): neither text nor advance (formerly left to pdf.js, removed on 01/11/2026).
    const glyphs = openOurGlyphs(predefined("90ms-RKSJ-H")).glyphsOfPage(0)[0];
    expect(glyphs?.map((g) => g.read)).toEqual(["not-ours", "not-ours"]);
  });

  it("claims neither text nor advance for these glyphs", () => {
    const glyph = openOurGlyphs(predefined("90ms-RKSJ-H")).glyphsOfPage(0)[0]?.[0];
    expect(glyph?.unicode).toBeUndefined();
    expect(glyph?.width).toBeUndefined();
  });

  it("a UTF16 one is OURS, and its four-byte code gives ONE glyph", () => {
    // ⚠️ This case claimed the opposite an hour earlier: our splitting did not know how to read the four-byte
    // code range of the `UTF16` space (`<D800DC00> <DBFFDFFF>`). It reads it now, so a character outside the BMP is
    // ONE code and ONE glyph, as pdf.js counted it — which kept the pairing with it.
    const bytes = buildPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>",
      "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
      stream("BT /F1 12 Tf <0041D83DDC000042> Tj ET"),
      "<< /Type /Font /Subtype /Type0 /BaseFont /MSungStd-Light /Encoding /UniCNS-UTF16-H /DescendantFonts [6 0 R] >>",
      "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /MSungStd-Light /DW 1000 >>",
    ]);
    const glyphs = openOurGlyphs(bytes).glyphsOfPage(0)[0];
    expect(glyphs?.map((g) => g.unicode)).toEqual(["A", "\u{1F400}", "B"]);
    expect(glyphs?.map((g) => g.read)).toEqual(["ours", "ours", "ours"]);
  });

  it("a UTF16 one whose high half-pair is NOT followed by a low one abstains on that code", () => {
    const bytes = buildPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>",
      "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
      stream("BT /F1 12 Tf <D83D0041> Tj ET"),
      "<< /Type /Font /Subtype /Type0 /BaseFont /MSungStd-Light /Encoding /UniCNS-UTF16-H /DescendantFonts [6 0 R] >>",
      "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /MSungStd-Light /DW 1000 >>",
    ]);
    expect(
      openOurGlyphs(bytes)
        .glyphsOfPage(0)[0]
        ?.map((g) => g.unicode),
    ).toEqual(["", "A"]);
  });

  it("and the Japanese half-width variant reads like a UCS2 one", () => {
    const glyphs = openOurGlyphs(predefined("UniJIS-UCS2-HW-H")).glyphsOfPage(0)[0];
    expect(glyphs?.map((g) => g.unicode)).toEqual(["A", "B"]);
  });

  it("an Identity-H one stays ours too", () => {
    const glyphs = openOurGlyphs(predefined("Identity-H")).glyphsOfPage(0)[0];
    expect(glyphs?.map((g) => g.read)).toEqual(["ours", "ours"]);
  });

  it("a simple font stays ours too", () => {
    expect(openOurGlyphs(onePage("BT /F1 12 Tf (A) Tj ET")).glyphsOfPage(0)[0]?.[0]?.read).toBe("ours");
  });
});

describe("openOurGlyphs: PAGE BY PAGE, not the whole document (security review of 31/10/2026)", () => {
  /** Two pages, whose SECOND carries a content stream that refuses. */
  function twoPagesSecondBroken(): Uint8Array {
    return buildPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 /MediaBox [0 0 612 792] >>",
      "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
      stream("BT /F1 12 Tf (Hi) Tj ET"),
      WINANSI_FONT,
      "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
      stream("] Tj"),
    ]);
  }

  it("tells how many pages there are without reading a single one of them", () => {
    // 🔴 This is the guard seen biting: if opening read the pages, the second would make it fail.
    expect(openOurGlyphs(twoPagesSecondBroken()).pageCount).toBe(2);
  });

  it("reads the first page even when the second is unreadable", () => {
    const source = openOurGlyphs(twoPagesSecondBroken());
    expect(
      source
        .glyphsOfPage(0)[0]
        ?.map((g) => g.unicode)
        .join(""),
    ).toBe("Hi");
    expect(refusalOf(() => source.glyphsOfPage(1)).reason).toBe("content-syntax");
  });

  it("refuses a page index that does not exist, inventing nothing", () => {
    expect(refusalOf(() => openOurGlyphs(onePage("BT ET")).glyphsOfPage(7)).reason).toBe("page-missing");
  });
});

describe("openOurGlyphs: the glyph cap of a page", () => {
  it("refuses a page that would paint more than MAX_SHOWN_GLYPHS_PER_PAGE glyphs", () => {
    // 🔴 Security review of 31/10/2026: one object per PAINTED BYTE, and nothing bounded it. `MAX_CONTENT_NODES` cannot
    // see it — a painted string is ONE node whatever its length, so a `Tj` costs two
    // nodes whether it paints two bytes or sixty-four megabytes.
    const painted = "A".repeat(MAX_SHOWN_GLYPHS_PER_PAGE + 1);
    expect(refusalOf(() => openOurGlyphs(onePage(`BT /F1 12 Tf (${painted}) Tj ET`)).glyphsOfPage(0)).reason).toBe(
      "glyphs-too-many",
    );
  });

  it("counts the glyphs of ALL the page's operators, not of one", () => {
    const run = "A".repeat(Math.ceil(MAX_SHOWN_GLYPHS_PER_PAGE / 2) + 1);
    const content = `BT /F1 12 Tf (${run}) Tj (${run}) Tj ET`;
    expect(refusalOf(() => openOurGlyphs(onePage(content)).glyphsOfPage(0)).reason).toBe("glyphs-too-many");
  });
});

describe("openOurGlyphs: two fonts on the SAME /ToUnicode share its table", () => {
  it("reads the CMap only ONCE, whatever the number of fonts that name it", () => {
    // 🔴 Security review of 31/10/2026: `/ToUnicode` was re-read and retained per font, so five hundred fonts
    // of one dictionary each, all pointing at one sixty-byte object, retained five hundred tables of
    // 65,536 entries — about three gigabytes for a 60 KB file. The table is shared per OBJECT.
    const cmap = `/CIDInit /ProcSet findresource begin
begincmap
1 begincodespacerange
<00> <FF>
endcodespacerange
1 beginbfchar
<41> <0042>
endbfchar
endcmap
end`;
    const fonts = 40;
    const bodies = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>",
      "",
      "",
      stream(cmap),
    ];
    const names: string[] = [];
    const draws: string[] = [];
    for (let i = 0; i < fonts; i += 1) {
      bodies.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 5 0 R >>`);
      names.push(`/F${i} ${bodies.length} 0 R`);
      draws.push(`/F${i} 12 Tf (A) Tj`);
    }
    const content = `BT ${draws.join(" ")} ET`;
    bodies[2] = `<< /Type /Page /Parent 2 0 R /Resources << /Font << ${names.join(" ")} >> >> /Contents 4 0 R >>`;
    bodies[3] = stream(content);

    const ops = openOurGlyphs(buildPdf(bodies)).glyphsOfPage(0);
    // Each font does render the text of the shared CMap: `<41>` paints "B".
    expect(ops.length).toBe(fonts);
    expect(ops.every((glyphs) => glyphs[0]?.unicode === "B")).toBe(true);
  });
});
