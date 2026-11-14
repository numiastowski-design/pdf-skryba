/** The second, independent reading of a Word document or a Google Doc
 *  export that becomes its conservation source
 *  (MIKSUDOC « Spécification technique » T11): every `w:t`/`m:t`
 *  word, text boxes and called notes, read straight off the zip — never
 *  through `extractor/docx-reader`'s reading nor its IR, so an extractor bug
 *  cannot pass its own check. The BYTES layer alone is shared
 *  (`source-reading-package.ts`): every part is opened through
 *  `ooxml/package.ts`'s bounded inflate and hardened parser, a
 *  refusal becoming an abstention. Moved here, unchanged, from
 *  `pipeline/no-word-lost.test.ts` (§4 of the conception): that test now
 *  imports `readSource` and `wordsOf` from here instead of keeping its own
 *  copy — one reader, not two.
 *  A table the page does not publish (over the column or row cap, `lib/table-width-cap.ts#tableExceedsCaps` via
 *  `source-reading-table.ts`, counted from this reading's own XML) expects none of its own words (the notes it calls are still read: the page publishes them); that count sees through `w:sdt` / `w:customXml` wrappers
 *  around rows and cells and ignores hidden text, as the page does.
 *  A SmartArt expects the words of its data model where its drawing stands (`source-reading-smartart.ts`, ECMA-376 Part 1 §21.4); hidden and off-page drawings expect none.
 *  The same walk counts the document's STRUCTURE for the structure control (`source-structure-docx.ts`: headings per level, outermost tables, list items,
 *  and what the page withholds, flattens or adds).
 *  NOT here: comparing the source against the published page
 *  (`pipeline/declared-format-conservation.ts`, `pipeline/structure-conservation.ts`), the docx EXTRACTOR itself
 *  (`extractor/docx.ts`, `extractor/docx-reader/**`).
 *  DECIDES here: what each kind of element contributes to the text and with which cause (one visit per kind, `VISITS`), which
 *  notes are read and in which order (`appendCalledNotes`), and WHERE A WORD ENDS — a drawing the page shows separates the
 *  texts around it (29/10/2026), because Word puts a title, a picture and a paragraph in one `w:p` with nothing between.
 *  Called by: `extractor/dispatch.ts`, for `docx` and `google-doc` (Drive
 *  exports a Google Doc to .docx first — same bytes, same reader). Its
 *  tokeniser `wordsOf` (defined in `lib/words.ts`, re-exported here) is the
 *  ONE word rule of every declared format: `pipeline/declared-format-conservation.ts`
 *  and `pipeline/conservation-source.ts#unitOf` import it from `lib/words`.
 *  `pipeline/no-word-lost.test.ts` imports the reader and the tokeniser. */

import type { MissingWordCause } from "doc-ir/lib/reader-types";
import type { ReaderLimits } from "doc-ir/lib/reader-limits";
import { isSymbolFont, symbolFontText } from "doc-ir/lib/symbol-font";
import { wordsOf } from "../lib/words";
import { resolveTarget } from "../extractor/ooxml/package";
import { chartReadOf, type ChartRead } from "./source-reading-chart";
import { smartArtPieces, smartArtRelIds } from "./source-reading-smartart";
import { attrOf, first, kidsOf, openSourceParts, pushAll, structureOnly, stylesOrAbsent, tagOf, textOf, type N } from "./source-reading-package";
import { guardedSourceAsync, type ConservationSourceReadFailure, type DeclaredFormatConservationSource, type UnitStructure } from "./conservation-source";
import { createListRule, DocxStructureTally, headingLevelOfId, headingLevelOfName } from "./source-structure-docx";
import { placeRowCells, tableWithheld, type CoveredRange, type GridRow } from "./source-reading-table";

const on = (el: N): boolean => {
  const v = attrOf(el, "w:val");
  return v === undefined || !["false", "0", "off"].includes(v);
};

/** Whether a run is hidden, given its `w:rPr` and its paragraph's style: `readStyleTable(...).hidden`, the walk's own rule. */
type HiddenRun = (rPr: N | undefined, pStyle: string | undefined) => boolean;

/** A drawing whose `wp:docPr` is hidden ("1" or "true", any case) is not published (Mikolaj, 08/10/2026). Written here on its own, not shared with the extractor. */
const drawingHidden = (drawing: N): boolean => {
  const frame = first(drawing, "wp:inline") ?? first(drawing, "wp:anchor");
  const hidden = attrOf(first(frame, "wp:docPr") ?? {}, "hidden")?.trim().toLowerCase();
  return hidden === "1" || hidden === "true";
};

/** A page size in EMU. */
interface Page {
  widthEmu: number;
  heightEmu: number;
}

/** A written number, or undefined when absent or not finite. */
const numberOf = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
};

/** The largest page of the document: the widest and the tallest `w:pgSz` over all its `w:sectPr` (twips, 635 EMU each;
 *  ECMA-376 Part 1 §17.6.13). Undefined when there is no section or one declares no readable size, as the page. */
const largestPageOf = (body: N): Page | undefined => {
  let width = 0;
  let height = 0;
  let sections = 0;
  let unreadable = false;
  const walkSections = (node: N): void => {
    for (const c of kidsOf(node)) {
      const tag = tagOf(c);
      if (tag === "#text") continue;
      if (tag === "w:sectPr") {
        sections++;
        const size = first(c, "w:pgSz");
        const w = size ? numberOf(attrOf(size, "w:w")) : undefined;
        const h = size ? numberOf(attrOf(size, "w:h")) : undefined;
        if (w === undefined || h === undefined || w <= 0 || h <= 0) unreadable = true;
        else {
          width = Math.max(width, w);
          height = Math.max(height, h);
        }
        continue;
      }
      walkSections(c);
    }
  };
  walkSections(body);
  return sections === 0 || unreadable ? undefined : { widthEmu: width * 635, heightEmu: height * 635 };
};

const rotated = (n: N): boolean => (tagOf(n) === "a:xfrm" && ![undefined, "0"].includes(attrOf(n, "rot"))) || kidsOf(n).some(rotated);

/** A floating drawing lying ENTIRELY outside the largest page is not displayed, so not published nor expected (Mikolaj,
 *  09/10/2026). Same conditions as the page, written on their own: a `wp:anchor` (never inline), not rotated, with a known
 *  `wp:extent`, positioned by `wp:simplePos` (page coordinates) or by `wp:positionH`/`wp:positionV` `relativeFrom="page"`
 *  with a `wp:posOffset` (ECMA-376 Part 1 §20.4.2.3, §20.4.2.10); one axis wholly outside is enough. */
