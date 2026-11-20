/** Where every single glyph sits on a PDF page, rebuilt from the operator
 *  stream of our own reader — a resolution no run of text gives, and what every
 *  geometric decision downstream stands on. Each glyph's own text is also
 *  decomposed here for the six Latin ligature presentation forms
 *  (U+FB00-FB06, `LIGATURE_PRESENTATION_FORMS` below), so that a table cell
 *  (`layout/cell-text.ts`), which reads glyphs and never any other text, sees
 *  the same letters as the rest of the pipeline.
 *  Decides: that a glyph whose text is a CONTROL character is not published at
 *  all (`isInventedControl`, 31/10/2026: "we abstain" — a font naming a
 *  glyph `g03` used to publish U+0003); and that reading the glyphs
 *  (`readGlyphs`) is SEPARATE from leaving the hidden ones out and merging
 *  overpaint (`filteredGlyphs`), `buildGlyphFragments` being the two in a row:
 *  a caller that decides its hide policy FROM the glyphs filters them instead of
 *  walking the operators a second time (performance review, 02/11/2026).
 *  NOT here: decoding the operators themselves (`extractor/pdf-ops.ts`), nor
 *  what the positions prove (`layout/**`, `extractor/pdf.ts`).
 *  Called by: `extractor/pdf-source.ts` (the reader), the PDF stages and layout
 *  helpers that use its types and helpers (`extractor/pdf-*.ts`, `glyph-window.ts`), and two probes in `tools/`. */

/**
 * glyph-positions — rebuilds the position of EVERY GLYPH from the operator
 * stream, where `getTextContent()` only returns aggregated runs.
 *
 * WHY THIS FILE EXISTS (measured on 09/09/2026, `docs/INVENTAIRE-PDFJS-
 * UNPDF.md` [purged 27/09/2026, git history]). On a real bordered table, twelve ambiguous fragments out of fifteen
 * came from a single text run crossing three cells — 383.7 pt
 * wide over a column 18.4 pt wide. The aggregation is the doing neither of the
 * file nor of `unpdf`: **the document emits 2990 `moveText` and 2990
 * `showText`, one glyph each**. It is `getTextContent`, a view DERIVED from the paint
 * stream, that glues them back together. The sub-cell position is therefore in the file,
 * and `getOperatorList()` — which `pdf-table-detector.ts#walkPage` already walks
 * — exposes it.
 *
 * TWO SHORTCUTS CLOSED BEFORE GETTING HERE, so that they are not reopened:
 * `getStructTree()` can NOT give what this file looks for — the structure
 * tree declares a reading ORDER and ROLES, never a coordinate,
 * hence never a sub-cell position (this is the structural reason, the one
 * that does not expire; `pdf-source.ts#declaredOrder` says what we take from it).
 * ⚠️ This header carried until 28/10/2026 a FALSE claim — "returns
 * `null` on the real documents measured, never tagged": measurement of
 * 28/10/2026, most of our PDFs in the repo return a non-empty declared
 * order (the count lives in `STATUS` and in the day's journal, not here: a
 * comment does not carry a verifiable external fact). And
 * `disableCombineTextItems` **no longer exists** in `pdfjs-dist` 6.2.108, where
 * passing it is a silent no-op.
 *
 * THIS FILE IS ON THE COUPLED SIDE OF THE BOUNDARY, and that is deliberate
 * (`layout/geometry.ts`, header): it is format decoding, and it is the
 * part where we went wrong. It therefore has its own tests, against operator lists
 * written by hand.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE RECONSTRUCTION, AND WHY TWO NAIVE ATTEMPTS RETURNED `NaN`
 * ─────────────────────────────────────────────────────────────────────────
 * Three matrices compose, and all three are needed:
 *
 *   Trm = P × Tm × CTM,  with  P = | Tfs×Th   0    0 |
 *                                  |   0     Tfs   0 |
 *                                  |   0     Ts    1 |
 *
 * - **CTM**: the graphics state stack (`save`/`restore`/`transform`). It is
 *   what the first attempt ignored. `setFont` returns **75** on the
 *   measured document while the effective size is **9.0008**: the factor
 *   ~0.12 is in the CTM. Forgetting it does not give `NaN` but a wrong order of
 *   magnitude, hence a plausible one — the worse of the two.
 * - **Tm / Tlm**: `Td` translates the LINE matrix (`Tlm`), then `Tm ← Tlm`.
 *   The second attempt only followed `Tm` through `setTextMatrix` — but the
 *   document emits 28 `setTextMatrix` for 2990 `moveText`. Hence `NaN`:
 *   almost all the position came from an operator that was not read.
 * - **P**: `Tfs` (size), `Th` (horizontal scale), `Ts` (rise).
 *
 * The arithmetic checks out on the measured values: `Td 763 −90` with
 * CTM = [0.12; 0; 0; 0.12; 28.31; 810.9] gives
 * 763 × 0.12 + 28.31 = **119.87** and −90 × 0.12 + 810.9 = **800.10**, which is
 * exactly what `getTextContent` returns for this glyph. And 28.3 / 810.9 are
 * moreover the left margin and the top edge of the page.
 *
 * THE ADVANCE, which gives the width (PDF 32000-1, 9.4.4):
 *
 *   tx = ((w0 − Tj/1000) × Tfs + Tc + Tw[if space]) × Th
 *
 * `w0` is the glyph's `width` read by our font reader (`pdf-fonts/widths.ts`, thousandths of an em); `Tj` the
 * kerning offset of a `TJ`, where a NEGATIVE number moves to the right.
 *
 * The width in page space is NOT `w0/1000 × Tfs`: it is taken as the
 * distance between the glyph's origin and that of the next one, both passed
 * through `Trm`. This is what makes it right under rotation, with no special case.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IS COVERED, AND A FAILURE THAT NAMES WHAT IS NOT
 * ─────────────────────────────────────────────────────────────────────────
 * Covered: `BT`, `ET`, `Tm`, `Td`, `TD`, `T*`, `TL`, `Tf`, `Ts`, `Tr`, `Tc`,
 * `Tw`, `Tz`, `Tj`, `TJ`, and `q`/`Q`/`cm`.
 *
 * - `Tc`, `Tw`, `Tz` are state values (22/09/2026). Until then any non-neutral
 *   value threw, and 68 pages of 18 PDFs lost every glyph: `Tc` first on 54,
 *   `TD` on 13, `Tw` on 1 — Word justifies with `Tc`, InDesign moves with `TD`.
 *   `Tw` applies to a glyph our reader marks `isSpace` only (a single-byte code 32, ISO 32000-1 9.3.3), the rule
 *   pdf.js applied before it was removed.
 * - `TD tx ty` sets the leading to −ty, then moves as `Td` (PDF 32000-1, 9.4.2).
 * - `q`/`Q` save and restore the text state with the CTM (PDF 32000-1, 8.4.1:
 *   `Tc`, `Tw`, `Tz`, `TL`, the font size, `Tr`, `Ts`). The text matrices are
 *   not part of it and are not restored.
 * - `'` and `"` never reach this module: our reader (`pdf-ops-ours.ts`) rewrites them into `T*` (plus
 *   `Tw` and `Tc`) and `Tj`.
 *   They still throw if they ever arrive.
 *
 * Everything else that looks like a text operator THROWS, naming it, and so
 * does a glyph of a vertical font (its advance runs down the page; 0 pages of
 * the corpus measured). Returning made-up coordinates in silence on the first
 * document that uses them is exactly what this repository refuses everywhere
 * else. The page then keeps no text at all, `PdfSourcePage.glyphsUnavailable`
 * says why (`unsupported`), and a `pdf-text-unread` notice names the page.
 *
 * `width` stays the ADVANCE, spacing included. Tried on 22/09/2026 and set
 * aside: the ink width alone (`w0` without `Tc`/`Tw`). No table on the 19
 * pages that gain glyphs changed its outcome, and one paragraph moved
 * (safedocs 0000609 p2).
 *
 * Type 3 fonts (font matrix other than 0.001): the caller may give each font's
 * glyph-space scale (`FontScaleOf`, the `[0]` of the font's FontMatrix, read from
 * our font object, `pdf-font-objects.ts`); the advance is then `w0 × scale × Tfs`, as pdf.js's canvas did
 * before its removal. Without it `w0 / 1000` stays. Fixture 26 declares eight Type 3
 * fonts (`/FontMatrix [1/1024 …]`); the earlier claim here, "no document of the
 * corpus is known to carry one", was false (14/10/2026).
 */

