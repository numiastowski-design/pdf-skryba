/** What `numbering.xml` declares for a numbered paragraph: whether its list is
 *  ordered, the value its counter reaches, and the number it displays
 *  (`lvlText`), counted in document order.
 *  NOT here: building the nested IR lists (`docx-reader/body.ts`), nor which
 *  paragraph is numbered (its `w:numPr`, read by the body).
 *  Called by: `docx-reader/body.ts`, `docx-reader/index.ts`. */

import { intAttr as intValue } from "../../lib/ooxml-num";
import { isOnOff } from "../../lib/ooxml-bool";
import { attributeOf, findChild, findChildren, valOfChild, type XNode } from "../ooxml/xml";

interface LevelDef {
  start: number;
  numFmt: string;
  lvlText: string | undefined;
  /** lvlRestart, one-based; undefined = the default rule. */
  restart: number | undefined;
  isLgl: boolean;
  suff: string;
}

/** What one numbered paragraph shows. */
interface NumberedItem {
  ordered: boolean;
  /** The counter's value for this paragraph. */
  value: number;
  /** The number as displayed (`1.1.`), or undefined when the level shows
   *  none (a bullet) or uses a format this reader does not spell. */
  label: string | undefined;
  /** What separates the number from the text (w:suff). */
  separator: string;
}

export interface Numbering {
  /** Advances the counters for a paragraph at (numId, ilvl) and returns what
   *  it shows; undefined when the numbering instance or level is undeclared. */
  next(numId: string, ilvl: number): NumberedItem | undefined;
}

const intAttr = (el: XNode | undefined, name: string): number | undefined => (el ? intValue(attributeOf(el, name)) : undefined);

/** The highest value Word's automatic list numbering reaches or can be set
 *  to: 32767 (Microsoft Q&A « Automatic Numbering … will not go past 32767 »,
 *  learn.microsoft.com/answers/a/12648143, read 27/09/2026). A file may declare
 *  anything: past 2^53 `roman()` looped for ever (1e21 − 1000 === 1e21) and
 *  `letters()` built strings as long as the value (review of 27/09/2026 night,
 *  finding 3). Declared values are clamped to 0..32767 where they are read. */
const MAX_LIST_START = 32_767;

/** ECMA-376 numbers list levels 0 to 8 (nine levels, `%1`…`%9` in lvlText). A
 *  larger w:ilvl used to become an array index — 2e9 made a counter array of
 *  that length, walked by every numbered paragraph (review of 27/09/2026
 *  night, finding 4). Also read by `body.ts#numberingOf`. */
export const MAX_ILVL = 8;

const clampedStart = (n: number | undefined): number | undefined =>
  n === undefined ? undefined : Math.min(MAX_LIST_START, Math.max(0, n));

/** A level index as ECMA-376 bounds it; undefined outside 0..8. */
const levelIndex = (n: number | undefined): number | undefined => (n !== undefined && n >= 0 && n <= MAX_ILVL ? n : undefined);

const readLevel = (lvl: XNode): LevelDef => {
  const isLglEl = findChild(lvl, "w:isLgl");
  return {
    // w:start: when omitted the starting value is ZERO, not one.
    start: clampedStart(intAttr(findChild(lvl, "w:start"), "w:val")) ?? 0,
    numFmt: valOfChild(lvl, "w:numFmt") ?? "decimal",
    lvlText: valOfChild(lvl, "w:lvlText"),
    restart: intAttr(findChild(lvl, "w:lvlRestart"), "w:val"),
    isLgl: isLglEl !== undefined && isOnOff(attributeOf(isLglEl, "w:val"), true),
    suff: valOfChild(lvl, "w:suff") ?? "tab",
  };
};