const drawingOffPage = (drawing: N, page: Page | undefined): boolean => {
  const frame = first(drawing, "wp:anchor");
  if (!frame || !page || rotated(frame)) return false;
  const extent = first(frame, "wp:extent");
  const cx = extent ? numberOf(attrOf(extent, "cx")) : undefined;
  const cy = extent ? numberOf(attrOf(extent, "cy")) : undefined;
  if (cx === undefined || cy === undefined) return false;
  const outside = (start: number | undefined, size: number, limit: number): boolean => start !== undefined && (start >= limit || start + size < 0 || (size > 0 && start + size <= 0));
  if (["1", "true", "on"].includes(attrOf(frame, "simplePos") ?? "")) {
    const pos = first(frame, "wp:simplePos");
    return (
      outside(pos ? numberOf(attrOf(pos, "x")) : undefined, cx, page.widthEmu) || outside(pos ? numberOf(attrOf(pos, "y")) : undefined, cy, page.heightEmu)
    );
  }
  const offsetOnPage = (tag: string): number | undefined => {
    const el = first(frame, tag);
    if (!el || attrOf(el, "relativeFrom") !== "page") return undefined;
    const offset = first(el, "wp:posOffset");
    return offset ? numberOf(textOf(offset).trim()) : undefined;
  };
  return outside(offsetOnPage("wp:positionH"), cx, page.widthEmu) || outside(offsetOnPage("wp:positionV"), cy, page.heightEmu);
};

/** True when the subtree holds a visible word (a `w:t`/`m:t` beyond blanks; deletions, field codes, fallbacks, hidden runs, hidden and off-page drawings apart). */
const holdsWord = (n: N, hidden: HiddenRun, page: Page | undefined, pStyle?: string): boolean =>
  kidsOf(n).some((c) => {
    const tag = tagOf(c);
    if (tag === "w:t" || tag === "m:t") return textOf(c).trim() !== "";
    if (tag === "w:del" || tag === "w:moveFrom" || tag === "w:instrText" || tag === "mc:Fallback") return false;
    if (tag === "w:r" && hidden(first(c, "w:rPr"), pStyle)) return false;
    if (tag === "w:drawing" && (drawingHidden(c) || drawingOffPage(c, page))) return false;
    if (tag === "w:p") return holdsWord(c, hidden, page, attrOf(first(first(c, "w:pPr"), "w:pStyle") ?? {}, "w:val"));
    if (tag === "w:txbxContent") return holdsWord(c, hidden, page, undefined);
    return holdsWord(c, hidden, page, pStyle);
  });

/** The rows of a `w:tbl` or the cells of a `w:tr` (`tag`), through the `w:sdt` content controls and `w:customXml` wrappers that only group them, as the page does. */
const unwrapped = (parent: N, tag: "w:tr" | "w:tc"): N[] =>
  kidsOf(parent).flatMap((c) => {
    const t = tagOf(c);
    if (t === tag) return [c];
    if (t === "w:customXml") return unwrapped(c, tag);
    const content = t === "w:sdt" ? first(c, "w:sdtContent") : undefined;
    return content ? unwrapped(content, tag) : [];
  });

/** Reads a `w:tbl`: `withheld` when the page does not publish it (too wide or too long once its empty columns and empty header rows are left out), by
 *  this reading's own count of its grid: a cell takes its `w:gridSpan` columns (at most 63, as Word) and starts at the next column
 *  no vertical merge above covers; `w:gridBefore` only keys the merges below, it takes no column in the layout (as the page). A header row (`w:tblHeader`) is empty for the page when it has no word, the words of the rows that continue
 *  its vertical merges included: a `w:vMerge` continuation (absent or "continue" value) folds into the restart cell above it only
 *  when that restart sits in the SAME grid column (`w:gridBefore` included) with the same span in the row just before, as the
 *  extractor's table walk folds them; a restart nothing continues, or a continuation with nothing above, is an ordinary cell.
 *  `folded` lists its vMerge continuation cells (their words are not shown). Linear in the cells. */
const readTable = (tbl: N, hidden: HiddenRun, page: Page | undefined, limits: ReaderLimits | undefined): { withheld: boolean; folded: Set<N> } => {
  const folded = new Set<N>();
  interface ReadCell {
    span: number;
    filled: boolean;
    rowspan: number; // 1 + the continuations folded into it
  }
  // The declared grid bounds a span as on the page (`docx-reader/body.ts#tableBlock`): no `w:tblGrid`, only the 63.
  const gridColumns = kidsOf(first(tbl, "w:tblGrid") ?? {}).filter((c) => tagOf(c) === "w:gridCol").length;
  let open = new Map<number, { span: number; cell: ReadCell }>(); // restart cells the row above leaves open, by grid column
  const read = unwrapped(tbl, "w:tr").map((tr) => {
    const trPr = first(tr, "w:trPr");
    const header = first(trPr, "w:tblHeader");
    // As the page (`intAttr`): `parseInt` of the value, a negative number kept (ST_DecimalNumber is signed), junk or absent is 0.
    const before = Number.parseInt(attrOf(first(trPr, "w:gridBefore") ?? {}, "w:val") ?? "", 10);
    let column = Number.isFinite(before) ? before : 0;
    const next = new Map<number, { span: number; cell: ReadCell }>();
    const cells: ReadCell[] = [];
    for (const tc of unwrapped(tr, "w:tc")) {
      const tcPr = first(tc, "w:tcPr");
      const span = Number.parseInt(attrOf(first(tcPr, "w:gridSpan") ?? {}, "w:val") ?? "1", 10);
      const vMerge = first(tcPr, "w:vMerge");
      const value = vMerge === undefined ? undefined : (attrOf(vMerge, "w:val") ?? "continue");
      // As the extractor: only "restart" opens a merge and only an absent value or "continue" continues one; any other value is an ordinary cell.
      const kind = value === "restart" || value === "continue" ? value : undefined;
      const cell: ReadCell = {
        span: Math.min(63, gridColumns === 0 ? 63 : Math.max(1, gridColumns - column), Math.max(1, Number.isInteger(span) ? span : 1)),
        filled: holdsWord(tc, hidden, page),
        rowspan: 1,
      };
      const above = open.get(column);
      if (kind === "continue" && above && above.span === cell.span) {
        // A continuation is no cell of its own: its row folds into the restart cell, as on the page, but its WORDS do not: Word
        // does not show them (docs/PLATFORM-STATUS.md §67, Mikolaj 09/10/2026), so they neither fill the restart cell nor are expected.
        folded.add(tc);
        above.cell.rowspan++;
        next.set(column, above);
      } else {
        cells.push(cell);
        if (kind === "restart") next.set(column, { span: cell.span, cell });
      }
      column += cell.span;
    }
    open = next;
    return { cells, header: header !== undefined && on(header) };
  });
  // The page lays the cells out WITHOUT `w:gridBefore` (it only keys the merges): each cell starts at the next column no rowspan
  // above covers (`lib/table-empty-parts.ts#anchorsOf`), the covered columns kept as ranges, never one by one. A gap stands for them.
  let covered: CoveredRange[] = [];
  // A row's emptiness is decided once the whole table is read: a restart cell gets the words of the rows that continue it only
  // when the rows below are read. A merged cell with no word at all is counted empty (the page removes its empty column and
  // the merge with it), the safe side: a word reported missing, never one lost unseen.
  const rows: GridRow[] = read.map(({ cells, header }, r) => {
    const row = placeRowCells(covered, cells, r, read.length);
    covered = row.covered;
    return { cells: row.placed, emptyHeader: header && cells.length > 0 && cells.every((c) => !c.filled) };
  });
  return { withheld: tableWithheld(rows, limits), folded };
};