import { ReaderError } from "doc-ir";
import { maxOf, minOf } from "../lib/extent";
import { symbolFontText } from "doc-ir/internal";
import { applyMatrix, composeMatrix, IDENTITY_MATRIX, translateMatrix, type Matrix2D } from "../layout/geometry";
import { GRAPHICS_STATE_MAX_DEPTH, GraphicsStateStack, HiddenLayerStack, readFormMatrix, type PdfOp } from "./pdf-ops";
import { dropDoubleDraws } from "./glyph-double-draw";
import { composeAccents } from "./glyph-accents";

export { GRAPHICS_STATE_MAX_DEPTH };

/** An operation of the stream, already named and UNFOLDED — see `./pdf-ops`, which is
 *  now the only file to know the encoding of the arguments (the shape inherited from pdf.js).
 *  Alias kept for the callers; the type lives behind the boundary. */
export type NamedOp = PdfOp;

/** What the glyph builder REFUSES to guess, as a closed tag set where it throws: the caller classifies the abstention by
 *  its class and tag (`pdf-source.ts#textUnreadReasonOf`), never by reading its message, which it drops. */
export type GlyphAbstentionTag = "vertical-writing" | "text-operator";

export class GlyphBuilderAbstention extends ReaderError {
  /** `operator`: the name our operator decoder gave, for a test or a development tool; read by nothing in production. */
  constructor(
    readonly tag: GlyphAbstentionTag,
    operator?: string,
  ) {
    super(
      "EXTRACT_FAILED",
      tag === "vertical-writing"
        ? "vertical writing: its advances run down the page and are not computed, refusing to guess"
        : `unsupported text operator ${operator ?? ""}: not covered by the glyph builder, and guessing a position would be worse than failing`,
    );
    this.name = "GlyphBuilderAbstention";
  }
}

export interface GlyphFragment {
  /**
   * One character — except a Latin ligature (see `LIGATURE_PRESENTATION_FORMS`
   * below in this file), ALWAYS decomposed into its letters.
   *
   * ⚠️ **pdf.js DID NOT DECOMPOSE HERE** (historical; corrected 29/09/2026 — an
   * independent counter-diagnosis found the former explanation false, see
   * `pdf-ligatures.test.ts`). The glyph a ligature paints carries an ALREADY
   * precomposed `unicode` (U+FB00-FB06) in the object pdf.js used to return for
   * `showText` — measured on the SYNTHETIC fixture `14-Ligatures-ToUnicode.pdf`
   * as well as on the REAL fixture `37-Circulaire-Rentree-2023-Pages.pdf`
   * (Apple Pages), whose `/ToUnicode` CMaps themselves map TO that precomposed
   * form. `showText` and `getTextContent()` resolve this Unicode the SAME way
   * (`font.charsToGlyphs()` → `_charToGlyph()`'s `toUnicode.get(charcode)`,
   * pdf.worker.mjs ~l.28767, fed to both paths — ~l.34704 for `showText`,
   * ~l.36098 for `getTextContent()`). What decomposes `getTextContent()`'s text
   * is a POST-PROCESSING step only that path runs, `normalizeUnicode()`
   * (~l.720, NFKC over a closed code-point list), called from
   * `runBidiTransform()` (~l.35856-35859); `showText`'s glyphs never go
   * through it, which is why this module decomposes on its own instead.
   */
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** `Trm` — carries the rotation, which the bounding box cannot carry
   *  (point 13: `extractTextItems` returns `dir: "ltr"` and a wrong width
   *  for a vertical text). */
  matrix: Matrix2D;
  /** Index of the originating paint operation. Two glyphs with the same `runId`
   *  came from the same run: this is what will allow recomposing the text
   *  of a cell, spaces included, once the assignment is done. */
  runId: number;
  /** `isSpace` (single-byte code 32). Marked rather than dropped — the assignment must be able to
   *  ignore it without the text losing it. */
  isSpace: boolean;
  /** How many times this mark was PAINTED at the same place.
   *
   *  Is 1 everywhere, except where the producer goes over its own stroke.
   *  It is not a glyph counter: it is an attribute of THIS glyph —
   *  see the definition at the top of `collapseOverpaint`.
   *
   *  It carries information that the merge would otherwise destroy, and that serves as a
   *  SECOND signal for `colspan`: a generator paints the label of a merged
   *  cell once per sub-column covered. Measured on two templates —
   *  `"Moyennes"` painted 4 times for a colspan of 4, 3 times for a colspan
   *  of 3. Two independent readings that must agree. */
  paintCount: number;
  /**
   * Is the glyph STROKED in addition to being filled — text rendering mode 2
   * or 6?
   *
   * **THIS IS FAKE BOLD**, the kind a word processor makes when the
   * font family has no weight: it fills the glyph, then
   * outlines its edge, which thickens it. Nothing in the font's name says
   * so, nor does the descriptor — it is a drawing decision, not a
   * property of the font (`pdf-table-detector.ts#textPositionSignals` carries
   * the measurement and the three forms of bold).
   *
   * Mode 1 (outline ONLY) is deliberately excluded: that is hollow text,
   * a drop cap or a title effect, not bold.
   */
  stroked: boolean;
  /** The link this glyph's words are tied to (`pdf-links.ts#linkTieOfPage`), set on a copy by `pdf.ts`; what a table
   *  cell, built from glyphs, reads. Absent on a glyph without a link. */
  href?: string;
  /**
   * Set ONLY by `readGlyphs` (never by a plain `buildGlyphFragments(ops)`): why a viewer does not show this glyph —
   * `"mode"` for text rendering mode 3 (neither fill nor stroke; ISO 32000-1 §9.3.6, Table 106), `"layer"` for
   * optional content whose group is OFF (§8.11), `"paint"` for a glyph filled WHITE on the bare page — the typesetter's
   * marks of the Federal Register `sd-4133285` (« VerDate Sep<11>2014 … », drawn after `1 g`, 05/11/2026). A
   * white glyph over a non-white box painted before it on the page is shown. Written limit: only white is the page's
   * colour here; a text painted in the colour of a coloured box is not caught. "Rien d'invisible" (09/10/2026).
   */
  hidden?: "mode" | "layer" | "paint" | "size" | "clip";
  /** Set ONLY by `readGlyphs`, on a glyph in a `NOT_PAINTED_MODES` mode that is NOT hidden (mode 7): published, but
   *  not counted as visible text of the page. */
  unpainted?: true;
  /** The `Tf` font name in force (the name our reader gives its font object; `PdfTextRun.fontId`). Set by `readGlyphs`. */
  font?: string;
  /** What the text rise (`Ts`) added to `x`, `y`, in page space: `{ x: 0, y: 0 }` without a rise. The baseline of the
   *  glyph is `(x - rise.x, y - rise.y)`: a superscript at the same size stays on its line (defect H, 22/09/2026). */
  rise?: { x: number; y: number };
  /** Counts the boundaries met so far: every marked-content begin or end and every form XObject begin or end adds one.
   *  Two glyphs with the same number lie in the same section of the stream; a text run never crosses a boundary. */
  section?: number;
  /** The innermost marked-content `/MCID` open at this glyph (`BDC`), if any. */
  mcid?: number;
  /** Is any open marked-content level an `/Artifact`? */
  artifact?: boolean;
  /** Set ONLY by `readGlyphs`, on the stand-in of a glyph whose font could not be read (`read: "not-ours"`, 17/11/2026): its
   *  text is empty, `filteredGlyphs` never publishes it. It is placed and marked like any other glyph so that ONE filter
   *  says whether that glyph would have been published (`unreadFontKept`). */
  unreadFont?: true;
}

