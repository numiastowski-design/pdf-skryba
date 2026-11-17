/** The second, independent reading of a PowerPoint file — or a Google Slides
 *  export, which arrives as the same bytes (`extractor/dispatch.ts`) — that
 *  becomes its conservation source (MIKSUDOC « Spécification technique » T11, lot D): one unit per VISIBLE slide (`p:sld@show` never "0"), its
 *  words read straight off the zip — never through `extractor/pptx` nor
 *  `extractor/pptx-reader/**`, so an extractor bug cannot pass its own check.
 *  Moved here, unchanged in its reading rules, from `pipeline/no-word-lost.test.ts`
 *  (§4 of the conception): that test now imports `readPptxSource` from here
 *  instead of keeping its own copy — one reader, not two.
 *
 *  DECLARED removals (never read as tokens, so never reported missing) are
 *  decided from THIS READING'S OWN facts — never from page wording (since
 *  docs/CONCEPTION-CARTE-ET-REMARQUES.md lot A, 29/09/2026, the page carries
 *  no remark at all; notices live on the dashboard):
 *   - a slide past `MAX_PRESENTATION_TABS`, by this reading's own count of
 *     VISIBLE slides (mirrors `extractPptx`'s cap on shown slides);
 *   - a slide whose STRUCTURAL element count (a fresh count, independent of
 *     `pptx-reader/shapes.ts#countElements`) passes `MAX_SLIDE_ELEMENTS`
 *     (such a slide gets no tab at all on the page);
 *   - a slide's title identical to the previous KEPT slide's (trimmed): not
 *     republished, so never collected as this slide's own text (mirrors
 *     `extractPptx`'s `!slide.titleRepeated`).
 *  The first two kinds still get a `ConservationUnit` (empty tokens, the
 *  index in `excludedUnits`) — one unit per visible slide the deck has,
 *  whether or not the page shows its content.
 *
 *  The diagram slides' text (`extractPptx`'s single `diagramText` block, one section per slide) is NOT on the page since 19/10/2026
 *  (no collapsed block): the control EXCUSES them (a diagram is published as a drawing only, 22/10/2026)
 *  (`declared-format-conservation.ts#diagramTextWords`). Our
 *  own composed text (`Slide N` tab titles and diagram section labels) needs
 *  no exclusion: production only checks for MISSING source words, never for
 *  extra page words (MIKSUDOC « Spécification technique » T11).
 *  A table the page does not publish (over the column or row cap, `lib/table-width-cap.ts#tableExceedsCaps` via
 *  `source-reading-table.ts`, counted from this reading's own XML) expects none of its words.
 *
 *  The same walk counts each slide's STRUCTURE for the structure control: its title (an h2), its tables, its list items (written or inherited bullets,
 *  `source-structure-pptx.ts`) and the tables the page adds for its charts.
 *  NOT here: comparing the source against the published page
 *  (`pipeline/declared-format-conservation.ts`, `pipeline/structure-conservation.ts`), the pptx EXTRACTOR itself
 *  (`extractor/pptx.ts`, `extractor/pptx-reader/**`).
 *  Called by: `extractor/dispatch.ts`, for `pptx` (native decks and Google
 *  Slides exports alike — same bytes, same reader).
 *  `pipeline/no-word-lost.test.ts` imports `readPptxSource`. */

import { NO_CAP, type ReaderLimits } from "doc-ir/lib/reader-limits";
import type { PageLanguage } from "doc-ir/lib/reader-types";
import { type PageLabelOverride, resolveLabels } from "doc-ir/lib/page-labels";
import { isSymbolFont, symbolFontText } from "doc-ir/lib/symbol-font";
import {
  addChartTable,
  emptyUnitStructure,
  excludedUnitsOf,
  guardedSourceAsync,
  unitOf,
  type ConservationSourceReadFailure,
  type ConservationUnit,
  type DeclaredFormatConservationSource,
  type UnitStructure,
} from "./conservation-source";
import { createBulletReader } from "./source-structure-pptx";
import { addHeading } from "./structure-counts";
import { resolveTarget } from "../extractor/ooxml/package";
import { chartReadOf, type ChartRead } from "./source-reading-chart";
import { smartArtPieces, smartArtRelIds } from "./source-reading-smartart";
import { placeRowCells, tableWithheld, type CoveredRange, type GridRow, type LayoutCell } from "./source-reading-table";
import {
  attrOf,
  first,
  kidsOf,
  openSourceParts,
  pushAll,
  structureOnly,
  tagOf,
  textOf,
  type N,
} from "./source-reading-package";