interface StyleInfo {
  name: string | undefined;
  basedOn: string | undefined;
  vanish: boolean | undefined;
  numbered: boolean | undefined;
}

const readStyleTable = (styles: N | undefined) => {
  const table = new Map<string, StyleInfo>();
  let defaultParagraph: string | undefined;
  let defaultCharacter: string | undefined;
  let baseVanish = false;
  for (const s of styles ? kidsOf(styles) : []) {
    if (tagOf(s) === "w:docDefaults") {
      const v = first(first(first(s, "w:rPrDefault"), "w:rPr"), "w:vanish");
      baseVanish = v ? on(v) : false;
    }
    if (tagOf(s) !== "w:style") continue;
    const id = attrOf(s, "w:styleId");
    if (id === undefined) continue;
    const vanishEl = first(first(s, "w:rPr"), "w:vanish");
    const numId = attrOf(first(first(first(s, "w:pPr"), "w:numPr"), "w:numId") ?? {}, "w:val");
    table.set(id, {
      name: attrOf(first(s, "w:name") ?? {}, "w:val"),
      basedOn: attrOf(first(s, "w:basedOn") ?? {}, "w:val"),
      vanish: vanishEl ? on(vanishEl) : undefined,
      numbered: numId !== undefined ? numId !== "0" : undefined,
    });
    const isDefault = ["1", "true", "on"].includes(attrOf(s, "w:default") ?? "");
    if (isDefault && attrOf(s, "w:type") === "paragraph") defaultParagraph ??= id;
    if (isDefault && attrOf(s, "w:type") === "character") defaultCharacter ??= id;
  }
  /** The nearest declaration of a property along a style's basedOn chain. */
  const nearest = (id: string | undefined, key: "vanish" | "numbered"): boolean | undefined => {
    const seen = new Set<string>();
    for (let cur = id; cur !== undefined && !seen.has(cur); cur = table.get(cur)?.basedOn) {
      seen.add(cur);
      const v = table.get(cur)?.[key];
      if (v !== undefined) return v;
    }
    return undefined;
  };
  // The basedOn walk depends on the style id alone, never on the run: memoised.
  const memo = { vanish: new Map<string | undefined, boolean | undefined>(), numbered: new Map<string | undefined, boolean | undefined>() };
  const nearestOf = (id: string | undefined, key: "vanish" | "numbered"): boolean | undefined => {
    const m = memo[key];
    if (!m.has(id)) m.set(id, nearest(id, key));
    return m.get(id);
  };
  // The heading level a paragraph style gives: along its basedOn chain, the first style whose NAME (else, for a style with no name,
  // whose built-in ID) is a heading style; a style defined nowhere, or a `Subtitle`, stops the walk. Depends on the style id alone: memoised.
  const levels = new Map<string | undefined, number | undefined>();
  const headingLevel = (id: string | undefined): number | undefined => {
    const seen = new Set<string>();
    for (let cur = id ?? defaultParagraph; cur !== undefined && !seen.has(cur); cur = table.get(cur)?.basedOn) {
      seen.add(cur);
      const info = table.get(cur);
      if (info === undefined) return undefined; // a style defined nowhere is a plain paragraph (ECMA-376 Part 1 section 17.7), as on the page
      const found = info.name === undefined ? headingLevelOfId(cur) : headingLevelOfName(info.name);
      if (found === "plain") return undefined;
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return {
    headingLevelOf: (id: string | undefined): number | undefined => {
      if (!levels.has(id)) levels.set(id, headingLevel(id));
      return levels.get(id);
    },
    /** w:vanish, a toggle: direct value, else docDefaults XOR paragraph style XOR character style. */
    hidden: (rPr: N | undefined, pStyle: string | undefined): boolean => {
      const direct = first(rPr, "w:vanish");
      if (direct) return on(direct);
      const cStyle = attrOf(first(rPr, "w:rStyle") ?? {}, "w:val") ?? defaultCharacter;
      return (baseVanish !== (nearestOf(pStyle ?? defaultParagraph, "vanish") ?? false)) !== (nearestOf(cStyle, "vanish") ?? false);
    },
    numberedByStyle: (pStyle: string | undefined): boolean => nearestOf(pStyle ?? defaultParagraph, "numbered") ?? false,
  };
};

export interface SourceReading {
  text: string;
  /** What the document declares of its structure, with what the page withholds, flattens and adds (`source-structure-docx.ts`). */
  structure: UnitStructure;
  /** A part only the structure reads was refused: the structure control abstains (`SourceStructure.unreadable`). */
  structureUnreadable?: true;
  /** One cause per token `wordsOf(text)` would produce, same order (lot C
   *  addendum, MIKSUDOC « Spécification technique » T11, 29/09/2026) — see
   *  `causesOf` below for how the two token streams are kept aligned. */
  wordCauses: MissingWordCause[];
}

/** A run of text with the source element it came from — the walk's sink,
 *  chunk by chunk (one push per XML text node or synthesised separator),
 *  never split mid-word: `text = chunks.map(c => c.text).join("")` is
 *  EXACTLY the string `wordsOf` tokenised before this addendum, so the
 *  authoritative word list and count are unchanged. */
interface Chunk {
  text: string;
  cause: MissingWordCause;
}

const hasTocField = (n: N): boolean =>
  kidsOf(n).some(
    (c) =>
      (tagOf(c) === "w:instrText" && /^\s*TOC\b/i.test(textOf(c))) ||
      (tagOf(c) === "w:fldSimple" && /^\s*TOC\b/i.test(attrOf(c, "w:instr") ?? "")) ||
      hasTocField(c),
  );

/** Best-effort: the word-run boundaries used here (no NFKC first) match
 *  `wordsOf`'s NFKC-then-split boundaries for every real FR/EN fixture read
 *  so far (STATUS.md, lot A, 20+ real docx) — Word writes accented Latin
 *  letters precomposed, never decomposed, so `\p{L}` already covers them
 *  raw. A future fixture that breaks this (a decomposed diacritic split
 *  across two chunks) degrades to the "text" cause on the affected word only
 *  — never to a wrong missing-word COUNT, which stays driven by `wordsOf`
 *  alone (`readDocxConservationSource` tokenises `text`, not this). */
const WORD_RUN = /[\p{L}\p{N}]+/gu;

/** One cause per token `wordsOf(chunks.map(c => c.text).join(""))` would
 *  produce, aligned by RAW character offset (see the doc comment above). */
const causesOf = (chunks: readonly Chunk[]): MissingWordCause[] => {
  // One pass, one cause lookup per WORD: `starts[i]` is chunk i's raw offset
  // and the word runs come in ascending order, so the chunk cursor only moves
  // forward (no per-character slot, no spread of the matches).
  const starts: number[] = [];
  let raw = "";
  for (const c of chunks) {
    starts.push(raw.length);
    raw += c.text;
  }
  const causes: MissingWordCause[] = [];
  let at = 0;
  for (const m of raw.matchAll(WORD_RUN)) {
    while (at + 1 < chunks.length && starts[at + 1]! <= m.index) at++;
    causes.push(chunks[at]?.cause ?? "text");
  }
  return causes;
};

/**
 * The source words, read independently: `readStyleTable` decides which runs
 * `w:vanish` hides (direct value, else docDefaults XOR paragraph style XOR
 * character style), then a tree walk collects `w:t`/`m:t` text in document
 * order — `w:del`/`w:moveFrom`/`w:instrText`/`mc:Fallback` and hidden runs
 * excluded, table-of-contents caches and controls skipped, text boxes
 * deferred to the end, called footnotes/endnotes appended. See
 * `pipeline/no-word-lost.test.ts` for the full rule-by-rule rationale (moved
 * here unchanged, this file's header).
 */
export const readSource = async (bytes: Uint8Array, onWithheld?: (text: string) => void, limits?: ReaderLimits): Promise<SourceReading> => (await readWalk(bytes, false, onWithheld, limits)).reading;

/** Paragraphs that carry a numbering, with their own text: a heading's
 *  computed number is expected only in front of one of these. Read by
 *  `no-word-lost.test.ts`'s extras check only — the production conservation
 *  source never asks for it, so `readSource` does not collect it. */
export const readNumberedParagraphs = async (bytes: Uint8Array): Promise<string[]> => (await readWalk(bytes, true)).numberedParagraphs;

/** The number Word computes in front of a numbered paragraph (its `lvlText`, literal words included: « Section 1 », « 1.1 - »),
 *  when `text` is that number followed by the text of one of `numberedParagraphs`: at most 40 characters, ENDING with a label
 *  (digits, roman numerals or one letter, with their punctuation: « 1.1. », « IV. », « A) », « SECTION 1: »), or a spaced dash after it (« Partie 1 - », « 1.1 - »). Undefined otherwise.
 *  The whole prefix is kept only when the head before the label is empty or one or two words of letters only (« Partie » of « Partie 1 - »);
 *  any other head is a sentence the block glued before the label, so only the label is returned (26/10/2026, bench issue 57, docx-reel 08 p5).
 *  Limit, written: a label word that carries punctuation (« Art. 1. », « N° 1. », « § 1. ») is not kept and its word stays counted invented
 *  (visible). Tried and dropped (26/10/2026): accepting up to two tokens of 12 characters without « : ; , » took « page. », the end of a sentence
 *  Poppler joined to « 3. » (docx-reel 01), for a label word: the shape cannot tell « Art. » from « page. ». The right source is the literal
 *  words of the level's `lvlText` in numbering.xml, not read here.
 *  The page publishes this number, the source reading holds none; the extras check of `no-word-lost.test.ts` and the bench
 *  (`tools/bench/words.ts`) share this rule. */
export const computedNumberOf = (text: string, numberedParagraphs: readonly string[]): string | undefined => {
  // eslint-disable-next-line sonarjs/regex-complexity -- list-label shape (number, roman, letter, separators), anchored at the end of a short label
  const LABEL_END = /(?:^|\s)(?:\p{N}+|[ivxlcdm]+|[IVXLCDM]+|\p{L})(?:[.):-]\p{N}+)*(?:[.):]|\s[-\u2013\u2014])?\s?$/u;
  // LE PLUS LONG DES PARAGRAPHES QUI COLLENT décide, pas le premier rencontré (28/10/2026, corpus 202 p1, le +1 mot
  // inventé du banc Office). Deux paragraphes numérotés finissent le même bloc : « Sample Policy » et « Annex B –
  // Sample Policy ». Le premier coupe à « 7. Annex B – », dont la tête « 7. Annex » n'est pas deux mots simples, donc
  // seule l'étiquette « B – » était gardée et le « 7 » du titre sortait du sac des numéros : la page le comptait
  // inventé. Le second coupe à « 7. », qui EST le numéro. La coupe la plus précoce est donc la bonne : ce qui reste
  // devant est exactement ce que Word a dessiné.
  let best: number | undefined;
  for (const p of numberedParagraphs) {
    const cut = cutBeforeTail(text, p);
    if (cut === undefined || cut === 0 || cut > 40) continue;
    if (LABEL_END.exec(text.slice(0, cut)) === null) continue;
    if (best === undefined || cut < best) best = cut;
  }
  if (best === undefined) return undefined;
  const prefix = text.slice(0, best);
  const label = LABEL_END.exec(prefix)!;
  const head = prefix.slice(0, label.index).trim();
  return head === "" || /^(?:\p{L}+\s+)?\p{L}+$/u.test(head) ? prefix : prefix.slice(label.index).trimStart();
};