/** The glyph-space scale of a font, `FontMatrix[0]`, for a font whose advance is NOT in thousandths of an em (Type 3);
 *  `undefined` for any other font. Called once per font name per walk. */
export type FontScaleOf = (fontName: string) => number | undefined;

/** Is the font under this name the Symbol font, whose private-use points are translated to the characters they draw
 *  (`lib/symbol-font.ts`)? Called once per font name per walk. */
export type SymbolFontOf = (fontName: string) => boolean;

interface GlyphLike {
  unicode?: string;
  width?: number;
  isSpace?: boolean;
  /** Set on a glyph of a VERTICAL font only (`pdf-ops-ours.ts`; formerly pdf.js). */
  vmetric?: unknown;
  /** Who read the glyph (`pdf-glyph-source.ts#OurGlyph.read`): `"not-ours"` for a font we could not read. */
  read?: unknown;
}

/**
 * The six Latin ligature presentation forms — U+FB00 ff, FB01 fi, FB02 fl,
 * FB03 ffi, FB04 ffl, FB05/FB06 st — the ONLY code points this module ever
 * decomposes. `String.prototype.normalize("NFKC")` applies exactly the
 * Unicode Standard's own compatibility decomposition for a code point
 * matching this pattern (`UnicodeData.txt`, the `<compat>` field); nothing
 * else a real PDF glyph paints is touched.
 *
 * WHY DECOMPOSE AT ALL, CORRECTED 29/09/2026 — an independent counter-
 * diagnosis of this fix (commit bc3900d) found the mechanism below false.
 * `getTextContent()`'s own text (`PdfTextRun.text`, what everything outside a
 * table cell is built from) never carries one of these — measured on the
 * corpus, `pdf-ligatures.test.ts` — but NOT because it reads the font's
 * `/ToUnicode` CMap while `showText` doesn't: both paths resolve a glyph's
 * `unicode` the SAME way (`_charToGlyph`'s `toUnicode.get(charcode)`,
 * pdf.worker.mjs ~l.28767, shared by `handleText` ~l.34704 and the
 * text-content builder ~l.36098), and on `14-Ligatures-ToUnicode.pdf` and
 * `37-Circulaire-Rentree-2023-Pages.pdf` alike that CMap maps TO the
 * precomposed ligature, not away from it. What actually decomposes
 * `getTextContent()`'s text is `normalizeUnicode()` (~l.720, NFKC over a
 * closed code-point list including U+FB00-FB06), a POST-PROCESSING step run
 * only inside `runBidiTransform()` (~l.35856-35859) when text-content items
 * are composed. `showText`'s per-glyph objects, which THIS module reads,
 * never go through it — hence the decomposition below. Left uncorrected, a
 * ligature word inside a table cell (`layout/cell-text.ts` reads glyphs, not
 * runs) publishes with the precomposed character instead of its letters: 73
 * occurrences over 5 cells of `37-Circulaire-Rentree-2023-Pages.pdf`, 0
 * outside a table.
 *
 * KNOWN DIVERGENCE, not fixed: `normalizeUnicode()` also maps U+00A0 and
 * U+2000-200A/202F to an ordinary space; this module keeps NBSP as-is (123 on
 * fixture 37). No effect measured — search treats it as a word boundary, and
 * `conservationKey` drops non-letters.
 */
const LIGATURE_PRESENTATION_FORMS = /^[\uFB00-\uFB06]$/;

/** The glyph's text — decomposed like `getTextContent()`'s own text for five
 *  of the six forms; NOT for U+FB05, where pdf.js's own `normalizeUnicode()`
 *  special-cased the result to "ſt" (long s) while plain NFKC here gives
 *  "st" — see `pdf-ligatures.test.ts`. Kept: "st" is the better outcome for
 *  search (`LIGATURE_PRESENTATION_FORMS` above has the mechanism).
 *
 *  A glyph of more than one code unit is also composed (NFC): Word 2010 gives « é » the Unicode « e » + U+0301, which
 *  pdf.js's own text kept decomposed (fixture 48), so a search typed with the precomposed « é » did not match it
 *  (14/10/2026, docs/CONCEPTION-TEXTE-PDF-GLYPHES.md). It is done HERE, on the glyph, so that a run built from glyphs,
 *  a link walking the glyphs of a word (`pdf-links.ts`) and a table cell all count the same characters. A mark painted
 *  as a glyph of its own after its base is not composed. */
const glyphText = (unicode: string): string =>
  LIGATURE_PRESENTATION_FORMS.test(unicode)
    ? unicode.normalize("NFKC")
    : unicode.length > 1
      ? unicode.normalize("NFC")
      : unicode;

/** Operators that MOVE the text and that this module does not cover. Throwing
 *  rather than ignoring: ignoring them would give wrong positions in silence.
 *
 *  `'` and `"` are here although our reader never emits them (see the header): if
 *  that changes, the page keeps no text (and says so) instead of being misplaced.
 *
 *  `nextLine` (`T*`) left this set on 09/09/2026: the five PDF fixtures of the
 *  time emitted `T*` and never `Td`, the real document measured the reverse, so
 *  leaving it out made the oracle inert. `T*` ≡ `Td 0 −TL`: covering it adds no
 *  unknown. `setLeadingMoveText` (`TD`) left it on 22/09/2026 for the same
 *  reason: it is fully determined. */
const UNSUPPORTED_MOVING_OPS = new Set(["nextLineShowText", "nextLineSetSpacingShowText"]);

/** The part of the graphics state this module reads — what `q` saves and `Q`
 *  restores (PDF 32000-1, 8.4.1). The text and line matrices are NOT in it. */
interface TextState {
  ctm: Matrix2D;
  /** `Tf`'s size, before the CTM. */
  fontSize: number;
  /** `Tf`'s font name. */
  fontName: string;
  /** `Ts`. */
  rise: number;
  /** `Tr`. 0 by default: fill only. */
  textRenderMode: number;
  /** The non-stroking colour in force, `#rrggbb` lower-case; black on a fresh page (§8.6.8), `undefined` after a colour
   *  set in a space we do not convert (`setFillColourUnknown`). Saved and restored with the graphics state. */
  fill: string | undefined;
  /** `TL`. Moves nothing by itself: read by `T*` and set by `TD`. */
  leading: number;
  /** `Tz` / 100. */
  hScale: number;
  /** `Tc`, in unscaled text space units. */
  charSpacing: number;
  /** `Tw`, added to a glyph marked `isSpace` only. */
  wordSpacing: number;
}