/** A run's text, its Symbol-font private-use points translated when its `a:rPr` sets the Symbol font (`a:sym` or `a:latin`), like the
 *  page (`extractor/pptx-reader/text.ts#isSymbolRun`, 26/10/2026). */
const symbolRunText = (run: N, text: string): string => {
  const rPr = first(run, "a:rPr");
  // A written a:sym decides alone, like the page.
  return isSymbolFont(attrOf(first(rPr, "a:sym") ?? first(rPr, "a:latin") ?? {}, "typeface"))
    ? symbolFontText(text)
    : text;
};

/** Every descendant tagged `tag`, in document order; a match is not searched inside. */
const allOf = (n: N, tag: string, out: N[] = []): N[] => {
  for (const c of kidsOf(n)) {
    if (tagOf(c) === tag) out.push(c);
    else allOf(c, tag, out);
  }
  return out;
};

const relsPathOf = (part: string): string => {
  const i = part.lastIndexOf("/");
  return `${part.slice(0, i)}/_rels/${part.slice(i + 1)}.rels`;
};

const isOn = (v: string | undefined): boolean => v === "1" || v === "true";

/** The « hidden » flag of a shape, tolerant (blanks and case ignored); written here on its own, not shared with the extractor. */
const isHiddenAttr = (v: string | undefined): boolean => {
  const t = v?.trim().toLowerCase();
  return t === "1" || t === "true";
};

/** True when an `a:tbl` is not published (too wide or too long once its empty columns and its empty first row are left out), by
 *  this reading's own count: a cell is as wide as its `gridSpan` (clamped to the declared grid columns right of it), a cell absorbed by a merge (`hMerge`, `vMerge`) is no cell and the ones after it shift left, a cell starts right of the columns a `rowSpan` above still covers, and the first
 *  row is a header row only when `a:tblPr firstRow` is on. `cellTexts[row][cell]` holds the paragraphs of each `a:tc` (none when absorbed).
 *  Cost O(rows x live ranges + cells), whatever the spans (`source-reading-cost.test.ts`). */
const tableIsWithheld = (
  tbl: N,
  cellTexts: readonly (readonly (readonly string[])[])[],
  limits: ReaderLimits | undefined,
): boolean => {
  const headerRow = isOn(attrOf(first(tbl, "a:tblPr") ?? {}, "firstRow"));
  const rowSpanOf = (tc: N): number => {
    const n = Number.parseInt(attrOf(tc, "rowSpan") ?? "1", 10);
    return Number.isInteger(n) ? n : 1;
  };
  // The extractor's exact clamp (`pptx-reader/table.ts#spanOf`): a span runs over the declared columns right of the cell's
  // rank among ALL the row's `a:tc`, never past them; at most one column of room, or no span, gives 1.
  const declaredColumns = kidsOf(first(tbl, "a:tblGrid") ?? {}).filter((k) => tagOf(k) === "a:gridCol").length;
  const trs = kidsOf(tbl).filter((k) => tagOf(k) === "a:tr");
  // Grid columns a `rowSpan` cell above still covers, kept as RANGES sorted by start (never one entry per column: a wide span
  // that also runs down would cost their product), as `lib/table-empty-parts.ts#anchorsOf` does for the page.
  let covered: CoveredRange[] = [];
  const rows: GridRow[] = trs.map((tr, r) => {
    const tcs = kidsOf(tr).filter((k) => tagOf(k) === "a:tc");
    // As the page lays the row out: a cell absorbed by a merge (`hMerge` or `vMerge`) is no cell, the cells after it shift left,
    // and a cell starts at the next grid column no `rowSpan` cell above still covers (a gap stands for the covered columns).
    const laidOut: LayoutCell[] = [];
    tcs.forEach((tc, c) => {
      if (isOn(attrOf(tc, "hMerge")) || isOn(attrOf(tc, "vMerge"))) return;
      const span = Number.parseInt(attrOf(tc, "gridSpan") ?? "1", 10);
      const room = declaredColumns - c;
      const width = Number.isInteger(span) && span > 1 && room > 1 ? Math.min(span, room) : 1;
      laidOut.push({
        span: width,
        filled: (cellTexts[r]?.[c] ?? []).some((p) => p.trim() !== ""),
        rowspan: rowSpanOf(tc),
      });
    });
    const row = placeRowCells(covered, laidOut, r, trs.length);
    covered = row.covered;
    const cells = row.placed;
    const live = tcs.filter((tc) => !isOn(attrOf(tc, "hMerge")) && !isOn(attrOf(tc, "vMerge")));
    const emptyHeader =
      headerRow &&
      r === 0 &&
      live.length > 0 &&
      cells.every((cell) => !cell.filled) &&
      live.every((tc) => rowSpanOf(tc) <= 1);
    return { cells, emptyHeader };
  });
  return tableWithheld(rows, limits);
};