/** Where in `text` the tail equal to `tail` begins, blanks ignored on both sides (the reading puts blanks around a formula:
 *  « The  r -Stabilized Result » against the page's « The r-Stabilized Result »); `undefined` when `text` does not end with it. */
const cutBeforeTail = (text: string, tail: string): number | undefined => {
  let t = text.length;
  for (let i = tail.length - 1; i >= 0; i--) {
    if (/\s/.test(tail[i]!)) continue;
    while (t > 0 && /\s/.test(text[t - 1]!)) t--;
    if (t === 0 || text[t - 1] !== tail[i]) return undefined;
    t--;
  }
  return tail.trim() === "" ? undefined : t;
};

/** A field the walk is inside: its code (`instr`), whether the code or the cached result is being read, and whether it is a table of contents. */
interface OpenField {
  instr: string;
  phase: "instr" | "result";
  toc: boolean;
}

type StyleTable = ReturnType<typeof readStyleTable>;

/** What the walk keeps from one node to the next, for the whole read of a document. */
interface WalkState {
  styles: StyleTable;
  page: Page | undefined;
  /** Whether to collect the text of the numbered paragraphs (`readNumberedParagraphs`, tests and bench only). */
  collectNumbered: boolean;
  fields: OpenField[];
  calls: Set<string>;
  callOrder: string[]; // the keys of `calls`, in call order
  numberedParagraphs: string[];
  foldedCells: Set<N>; // vMerge continuation cells that fold into the cell above (filled by `visitTable` from `readTable`)
  /** The words and the table of each chart part the body relates to, by relationship id (`chartReadsOf`). */
  charts: ReadonlyMap<string, ChartRead>;
  /** The structure counters (`source-structure-docx.ts`) and the rule that tells a list paragraph by the numbering the document defines. */
  tally: DocxStructureTally;
  listed: (pPr: N | undefined) => boolean; // mutable: set once the parts the words need are read
  /** The words of each SmartArt the stories name, by story part then by the frame's `r:dm` relationship id (`smartArtTextsOf`). */
  smartArts: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;
  /** The part being walked (`word/document.xml`, then each called note's), whose relationships its frames' ids belong to. */
  story: string;
  /** Where the words of the tables the page withholds are collected, when the caller asked for them (`onWithheld`). */
  withheld: Chunk[] | undefined;
  /** The caps the page was read under: the same as the extraction's, or a table withheld by one is expected by the other. */
  limits: ReaderLimits | undefined;
}