/** Text operators with no effect on the GEOMETRY — ignored knowingly.
 *  `setTextRenderingMode` decides visibility, not
 *  position (the invisible OCR layer is detected elsewhere, `walkPage`). */
const IGNORED_TEXT_OPS = new Set(["setTextRenderingMode", "beginText", "endText"]);

/**
 * The floor under which nobody reads a glyph, in points. One measure, the rendered height of the glyph
 * (`hypot(trm.c, trm.d)`, the definition of `PdfTextRun.fontSize`), refuses two gaps of « What Users See Is Not What
 * Models Read » (arXiv:2606.15020): EG07, a near-zero font size (`0.01 Tf`), and EG12, a degenerate text matrix
 * (`d = 0`).
 *
 * What bounds the floor from above is our own geometry, not human legibility. Tried and set aside: 1 pt. A diagonal
 * watermark whose rotation is lost upstream reaches us upright and 0.8 pt high, so 1 pt dropped a visible word.
 *
 * Starting value to calibrate, with its two populations: real text as we see it, 0.792 pt at the lowest (that
 * watermark; legible text starts at 3.5 pt); hostile, 0.01 pt and 0.
 * Written limit: a text between this floor and legibility (about 3 pt) is still published. Tightening the floor
 * first takes reading a watermark's real geometry.
 */
export const MIN_VISIBLE_HEIGHT = 0.25;

/** Text rendering modes that paint NOTHING themselves: 3 (neither fill nor stroke) and 7 (add to the clip only) - ISO
 *  32000-1 §9.3.6, Table 106. ONE set for "does this page have visible text": the scan/OCR-layer verdict of
 *  `pdf-table-detector.ts` and the filter of `pdf-hidden-text.ts` both count only glyphs outside it, so they cannot
 *  disagree on a page (a scan with an OCR layer and some mode 7 text is an OCR page for both). */
export const NOT_PAINTED_MODES: ReadonlySet<number> = new Set([3, 7]);

/** Mode 7: the text only adds its outline to the clip (ISO 32000-1 §9.3.6, Table 106). The operator paints nothing
 *  itself; what follows in the same `q` may be painted through the letters. */
const CLIP_ONLY_MODE = 7;

/** The modes whose text is HIDDEN by the rule "Rien d'invisible" (what is dropped): only 3. Mode 7 is published
 *  (09/10/2026: a gradient title exported from PowerPoint is visible through its clip). Bias, chosen: an
 *  unpainted stencil is published. */
export const INVISIBLE_TEXT_MODES: ReadonlySet<number> = new Set([3]);

/** Is a glyph a viewer does not show left out? A hidden layer always; a mode 3 glyph only when `dropModeHidden`. */
export const isGlyphDropped = (hidden: GlyphFragment["hidden"], dropModeHidden: boolean): boolean =>
  hidden === "layer" || hidden === "paint" || (hidden === "mode" && dropModeHidden);

/** How `buildGlyphFragments` treats glyphs a viewer does not show ("Rien d'invisible", 09/10/2026). */
export interface HidePolicy {
  /** Whether an optional-content group (`pdf-layers.ts`, ISO 32000-1 §8.11) is shown. */
  isLayerVisible: (group: unknown) => boolean;
  /** Drop mode 3 glyphs. False on a page whose every glyph is invisible: that is an OCR layer over a scan, which
   *  stays published (the `ocrLayer` verdict of `pdf-table-detector.ts`). */
  dropModeHidden: boolean;
}

/** Text rendering modes that FILL THEN STROKE — fake bold. Mode 1
 *  strokes without filling: that is hollow text, not bold. */
const STROKED_TEXT_MODES = new Set([2, 6]);

/** Anything that is neither handled, nor ignored, nor a text operator at all.
 *  We only throw on what LOOKS like text: the stream also holds
 *  colours, paths and images, which do not concern us. */
const looksLikeTextOp = (op: string): boolean => /text|font|leading|charspac|wordspac|hscale/i.test(op);

/** `transform` and `setTextMatrix` ALREADY arrive as a `Matrix2D`:
 *  `decodeOps` untangled the four encodings of the former pdf.js upstream, and that is
 *  exactly what the boundary moved. This module only knows ordinary
 *  matrices; if it receives anything else, it throws rather than
 *  build on an invented geometry. */
const asMatrix = (args: unknown, op: string): Matrix2D => {
  const m = args as Partial<Matrix2D> | undefined;
  if (
    m === undefined ||
    typeof m.a !== "number" ||
    typeof m.b !== "number" ||
    typeof m.c !== "number" ||
    typeof m.d !== "number" ||
    typeof m.e !== "number" ||
    typeof m.f !== "number"
  ) {
    // An INTERNAL contract broken, never the file's fault: `UNKNOWN`, which a page's reason reads as `unexpected` (17/11/2026).
    throw new ReaderError("UNKNOWN", `${op}: expected a decoded matrix (see pdf-ops.decodeOps), got something else`);
  }
  return { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f };
};

const numberArg = (args: unknown, index: number): number => {
  const v: unknown = Array.isArray(args) ? args[index] : undefined;
  return typeof v === "number" ? v : 0;
};

/**
 * The operator stream of ONE page → one fragment per glyph, in page space.
 *
 * Throws `EXTRACT_FAILED`, naming the operator, as soon as it meets an
 * uncovered text move: better a document that visibly fails than a
 * table published on invented coordinates.
 */
export function buildGlyphFragments(
  ops: readonly NamedOp[],
  hide?: HidePolicy,
  fontScaleOf?: FontScaleOf,
  symbolFontOf?: SymbolFontOf,
): GlyphFragment[] {
  return filteredGlyphs(readGlyphs(ops, hide?.isLayerVisible, fontScaleOf, symbolFontOf), hide);
}

/** The second half of `buildGlyphFragments`: the glyphs `readGlyphs` gave, the hidden ones left out, overpaint merged. A caller that has already
 *  read the glyphs (to decide the hide policy from them) passes them here instead of walking the operators a second time. */
export function filteredGlyphs(all: GlyphFragment[], hide?: HidePolicy): GlyphFragment[] {
  const readable = pageIsReadable(all);
  const kept: GlyphFragment[] = [];
  // `unpainted` is a marker for the filter only: it is taken out of the published glyph. `hidden` too — and it is
  // stripped on BOTH paths, since a size mark is set whether or not the page has a hiding policy.
  // eslint-disable-next-line sonarjs/no-unused-vars -- rest-destructure to omit a key from the published glyph
  for (const { hidden, unpainted: _unpainted, ...glyph } of all) {
    // The stand-in of an unreadable font's glyph is never published: it only feeds `unreadFontKept`.
    if (glyph.unreadFont === true || isFilteredOut(hidden, readable, hide)) continue;
    kept.push(glyph);
  }
  return composeAccents(dropDoubleDraws(collapseOverpaint(kept)));
}