/** Only the group-wrapper elements a group shape carries besides its
 *  members — mirrors `pptx-reader/shapes.ts#GROUP_PROPERTIES`, a fresh copy:
 *  this count is its OWN, independent of that module (the import-boundary
 *  guard forbids importing it). */
const GROUP_PROPERTIES = new Set(["p:nvGrpSpPr", "p:grpSpPr", "p:extLst"]);

/** A slide's STRUCTURAL element count: every element counts, a group counts
 *  itself then its members, an `mc:AlternateContent` counts once, as the
 *  larger of its two variants — the same ranking as `countElements` in
 *  `pptx-reader/shapes.ts`, reimplemented here rather than imported (this
 *  reading's independence from the extractor, `core/import-boundaries.test.ts`). */
const countElements = (tree: N): number => {
  let count = 0;
  for (const element of kidsOf(tree)) {
    const tag = tagOf(element);
    if (tag === "" || tag === "#text" || GROUP_PROPERTIES.has(tag)) continue;
    if (tag === "mc:AlternateContent") {
      const choice = first(element, "mc:Choice");
      const fallback = first(element, "mc:Fallback");
      count += Math.max(choice ? countElements(choice) : 0, fallback ? countElements(fallback) : 0);
      continue;
    }
    count++;
    if (tag === "p:grpSp") count += countElements(element);
  }
  return count;
};

interface PptxSlideReading {
  /** 1-based, among VISIBLE slides only — matches `page-labels.ts#slideTabTitle`'s "Slide N". */
  number: number;
  /** This slide's words, in reading order; empty for a slide excluded below
   *  (its real content is never read: the page withholds or drops it whole). */
  text: string;
  /** Past `MAX_PRESENTATION_TABS`, by this reading's own visible-slide count. */
  overCap: boolean;
  /** This reading's own structural element count passes `MAX_SLIDE_ELEMENTS`. */
  withheld: boolean;
  /** What the slide declares of its structure (a title, tables, list items), what the page withholds and adds: all zeros for a slide without a tab. */
  structure: UnitStructure;
}

export interface PptxSourceReading {
  /** One entry per VISIBLE slide, in deck order — hidden slides (`show="0"`)
   *  are not even counted, like the page itself. */
  slides: readonly PptxSlideReading[];
  /** A part only the structure reads (a layout, a master) was refused: the structure control abstains (`SourceStructure.unreadable`). */
  structureUnreadable?: true;
}

/**
 * The source words, read independently: each VISIBLE slide's `p:sp` text
 * bodies, `p:graphicFrame` tables (every cell not absorbed by a merge) and
 * charts (their part: titles, series names, categories, values), groups
 * walked into, the first `mc:Choice` of an `mc:AlternateContent`. Left out,
 * each a decision of the lot (MIKSUDOC « Spécification fonctionnelle » §9.3, STATUS decisions
 * (2), (9), (10), (11)), not a tolerance: hidden slides and hidden shapes
 * (`hidden` on `p:cNvPr`), `mc:Fallback`, speaker notes, alt text, layouts
 * and masters, a merged-away cell, OLE/other
 * frames (never walked, matching `extractor/pptx.ts`'s markers standing for
 * them instead; a SmartArt frame's words ARE expected, source-reading-smartart.ts). See `pipeline/no-word-lost.test.ts` for the fixture-level
 * rationale (moved here unchanged, this file's header).
 */
