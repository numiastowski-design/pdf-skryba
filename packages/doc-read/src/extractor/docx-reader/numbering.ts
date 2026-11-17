/** What `numbering.xml` declares for a numbered paragraph: whether its list is
 *  ordered, the value its counter reaches, and the number it displays
 *  (`lvlText`), counted in document order.
 *  Decides: counters are kept per numId; declared start values are clamped to 0..32767 and levels to 0..8; a format
 *  this reader does not spell leaves the number out rather than guess it.
 *  NOT here: building the nested IR lists (`docx-reader/body.ts`), nor which
 *  paragraph is numbered (its `w:numPr`, read by the body).
 *  Called by: `docx-reader/body.ts`, `docx-reader/index.ts`. */

import { intAttr as intValue } from "../../lib/ooxml-num";
import { isOnOff } from "../../lib/ooxml-bool";
import { attributeOf, findChild, findChildren, valOfChild, type XNode } from "../ooxml/xml";

interface LevelDefinition {
  readonly start: number;
  readonly numFmt: string;
  readonly lvlText: string | undefined;
  /** lvlRestart, one-based; undefined = the default rule. */
  readonly restart: number | undefined;
  readonly isLgl: boolean;
  readonly suff: string;
}

/** The levels of one abstract definition or numbering instance, by level index. */
type Levels = Map<number, LevelDefinition>;

/** What one numbered paragraph shows. */
interface NumberedItem {
  readonly ordered: boolean;
  /** The counter's value for this paragraph. */
  readonly value: number;
  /** The number as displayed (`1.1.`), or undefined when the level shows
   *  none (a bullet) or uses a format this reader does not spell. */
  readonly label: string | undefined;
  /** What separates the number from the text (w:suff). */
  readonly separator: string;
}

export interface Numbering {
  /** Advances the counters for a paragraph at (numId, ilvl) and returns what
   *  it shows; undefined when the numbering instance or level is undeclared. */
  next(numId: string, ilvl: number): NumberedItem | undefined;
}

const intAttributeOf = (element: XNode | undefined, name: string): number | undefined =>
  element ? intValue(attributeOf(element, name)) : undefined;

/** The highest start value we accept, taken as Word's own ceiling (27/09/2026). A file may declare anything: past
 *  2^53 `roman()` looped for ever (1e21 − 1000 === 1e21) and `letters()` built strings as long as the value. Declared
 *  values are clamped to 0..32767 where they are read (held by `docx-reader.test.ts`, « clamped to Word's own
 *  0..32767 »). */
const MAX_LIST_START = 32_767;

/** The deepest list level read, `%1`…`%9` in lvlText. A larger w:ilvl used to become an array index — 2e9 made a
 *  counter array of that length, walked by every numbered paragraph (27/09/2026). */
export const MAX_ILVL = 8;

const clampedStart = (declaredStart: number | undefined): number | undefined =>
  declaredStart === undefined ? undefined : Math.min(MAX_LIST_START, Math.max(0, declaredStart));

/** A level index within 0..`MAX_ILVL`; undefined outside. */
const levelIndex = (declaredIlvl: number | undefined): number | undefined =>
  declaredIlvl !== undefined && declaredIlvl >= 0 && declaredIlvl <= MAX_ILVL ? declaredIlvl : undefined;

const readLevel = (lvl: XNode): LevelDefinition => {
  const isLglElement = findChild(lvl, "w:isLgl");
  return {
    start: clampedStart(intAttributeOf(findChild(lvl, "w:start"), "w:val")) ?? 0,
    numFmt: valOfChild(lvl, "w:numFmt") ?? "decimal",
    lvlText: valOfChild(lvl, "w:lvlText"),
    restart: intAttributeOf(findChild(lvl, "w:lvlRestart"), "w:val"),
    isLgl: isLglElement !== undefined && isOnOff(attributeOf(isLglElement, "w:val"), true),
    suff: valOfChild(lvl, "w:suff") ?? "tab",
  };
};