/** What a node hands down to its children: where their chunks go, where the text boxes wait, the paragraph style they sit in and the cause of their words. */
interface WalkCtx {
  sink: Chunk[];
  deferred: Chunk[];
  pStyle: string | undefined;
  cause: MissingWordCause;
}

type Visit = (st: WalkState, c: N, ctx: WalkCtx) => void;

const TOC_CODE = /^\s*TOC\b/i;

const hiddenByField = (st: WalkState): boolean => st.fields.some((f) => f.phase === "instr" || f.toc);

// Lot C addendum (MIKSUDOC « Spécification technique » T11, 29/09/2026):
// every pushed chunk carries the CAUSE a missing word would report — the
// nesting cause threaded through the walk (content control, text box, a
// note's own call site), UNLESS a complex field's cached result is
// currently open (`fields` non-empty here is only ever reachable at
// `phase === "result"`, non-toc — `hiddenByField` already filtered the
// rest out before a push is attempted): a field's own cause wins, whatever
// container it sits inside.
const pushText = (st: WalkState, ctx: WalkCtx, s: string): void => {
  ctx.sink.push({ text: s, cause: st.fields.length > 0 ? "field-result" : ctx.cause });
};

/** The same sink, the same text boxes, the same style, another cause. */
const withCause = (ctx: WalkCtx, cause: MissingWordCause): WalkCtx => ({ sink: ctx.sink, deferred: ctx.deferred, pStyle: ctx.pStyle, cause });

/** Children read for their fields and note calls only: their words go to sinks that are thrown away. */
const discarded = (ctx: WalkCtx): WalkCtx => ({ sink: [], deferred: [], pStyle: ctx.pStyle, cause: ctx.cause });

/** The children of `n`, each read by the visit of its kind (`VISITS`); a kind with no visit is read through, its children in place. */
const walkChildren = (st: WalkState, n: N, ctx: WalkCtx): void => {
  for (const c of kidsOf(n)) (VISITS.get(tagOf(c)) ?? walkChildren)(st, c, ctx);
};

/** The node and its children between two line breaks (a table, a row, a cell). */
const walkFramed: Visit = (st, c, ctx) => {
  ctx.sink.push({ text: "\n", cause: ctx.cause });
  walkChildren(st, c, ctx);
  ctx.sink.push({ text: "\n", cause: ctx.cause });
};

/** Deleted text, moved-from text and fallbacks: nothing is read. */
const ignored: Visit = () => undefined;

const visitFieldCode: Visit = (st, c) => {
  const top = st.fields[st.fields.length - 1];
  if (top?.phase === "instr") top.instr += textOf(c);
};

const visitFieldChar: Visit = (st, c) => {
  const type = attrOf(c, "w:fldCharType");
  const top = st.fields[st.fields.length - 1];
  if (type === "begin") st.fields.push({ instr: "", phase: "instr", toc: false });
  else if (type === "separate" && top) {
    top.phase = "result";
    top.toc = TOC_CODE.test(top.instr);
  } else if (type === "end") st.fields.pop();
};

const visitSimpleField: Visit = (st, c, ctx) => {
  st.fields.push({ instr: "", phase: "result", toc: TOC_CODE.test(attrOf(c, "w:instr") ?? "") });
  walkChildren(st, c, ctx);
  st.fields.pop();
};

const visitContentControl: Visit = (st, c, ctx) => {
  const gallery = attrOf(first(first(first(c, "w:sdtPr"), "w:docPartObj"), "w:docPartGallery") ?? {}, "w:val");
  if (gallery === "Table of Contents" && !hasTocField(c)) return;
  walkChildren(st, c, withCause(ctx, "content-control"));
};