/** Would a glyph of a font we could not read have been PUBLISHED, its font readable? The one filter of the published
 *  text (`isFilteredOut`, the same page-level `readable`) decides, on the stand-ins `readGlyphs` places (17/11/2026: nothing
 *  invisible in the source is published nor expected, so an invisible glyph of such a font is no missing word). */
export function unreadFontKept(all: readonly GlyphFragment[], hide?: HidePolicy): boolean {
  const readable = pageIsReadable(all);
  return all.some((glyph) => glyph.unreadFont === true && !isFilteredOut(glyph.hidden, readable, hide));
}

/** Decided at page level, like the mode 3 rule and for the same reason: a page whose whole text is under the floor
 *  is no injection, it is a page drawn at a scale (an imposition, a `cm` of 0.05). A tiny glyph is dropped only when
 *  the page carries one that is not. A
 *  stand-in of an unreadable font has no text, so it never makes a page readable. */
const pageIsReadable = (all: readonly GlyphFragment[]): boolean =>
  all.some((g) => g.hidden === undefined && g.unpainted === undefined && !g.isSpace && g.text.trim() !== "");

/** Is a glyph with this mark left out of the published text? `size` and `clip` hold without a hiding policy:
 *  neither a size nor an empty clip shows in an operator, so no pre-scan can announce them. */
const isFilteredOut = (hidden: GlyphFragment["hidden"], readable: boolean, hide: HidePolicy | undefined): boolean =>
  hidden === "size" || hidden === "clip" ? readable : hide !== undefined && isGlyphDropped(hidden, hide.dropModeHidden);

/** The open marked-content levels of a page: their `/MCID`s and which are an `/Artifact`. Both answers a glyph needs are kept
 *  up to date on push and pop, so that reading them is O(1) however deep the stack (a hostile page opens a million `BDC`
 *  without `EMC`; scanning the stack at each glyph would be quadratic). */
export class MarkedContentStack {
  /** For each level, the innermost mcid defined at that level or below (a `BMC` without mcid inherits). */
  private readonly mcids: (number | undefined)[] = [];
  private readonly artifacts: boolean[] = [];
  private artifactDepth = 0;

  push(mcid: number | undefined, artifact: boolean): void {
    this.mcids.push(mcid ?? this.innermostMcid);
    this.artifacts.push(artifact);
    if (artifact) this.artifactDepth += 1;
  }

  pop(): void {
    if (this.mcids.length === 0) return;
    this.mcids.pop();
    if (this.artifacts.pop() === true) this.artifactDepth -= 1;
  }

  get innermostMcid(): number | undefined {
    return this.mcids[this.mcids.length - 1];
  }

  get inArtifact(): boolean {
    return this.artifactDepth > 0;
  }
}

/** What the walk over one page's operators carries from one operator to the next. */
interface GlyphWalk {
  /** `BDC /OC` sections have their own stack, independent of `q`/`Q`. */
  layers: HiddenLayerStack;
  stack: GraphicsStateStack<TextState>;
  textMatrix: Matrix2D;
  lineMatrix: Matrix2D;
  out: GlyphFragment[];
  /** Boundary counter (`GlyphFragment.section`). */
  section: number;
  /** The open marked-content levels. */
  marked: MarkedContentStack;
  /** The boxes of every NON-white fill and every image painted so far, in page space: what shelters a white glyph drawn over them. */
  darkFills: { xMin: number; xMax: number; yMin: number; yMax: number }[];
  /** Set once `darkFills` holds `MAX_SHELTER_BOXES_PER_PAGE`: from then on no white glyph is dropped. */
  sheltersFull: boolean;
  fontScaleOf: FontScaleOf | undefined;
  /** `fontScaleOf` answers, by font name. */
  fontScales: Map<string, number | undefined>;
  symbolFontOf: SymbolFontOf | undefined;
  /** `symbolFontOf` answers, by font name. */
  symbolFonts: Map<string, boolean>;
  /** Mode 7 (EG11): a clip text is visible only through what is painted through it. Three values say it: the
   *  current `q`/`Q` depth, the number of paints since the page began, and the clip glyphs not yet judged. */
  depth: number;
  paints: number;
  clipGlyphs: { index: number; depth: number; paintsAt: number }[];
}

/** Judges the clip glyphs whose `q` has just closed: if nothing was painted since they were drawn, their outline
 *  never showed anything. `toDepth` is the depth after the `Q` (-1 at the end of the page, to empty the list). */
function settleClipGlyphs(walk: GlyphWalk, toDepth: number): void {
  const pending: GlyphWalk["clipGlyphs"] = [];
  for (const clip of walk.clipGlyphs) {
    if (clip.depth <= toDepth) {
      pending.push(clip);
      continue;
    }
    if (walk.paints === clip.paintsAt) {
      const glyph = walk.out[clip.index];
      if (glyph !== undefined) glyph.hidden = "clip";
    }
  }
  walk.clipGlyphs = pending;
}

/** Td, TD and T*: the translation applies to the LINE matrix, then Tm takes Tlm. */
const moveLine = (walk: GlyphWalk, tx: number, ty: number): void => {
  walk.lineMatrix = composeMatrix(translateMatrix(tx, ty), walk.lineMatrix);
  walk.textMatrix = walk.lineMatrix;
};

/** `q`, `Q`, `cm`, `Tr`: the graphics-state operators. Returns false for any other operator. */
function applyStateOp(op: string, args: unknown, walk: GlyphWalk): boolean {
  const { stack } = walk;
  if (op === "save") {
    stack.save();
    walk.depth += 1;
  } else if (op === "restore") {
    stack.restore();
    walk.depth = Math.max(0, walk.depth - 1);
    settleClipGlyphs(walk, walk.depth);
  } else if (op === "transform") {
    const state = stack.current;
    state.ctm = composeMatrix(asMatrix(args, "transform"), state.ctm);
  } else if (op === "setTextRenderingMode") {
    stack.current.textRenderMode = typeof args === "number" ? args : numberArg(args, 0);
  } else {
    return false;
  }
  return true;
}

const WHITE = "#ffffff";
/** Modes that STROKE the outline (1, 2, 5, 6; ISO 32000-1 Table 106). The stroke colour is not tracked, so a white fill
 *  says nothing about what is painted: such a glyph is never called white on the bare page. */
const STROKING_MODES: ReadonlySet<number> = new Set([1, 2, 5, 6]);

/** HOW MANY SHELTER BOXES A PAGE KEEPS (06/11/2026, review). Each white glyph is tested against every box, so a page of
 *  B boxes and G white glyphs costs B x G. Past the cap no box is kept and no white glyph of the page is dropped: the
 *  bias is « we publish ». Starting value to calibrate. */
export const MAX_SHELTER_BOXES_PER_PAGE = 20_000;
const FILL_PAINTS = new Set(["fill", "eoFill", "fillStroke", "eoFillStroke", "closeFillStroke", "closeEOFillStroke"]);
/** The paints that show ink without filling: mode 7 is judged on them too (a title clipped, then stroked). */
const STROKE_PAINTS = new Set(["stroke", "closeStroke"]);
const UNIT_SQUARE = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];
const IMAGE_PAINTS = new Set(["paintImageXObject", "paintInlineImageXObject"]);

/** The fill colour in force (`rg`, `g`, `k`, or a space we do not convert). Returns false for any other operator. */
function applyColourOp(op: string, args: unknown, walk: GlyphWalk): boolean {
  if (op === "setFillRGBColor") {
    const hex: unknown = Array.isArray(args) ? args[0] : args;
    if (typeof hex === "string") walk.stack.current.fill = hex.toLowerCase();
    return true;
  }
  if (op === "setFillColourUnknown") {
    walk.stack.current.fill = undefined;
    return true;
  }
  return false;
}