export const readPptxSource = async (bytes: Uint8Array, limits?: ReaderLimits): Promise<PptxSourceReading> => {
  const { xmlOf } = await openSourceParts(bytes);
  const relsOf = async (partPath: string): Promise<Map<string, { target: string; external: boolean }>> => {
    const out = new Map<string, { target: string; external: boolean }>();
    const r = await xmlOf(relsPathOf(partPath));
    for (const rel of r ? kidsOf(r) : []) {
      const id = attrOf(rel, "Id");
      const target = attrOf(rel, "Target");
      if (id === undefined || target === undefined) continue;
      const external = attrOf(rel, "TargetMode") === "External";
      out.set(id, { target: external ? target : resolveTarget(partPath, target), external });
    }
    return out;
  };

  /** A DrawingML paragraph: its runs' and fields' text (the slide
   *  number included), a line break as a space. */
  const paragraphText = (p: N, shownNumber: number): string =>
    kidsOf(p)
      .map((c) => {
        const tag = tagOf(c);
        if (tag === "a:br") return " ";
        if (tag === "a:fld" && attrOf(c, "type") === "slidenum") return String(shownNumber); // the field stores a placeholder; PowerPoint shows the number
        if (tag === "a:r" || tag === "a:fld") return symbolRunText(c, allOf(c, "a:t").map(textOf).join(""));
        return "";
      })
      .join("");
  const bodyText = (body: N | undefined, shownNumber: number): string[] =>
    body
      ? kidsOf(body)
          .filter((c) => tagOf(c) === "a:p")
          .map((p) => paragraphText(p, shownNumber))
      : [];

  const chartRead = async (partPath: string): Promise<ChartRead> => {
    const chart = await xmlOf(partPath);
    // Titles, series names, categories and the values AS DISPLAYED, and the table the page holds (`source-reading-chart.ts`).
    return chart ? chartReadOf(chart, limits) : { words: [], shape: undefined };
  };
  const bullets = createBulletReader(xmlOf);

  const presentation = await xmlOf("ppt/presentation.xml");
  if (!presentation) throw new Error("no presentation part");
  const presRels = await relsOf("ppt/presentation.xml");
  const sldSz = first(presentation, "p:sldSz");
  const slideW = Number(attrOf(sldSz ?? {}, "cx"));
  const slideH = Number(attrOf(sldSz ?? {}, "cy"));
  // Same numbers as the page, written here on their own: ECMA-376 bounds, a value past them counts as NOT written.
  const sizeWithin = (v: number): boolean => Number.isInteger(v) && v > 0 && v <= 27_273_042_316_900;
  const sizeKnown = sldSz !== undefined && sizeWithin(slideW) && sizeWithin(slideH);
  const intOf = (el: N | undefined, name: string): number | undefined => {
    const raw = el ? attrOf(el, name) : undefined;
    if (raw === undefined || raw.trim() === "") return undefined;
    const n = Number(raw);
    return Number.isInteger(n) && Math.abs(n) <= 27_273_042_329_600 ? n : undefined;
  };
  /** Rule « Rien d'invisible » (09/10/2026), written here on its own, not shared with the extractor: a TOP-LEVEL element
   *  (a group by its own frame, never its members) wholly outside the slide is not published, so none of its words is expected.
   *  PowerPoint shows the pasteboard only in normal view, never in slideshow, print or export (observed behaviour, not sourced).
   *  A rotated element, an unwritten box (a placeholder inheriting from its layout) or an unknown slide size is kept. */
  const offSlide = (el: N): boolean => {
    if (!sizeKnown) return false;
    const tag = tagOf(el);
    const xfrm =
      tag === "p:graphicFrame"
        ? first(el, "p:xfrm")
        : first(first(el, tag === "p:grpSp" ? "p:grpSpPr" : "p:spPr"), "a:xfrm");
    if (!xfrm) return false;
    if ((intOf(xfrm, "rot") ?? 0) !== 0) return false;
    const off = first(xfrm, "a:off");
    const ext = first(xfrm, "a:ext");
    const x = intOf(off, "x");
    const y = intOf(off, "y");
    const w = intOf(ext, "cx");
    const h = intOf(ext, "cy");
    if (x === undefined || y === undefined || w === undefined || h === undefined || w < 0 || h < 0) return false;
    // A zero-size shape lying ON the edge (a line at y = 0) is still on the slide: `<= 0` only counts for a real size.
    const outside = (start: number, size: number, limit: number): boolean =>
      start >= limit || start + size < 0 || (size > 0 && start + size <= 0);
    return outside(x, w, slideW) || outside(y, h, slideH);
  };

  const slides: PptxSlideReading[] = [];
  let structureUnreadable = false;
  let previousTitle: string | undefined;

  // The number PowerPoint shows: position in `p:sldIdLst` (hidden slides counted) + firstSlideNum - 1 (ECMA-376 Part 1 §19.3.1.26, default 1).
  const firstNumber = Number(attrOf(presentation, "firstSlideNum"));
  const numberBase = Number.isInteger(firstNumber) && firstNumber >= 0 && firstNumber < 10 ** 9 ? firstNumber : 1;
  for (const [position, sldId] of allOf(presentation, "p:sldId").entries()) {
    const shownNumber = numberBase + position;
    const rel = presRels.get(attrOf(sldId, "r:id") ?? "");
    if (!rel) throw new Error("slide relationship missing");
    const slide = await xmlOf(rel.target);
    if (!slide) throw new Error(`slide part missing: ${rel.target}`);
    if (["0", "false"].includes(attrOf(slide, "show") ?? "")) continue; // hidden: not a unit at all, like the page

    const number = slides.length + 1;
    // The display cap (27/09/2026): mirrors `extractPptx`'s own
    // slice of VISIBLE slides — this reading's own count, never the page's
    // notice text (see this file's header).
    if (number > (limits?.presentationTabs ?? NO_CAP)) {
      slides.push({ number, text: "", overCap: true, withheld: false, structure: emptyUnitStructure() });
      previousTitle = undefined;
      continue;
    }

    const tree = first(first(slide, "p:cSld"), "p:spTree");
    const elementCount = tree ? countElements(tree) : 0;
    // The element-cap withhold (28/09/2026): this reading's own
    // structural count, never the page's notice text (see this file's header).
    if (elementCount > (limits?.slideElements ?? NO_CAP)) {
      slides.push({ number, text: "", overCap: false, withheld: true, structure: emptyUnitStructure() });
      previousTitle = undefined;
      continue;
    }

    const slideRels = await relsOf(rel.target);
    // The layout and the master are read for the bullets alone: a refusal of the part (not a defect of ours) leaves the structure unreadable, the
    // words as they were. Limit: they are read slide by slide, memoised by path, so on a package near its shared inflation budget they can use up what
    // a later slide's words need; they are small parts, and reading them all after the slides would mean walking the slides twice.
    const bulletRule = await structureOnly(() => bullets.forSlide(rel.target));
    if ("unreadable" in bulletRule) structureUnreadable = true;
    const isList = "unreadable" in bulletRule ? () => false : bulletRule.value;
    const unit = emptyUnitStructure();
    /** The list items among the paragraphs of a text body (those that show text); `withheld`: the page does not publish them. */
    const countItems = (sp: N | undefined, body: N | undefined, withheld = false): void => {
      for (const p of body ? kidsOf(body).filter((c) => tagOf(c) === "a:p") : []) {
        if (paragraphText(p, shownNumber).trim() === "" || !isList(sp, p)) continue;
        unit.declared.items++;
        if (withheld) unit.withheld.items++;
      }
    };
    const own: string[] = [];
    /** A table frame: its words unless the page withholds it, the table itself and the list items of its cells. */
    const readTableFrame = (tbl: N): void => {
      const cellTexts: string[][][] = kidsOf(tbl)
        .filter((k) => tagOf(k) === "a:tr")
        .map((tr) =>
          kidsOf(tr)
            .filter((k) => tagOf(k) === "a:tc")
            .map((tc) =>
              isOn(attrOf(tc, "hMerge")) || isOn(attrOf(tc, "vMerge"))
                ? []
                : bodyText(first(tc, "a:txBody"), shownNumber),
            ),
        );
      // A table the page does not publish expects none of its words (the same rule as the page: `source-reading-table.ts`).
      const withheld = tableIsWithheld(tbl, cellTexts, limits);
      if (!withheld) for (const texts of cellTexts.flat()) pushAll(own, texts);
      unit.declared.tables++;
      if (withheld) unit.withheld.tables++;
      for (const tc of allOf(tbl, "a:tc"))
        if (!isOn(attrOf(tc, "hMerge")) && !isOn(attrOf(tc, "vMerge")))
          countItems(undefined, first(tc, "a:txBody"), withheld);
    };
    /** A frame that is not a table: a chart (its words, and the table the page holds for it) or a SmartArt (its data model's words, which the page publishes in its diagram text). */
    const readObjectFrame = async (data: N | undefined): Promise<void> => {
      const chartRef = first(data, "c:chart");
      const target = chartRef ? slideRels.get(attrOf(chartRef, "r:id") ?? "") : undefined;
      if (target && !target.external) {
        const chart = await chartRead(target.target);
        pushAll(own, chart.words);
        if (chart.shape !== undefined) addChartTable(unit, chart.shape);
      }
      const partOf = (id: string | undefined): string | undefined => {
        const rel = id === undefined ? undefined : slideRels.get(id);
        return rel && !rel.external ? rel.target : undefined;
      };
      for (const id of data ? smartArtRelIds(data) : []) pushAll(own, await smartArtPieces(xmlOf, partOf(id), partOf));
    };
    let title: string | undefined;
    let titleSeen = false;

    const hidden = (el: N): boolean =>
      kidsOf(el).some(
        (nv) => tagOf(nv).startsWith("p:nv") && isHiddenAttr(attrOf(first(nv, "p:cNvPr") ?? {}, "hidden")),
      );

    const walk = async (t: N, topLevel = true): Promise<void> => {
      for (const el of kidsOf(t)) {
        const tag = tagOf(el);
        if (tag === "mc:AlternateContent") {
          const choice = first(el, "mc:Choice");
          if (choice) await walk(choice, topLevel);
          continue;
        }
        if (hidden(el)) continue;
        if (topLevel && offSlide(el)) continue;
        if (tag === "p:grpSp") await walk(el, false);
        else if (tag === "p:sp") {
          const ph = first(first(first(el, "p:nvSpPr"), "p:nvPr"), "p:ph");
          const type = ph ? attrOf(ph, "type") : undefined;
          const paragraphs = bodyText(first(el, "p:txBody"), shownNumber);
          // The first shape declaring itself the title; a title WITH an idx is a column header.
          if (!titleSeen && ph && attrOf(ph, "idx") === undefined && (type === "title" || type === "ctrTitle")) {
            titleSeen = true;
            const t2 = paragraphs
              .filter((p) => p.trim() !== "")
              .join("\n")
              .trim();
            title = t2 === "" ? undefined : t2;
          } else {
            pushAll(own, paragraphs);
            countItems(el, first(el, "p:txBody"));
          }
        } else if (tag === "p:graphicFrame") {
          const data = first(first(el, "a:graphic"), "a:graphicData");
          const tbl = first(data, "a:tbl");
          if (tbl) readTableFrame(tbl);
          else await readObjectFrame(data);
        }
      }
    };
    if (tree) await walk(tree);

    // A title identical to the previous KEPT slide's (trimmed) is not
    // republished (`pptx.ts:486`): never collected, so never reported missing.
    const repeated = title !== undefined && title === previousTitle;
    const parts: string[] = [];
    if (title !== undefined && !repeated) {
      parts.push(title);
      addHeading(unit.declared, 2); // the page writes a slide's title as an h2 in its tab
    }
    pushAll(parts, own);
    slides.push({ number, text: parts.join("\n"), overCap: false, withheld: false, structure: unit });
    previousTitle = title;
  }

  return { slides, ...(structureUnreadable ? { structureUnreadable: true as const } : {}) };
};