const visitRun: Visit = (st, c, ctx) => {
  if (st.styles.hidden(first(c, "w:rPr"), ctx.pStyle)) {
    // Hidden text: only its field characters count (they open and close fields).
    walkChildren(st, { "w:r": kidsOf(c).filter((k) => ["w:fldChar", "w:instrText"].includes(tagOf(k))) }, discarded(ctx));
    return;
  }
  walkChildren(st, c, ctx);
};

const visitText: Visit = (st, c, ctx) => {
  if (!hiddenByField(st)) pushText(st, ctx, textOf(c));
};

const visitMathRun: Visit = (st, c, ctx) => {
  pushText(st, ctx, " ");
  walkChildren(st, c, ctx);
  pushText(st, ctx, " ");
};

const visitSpace: Visit = (st, _c, ctx) => pushText(st, ctx, " ");

const visitNoBreakHyphen: Visit = (st, _c, ctx) => pushText(st, ctx, "-");

const visitSymbol: Visit = (st, c, ctx) => {
  const code = Number.parseInt(attrOf(c, "w:char") ?? "", 16);
  if (Number.isFinite(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) && !hiddenByField(st)) {
    const point = String.fromCodePoint(code);
    pushText(st, ctx, isSymbolFont(attrOf(c, "w:font")) ? symbolFontText(point) : point);
  }
};

/** A call to a footnote or an endnote, registered once, in call order, unless it sits in the code of a field. */
const noteCallOf =
  (kind: "footnote" | "endnote"): Visit =>
  (st, c) => {
    const id = attrOf(c, "w:id");
    const key = `${kind}:${id}`;
    if (id !== undefined && !hiddenByField(st) && !st.calls.has(key)) {
      st.calls.add(key);
      st.callOrder.push(key);
    }
  };

// w:ruby (CT_Ruby, ECMA-376 Part 1 §17.3.3.25): a phonetic guide, its
// own cause — the extractor now publishes it (`docx-reader/body.ts`),
// so a future loss of it is named, not folded into plain "text"
// (Mikolaj, « on fix », 29/09/2026). In place, like plain text: only
// the cause changes, not the reading order or the text collected.
const visitRuby: Visit = (st, c, ctx) => walkChildren(st, c, withCause(ctx, "ruby"));

// A drawing whose wp:docPr is hidden ("1" or "true", any case) is not published (Mikolaj, 08/10/2026), nor one wholly
// off the page (09/10/2026): none of their words are expected (`drawingHidden`, `drawingOffPage`).
const visitDrawing: Visit = (st, c, ctx) => {
  if (drawingHidden(c) || drawingOffPage(c, st.page)) return;
  // A DRAWING BETWEEN TWO TEXTS IS A WORD BOUNDARY (29/10/2026, `200-2022-23-sshrcs`, the bench's last lost word). Word
  // puts in ONE `w:p`: « …2023-24 Competition », a coloured bar as `wp:inline`, then « There are no anticipated… », with
  // no space between them. The page cuts around the picture, rightly; the reading here joined the runs and produced
  // « competitionthere », a word that exists nowhere, counted lost. Same rule as the equation of the same morning: what
  // is not text, between two texts, separates words. A drawing the page does not show takes the early return above, so
  // the two readings still agree there.
  pushText(st, ctx, " ");
  walkChildren(st, c, ctx);
  // A SmartArt's words are published in the document's diagram text: expected where its drawing stands (a text box inside is a node of
  // its own and is not searched, nor is a fallback).
  for (const id of smartArtRelIds(c, DRAWING_SUBSTORIES)) {
    for (const w of st.smartArts.get(st.story)?.get(id) ?? []) pushText(st, ctx, ` ${w} `);
  }
  // A native chart is published as a data table: its words are expected where the drawing stands.
  for (const id of chartIdsOf(c)) {
    const chart = st.charts.get(id);
    if (chart) for (const w of chart.words) pushText(st, ctx, ` ${w} `);
    st.tally.chart(chart?.shape);
  }
  pushText(st, ctx, " ");
};

/** Where a drawing's own frames stop: a text box is walked as a story, a fallback is never read. */
const DRAWING_SUBSTORIES: ReadonlySet<string> = new Set(["w:txbxContent", "mc:Fallback"]);

/** The relationship ids of the `c:chart` frames inside a drawing (a text box inside it is a node of its own and is not searched). */
const chartIdsOf = (n: N, out: string[] = []): string[] => {
  for (const c of kidsOf(n)) {
    if (tagOf(c) === "c:chart") {
      const id = attrOf(c, "r:id");
      if (id !== undefined) out.push(id);
    } else chartIdsOf(c, out);
  }
  return out;
};

/** The words and the table of every chart part the document body relates to (`chart` relationships of `word/document.xml`), by relationship
 *  id. A missing or damaged chart part expects nothing (its absence is the extractor's notice, not a refusal of the document). */
const chartReadsOf = async (xmlOf: (path: string) => Promise<N | undefined>, limits: ReaderLimits | undefined): Promise<Map<string, ChartRead>> => {
  const out = new Map<string, ChartRead>();
  const rels = await stylesOrAbsent(() => xmlOf("word/_rels/document.xml.rels"));
  for (const rel of rels ? kidsOf(rels) : []) {
    const id = attrOf(rel, "Id");
    const target = attrOf(rel, "Target");
    if (id === undefined || target === undefined || attrOf(rel, "TargetMode") === "External" || !(attrOf(rel, "Type") ?? "").endsWith("/chart")) continue;
    const chart = await stylesOrAbsent(() => xmlOf(resolveTarget("word/document.xml", target)));
    if (chart) out.set(id, chartReadOf(chart, limits));
  }
  return out;
};

/** The words of every SmartArt a story (`word/document.xml` or a notes part, parsed as `root`) names, by `r:dm` relationship id: the
 *  model part each id resolves to inside the package (`source-reading-smartart.ts`). Only the ids the story names are read. */