const ROMAN: readonly (readonly [number, string])[] = [
  [1000, "m"],
  [900, "cm"],
  [500, "d"],
  [400, "cd"],
  [100, "c"],
  [90, "xc"],
  [50, "l"],
  [40, "xl"],
  [10, "x"],
  [9, "ix"],
  [5, "v"],
  [4, "iv"],
  [1, "i"],
];

const roman = (counterValue: number): string => {
  let rest = counterValue;
  let numeral = "";
  for (const [value, digits] of ROMAN) {
    while (rest >= value) {
      numeral += digits;
      rest -= value;
    }
  }
  return numeral;
};

/** Letters: a, b, … z, aa, bb, … (the letter repeats, it does not carry like a spreadsheet column). */
const letters = (counterValue: number): string => {
  if (counterValue <= 0) return "";
  const letter = String.fromCharCode(97 + ((counterValue - 1) % 26));
  return letter.repeat(Math.floor((counterValue - 1) / 26) + 1);
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

/** One `w:abstractNum`: its own levels, and the numbering style it defers to (`w:numStyleLink`). */
interface AbstractNum {
  readonly levels: Levels;
  readonly numStyleLink: string | undefined;
}

const readAbstractNums = (root: XNode | undefined): Map<string, AbstractNum> => {
  const abstractNums = new Map<string, AbstractNum>();
  for (const abstractNum of root ? findChildren(root, "w:abstractNum") : []) {
    const abstractNumId = attributeOf(abstractNum, "w:abstractNumId");
    if (abstractNumId === undefined) continue;
    const levels: Levels = new Map();
    for (const lvl of findChildren(abstractNum, "w:lvl")) {
      // A level outside 0..8 is not read.
      const ilvl = levelIndex(intAttributeOf(lvl, "w:ilvl"));
      if (ilvl !== undefined) levels.set(ilvl, readLevel(lvl));
    }
    abstractNums.set(abstractNumId, { levels, numStyleLink: valOfChild(abstractNum, "w:numStyleLink") });
  }
  return abstractNums;
};

/** The numId and abstractNumId of a `w:num`, or undefined when either is missing. */
const numIdsOf = (num: XNode): { numId: string; abstractNumId: string } | undefined => {
  const numId = attributeOf(num, "w:numId");
  const abstractNumId = valOfChild(num, "w:abstractNumId");
  return numId === undefined || abstractNumId === undefined ? undefined : { numId, abstractNumId };
};

/** One `w:lvlOverride` applied to an instance's levels. */
const applyLvlOverride = (levels: Levels, lvlOverride: XNode): void => {
  const ilvl = levelIndex(intAttributeOf(lvlOverride, "w:ilvl"));
  if (ilvl === undefined) return;
  const replacementLvl = findChild(lvlOverride, "w:lvl");
  const baseLevel = replacementLvl ? readLevel(replacementLvl) : levels.get(ilvl);
  const startOverride = clampedStart(intAttributeOf(findChild(lvlOverride, "w:startOverride"), "w:val"));
  if (baseLevel) levels.set(ilvl, startOverride !== undefined ? { ...baseLevel, start: startOverride } : baseLevel);
};

/** Advances the counter of `ilvl` and resets the deeper levels its use restarts. */
const advanceCounters = (counterValues: (number | undefined)[], ilvl: number, levels: Levels, start: number): void => {
  const current = counterValues[ilvl];
  counterValues[ilvl] = current === undefined ? start : current + 1;
  // lvlRestart: a level restarts when a level whose one-based
  // index is at most its value is used; by default, whenever any level
  // above it is used; 0 = never.
  for (let deeper = ilvl + 1; deeper < counterValues.length; deeper++) {
    const restartAfter = levels.get(deeper)?.restart ?? deeper;
    if (ilvl + 1 <= restartAfter) counterValues[deeper] = undefined;
  }
};

/** The number a level displays (its lvlText filled in), or undefined when one of its parts has a format this reader does not spell. */
const labelOf = (
  lvlText: string,
  isLgl: boolean,
  levels: Levels,
  counterValues: readonly (number | undefined)[],
): string | undefined => {
  let complete = true;
  // lvlText: %1 … %9 stand for the current value of levels 0 … 8.
  const label = lvlText.replace(/%([1-9])/g, (_, digit: string) => {
    const referencedIlvl = Number(digit) - 1;
    const referencedLevel = levels.get(referencedIlvl);
    const referencedValue = counterValues[referencedIlvl] ?? referencedLevel?.start ?? 0;
    // isLgl: every level shown in decimal ("legal" numbering).
    const text = spelled(referencedValue, isLgl ? "decimal" : (referencedLevel?.numFmt ?? "decimal"));
    if (text === undefined) complete = false;
    return text ?? "";
  });
  return complete ? label : undefined;
};

export const readNumbering = (
  root: XNode | undefined,
  numIdOfStyle: NumberingStyleLookup = () => undefined,
): Numbering => {
  const abstractNums = readAbstractNums(root);
  // `w:num` is walked TWICE on purpose: a `w:numStyleLink` may lead to a numId declared further down, so every numId
  // must be known before any instance's levels are resolved (held by `docx-reader.test.ts`, « a numId declared
  // FURTHER DOWN »).
  const abstractNumIdByNumId = new Map<string, string>();
  for (const num of root ? findChildren(root, "w:num") : []) {
    const ids = numIdsOf(num);
    if (ids !== undefined) abstractNumIdByNumId.set(ids.numId, ids.abstractNumId);
  }

  /** An abstract definition's levels. w:numStyleLink says they live
   *  elsewhere: the numbering STYLE it names carries a numId, whose abstract
   *  definition holds the levels. Followed until a definition has levels of
   *  its own; a loop gives none. */
  const levelsOf = (abstractNumId: string, seen: Set<string> = new Set()): Levels => {
    const abstractNum = abstractNums.get(abstractNumId);
    if (!abstractNum || seen.has(abstractNumId)) return new Map();
    seen.add(abstractNumId);
    if (abstractNum.levels.size > 0 || abstractNum.numStyleLink === undefined) return abstractNum.levels;
    const linkedNumId = numIdOfStyle(abstractNum.numStyleLink);
    const linkedAbstractNumId = linkedNumId === undefined ? undefined : abstractNumIdByNumId.get(linkedNumId);
    return linkedAbstractNumId === undefined ? new Map<number, LevelDefinition>() : levelsOf(linkedAbstractNumId, seen);
  };

  // w:num: an instance points at an abstract definition and may
  // override a level (lvlOverride): a whole new w:lvl, or only its
  // start value (startOverride).
  const instances = new Map<string, Levels>();
  for (const num of root ? findChildren(root, "w:num") : []) {
    const ids = numIdsOf(num);
    if (ids === undefined) continue;
    const levels = new Map(levelsOf(ids.abstractNumId));
    for (const lvlOverride of findChildren(num, "w:lvlOverride")) applyLvlOverride(levels, lvlOverride);
    instances.set(ids.numId, levels);
  }

  // Counters are kept PER numId: the same numId continues its numbering, a new numId starts again.
  const counters = new Map<string, (number | undefined)[]>();

  const next = (numId: string, ilvl: number): NumberedItem | undefined => {
    // The counters are an array indexed by level: only 0..8 ever index it.
    if (levelIndex(ilvl) === undefined) return undefined;
    const levels = instances.get(numId);
    const level = levels?.get(ilvl);
    if (!levels || !level) return undefined;
    const counterValues = counters.get(numId) ?? [];
    counters.set(numId, counterValues);

    advanceCounters(counterValues, ilvl, levels, level.start);

    const value = counterValues[ilvl] ?? level.start;
    const ordered = !UNNUMBERED.has(level.numFmt);
    const label =
      ordered && level.lvlText !== undefined ? labelOf(level.lvlText, level.isLgl, levels, counterValues) : undefined;
    return { ordered, value, label, separator: level.suff === "nothing" ? "" : " " };
  };

  return { next };
};