const ROMAN: [number, string][] = [
  [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
  [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
];

const roman = (n: number): string => {
  let rest = n;
  let out = "";
  for (const [value, digits] of ROMAN) {
    while (rest >= value) {
      out += digits;
      rest -= value;
    }
  }
  return out;
};

/** ST_NumberFormat letter formats: a, b, … z, aa, bb, … (the
 *  letter repeats, it does not carry like a spreadsheet column). */
const letters = (n: number): string => {
  if (n <= 0) return "";
  const letter = String.fromCharCode(97 + ((n - 1) % 26));
  return letter.repeat(Math.floor((n - 1) / 26) + 1);
};

/** The counter spelled in its level's format; undefined for a format this
 *  reader does not spell — the number is then left out rather than guessed. */
const spelled = (value: number, numFmt: string): string | undefined => {
  switch (numFmt) {
    case "decimal":
      return String(value);
    case "decimalZero":
      return value < 10 && value >= 0 ? `0${value}` : String(value);
    case "upperRoman":
      return value > 0 ? roman(value).toUpperCase() : undefined;
    case "lowerRoman":
      return value > 0 ? roman(value) : undefined;
    case "upperLetter":
      return value > 0 ? letters(value).toUpperCase() : undefined;
    case "lowerLetter":
      return value > 0 ? letters(value) : undefined;
    default:
      return undefined;
  }
};

/** Formats that show no number: the paragraph is an unordered list item. */
const UNNUMBERED = new Set(["bullet", "none"]);

/** The numId a numbering style declares in its own w:pPr/w:numPr. */
export type NumberingStyleLookup = (styleId: string) => string | undefined;

export const readNumbering = (root: XNode | undefined, numIdOfStyle: NumberingStyleLookup = () => undefined): Numbering => {
  const abstracts = new Map<string, { levels: Map<number, LevelDef>; numStyleLink: string | undefined }>();
  for (const a of root ? findChildren(root, "w:abstractNum") : []) {
    const id = attributeOf(a, "w:abstractNumId");
    if (id === undefined) continue;
    const levels = new Map<number, LevelDef>();
    for (const lvl of findChildren(a, "w:lvl")) {
      // A level outside 0..8 is not one ECMA-376 defines: not read.
      const ilvl = levelIndex(intAttr(lvl, "w:ilvl"));
      if (ilvl !== undefined) levels.set(ilvl, readLevel(lvl));
    }
    abstracts.set(id, { levels, numStyleLink: valOfChild(a, "w:numStyleLink") });
  }
  const abstractOfNum = new Map<string, string>();
  for (const n of root ? findChildren(root, "w:num") : []) {
    const numId = attributeOf(n, "w:numId");
    const abstractId = valOfChild(n, "w:abstractNumId");
    if (numId !== undefined && abstractId !== undefined) abstractOfNum.set(numId, abstractId);
  }

  /** An abstract definition's levels. w:numStyleLink says they live
   *  elsewhere: the numbering STYLE it names carries a numId, whose abstract
   *  definition holds the levels. Followed until a definition has levels of
   *  its own; a loop gives none. */
  const levelsOf = (abstractId: string, seen: Set<string> = new Set()): Map<number, LevelDef> => {
    const def = abstracts.get(abstractId);
    if (!def || seen.has(abstractId)) return new Map();
    seen.add(abstractId);
    if (def.levels.size > 0 || def.numStyleLink === undefined) return def.levels;
    const linkedNum = numIdOfStyle(def.numStyleLink);
    const linkedAbstract = linkedNum === undefined ? undefined : abstractOfNum.get(linkedNum);
    return linkedAbstract === undefined ? new Map() : levelsOf(linkedAbstract, seen);
  };

  // w:num: an instance points at an abstract definition and may
  // override a level (lvlOverride): a whole new w:lvl, or only its
  // start value (startOverride).
  const instances = new Map<string, Map<number, LevelDef>>();
  for (const n of root ? findChildren(root, "w:num") : []) {
    const numId = attributeOf(n, "w:numId");
    const abstractId = valOfChild(n, "w:abstractNumId");
    if (numId === undefined || abstractId === undefined) continue;
    const levels = new Map(levelsOf(abstractId));
    for (const o of findChildren(n, "w:lvlOverride")) {
      const ilvl = levelIndex(intAttr(o, "w:ilvl"));
      if (ilvl === undefined) continue;
      const replaced = findChild(o, "w:lvl");
      const base = replaced ? readLevel(replaced) : levels.get(ilvl);
      const startOverride = clampedStart(intAttr(findChild(o, "w:startOverride"), "w:val"));
      if (base) levels.set(ilvl, startOverride !== undefined ? { ...base, start: startOverride } : base);
    }
    instances.set(numId, levels);
  }

  // Counters are kept PER numId (the docx reader (`extractor/docx-reader/`): the same
  // numId continues its numbering, a new numId starts again).
  const counters = new Map<string, (number | undefined)[]>();

  const next = (numId: string, ilvl: number): NumberedItem | undefined => {
    // The counters are an array indexed by level: only 0..8 ever index it.
    if (levelIndex(ilvl) === undefined) return undefined;
    const levels = instances.get(numId);
    const def = levels?.get(ilvl);
    if (!levels || !def) return undefined;
    const values = counters.get(numId) ?? [];
    counters.set(numId, values);

    const current = values[ilvl];
    values[ilvl] = current === undefined ? def.start : current + 1;
    // lvlRestart: a level restarts when a level whose one-based
    // index is at most its value is used; by default, whenever any level
    // above it is used; 0 = never.
    for (let deeper = ilvl + 1; deeper < values.length; deeper++) {
      const restartAfter = levels.get(deeper)?.restart ?? deeper;
      if (ilvl + 1 <= restartAfter) values[deeper] = undefined;
    }

    const value = values[ilvl] ?? def.start;
    const ordered = !UNNUMBERED.has(def.numFmt);
    let label: string | undefined;
    if (ordered && def.lvlText !== undefined) {
      let complete = true;
      // lvlText: %1 … %9 stand for the current value of levels 0 … 8.
      label = def.lvlText.replace(/%([1-9])/g, (_, digit: string) => {
        const level = Number(digit) - 1;
        const levelDef = levels.get(level);
        const levelValue = values[level] ?? levelDef?.start ?? 0;
        // isLgl: every level shown in decimal ("legal" numbering).
        const text = spelled(levelValue, def.isLgl ? "decimal" : (levelDef?.numFmt ?? "decimal"));
        if (text === undefined) complete = false;
        return text ?? "";
      });
      if (!complete) label = undefined;
    }
    return { ordered, value, label, separator: def.suff === "nothing" ? "" : " " };
  };

  return { next };
};