/** What shelters a white glyph: the paths filled in a non-white colour, the images painted, a stencil painted dark.
 *  Returns false for any other operator. */
function applyShelterOp(op: string, args: unknown, walk: GlyphWalk): boolean {
  const { fill } = walk.stack.current;
  // An UNKNOWN colour (`setFillColourUnknown`: a space we do not convert, a pattern) counts as not white: the bias is
  // « we publish », so what it paints shelters the white text above it.
  const dark = fill !== WHITE;
  if (op === "paintShading") {
    // `sh` paints the whole clip, which we do not track: its box is unknown, so it shelters the whole page from here on.
    walk.darkFills.push({ xMin: -Infinity, xMax: Infinity, yMin: -Infinity, yMax: Infinity });
    walk.paints += 1;
    return true;
  }
  if (op === "constructPath") {
    if (dark) rememberDarkFill(args, walk);
    const paint = (args as { paint?: string } | null)?.paint;
    if (paint !== undefined && (FILL_PAINTS.has(paint) || STROKE_PAINTS.has(paint))) walk.paints += 1;
    return true;
  }
  if (IMAGE_PAINTS.has(op) || (op === "paintImageMaskXObject" && dark)) {
    walk.paints += 1;
    // An image is drawn in the unit square under the CTM (§8.9.4); a stencil is painted with the fill colour.
    rememberShelter(UNIT_SQUARE, walk);
    return true;
  }
  return false;
}

/** A path FILLED (the caller checked the colour is not white): its box, in page space, joins what shelters white text
 *  drawn after it. The box is the path's `minMax` (curves included — a disc is all curves, and the decoded subpaths stop
 *  at the first), else its decoded points. */
function rememberDarkFill(args: unknown, walk: GlyphWalk): void {
  const path = args as { paint?: string; subpaths?: { x: number; y: number }[][]; minMax?: number[] } | null;
  if (path === null || typeof path !== "object" || path.paint === undefined || !FILL_PAINTS.has(path.paint)) return;
  const box = path.minMax;
  if (box !== undefined && box.length === 4) {
    rememberShelter(
      [
        { x: box[0]!, y: box[1]! },
        { x: box[2]!, y: box[1]! },
        { x: box[2]!, y: box[3]! },
        { x: box[0]!, y: box[3]! },
      ],
      walk,
    );
    return;
  }
  if (Array.isArray(path.subpaths)) rememberShelter(path.subpaths.flat(), walk);
}

/** The box of these points, under the CTM, joins what shelters white text drawn after it. */
function rememberShelter(points: readonly { x: number; y: number }[], walk: GlyphWalk): void {
  if (points.length === 0) return;
  if (walk.darkFills.length >= MAX_SHELTER_BOXES_PER_PAGE) {
    walk.sheltersFull = true;
    return;
  }
  const { ctm } = walk.stack.current;
  const placed = points.map((pt) => applyMatrix(ctm, pt.x, pt.y));
  walk.darkFills.push({
    xMin: minOf(placed, (pt) => pt.x),
    xMax: maxOf(placed, (pt) => pt.x),
    yMin: minOf(placed, (pt) => pt.y),
    yMax: maxOf(placed, (pt) => pt.y),
  });
}

/** Is a glyph at (x, y) painted WHITE on the bare page — over no non-white box painted before it? Then a viewer does not show it. */
const whiteOnPageAt = (walk: GlyphWalk, x: number, y: number): boolean =>
  walk.stack.current.fill === WHITE &&
  !walk.sheltersFull &&
  !STROKING_MODES.has(walk.stack.current.textRenderMode) &&
  !walk.darkFills.some((box) => x >= box.xMin && x <= box.xMax && y >= box.yMin && y <= box.yMax);

/** The begin and end of a form XObject. Returns false for any other operator. */
function applyFormOp(op: string, args: unknown, walk: GlyphWalk): boolean {
  const { stack } = walk;
  if (op === "paintFormXObjectBegin") {
    // A form XObject runs in its own graphics state; its /Matrix is concatenated
    // to the CTM before its content (ISO 32000-1 8.10.1). Past the depth cap the
    // form is not isolated; its End is paired like a surplus `Q`.
    const { ctm } = stack.current;
    const formMatrix = readFormMatrix(args);
    stack.form((top) => ({ ...top, ctm: formMatrix === undefined ? ctm : composeMatrix(formMatrix, ctm) }));
    walk.section += 1;
  } else if (op === "paintFormXObjectEnd") {
    stack.restore();
    walk.section += 1;
  } else {
    return false;
  }
  return true;
}

/** `BMC`/`BDC`/`EMC`: the marked-content operators. Returns false for any other operator. */
function applyMarkedContentOp(
  op: string,
  args: unknown,
  walk: GlyphWalk,
  isLayerVisible: ((group: unknown) => boolean) | undefined,
): boolean {
  if (op === "beginMarkedContent" || op === "beginMarkedContentProps") {
    walk.layers.enter(op, args, isLayerVisible);
    // `BDC`: [tag, MCID or null], the tag already a string; `BMC`: [tag] with the tag still a name object `{ name }`
    // (the operator list, not a text-content view: fixture 33, page 6, tags its footer that way).
    const list = Array.isArray(args) ? (args as unknown[]) : [];
    const tag = typeof list[0] === "string" ? list[0] : (list[0] as { name?: unknown } | null | undefined)?.name;
    walk.marked.push(
      typeof list[1] === "number" && Number.isInteger(list[1]) ? list[1] : undefined,
      tag === "Artifact",
    );
    walk.section += 1;
  } else if (op === "endMarkedContent") {
    walk.layers.leave();
    walk.marked.pop();
    walk.section += 1;
  } else {
    return false;
  }
  return true;
}

/** The operators of the graphics state, of form XObjects and of marked content. Returns false for any other operator. */
function applyGraphicsOp(
  op: string,
  args: unknown,
  walk: GlyphWalk,
  isLayerVisible: ((group: unknown) => boolean) | undefined,
): boolean {
  return (
    applyStateOp(op, args, walk) ||
    applyColourOp(op, args, walk) ||
    applyShelterOp(op, args, walk) ||
    applyFormOp(op, args, walk) ||
    applyMarkedContentOp(op, args, walk, isLayerVisible)
  );
}

/** The operators that place the text and line matrices: `BT`, `Tm`, `Td`, `TD`, `T*`. Returns false for any other operator. */
function applyTextPlacementOp(op: string, args: unknown, walk: GlyphWalk): boolean {
  if (op === "beginText") {
    walk.textMatrix = IDENTITY_MATRIX;
    walk.lineMatrix = IDENTITY_MATRIX;
  } else if (op === "setTextMatrix") {
    walk.textMatrix = asMatrix(args, "setTextMatrix");
    walk.lineMatrix = walk.textMatrix;
  } else if (op === "moveText") {
    // Td: the translation applies to the LINE matrix, then Tm takes Tlm.
    // This is the operator the second attempt did not read, although it
    // carries 2990 of the 3018 moves of the measured document.
    moveLine(walk, numberArg(args, 0), numberArg(args, 1));
  } else if (op === "setLeadingMoveText") {
    // `TD tx ty` ≡ `−ty TL` then `tx ty Td` (PDF 32000-1, 9.4.2).
    walk.stack.current.leading = -numberArg(args, 1);
    moveLine(walk, numberArg(args, 0), numberArg(args, 1));
  } else if (op === "nextLine") {
    // `T*` ≡ `Td 0 −TL`, to the letter (PDF 32000-1, 9.4.2).
    moveLine(walk, 0, -walk.stack.current.leading);
  } else {
    return false;
  }
  return true;
}