const smartArtTextsOf = async (xmlOf: (path: string) => Promise<N | undefined>, story: string, root: N | undefined): Promise<Map<string, readonly string[]>> => {
  const out = new Map<string, readonly string[]>();
  if (!root) return out;
  const wanted = new Set(smartArtRelIds(root));
  if (wanted.size === 0) return out;
  const cut = story.lastIndexOf("/");
  const rels = await stylesOrAbsent(() => xmlOf(`${story.slice(0, cut)}/_rels/${story.slice(cut + 1)}.rels`));
  const parts = new Map<string, string>();
  for (const rel of rels ? kidsOf(rels) : []) {
    const id = attrOf(rel, "Id");
    const target = attrOf(rel, "Target");
    if (id !== undefined && target !== undefined && attrOf(rel, "TargetMode") !== "External") parts.set(id, resolveTarget(story, target));
  }
  const partOf = (id: string | undefined): string | undefined => (id === undefined ? undefined : parts.get(id));
  for (const id of wanted) out.set(id, await smartArtPieces(xmlOf, partOf(id), partOf));
  return out;
};

/** A text box is read where it stands but published after the body: its chunks wait in `deferred`, between two line breaks. */
const visitTextBox: Visit = (st, c, ctx) => {
  const box: Chunk[] = [];
  walkChildren(st, c, { sink: box, deferred: ctx.deferred, pStyle: undefined, cause: "text-box" });
  ctx.deferred.push({ text: "\n", cause: ctx.cause });
  pushAll(ctx.deferred, box);
  ctx.deferred.push({ text: "\n", cause: ctx.cause });
};

const visitParagraph: Visit = (st, c, ctx) => {
  const pPr = first(c, "w:pPr");
  const style = attrOf(first(pPr, "w:pStyle") ?? {}, "w:val");
  const directNum = attrOf(first(first(pPr, "w:numPr"), "w:numId") ?? {}, "w:val");
  const numbered = directNum !== undefined ? directNum !== "0" : st.styles.numberedByStyle(style);
  const own: Chunk[] = [];
  walkChildren(st, c, { sink: own, deferred: ctx.deferred, pStyle: style, cause: ctx.cause });
  if (numbered && st.collectNumbered) st.numberedParagraphs.push(own.map((k) => k.text).join(""));
  st.tally.paragraph(st.styles.headingLevelOf(style), st.listed(pPr), own.some((k) => k.text.trim() !== ""));
  ctx.sink.push({ text: "\n", cause: ctx.cause });
  pushAll(ctx.sink, own);
  ctx.sink.push({ text: "\n", cause: ctx.cause });
};

const visitTable: Visit = (st, c, ctx) => {
  // A table the page does not publish expects none of its words (the same rule as the page: `source-reading-table.ts`).
  // The page still publishes the footnotes and endnotes it calls, so its note calls are registered (and its field state
  // kept) while the words go to a sink that is thrown away.
  const table = readTable(c, st.styles.hidden, st.page, st.limits);
  for (const cell of table.folded) st.foldedCells.add(cell);
  st.tally.enterTable(table.withheld);
  if (table.withheld) {
    // With a collector the words (and the text boxes) of the withheld table are kept for the caller, never for the expected words.
    const kept = st.withheld;
    walkChildren(st, c, kept ? { sink: kept, deferred: kept, pStyle: ctx.pStyle, cause: ctx.cause } : discarded(ctx));
  } else walkFramed(st, c, ctx);
  st.tally.leaveTable(table.withheld);
};

// A vMerge continuation folded into the cell above: its words are not shown (PLATFORM-STATUS §67), so none is expected, and the page does
// not even read it: its note calls register nothing.
const visitCell: Visit = (st, c, ctx) => {
  if (!st.foldedCells.has(c)) walkFramed(st, c, ctx);
};

const VISITS = new Map<string, Visit>([
  ["mc:Fallback", ignored],
  ["w:del", ignored],
  ["w:moveFrom", ignored],
  ["w:delText", ignored],
  ["w:delInstrText", ignored],
  ["w:instrText", visitFieldCode],
  ["w:fldChar", visitFieldChar],
  ["w:fldSimple", visitSimpleField],
  ["w:sdt", visitContentControl],
  ["w:r", visitRun],
  ["w:t", visitText],
  ["m:t", visitText],
  ["m:r", visitMathRun],
  ["w:tab", visitSpace],
  ["w:br", visitSpace],
  ["w:cr", visitSpace],
  ["w:noBreakHyphen", visitNoBreakHyphen],
  ["w:sym", visitSymbol],
  ["w:footnoteReference", noteCallOf("footnote")],
  ["w:endnoteReference", noteCallOf("endnote")],
  ["w:ruby", visitRuby],
  ["w:drawing", visitDrawing],
  ["w:txbxContent", visitTextBox],
  ["w:p", visitParagraph],
  ["w:tbl", visitTable],
  ["w:tc", visitCell],
  ["w:tr", walkFramed],
]);

/** The footnotes and endnotes of the document by key (`footnote:3`); of several notes with one id the LAST is the one, as on the page
 *  (`docx-reader/index.ts#noteBlocks`). */
const indexNotes = (parts: readonly (readonly ["footnote" | "endnote", N | undefined])[]): Map<string, { kind: "footnote" | "endnote"; note: N }> => {
  const noteIndex = new Map<string, { kind: "footnote" | "endnote"; note: N }>();
  for (const [kind, part] of parts) {
    for (const note of part ? kidsOf(part) : []) {
      if (tagOf(note) === `w:${kind}`) noteIndex.set(`${kind}:${attrOf(note, "w:id")}`, { kind, note });
    }
  }
  return noteIndex;
};

/** Notes: only those called from the published text, and those called from a called note, whatever their order in the part.
 *  Worklist: the notes are indexed once by key; the notes the body calls are read first, in part order, then a first-in
 *  first-out queue reads those called from a note read, each key once. Cost O(notes), whatever the nesting order. */
const appendCalledNotes = (st: WalkState, noteIndex: ReadonlyMap<string, { kind: "footnote" | "endnote"; note: N }>, out: Chunk[]): void => {
  const queue: string[] = [];
  const queued = new Set<string>();
  const enqueue = (key: string): void => {
    if (queued.has(key) || !noteIndex.has(key)) return;
    queued.add(key);
    queue.push(key);
  };
  for (const key of noteIndex.keys()) if (st.calls.has(key)) enqueue(key);
  let seenCalls = st.callOrder.length;
  for (let q = 0; q < queue.length; q++) {
    const { kind, note } = noteIndex.get(queue[q]!)!;
    const noteDeferred: Chunk[] = [];
    st.fields.length = 0;
    st.story = `word/${kind}s.xml`;
    st.tally.note();
    st.tally.enterNote();
    walkChildren(st, note, { sink: out, deferred: noteDeferred, pStyle: undefined, cause: kind });
    st.tally.leaveNote();
    pushAll(out, noteDeferred);
    // The calls this note added, in call order.
    for (; seenCalls < st.callOrder.length; seenCalls++) enqueue(st.callOrder[seenCalls]!);
  }
};