/**
 * The pptx / Google-Slides conservation source (MIKSUDOC « Spécification technique » T11, lot D): one unit per visible slide, in deck order. `deliberateRemovals`
 * stays empty — unlike the notice LINES `page-messages.ts` composes for a
 * capped or withheld slide, nothing here is a literal text the page repeats
 * that would need budgeting back in; the declared removals instead never
 * become tokens at all (`excludedUnits`, or simply never collected — the
 * repeated title). A read that cannot be trusted becomes a named failure
 * instead of throwing through to the caller: never a reason not to publish
 * (21/09/2026).
 */
export async function readPptxConservationSource(
  bytes: Uint8Array,
  language: PageLanguage = "en",
  limits?: ReaderLimits,
  /** The same labels the reader was given, so a unit is named as the tab is (`lib/page-labels.ts#resolveLabels`). */
  labels?: PageLabelOverride,
): Promise<DeclaredFormatConservationSource | ConservationSourceReadFailure> {
  return guardedSourceAsync(async () => {
    const { slides, structureUnreadable } = await readPptxSource(bytes, limits);
    const units: ConservationUnit[] = slides.map((slide) =>
      unitOf(resolveLabels(language, labels).slideTabTitle(slide.number), slide.text),
    );
    const excludedUnits = excludedUnitsOf(slides, (slide) => slide.overCap || slide.withheld);
    return {
      units,
      deliberateRemovals: [],
      excludedUnits,
      structure: {
        units: slides.map((slide) => slide.structure),
        format: "pptx",
        ...(structureUnreadable === true ? { unreadable: true as const } : {}),
      },
    };
  });
}