/** The operators that set a field of the text state: `TL`, `Tf`, `Ts`, `Tc`, `Tw`, `Tz`. Returns false for any other operator. */
function applyTextStateOp(op: string, args: unknown, state: TextState): boolean {
  if (op === "setLeading") {
    // `TL` alone moves nothing: it feeds `T*`. Following it is what makes
    // `T*` exact instead of guessed.
    state.leading = numberArg(args, 0);
  } else if (op === "setFont") {
    state.fontSize = Math.abs(numberArg(args, 1));
    state.fontName = Array.isArray(args) && typeof args[0] === "string" ? args[0] : "";
  } else if (op === "setTextRise") {
    state.rise = numberArg(args, 0);
  } else if (op === "setCharSpacing") {
    state.charSpacing = numberArg(args, 0);
  } else if (op === "setWordSpacing") {
    state.wordSpacing = numberArg(args, 0);
  } else if (op === "setHScale") {
    state.hScale = numberArg(args, 0) / 100;
  } else {
    return false;
  }
  return true;
}

/** Is this an operator that moves or sets text and that no branch above covers? Guessing a position would be worse than failing. */
const isUnsupportedTextOp = (op: string): boolean =>
  UNSUPPORTED_MOVING_OPS.has(op) || (looksLikeTextOp(op) && !IGNORED_TEXT_OPS.has(op));

/** The marks a glyph carries when the caller asked to know what a viewer does not show (`GlyphFragment.hidden`). */
const NO_MARK = {};
const LAYER_MARK = { hidden: "layer" as const };
const MODE_MARK = { hidden: "mode" as const };
const PAINT_MARK = { hidden: "paint" as const };
const SIZE_MARK = { hidden: "size" as const };
const UNPAINTED_MARK = { unpainted: true as const };
const UNREAD_FONT_MARK = { unreadFont: true as const };
/** A glyph's mark, in the order of the verdicts: its size first (it holds without a hiding policy), then its layer,
 *  its mode, and white on white. `whiteOnPageAt` costs a search, so it is evaluated in its branch only. */
function markOfGlyph(
  walk: GlyphWalk,
  isLayerVisible: ((group: unknown) => boolean) | undefined,
  textRenderMode: number,
  height: number,
  origin: { x: number; y: number },
): Pick<GlyphFragment, "hidden" | "unpainted"> {
  if (height < MIN_VISIBLE_HEIGHT) return SIZE_MARK;
  if (isLayerVisible === undefined) return NO_MARK;
  return hiddenMarkOf(walk.layers.hidden, textRenderMode, whiteOnPageAt(walk, origin.x, origin.y));
}

function hiddenMarkOf(
  layerHidden: boolean,
  textRenderMode: number,
  whiteOnPage: boolean,
): Pick<GlyphFragment, "hidden" | "unpainted"> {
  if (layerHidden) return LAYER_MARK;
  if (INVISIBLE_TEXT_MODES.has(textRenderMode)) return MODE_MARK;
  if (NOT_PAINTED_MODES.has(textRenderMode)) return UNPAINTED_MARK;
  return whiteOnPage ? PAINT_MARK : NO_MARK;
}

const NO_RISE: Readonly<{ x: number; y: number }> = Object.freeze({ x: 0, y: 0 });

/** The scale of a font's glyph space, asked of the caller once per font name per walk. */
function fontScaleOfWalk(walk: GlyphWalk, fontName: string): number | undefined {
  if (walk.fontScaleOf === undefined) return undefined;
  if (!walk.fontScales.has(fontName)) walk.fontScales.set(fontName, walk.fontScaleOf(fontName));
  return walk.fontScales.get(fontName);
}

/** Is the font the Symbol font, asked of the caller once per font name per walk. */
function isSymbolFontOfWalk(walk: GlyphWalk, fontName: string): boolean {
  if (walk.symbolFontOf === undefined) return false;
  let answer = walk.symbolFonts.get(fontName);
  if (answer === undefined) {
    answer = walk.symbolFontOf(fontName);
    walk.symbolFonts.set(fontName, answer);
  }
  return answer;
}

/** The glyph's Unicode text, its private-use points translated when the font is Symbol. */
const glyphUnicode = (unicode: string | undefined, inSymbolFont: boolean): string =>
  inSymbolFont ? symbolFontText(unicode ?? "") : (unicode ?? "");

/** 🔴 WE ABSTAIN RATHER THAN PUBLISH WHAT pdf.js INVENTED (31/10/2026: "we abstain").
 *  When nothing says what a code paints — a glyph named `g03`, a CID without `/ToUnicode` — pdf.js returned the CODE
 *  as if it were a character: U+0003 for `g03`. Measured by the POC (`tools/poc/which-names.ts` (deleted, see git history)): 27 glyphs
 *  of `13-Police-Sans-CMap` and `49-GrandSoissons-RPQS` thus become CONTROL characters, which nothing
 *  in the rendering filtered — only `publisher/title.ts` cleans a page's title.
 *  A control character is never the content of a document: it is invisible, and the product rule says
 *  that nothing invisible is published. The tab is kept, because a document can really
 *  carry it.
 *  LIMIT: the other half of the defect needs OUR font layer, which knows that a font has no
 *  `/ToUnicode` (24 glyphs of `25-Notice-Montre-InDesign` where pdf.js returned "x" for CID 0x78); pdf.js did not
 *  say so, so this path could not abstain. */
const INVENTED_CONTROL = /^[\u0000-\u0008\u000a-\u001f\u007f-\u009f]+$/u;
const isInventedControl = (text: string): boolean => INVENTED_CONTROL.test(text);

/** What a shown glyph places: its text, or — for a glyph of a font we could not read (`read: "not-ours"`, 17/11/2026) — a
 *  stand-in with no text, placed and marked like the others so the filter of the published text can judge it
 *  (`unreadFontKept`); `undefined` for a glyph that places nothing (no text, or an invented control character). */
function placedTextOf(g: GlyphLike, inSymbolFont: boolean): { text: string; unreadFont?: true } | undefined {
  const unicode = glyphUnicode(g.unicode, inSymbolFont);
  if (unicode.length === 0) return g.read === "not-ours" ? { text: "", ...UNREAD_FONT_MARK } : undefined;
  return isInventedControl(unicode) ? undefined : { text: glyphText(unicode) };
}

/** How far the text rise moved the origin: the gap to where the same glyph would sit with a rise of zero. */
function riseShiftOf(
  rise: number,
  params: Matrix2D,
  textToDevice: Matrix2D,
  origin: { x: number; y: number },
): { x: number; y: number } {
  if (rise === 0) return NO_RISE;
  const flat = applyMatrix(composeMatrix({ ...params, f: 0 }, textToDevice), 0, 0);
  return { x: origin.x - flat.x, y: origin.y - flat.y };
}