/** The numbering part the document body relates to (`numbering` relationship of `word/document.xml`). Only the STRUCTURE reads it: a refusal here
 *  (a damaged or too large part) is not tolerated as an absent part, which would count every list paragraph wrongly. */
const numberingPartOf = async (xmlOf: (path: string) => Promise<N | undefined>): Promise<N | undefined> => {
  const rels = await xmlOf("word/_rels/document.xml.rels");
  for (const rel of rels ? kidsOf(rels) : []) {
    const target = attrOf(rel, "Target");
    if (target !== undefined && attrOf(rel, "TargetMode") !== "External" && (attrOf(rel, "Type") ?? "").endsWith("/numbering")) {
      return xmlOf(resolveTarget("word/document.xml", target));
    }
  }
  return undefined;
};

/** The list rule of the structure control and whether it could be built: any refusal of the parts only the structure reads leaves the structure
 *  unreadable (its control abstains, `check-failed`) and the words as they were. */
const listRuleOf = async (
  xmlOf: (path: string) => Promise<N | undefined>,
  stylesRoot: N | undefined,
): Promise<{ listed: (pPr: N | undefined) => boolean; unreadable: boolean }> => {
  const read = await structureOnly(async () => createListRule(stylesRoot, await numberingPartOf(xmlOf)));
  return "unreadable" in read ? { listed: () => false, unreadable: true } : { listed: read.value, unreadable: false };
};

const readWalk = async (bytes: Uint8Array, collectNumbered: boolean, onWithheld?: (text: string) => void, limits?: ReaderLimits): Promise<{ reading: SourceReading; numberedParagraphs: string[] }> => {
  const { xmlOf } = await openSourceParts(bytes);
  const stylesRoot = await stylesOrAbsent(() => xmlOf("word/styles.xml"));
  const styles = readStyleTable(stylesRoot);
  const body = first(await xmlOf("word/document.xml"), "w:body");
  if (!body) throw new Error("no body");
  const noteParts = [
    ["footnote", await xmlOf("word/footnotes.xml")],
    ["endnote", await xmlOf("word/endnotes.xml")],
  ] as const;
  const st: WalkState = {
    styles,
    page: largestPageOf(body),
    collectNumbered,
    fields: [],
    calls: new Set(),
    callOrder: [],
    numberedParagraphs: [],
    foldedCells: new Set(),
    charts: await chartReadsOf(xmlOf, limits),
    tally: new DocxStructureTally(),
    listed: () => false, // set below, once every part the words need is read
    smartArts: new Map([
      ["word/document.xml", await smartArtTextsOf(xmlOf, "word/document.xml", body)],
      ["word/footnotes.xml", await smartArtTextsOf(xmlOf, "word/footnotes.xml", noteParts[0][1])],
      ["word/endnotes.xml", await smartArtTextsOf(xmlOf, "word/endnotes.xml", noteParts[1][1])],
    ]),
    story: "word/document.xml",
    withheld: onWithheld ? [] : undefined,
    limits,
  };
  // The numbering part is read for the structure alone, after every part the words need (the package's inflation budget is shared).
  const lists = await listRuleOf(xmlOf, stylesRoot);
  st.listed = lists.listed;
  const out: Chunk[] = [];
  const deferred: Chunk[] = [];
  walkChildren(st, body, { sink: out, deferred, pStyle: undefined, cause: "text" });
  pushAll(out, deferred);
  appendCalledNotes(st, indexNotes(noteParts), out);
  const text = out.map((k) => k.text).join("");
  if (onWithheld && st.withheld && st.withheld.length > 0) onWithheld(st.withheld.map((k) => k.text).join(""));
  return {
    reading: { text, structure: st.tally.unit, wordCauses: causesOf(out), ...(lists.unreadable ? { structureUnreadable: true as const } : {}) },
    numberedParagraphs: st.numberedParagraphs };
};

/** A word: a maximal run of letters/digits, NFKC lower case — the rule the
 *  design settled on (MIKSUDOC « Spécification technique » T11),
 *  the same one the published page is read by
 *  (`declared-format-conservation.ts#pageWords`), validated over 20+ real
 *  docx fixtures in `pipeline/no-word-lost.test.ts`. */
export { wordsOf };

/**
 * The docx/Google-Doc conservation source (MIKSUDOC « Spécification technique » T11, lot A): one unit (a Word or Google Doc never has more), its words
 * tokenised in reading order. Nothing is ever capped or withheld for a
 * single unit, so `deliberateRemovals` and `excludedUnits` are always empty.
 * A read that cannot be trusted — a corrupt part, a size limit crossed —
 * becomes a named failure instead of throwing through to the caller: never a
 * reason not to publish (Mikolaj, 21/09/2026).
 * `opts.limits`: the caps the page was read under, the SAME object the extraction got. Absent: NONE — `NO_CAP`,
 * nothing withheld, so `onWithheld` never fires (corrected 10/11/2026; the bench's pair reading was caught by this).
 * `opts.onWithheld` (bench only): called once, after a successful walk, with the text of the tables the page withholds
 * (including their text boxes and nested tables), joined; not called when there is none. The returned reading is the same with or without it.
 */
export async function readDocxConservationSource(
  bytes: Uint8Array,
  opts?: { onWithheld?: (text: string) => void; limits?: ReaderLimits },
): Promise<DeclaredFormatConservationSource | ConservationSourceReadFailure> {
  return guardedSourceAsync(async () => {
    const { text, wordCauses, structure, structureUnreadable } = await readSource(bytes, opts?.onWithheld, opts?.limits);
    const words = wordsOf(text);
    return {
      units: [{ label: "", tokens: words.map((word, i): { text: string; cause: MissingWordCause } => ({ text: word, cause: wordCauses[i] ?? "text" })) }],
      deliberateRemovals: [],
      excludedUnits: new Set(),
      structure: { units: [structure], format: "docx", ...(structureUnreadable === true ? { unreadable: true as const } : {}) },
    };
  });
}
