/** What a private-use point written in the Symbol font draws: Word stores θ as U+F071, − as U+F02D, • as U+F0B7, and
 *  Confluence draws nothing for such a point and search cannot find it. Here the point becomes the character it draws,
 *  by the official table (ISO 32000-1 Annex D.5 « Symbol Set and Encoding », glyph names to Unicode by the Adobe Glyph
 *  List), and ONLY when the font is Symbol (26/10/2026). The table was generated once from pdfjs-dist
 *  (`SymbolSetEncoding` × `getGlyphsUnicode()`), now removed from the product; the table is ours and stays.
 *  Written biases: Delta, Omega and mu are the GREEK letters (U+0394, U+03A9, U+03BC), not the maths signs the Adobe
 *  list gives (U+2206, U+2126, U+00B5), because that is what a maths document is searched for. The 29 codes whose
 *  Unicode is itself private-use (bracket and brace pieces, serif and sans ®©™, radical and arrow extenders) have no
 *  entry: the point stays as it is.
 *  Written limits: Wingdings and every other symbol font keep their points (another table). ASCII written in a Symbol
 *  font (« q » for θ) is not translated: pdf.js gave U+F0xx when Word wrote a ToUnicode, translated a non-embedded
 *  Symbol itself, and only an embedded simple symbolic TrueType without ToUnicode gave ASCII (measured before its removal). `w:t` text in a run whose
 *  `w:rFonts` is Symbol is not read by the app as symbols. PowerPoint is translated too, when a run's `a:sym` or `a:latin` typeface
 *  is Symbol (`extractor/pptx-reader/text.ts#isSymbolRun`; a written `a:sym` decides alone). A Symbol font a run INHERITS (`a:defRPr` of a
 *  list style, layout or master) is not seen: only the run's own `a:rPr` counts.
 *  NOT here: where the font name comes from (each reader reads its own).
 *  Called by: `extractor/docx-reader/body.ts`, `pipeline/source-reading-docx.ts`, `extractor/glyph-positions.ts`,
 *  `extractor/pdf-source.ts`, `extractor/pptx-reader/text.ts`, `pipeline/source-reading-pptx.ts`, `tools/bench/words.ts`. */