/** `Tj`/`TJ`: one fragment per glyph of the shown items, the text matrix moving on after each. `runId` is the index of the operator. */
function showGlyphs(
  args: unknown,
  runId: number,
  walk: GlyphWalk,
  isLayerVisible: ((group: unknown) => boolean) | undefined,
): void {
  const items = (Array.isArray(args) ? args[0] : undefined) as unknown[] | undefined;
  if (!Array.isArray(items)) return;
  const { ctm, fontSize, fontName, rise, textRenderMode, hScale, charSpacing, wordSpacing } = walk.stack.current;
  const fontScale = fontScaleOfWalk(walk, fontName);
  const inSymbolFont = isSymbolFontOfWalk(walk, fontName);
  const mcid = walk.marked.innermostMcid;
  const artifact = walk.marked.inArtifact;
  for (const item of items) {
    if (typeof item === "number") {
      // Kerning of a TJ: a NEGATIVE number moves to the right.
      const tx = (-item / 1000) * fontSize * hScale;
      walk.textMatrix = composeMatrix(translateMatrix(tx, 0), walk.textMatrix);
      continue;
    }
    const g = item as GlyphLike;
    if (g.vmetric !== undefined && g.vmetric !== null) {
      // A vertical font advances DOWN the page, by an amount this module
      // does not compute: a named abstention, never a guessed position.
      throw new GlyphBuilderAbstention("vertical-writing");
    }
    const params: Matrix2D = { a: fontSize * hScale, b: 0, c: 0, d: fontSize, e: 0, f: rise };
    const trm = composeMatrix(params, composeMatrix(walk.textMatrix, ctm));
    const origin = applyMatrix(trm, 0, 0);

    const glyphAdvance = fontScale === undefined ? (g.width ?? 0) / 1000 : (g.width ?? 0) * fontScale;
    const advance = (glyphAdvance * fontSize + charSpacing + (g.isSpace === true ? wordSpacing : 0)) * hScale;
    const nextTextMatrix = composeMatrix(translateMatrix(advance, 0), walk.textMatrix);
    // The width is the distance between the two origins, not a product:
    // that is what keeps it right under rotation, with no special case.
    const nextOrigin = applyMatrix(composeMatrix(params, composeMatrix(nextTextMatrix, ctm)), 0, 0);
    const width = Math.hypot(nextOrigin.x - origin.x, nextOrigin.y - origin.y);

    const placed = placedTextOf(g, inSymbolFont);
    if (placed !== undefined) {
      const riseShift = riseShiftOf(rise, params, composeMatrix(walk.textMatrix, ctm), origin);
      walk.out.push({
        ...placed,
        x: origin.x,
        y: origin.y,
        width,
        height: Math.hypot(trm.c, trm.d),
        matrix: trm,
        runId,
        stroked: STROKED_TEXT_MODES.has(textRenderMode),
        isSpace: g.isSpace === true,
        paintCount: 1,
        font: fontName,
        rise: riseShift,
        section: walk.section,
        ...(mcid === undefined ? {} : { mcid }),
        artifact,
        ...markOfGlyph(walk, isLayerVisible, textRenderMode, Math.hypot(trm.c, trm.d), origin),
      });
      // Its verdict waits for what gets painted: `settleClipGlyphs` gives it at the `Q` that closes its clip.
      if (textRenderMode === CLIP_ONLY_MODE)
        walk.clipGlyphs.push({ index: walk.out.length - 1, depth: walk.depth, paintsAt: walk.paints });
    }
    walk.textMatrix = nextTextMatrix;
  }
}

/**
 * Every glyph of the page, in paint order, BEFORE the overpaint merge. With `isLayerVisible` given, a glyph a viewer
 * does not show carries `hidden` (see `GlyphFragment.hidden`); without it nothing is flagged. The marked-content
 * stack is independent of `q`/`Q` (ISO 32000-1 §14.6), so it has its own stack: a `BDC /OC` hides every glyph until
 * its `EMC`, whatever the graphics state does meanwhile.
 */
export function readGlyphs(
  ops: readonly NamedOp[],
  isLayerVisible?: (group: unknown) => boolean,
  fontScaleOf?: FontScaleOf,
  symbolFontOf?: SymbolFontOf,
): GlyphFragment[] {
  const walk: GlyphWalk = {
    layers: new HiddenLayerStack(),
    stack: new GraphicsStateStack<TextState>({
      ctm: IDENTITY_MATRIX,
      fontSize: 0,
      fontName: "",
      rise: 0,
      textRenderMode: 0,
      leading: 0,
      hScale: 1,
      charSpacing: 0,
      wordSpacing: 0,
      fill: "#000000",
    }),
    textMatrix: IDENTITY_MATRIX,
    lineMatrix: IDENTITY_MATRIX,
    out: [],
    section: 0,
    marked: new MarkedContentStack(),
    darkFills: [],
    sheltersFull: false,
    depth: 0,
    paints: 0,
    clipGlyphs: [],
    fontScaleOf,
    fontScales: new Map(),
    symbolFontOf,
    symbolFonts: new Map(),
  };

  for (let i = 0; i < ops.length; i++) {
    const { op, args } = ops[i]!;
    if (op === "showText" || op === "showSpacedText") {
      showGlyphs(args, i, walk, isLayerVisible);
    } else if (!(
      applyGraphicsOp(op, args, walk, isLayerVisible) ||
      applyTextPlacementOp(op, args, walk) ||
      applyTextStateOp(op, args, walk.stack.current)
    )) {
      if (isUnsupportedTextOp(op)) {
        throw new GlyphBuilderAbstention("text-operator", op);
      }
    }
  }

  settleClipGlyphs(walk, -1);
  return walk.out;
}

/**
 * A GLYPH IS IDENTIFIED BY ITS CHARACTER AND ITS POSITION.
 *
 * Two marks at the same point are not two characters: they are **one mark
 * painted twice**. This function therefore removes nothing — it applies the
 * definition. The conservation property of `layout/cell-text` holds
 * entirely under this definition, and **there is no exception here to
 * delimit**.
 *
 * **The wording is deliberate.** Written as a "narrow exception", someone
 * would find it one day and widen it — *since the principle is
 * already breached*. Written as the definition of what a glyph IS, it
 * opens nothing.
 *
 * **No restriction of context, and that is intended.** The merge does not
 * only apply to merged cells: two strictly co-located glyphs
 * are a paint duplicate everywhere. Measured on real documents — over-painting
 * only exists on the header row, 0.6 % to 1.7 % of the glyphs,
 * all at a single ordinate per page. Restricting would therefore protect against nothing
 * and add a condition that would have to be explained.
 *
 * **It is the STRICT condition that protects**: same character, same position.
 * Two different characters at the same point, or the same character at distinct
 * points, are never merged — they come out as they are.
 *
 * The position tolerance is 0.01 pt, a hundredth of the PDF point: far
 * below any real typographic gap, and just enough to absorb the
 * noise of a matrix composition. The first occurrence is kept,
 * hence the reading order of the document too.
 */
function collapseOverpaint(glyphs: readonly GlyphFragment[]): GlyphFragment[] {
  const seen = new Map<string, GlyphFragment>();
  const out: GlyphFragment[] = [];
  for (const g of glyphs) {
    const key = `${Math.round(g.x * 100)}|${Math.round(g.y * 100)}|${g.text}`;
    const first = seen.get(key);
    if (first === undefined) {
      const kept = { ...g };
      seen.set(key, kept);
      out.push(kept);
      continue;
    }
    first.paintCount += 1;
  }
  return out;
}