/** Symbol code (0x20–0xFE) → Unicode code point, exclusions and Greek bias already applied (160 rows). */
const ROWS: ReadonlyArray<readonly [number, number]> = [
  [0x20, 0x0020], // space
  [0x21, 0x0021], // exclam
  [0x22, 0x2200], // universal
  [0x23, 0x0023], // numbersign
  [0x24, 0x2203], // existential
  [0x25, 0x0025], // percent
  [0x26, 0x0026], // ampersand
  [0x27, 0x220b], // suchthat
  [0x28, 0x0028], // parenleft
  [0x29, 0x0029], // parenright
  [0x2a, 0x2217], // asteriskmath
  [0x2b, 0x002b], // plus
  [0x2c, 0x002c], // comma
  [0x2d, 0x2212], // minus
  [0x2e, 0x002e], // period
  [0x2f, 0x002f], // slash
  [0x30, 0x0030], // zero
  [0x31, 0x0031], // one
  [0x32, 0x0032], // two
  [0x33, 0x0033], // three
  [0x34, 0x0034], // four
  [0x35, 0x0035], // five
  [0x36, 0x0036], // six
  [0x37, 0x0037], // seven
  [0x38, 0x0038], // eight
  [0x39, 0x0039], // nine
  [0x3a, 0x003a], // colon
  [0x3b, 0x003b], // semicolon
  [0x3c, 0x003c], // less
  [0x3d, 0x003d], // equal
  [0x3e, 0x003e], // greater
  [0x3f, 0x003f], // question
  [0x40, 0x2245], // congruent
  [0x41, 0x0391], // Alpha
  [0x42, 0x0392], // Beta
  [0x43, 0x03a7], // Chi
  [0x44, 0x0394], // Delta
  [0x45, 0x0395], // Epsilon
  [0x46, 0x03a6], // Phi
  [0x47, 0x0393], // Gamma
  [0x48, 0x0397], // Eta
  [0x49, 0x0399], // Iota
  [0x4a, 0x03d1], // theta1
  [0x4b, 0x039a], // Kappa
  [0x4c, 0x039b], // Lambda
  [0x4d, 0x039c], // Mu
  [0x4e, 0x039d], // Nu
  [0x4f, 0x039f], // Omicron
  [0x50, 0x03a0], // Pi
  [0x51, 0x0398], // Theta
  [0x52, 0x03a1], // Rho
  [0x53, 0x03a3], // Sigma
  [0x54, 0x03a4], // Tau
  [0x55, 0x03a5], // Upsilon
  [0x56, 0x03c2], // sigma1
  [0x57, 0x03a9], // Omega
  [0x58, 0x039e], // Xi
  [0x59, 0x03a8], // Psi
  [0x5a, 0x0396], // Zeta
  [0x5b, 0x005b], // bracketleft
  [0x5c, 0x2234], // therefore
  [0x5d, 0x005d], // bracketright
  [0x5e, 0x22a5], // perpendicular
  [0x5f, 0x005f], // underscore
  [0x61, 0x03b1], // alpha
  [0x62, 0x03b2], // beta
  [0x63, 0x03c7], // chi
  [0x64, 0x03b4], // delta
  [0x65, 0x03b5], // epsilon
  [0x66, 0x03c6], // phi
  [0x67, 0x03b3], // gamma
  [0x68, 0x03b7], // eta
  [0x69, 0x03b9], // iota
  [0x6a, 0x03d5], // phi1
  [0x6b, 0x03ba], // kappa
  [0x6c, 0x03bb], // lambda
  [0x6d, 0x03bc], // mu
  [0x6e, 0x03bd], // nu
  [0x6f, 0x03bf], // omicron
  [0x70, 0x03c0], // pi
  [0x71, 0x03b8], // theta
  [0x72, 0x03c1], // rho
  [0x73, 0x03c3], // sigma
  [0x74, 0x03c4], // tau
  [0x75, 0x03c5], // upsilon
  [0x76, 0x03d6], // omega1
  [0x77, 0x03c9], // omega
  [0x78, 0x03be], // xi
  [0x79, 0x03c8], // psi
  [0x7a, 0x03b6], // zeta
  [0x7b, 0x007b], // braceleft
  [0x7c, 0x007c], // bar
  [0x7d, 0x007d], // braceright
  [0x7e, 0x223c], // similar
  [0xa0, 0x20ac], // Euro
  [0xa1, 0x03d2], // Upsilon1
  [0xa2, 0x2032], // minute
  [0xa3, 0x2264], // lessequal
  [0xa4, 0x2044], // fraction
  [0xa5, 0x221e], // infinity
  [0xa6, 0x0192], // florin
  [0xa7, 0x2663], // club
  [0xa8, 0x2666], // diamond
  [0xa9, 0x2665], // heart
  [0xaa, 0x2660], // spade
  [0xab, 0x2194], // arrowboth
  [0xac, 0x2190], // arrowleft
  [0xad, 0x2191], // arrowup
  [0xae, 0x2192], // arrowright
  [0xaf, 0x2193], // arrowdown
  [0xb0, 0x00b0], // degree
  [0xb1, 0x00b1], // plusminus
  [0xb2, 0x2033], // second
  [0xb3, 0x2265], // greaterequal
  [0xb4, 0x00d7], // multiply
  [0xb5, 0x221d], // proportional
  [0xb6, 0x2202], // partialdiff
  [0xb7, 0x2022], // bullet
  [0xb8, 0x00f7], // divide
  [0xb9, 0x2260], // notequal
  [0xba, 0x2261], // equivalence
  [0xbb, 0x2248], // approxequal
  [0xbc, 0x2026], // ellipsis
  [0xbf, 0x21b5], // carriagereturn
  [0xc0, 0x2135], // aleph
  [0xc1, 0x2111], // Ifraktur
  [0xc2, 0x211c], // Rfraktur
  [0xc3, 0x2118], // weierstrass
  [0xc4, 0x2297], // circlemultiply
  [0xc5, 0x2295], // circleplus
  [0xc6, 0x2205], // emptyset
  [0xc7, 0x2229], // intersection
  [0xc8, 0x222a], // union
  [0xc9, 0x2283], // propersuperset
  [0xca, 0x2287], // reflexsuperset
  [0xcb, 0x2284], // notsubset
  [0xcc, 0x2282], // propersubset
  [0xcd, 0x2286], // reflexsubset
  [0xce, 0x2208], // element
  [0xcf, 0x2209], // notelement
  [0xd0, 0x2220], // angle
  [0xd1, 0x2207], // gradient
  [0xd5, 0x220f], // product
  [0xd6, 0x221a], // radical
  [0xd7, 0x22c5], // dotmath
  [0xd8, 0x00ac], // logicalnot
  [0xd9, 0x2227], // logicaland
  [0xda, 0x2228], // logicalor
  [0xdb, 0x21d4], // arrowdblboth
  [0xdc, 0x21d0], // arrowdblleft
  [0xdd, 0x21d1], // arrowdblup
  [0xde, 0x21d2], // arrowdblright
  [0xdf, 0x21d3], // arrowdbldown
  [0xe0, 0x25ca], // lozenge
  [0xe1, 0x2329], // angleleft
  [0xe5, 0x2211], // summation
  [0xf1, 0x232a], // angleright
  [0xf2, 0x222b], // integral
  [0xf3, 0x2320], // integraltp
  [0xf5, 0x2321], // integralbt
];

export const SYMBOL_FONT_TABLE: ReadonlyMap<number, string> = new Map(ROWS.map(([code, unicode]) => [code, String.fromCodePoint(unicode)]));

const POINT_TO_CODE_OFFSET = 0xf000;
const POINTS = /[\uF020-\uF0FF]/;
const POINTS_ALL = /[\uF020-\uF0FF]/g;

/** `text` with each point U+F020–U+F0FF that has an entry replaced by its character; the same string when none. */
export const symbolFontText = (text: string): string =>
  POINTS.test(text) ? text.replace(POINTS_ALL, (point) => SYMBOL_FONT_TABLE.get(point.charCodeAt(0) - POINT_TO_CODE_OFFSET) ?? point) : text;

/** Symbol by its name only (subset prefix and style suffix allowed): Segoe UI Symbol and SymbolNeu are Unicode fonts. */
const SYMBOL_FONT_NAME = /^(?:[A-Z]{6}\+)?Symbol(?:MT)?(?:[,-](?:Bold|Italic|BoldItalic))?$/i;

export const isSymbolFont = (name: string | undefined): boolean => name !== undefined && SYMBOL_FONT_NAME.test(name);
