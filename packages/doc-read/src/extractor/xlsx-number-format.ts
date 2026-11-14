/** Our number-format writer for spreadsheet cells: Excel's « General »,
 *  numbers, percentages, dates and times, scientific, fractions, currency
 *  and condition brackets — written as Excel displays them, in the PAGE's
 *  language (`PageLanguage`, features/page-language.feature,
 *  decided 30/09/2026): English (`1,234.50`) or French (`1 234,50`, U+00A0
 *  between thousands). A locale written in a code (`[$-40C]`) governs the
 *  WORDS only (month and day names), never the separators. Unknown code:
 *  `undefined`, the caller keeps the raw value, nothing is invented.
 *  NOT here: which cell carries which code (`xlsx-cells.ts` reads it raw,
 *  `xlsx.ts` calls this), nor where the page language comes from (the
 *  connection's `pageLanguage`). A trailing `@` section of a two- or three-section code is the
 *  TEXT section (numbers use the earlier ones); more than 30 decimals
 *  answers `undefined`; so does a code longer than 1024 characters.
 *  Called by: `extractor/xlsx.ts`. */

/**
 * Scope. Étape 5 of the validated plan wrote the codes the repository
 * workbooks carry — dates `d/m/yyyy`, `dd/mm/yyyy`, `m/d/yy`, percentages,
 * `#,##0`-style grouping, quoted literals (`"€"`), `\x` escapes, `[Red]`
 * colour tags, sections split on `;`. The revue HIGH du 29/09 (constats 1,
 * 2, 6, 7; option (c) of Mikolaj for 2 and 6) added: « General », the zero
 * section, decimal rounding, month and day NAMES, times (h, m
 * after h or before s, s, AM/PM, elapsed [h]/[m]/[s]), scientific
 * (`0.00E+00`), fractions (`# ?/?`, `# ??/??`, a fixed denominator),
 * currency/locale brackets (`[$€-40C]`: the symbol shows, the locale id
 * chooses the WORDS of a date) and conditions (`[>=1000]`) selecting the section. The lot of
 * 29/09 evening added engineering notation (`##0.0E+0`), fractions of a
 * second (`ss.00`, `[ss].000`), accounting shapes (`_x` and `*x` published
 * as nothing, `?` as a space, `$ + ( )` shown as themselves) and `0`
 * padding. « General » was checked against ISO 29500 §18.8.30 (11
 * characters, sign excluded): unchanged — 0.00001 fits, 1E-10 does not.
 * Anything else answers `undefined`. Where Excel's own behaviour was not observed
 * here, SheetJS's SSF (Apache-2.0, the reference emulation) was read and
 * followed — the same text Excel's TEXT() gives, alignment spaces of `?`
 * included.
 */

import { DAY_MS } from "../lib/clock";
import type { PageLanguage } from "doc-ir/lib/reader-types";

type Token =
  | { kind: "mask"; text: string }
  /** A locale written in the code (`[$-40C]`): zero width, words only. */
  | { kind: "locale"; words: PageLanguage }
  | { kind: "literal"; text: string; bare?: true }
  | { kind: "percent" }
  | { kind: "date"; text: string }
  | { kind: "minute"; text: string }
  | { kind: "hour"; text: string }
  | { kind: "second"; text: string }
  | { kind: "ampm"; am: string; pm: string }
  | { kind: "elapsed"; unit: "h" | "m" | "s"; width: number }
  | { kind: "exponent"; sign: "+" | "-"; digits: number }
  | { kind: "subsecond"; digits: number };

/** Colour tags: styling, never content. */
const COLOUR = /^(black|blue|cyan|green|magenta|red|white|yellow|color\s?\d{1,2})$/i;
/** A condition bracket (SSF's `cfregex2`), applied at section selection. */
const CONDITION = /\[(=|>=?|<[>=]?)(-?\d+(?:\.\d*)?)\]/;
/** `[$symbol-locale]`: the symbol shows; the locale (a hex LCID or a language
 *  label such as `fr-FR`) only chooses the WORDS of a date. */
const CURRENCY = /^\$([^-]*)(?:-([0-9A-Za-z]+(?:-[0-9A-Za-z]+)*))?$/;
/** Hex locale ids: the system date and time (`[$-F800]`, `[$-F400]`) are the
 *  reader's settings, not a locale of the file. `[$-F800]` is answered earlier, as the page language's long date
 *  (`formatNumberCell`, 06/11/2026); the others stay refused. */
const SYSTEM_LOCALE_IDS = new Set([0xf800, 0xf400]);
/** The primary language of a language id is its 10 low bits (MS-LCID):
 *  `0x0C` is French, whatever the region (040C fr-FR … 3C0C fr-HT). */
const FRENCH_PRIMARY_LANGUAGE = 0x0c;

/** Why the locale touches the words and never the separators: that is what
 *  Excel does (`[$-409]mmm` turns « mai » into « May », not the comma) —
 *  observed by the community, the standard only shows `[$-404]e/m/d`, and NO
 *  Microsoft page was found: a limit, written here, not a cited fact. Dropped: the
 *  locale governing everything, which yields text no Excel displays.
 *  The language of the WORDS a locale written in a code asks for. `null`: a
 *  locale we do not read (the system date, an `x-` extension) — the whole
 *  code then answers `undefined`. Anything that is not French is English. */
const localeWords = (locale: string): PageLanguage | null => {
  if (/^[0-9A-Fa-f]+$/.test(locale)) {
    const id = parseInt(locale, 16);
    if (SYSTEM_LOCALE_IDS.has(id & 0xffff)) return null;
    return (id & 0x3ff) === FRENCH_PRIMARY_LANGUAGE ? "fr" : "en";
  }
  if (/^x(-|$)/i.test(locale)) return null;
  return /^fr(-|$)/i.test(locale) ? "fr" : "en";
};
const ELAPSED = /^(h+|m+|s+)$/i;
/** Most decimal places written. Excel's own decimal-places setting stops at
 *  30 (Microsoft, « Display more digits in trendline equation coefficients
 *  in Excel »: « Decimal places setting to 30 or less »): a mask asking for
 *  more answers `undefined` (the raw value) instead of growing the output
 *  with the code. */
const MAX_DECIMALS = 30;
/** Longest format code read at all — STARTING VALUE TO CALIBRATE. No
 *  Microsoft source was found for a code-length limit; 1024 is chosen far
 *  above any real code seen. It bounds by construction every part that grows
 *  with the code (integer padding, elapsed width, exponent digits): a longer
 *  code answers `undefined`, the raw value is published, no text is lost. */
const MAX_FORMAT_CODE_CHARS = 1024;

const isSecond = (t: Token | undefined): boolean => t?.kind === "second" || (t?.kind === "elapsed" && t.unit === "s");

/** What a reader of one token answers: the position after it, or `undefined`
 *  when the whole section is a shape we do not treat. Each reader pushes its
 *  token(s) on `tokens` before answering. */
type TokenRead = number | undefined;

/** `"text"`: a literal. */
const readQuoted = (section: string, i: number, tokens: Token[]): TokenRead => {
  const end = section.indexOf('"', i + 1);
  if (end === -1) return undefined;
  tokens.push({ kind: "literal", text: section.slice(i + 1, end) });
  return end + 1;
};

/** `\x`: the next character, as a literal. */
const readEscaped = (section: string, i: number, tokens: Token[]): TokenRead => {
  if (i + 1 >= section.length) return undefined;
  tokens.push({ kind: "literal", text: section[i + 1]! });
  return i + 2;
};

/** `[$symbol-locale]`: the symbol is a literal, the locale a zero-width token. */
const pushCurrency = (currency: RegExpExecArray, tokens: Token[]): boolean => {
  if (currency[1]!.length > 0) tokens.push({ kind: "literal", text: currency[1]! });
  if (currency[2] !== undefined) {
    const words = localeWords(currency[2]);
    if (words === null) return false;
    tokens.push({ kind: "locale", words });
  }
  return true;
};

/** `[...]`: a colour or a condition (styling), a currency/locale, or an
 *  elapsed-time unit; any other bracket is not ours. */
const readBracket = (section: string, i: number, tokens: Token[]): TokenRead => {
  const end = section.indexOf("]", i);
  if (end === -1) return undefined;
  const inner = section.slice(i + 1, end);
  const currency = CURRENCY.exec(inner);
  const elapsed = ELAPSED.exec(inner);
  if (COLOUR.test(inner) || CONDITION.test(`[${inner}]`)) {
    // styling, or a condition already applied by `selectSection`
  } else if (currency) {
    if (!pushCurrency(currency, tokens)) return undefined;
  } else if (elapsed) {
    tokens.push({ kind: "elapsed", unit: inner[0]!.toLowerCase() as "h" | "m" | "s", width: inner.length });
  } else {
    // Any other bracket (DBNum, locale-only calendars…) changes the
    // display in a way we do not write (revue HIGH 29/09, constat 6):
    // dropping it silently published a wrong text.
    return undefined;
  }
  return end + 1;
};

/** `_x` and `*x`: a space the width of x, x repeated to the column width.
 *  Both align a column we do not have: published as nothing (choice of
 *  29/09: no stray padding around the words; a text cell under the
 *  same format is published as its bare text too). */
const skipAlignment = (section: string, i: number): TokenRead => (i + 1 >= section.length ? undefined : i + 2);

/** A run of digit placeholders and separators (`#,##0.00`). */
const readMask = (section: string, i: number, tokens: Token[]): TokenRead => {
  let end = i;
  while (end < section.length && "#0?,.".includes(section[end]!)) end++;
  tokens.push({ kind: "mask", text: section.slice(i, end) });
  return end;
};

/** `E+00`, `e-0` right after a mask. */
const readExponent = (section: string, i: number, tokens: Token[]): TokenRead => {
  const exponent = /^[Ee]([+-])(0+)/.exec(section.slice(i));
  if (!exponent || tokens.at(-1)?.kind !== "mask") return undefined; // `e` alone is an era year: not ours
  tokens.push({ kind: "exponent", sign: exponent[1] as "+" | "-", digits: exponent[2]!.length });
  return i + exponent[0].length;
};

/** A run of one date or time letter (`yyyy`, `mm`, `hh`, `s`). */
const readDateLetters = (section: string, i: number, lower: string, tokens: Token[]): TokenRead => {
  let end = i;
  while (end < section.length && section[end]!.toLowerCase() === lower) end++;
  const text = section.slice(i, end).toLowerCase();
  if ((lower === "h" || lower === "s") && text.length > 2) return undefined;
  tokens.push(lower === "h" ? { kind: "hour", text } : lower === "s" ? { kind: "second", text } : { kind: "date", text });
  return end;
};

/** `AM/PM` or `A/P`. */
const readAmPm = (section: string, i: number, tokens: Token[]): TokenRead => {
  if (section.slice(i, i + 5).toUpperCase() === "AM/PM") {
    tokens.push({ kind: "ampm", am: "AM", pm: "PM" });
    return i + 5;
  }
  if (section.slice(i, i + 3).toUpperCase() === "A/P") {
    tokens.push({ kind: "ampm", am: section[i]!, pm: section[i + 2]! });
    return i + 3;
  }
  return undefined;
};

/** Fractions of a second right after the seconds (`ss.00`, `[ss].000`). */
const readSubsecond = (section: string, i: number, tokens: Token[]): TokenRead => {
  let end = i + 1;
  while (end < section.length && section[end] === "0") end++;
  tokens.push({ kind: "subsecond", digits: end - i - 1 });
  return end;
};

/** Characters shown as themselves (Learn, « Format Cells dialog box »: « $-+/():space »). */
const SHOWN_AS_THEMSELVES = new Set(["/", " ", "-", ":", "$", "+", "(", ")"]);
/** The letters that open a date or time token. */
const DATE_TIME_LETTERS = new Set(["d", "m", "y", "h", "s"]);
/** The characters that open a digit mask. */
const MASK_OPENERS = new Set(["#", "0", "?"]);

/** What is left once the structural characters and the letters are ruled out:
 *  fractions of a second, characters shown as themselves, bare separators. */
const readPunctuation = (section: string, i: number, ch: string, tokens: Token[]): TokenRead => {
  if (ch === "." && /^\.0/.test(section.slice(i)) && isSecond(tokens.at(-1))) return readSubsecond(section, i, tokens);
  if (SHOWN_AS_THEMSELVES.has(ch)) {
    tokens.push({ kind: "literal", text: ch });
    return i + 1;
  }
  if (ch === "." || ch === ",") {
    // Outside a digit mask: a separator in a date (« d. mmmm, yyyy »),
    // meaningless in a number section — flagged so the number path refuses.
    tokens.push({ kind: "literal", text: ch, bare: true });
    return i + 1;
  }
  return undefined; // @, G, any other letter … : not ours
};

/** One token at `i`, pushed on `tokens`; the position after it, or `undefined`. */
const readToken = (section: string, i: number, tokens: Token[]): TokenRead => {
  const ch = section[i]!;
  const lower = ch.toLowerCase();
  if (ch === '"') return readQuoted(section, i, tokens);
  if (ch === "\\") return readEscaped(section, i, tokens);
  if (ch === "[") return readBracket(section, i, tokens);
  if (ch === "_" || ch === "*") return skipAlignment(section, i);
  if (MASK_OPENERS.has(ch)) return readMask(section, i, tokens);
  if (lower === "e") return readExponent(section, i, tokens);
  if (ch === "%") {
    tokens.push({ kind: "percent" });
    return i + 1;
  }
  if (DATE_TIME_LETTERS.has(lower)) return readDateLetters(section, i, lower, tokens);
  if (lower === "a") return readAmPm(section, i, tokens);
  return readPunctuation(section, i, ch, tokens);
};

/** The token before (`step` -1) or after (+1) `from`, literals and locales skipped. */
const meaningfulNeighbour = (tokens: Token[], from: number, step: 1 | -1): Token | undefined => {
  for (let j = from + step; j >= 0 && j < tokens.length; j += step) if (tokens[j]!.kind !== "literal" && tokens[j]!.kind !== "locale") return tokens[j];
  return undefined;
};

/** `m`/`mm` are MINUTES right after an hour or right before a second
 *  (literals between do not count) — Excel's rule; months otherwise. */
const resolveMinutes = (tokens: Token[]): Token[] =>
  tokens.map((t, j) => {
    if (t.kind !== "date" || (t.text !== "m" && t.text !== "mm")) return t;
    const before = meaningfulNeighbour(tokens, j, -1);
    const after = meaningfulNeighbour(tokens, j, 1);
    const afterHour = before?.kind === "hour" || (before?.kind === "elapsed" && before.unit === "h");
    const beforeSecond = after?.kind === "second" || (after?.kind === "elapsed" && after.unit === "s");
    return afterHour || beforeSecond ? { kind: "minute", text: t.text } : t;
  });

/** Splits one SECTION into tokens; undefined = a shape we do not treat. */
const tokenize = (section: string): Token[] | undefined => {
  const tokens: Token[] = [];
  let i = 0;
  while (i < section.length) {
    const next = readToken(section, i, tokens);
    if (next === undefined) return undefined;
    i = next;
  }
  return resolveMinutes(tokens);
};

/** Excel's last displayable day number, 9999-12-31; above it Excel shows #####. */
const LAST_DISPLAYABLE_DAY = 2_958_465;

/** Excel 1900-system day number → UTC date, honouring the fake 1900-02-29
 *  (days 1..59 sit one day higher than the real calendar). */
const dateOfDays = (days: number): Date | undefined => {
  if (days < 1 || days > LAST_DISPLAYABLE_DAY) return undefined; // before day 1 or past 9999-12-31: no display
  const adjusted = days >= 60 ? days - 1 : days; // skip Excel's nonexistent 29/02/1900
  const date = new Date(Date.UTC(1899, 11, 31) + adjusted * DAY_MS);
  return Number.isNaN(date.getTime()) ? undefined : date; // not finite: no display
};

/** The page language's separators (decided Q3, 30/09/2026: the French
 *  thousands separator is the NO-BREAK space U+00A0, what Windows and
 *  LibreOffice write; its effect on Confluence search is not measured). */
const SEPARATORS: Record<PageLanguage, { thousands: string; decimal: string }> = {
  en: { thousands: ",", decimal: "." },
  fr: { thousands: " ", decimal: "," },
};

/** Thousands separators every three digits from the right, in ONE pass (a
 *  lookahead regex over a long digit run is quadratic). `integer` may start
 *  with spaces (« ? » placeholders): only the digit run is grouped. */
const groupThousands = (integer: string, separator: string): string => {
  const from = integer.search(/\d/);
  if (from === -1) return integer;
  const digits = integer.slice(from);
  const groups: string[] = [];
  for (let end = digits.length; end > 0; end -= 3) groups.push(digits.slice(Math.max(0, end - 3), end));
  return integer.slice(0, from) + groups.reverse().join(separator);
};

/** `abs` (≥ 0) rounded to `decimals` places, half AWAY from zero on its
 *  DECIMAL reading (revue HIGH 29/09, constat 7): `toFixed` rounds the
 *  binary double, so 1.005 (stored 1.00499…) showed « 1.00 » where Excel
 *  shows « 1.01 ». The decimal reading is the 15 significant digits Excel
 *  itself keeps. Returns [integer digits, fraction digits]. */
const roundDecimal = (abs: number, decimals: number): [string, string] => {
  const [mantissa = "0", exponent = "0"] = abs.toExponential(14).split("e");
  const digits = mantissa.replace(".", "");
  const keep = Number(exponent) + 1 + decimals; // digits left of the cut
  let kept: string;
  if (keep < 0) kept = "0";
  else if (keep >= digits.length) kept = digits + "0".repeat(keep - digits.length);
  else {
    kept = digits.slice(0, keep) || "0";
    if (digits[keep]! >= "5") {
      // Decimal carry on the kept digits, right to left.
      const out = kept.split("");
      let i = out.length - 1;
      while (i >= 0 && out[i] === "9") out[i--] = "0";
      if (i >= 0) out[i] = String(Number(out[i]) + 1);
      else out.unshift("1");
      kept = out.join("");
    }
  }
  const padded = kept.padStart(decimals + 1, "0");
  const integer = padded.slice(0, padded.length - decimals).replace(/^0+(?=\d)/, "");
  return [integer, padded.slice(padded.length - decimals)];
};

const writeNumber = (value: number, signedMask: string, language: PageLanguage): string | undefined => {
  // THE SCALING COMMA, written for what it is since 30/10/2026. Each comma AFTER the last digit placeholder divides the
  // value by 1000 (Microsoft, « Number format codes », Display numbers in thousands). It was REFUSED until now, and the
  // refusal was right: rendering it as plain grouping published figures 1000× the displayed value (revue HIGH du 28/09
  // au soir, constat 4). Measured on 68 real workbooks the same day: `#,##0,` on 1 048 cells and `#,,` on 462, 88 % of
  // all the cells that fell back to their raw value. Only a run at the very END of the mask scales: a comma anywhere
  // else that is not followed by a digit placeholder stays unknown, and unknown is still `undefined`.
  // UNE VALEUR NON FINIE NE S'ÉCRIT PAS (revue sécurité du 30/10/2026). `%` répété 200 fois fait déborder la
  // multiplication à `Infinity`, et l'arrondi décimal en tirait la CHAÎNE « NaN », publiée telle quelle dans une
  // cellule. Le code de format est du texte que le DOCUMENT choisit : il ne décide pas de ce qu'on affiche.
  if (!Number.isFinite(value)) return undefined;
  // La suite de virgules se compte à la main, de la fin vers le début : `/,+$/` est quadratique sur une longue suite
  // (le cliquet sonarjs l'a refusée), et un code de format est du texte que le document choisit.
  let scale = 0;
  while (scale < signedMask.length && signedMask[signedMask.length - 1 - scale] === ",") scale++;
  const mask = scale === 0 ? signedMask : signedMask.slice(0, -scale);
  if (/,(?![#0])/.test(mask)) return undefined;
  value = value / 1000 ** scale;
  const grouped = mask.includes(",");
  if (grouped && mask.includes("?")) return undefined; // grouping over space-padded digits: not ours
  const dot = mask.indexOf(".");
  const decimals = dot === -1 ? 0 : mask.length - dot - 1;
  const fractionMask = dot === -1 ? "" : mask.slice(dot + 1);
  if (dot !== -1 && !/^[#0?]+$/.test(fractionMask)) return undefined;
  if (decimals > MAX_DECIMALS) return undefined;
  const [rounded, fraction] = roundDecimal(Math.abs(value), decimals);
  // A '#'-only integer mask shows NOTHING for a zero integer part (« # » on
  // 0 is blank in Excel, « #,##0 » shows 0) — revue HIGH 29/09, constat 7.
  const integerMask = dot === -1 ? mask : mask.slice(0, dot);
  let integer = rounded === "0" && !integerMask.includes("0") ? "" : rounded;
  // Placeholders beyond the digits (Learn, « Format Cells dialog box »):
  // `0` shows a zero ((000) on 12 → (012)), `?` a space, `#` nothing — on
  // the left of the integer, and for the trailing zeros of the decimals.
  const placeholders = integerMask.replaceAll(",", "");
  if (integer.length < placeholders.length) {
    integer = placeholders.slice(0, placeholders.length - integer.length).replaceAll("#", "").replaceAll("?", " ") + integer;
  }
  const decimalsOut = fraction.split("");
  for (let j = decimalsOut.length - 1; j >= 0 && decimalsOut[j] === "0" && fractionMask[j] !== "0"; j--) decimalsOut[j] = fractionMask[j] === "?" ? " " : "";
  const { thousands, decimal } = SEPARATORS[language];
  const written = (grouped ? groupThousands(integer, thousands) : integer) + (decimals > 0 ? `${decimal}${decimalsOut.join("")}` : "");
  return value < 0 ? `-${written}` : written;
};

/** An integer mask cut by escaped literals, `#\ ##0` (52 cells of the 68-workbook corpus): the digits fill the placeholders from
 *  the right, a literal stays where the code puts it, and digits beyond the placeholders pile up in the leftmost one, as
 *  Excel's screen shows it (1234567 → « 1234 567 », not a regrouping). Decided 06/11/2026 (Mikolaj): the cell shows what
 *  Excel shows, no longer the raw value. Integer placeholders only; any other shape answers `undefined`. */
const writeSplitIntegerMask = (tokens: Token[], value: number, language: PageLanguage): string | undefined => {
  if (!tokens.every((t) => t.kind === "locale" || t.kind === "literal" || (t.kind === "mask" && /^[#0?]+$/.test(t.text)))) return undefined;
  const whole = writeNumber(Math.abs(value), tokens.map((t) => (t.kind === "mask" ? t.text : "")).join(""), language);
  if (whole === undefined) return undefined;
  let digits = whole;
  let out = "";
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i]!;
    if (t.kind === "literal") out = t.text + out;
    else if (t.kind === "mask") {
      const isLeftmost = !tokens.slice(0, i).some((p) => p.kind === "mask");
      const take = isLeftmost ? digits.length : Math.min(t.text.length, digits.length);
      out = digits.slice(digits.length - take) + out;
      digits = digits.slice(0, digits.length - take);
    }
  }
  return value < 0 ? `-${out}` : out;
};

/** `0.00E+00`, and engineering `##0.0E+0`: n integer placeholders make the
 *  exponent a multiple of n, the mantissa 1 to n digits (Learn, « Format
 *  Cells dialog box »: #0.0E+0 on 12,200,000 → 12.2E+6; ISO 29500 builtin
 *  48 is ##0.0E+0). Zeros only after the point. Same decimal rounding. */
const writeScientific = (value: number, mask: string, exponent: Extract<Token, { kind: "exponent" }>, language: PageLanguage): string | undefined => {
  if (!Number.isFinite(value)) return undefined; // même raison qu'au-dessus : jamais « NaN » dans une cellule.
  if (!/^[#0]+(\.0*)?$/.test(mask)) return undefined;
  const dot = mask.indexOf(".");
  const step = dot === -1 ? mask.length : dot;
  const decimals = dot === -1 ? 0 : mask.length - dot - 1;
  if (decimals > MAX_DECIMALS) return undefined;
  let power = 0;
  let integer = "0";
  let fraction = "0".repeat(decimals);
  if (value !== 0) {
    const [m = "0", e = "0"] = Math.abs(value).toExponential(14).split("e");
    power = Math.floor(Number(e) / step) * step;
    [integer, fraction] = roundDecimal(Number(m) * 10 ** (Number(e) - power), decimals);
    if (integer.length > step) {
      // Rounding reached 10^step (999.96 → 1000.0): next exponent step.
      power += step;
      [integer, fraction] = roundDecimal(Number(`${integer}.${fraction}`) / 10 ** step, decimals);
    }
  }
  const sign = power < 0 ? "-" : exponent.sign === "+" ? "+" : "";
  const mantissa = integer + (decimals > 0 ? `${SEPARATORS[language].decimal}${fraction}` : "");
  return `${value < 0 ? "-" : ""}${mantissa}E${sign}${String(Math.abs(power)).padStart(exponent.digits, "0")}`;
};

/** Best rational approximation with a denominator ≤ `maxDen` (continued
 *  fractions, SSF's `SSF_frac`). Returns [whole, numerator, denominator]
 *  of the absolute value, the whole part split off when `mixed`. */
const approximate = (abs: number, maxDen: number, mixed: boolean): [number, number, number] => {
  let b = abs;
  let p2 = 0;
  let p1 = 1;
  let p = 0;
  let q2 = 1;
  let q1 = 0;
  let q = 0;
  while (q1 < maxDen) {
    const a = Math.floor(b);
    p = a * p1 + p2;
    q = a * q1 + q2;
    if (b - a < 0.00000005) break;
    b = 1 / (b - a);
    p2 = p1;
    p1 = p;
    q2 = q1;
    q1 = q;
  }
  if (q > maxDen) {
    if (q1 > maxDen) {
      q = q2;
      p = p2;
    } else {
      q = q1;
      p = p1;
    }
  }
  if (!mixed) return [0, p, q];
  const whole = Math.floor(p / q);
  return [whole, p - whole * q, q];
};

/** Fractions: `# ?/?`, `# ??/??` (denominator up to 9, 99…), `# ?/4` (a
 *  fixed denominator, never reduced), `?/?` (no whole part). The `?`
 *  placeholders pad with spaces, as Excel's cell text does. */
const writeFraction = (abs: number, sign: string, section: string): string | undefined => {
  const shape = /^(?:(#+|0+) )?(\?+)\/(\?+|\d+)$/.exec(section);
  if (!shape) return undefined;
  const whole = shape[1];
  const numerator = shape[2]!;
  const denominator = shape[3]!;
  if (/^\d+$/.test(denominator)) {
    if (whole === undefined) return undefined;
    const den = Number(denominator);
    if (den === 0) return undefined;
    const scaled = Math.round(abs * den);
    const base = Math.floor(scaled / den);
    const num = scaled - base * den;
    return `${sign}${base === 0 ? "" : base} ${num === 0 ? " ".repeat(numerator.length + 1 + denominator.length) : `${String(num).padStart(numerator.length, " ")}/${denominator}`}`;
  }
  if (whole === undefined) {
    const width = Math.min(denominator.length, 7);
    const [, num, den] = approximate(abs, 10 ** width - 1, false);
    return `${sign}${String(num).padStart(numerator.length, " ")}/${String(den).padEnd(width, " ")}`;
  }
  const width = Math.min(Math.max(numerator.length, denominator.length), 7);
  const [base, num, den] = approximate(abs, 10 ** width - 1, true);
  const head = base !== 0 ? String(base) : num !== 0 ? "" : "0";
  return `${sign}${head} ${num !== 0 ? `${String(num).padStart(width, " ")}/${String(den).padEnd(width, " ")}` : " ".repeat(2 * width + 1)}`;
};

/** Month and day names per language: full, then abbreviated. French is
 *  CLDR's (lowercase, points included); there an abbreviation is never a
 *  slice of the full name (« janv. », not « jan »). */
interface Names {
  months: string[];
  monthsShort: string[];
  days: string[];
  daysShort: string[];
}
const NAMES: Record<PageLanguage, Names> = {
  en: {
    months: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
    monthsShort: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
    days: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
    daysShort: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  },
  fr: {
    months: ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"],
    monthsShort: ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."],
    days: ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"],
    daysShort: ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."],
  },
};
const pad2 = (n: number): string => String(n).padStart(2, "0");
const TIME_KINDS: ReadonlySet<Token["kind"]> = new Set(["hour", "minute", "second", "ampm", "elapsed", "subsecond"]);

/** What every token of one value is written from. */
interface DateTimeContext {
  /** Excel day number (carry of the rounded time included). */
  days: number;
  secondOfDay: number;
  hour: number;
  /** Seconds since the serial's zero, for the elapsed units. */
  totalSeconds: number;
  /** The shown fraction of a second, zero-padded to its digits. */
  subsecond: string;
  twelveHour: boolean;
  /** Present exactly when a token asks for a date part. */
  date: Date | undefined;
  names: Names;
  language: PageLanguage;
}

/** The value split into days and clock parts, once for all its tokens. With
 *  a time on show, the value is read to the nearest second — or to the shown
 *  fraction of a second (`ss.00`, at most 3 digits, Excel's own limit) — a
 *  carry can reach the next day; a pure DATE format shows the date part
 *  (revue HIGH 28/09 soir, constat 7 — a datetime is not refused).
 *  `undefined`: more than 3 digits of a second, or a date part that has no
 *  date (before day 1 or past Excel's last date, 9999-12-31), or a time too
 *  large to count. Huge elapsed `[h]` values: Excel's own display of them is
 *  not verified against a source, so past 2^53 ticks the raw value is kept. */
const dateTimeContextOf = (tokens: Token[], value: number, date1904: boolean, names: Names, language: PageLanguage): DateTimeContext | undefined => {
  const serial = date1904 ? value + 1462 : value;
  const hasTime = tokens.some((t) => TIME_KINDS.has(t.kind));
  const subDigits = tokens.find((t): t is Extract<Token, { kind: "subsecond" }> => t.kind === "subsecond")?.digits ?? 0;
  if (subDigits > 3) return undefined;
  const ticksPerSecond = 10 ** subDigits;
  const totalTicks = hasTime ? Math.round(value * 86_400 * ticksPerSecond) : 0;
  if (!Number.isSafeInteger(totalTicks)) return undefined; // too large (or not finite) to count exactly: no display
  const totalSeconds = Math.floor(totalTicks / ticksPerSecond);
  const subsecond = String(totalTicks - totalSeconds * ticksPerSecond).padStart(subDigits, "0");
  const days = hasTime ? Math.floor((date1904 ? totalSeconds + 1462 * 86_400 : totalSeconds) / 86_400) : Math.floor(serial);
  const secondOfDay = totalSeconds % 86_400;
  const twelveHour = tokens.some((t) => t.kind === "ampm");
  const needsDate = tokens.some((t) => t.kind === "date");
  const date = needsDate ? dateOfDays(days) : undefined;
  if (needsDate && date === undefined) return undefined;
  return { days, secondOfDay, hour: Math.floor(secondOfDay / 3600), totalSeconds, subsecond, twelveHour, date, names, language };
};

/** A clock number: two digits when the token is two letters wide. */
const clockNumber = (text: string, n: number): string => (text.length === 2 ? pad2(n) : String(n));

const writeElapsed = (t: Extract<Token, { kind: "elapsed" }>, totalSeconds: number): string => {
  const total = t.unit === "h" ? Math.floor(totalSeconds / 3600) : t.unit === "m" ? Math.floor(totalSeconds / 60) : totalSeconds;
  return String(total).padStart(t.width, "0");
};

/** `m` run: 1-2 letters a number, 3 the short name, 5 the initial, else the full name. */
const writeMonth = (month: number, n: number, names: Names): string => {
  if (n === 1) return String(month + 1);
  if (n === 2) return pad2(month + 1);
  if (n === 3) return names.monthsShort[month]!;
  return n === 5 ? names.months[month]![0]!.toUpperCase() : names.months[month]!;
};

/** `d` run: 1-2 letters the day of the month, 3 the short weekday, else the full one. */
const writeDay = (d: Date, days: number, n: number, names: Names): string => {
  if (n === 1) return String(d.getUTCDate());
  if (n === 2) return pad2(d.getUTCDate());
  // Excel's calendar believes 1900-01-01 was a Sunday: before its
  // fake 29/02 the weekday sits one lower (SSF does the same).
  const weekday = days < 60 ? (d.getUTCDay() + 6) % 7 : d.getUTCDay();
  return n === 3 ? names.daysShort[weekday]! : names.days[weekday]!;
};

/** A `d`, `m` or `y` run: its width picks number, short name or full name. */
const writeDateToken = (text: string, d: Date, days: number, names: Names): string => {
  const letter = text[0];
  const n = text.length;
  if (letter === "y") return n <= 2 ? pad2(d.getUTCFullYear() % 100) : String(d.getUTCFullYear() % 10_000).padStart(4, "0");
  if (letter === "m") return writeMonth(d.getUTCMonth(), n, names);
  return writeDay(d, days, n, names);
};

/** The text of one token; `null`: a token that has no place in a date. */
const writeDateTimeToken = (t: Token, ctx: DateTimeContext): string | null => {
  switch (t.kind) {
    case "literal":
      return t.text;
    case "locale":
      return "";
    case "hour":
      return clockNumber(t.text, ctx.twelveHour ? 1 + ((ctx.hour + 11) % 12) : ctx.hour);
    case "minute":
      return clockNumber(t.text, Math.floor(ctx.secondOfDay / 60) % 60);
    case "second":
      return clockNumber(t.text, ctx.secondOfDay % 60);
    case "ampm":
      return ctx.hour >= 12 ? t.pm : t.am;
    case "subsecond":
      return `${SEPARATORS[ctx.language].decimal}${ctx.subsecond}`;
    case "elapsed":
      return writeElapsed(t, ctx.totalSeconds);
    case "date":
      return writeDateToken(t.text, ctx.date!, ctx.days, ctx.names);
    default:
      return null; // a digit mask, a percent or an exponent inside a date: not ours
  }
};

/** Dates and times. A negative value has no date or time display: in the
 *  1900 system Excel shows ##### (support, « How to correct a ##### error »:
 *  dates and times must be positive). Undefined: the raw value, our rule
 *  for what we cannot write faithfully. The 1904 system does show negative
 *  times, but no source read gives their exact text: not written either. */
const writeDateTime = (tokens: Token[], value: number, date1904: boolean, language: PageLanguage): string | undefined => {
  if (value < 0) return undefined;
  // The words follow a locale written in the code, else the page language.
  const locale = tokens.filter((t): t is Extract<Token, { kind: "locale" }> => t.kind === "locale").at(-1);
  const names = NAMES[locale?.words ?? language];
  const ctx = dateTimeContextOf(tokens, value, date1904, names, language);
  if (ctx === undefined) return undefined;
  let out = "";
  for (const t of tokens) {
    const piece = writeDateTimeToken(t, ctx);
    if (piece === null) return undefined;
    out += piece;
  }
  return out;
};

/** Excel's « General » for a number, at the default column width: at most
 *  11 characters (12 with a minus sign), trailing zeros trimmed, scientific
 *  notation past that width (revue HIGH 29/09, constat 1: `String(v)`
 *  published 0.30000000000000004 and 1e+21). Ported from SheetJS SSF's
 *  `SSF_general_num` (Apache-2.0), the reference emulation of Excel's rule
 *  — 1/3 shows 0.333333333, 123456789012 shows 1.23457E+11. */
const trimDecimal = (o: string): string => (o.includes(".") ? o.replace(/(?:\.0*|(\.\d*[1-9])0+)$/, "$1") : o);
const normalizeExp = (o: string): string =>
  o.includes("E") ? o.replace(/(?:\.0*|(\.\d*[1-9])0+)E/, "$1E").replace(/(E[+-])(\d)$/, "$10$2") : o;
export const formatGeneral = (v: number, language: PageLanguage = "en"): string => {
  const written = generalDigits(v);
  return language === "en" ? written : written.replace(".", SEPARATORS[language].decimal);
};
const generalDigits = (v: number): string => {
  if (Number.isInteger(v) && Math.abs(v) <= 2_147_483_647) return String(v === 0 ? 0 : v);
  if (!Number.isFinite(v)) return String(v); // unreachable from a cell: no such value in a file
  const width = v < 0 ? 12 : 11;
  const magnitude = Math.floor(Math.log10(Math.abs(v)));
  let o: string;
  if (magnitude >= -4 && magnitude <= -1) o = v.toPrecision(10 + magnitude);
  else if (Math.abs(magnitude) <= 9) {
    o = trimDecimal(v.toFixed(12));
    if (o.length > width) o = v.toPrecision(10);
    if (o.length > width) o = v.toExponential(5);
  } else if (magnitude === 10) o = v.toFixed(10).slice(0, 12);
  else {
    o = trimDecimal(v.toFixed(11));
    if (o.length > width || o === "0" || o === "-0") o = v.toPrecision(6);
  }
  return trimDecimal(normalizeExp(o.toUpperCase()));
};

/** A code's sections, split on `;` outside quotes and escapes. */
const splitSections = (code: string): string[] => {
  const sections: string[] = [];
  let from = 0;
  let quoted = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!;
    if (ch === "\\" && !quoted && i + 1 < code.length) {
      i++;
      continue;
    }
    if (ch === '"') quoted = !quoted;
    if (ch === ";" && !quoted) {
      sections.push(code.slice(from, i));
      from = i + 1;
    }
  }
  sections.push(code.slice(from));
  return sections;
};

/** Whether a section carries the text placeholder « @ » outside quotes and
 *  escapes: a TEXT section, never a number one. */
const hasTextPlaceholder = (section: string): boolean => {
  let quoted = false;
  for (let i = 0; i < section.length; i++) {
    const ch = section[i]!;
    if (ch === "\\" && !quoted) i++;
    else if (ch === '"') quoted = !quoted;
    else if (ch === "@" && !quoted) return true;
  }
  return false;
};

const holds = (value: number, condition: RegExpExecArray): boolean => {
  const threshold = Number(condition[2]);
  switch (condition[1]) {
    case "=":
      return value === threshold;
    case ">":
      return value > threshold;
    case "<":
      return value < threshold;
    case "<>":
      return value !== threshold;
    case ">=":
      return value >= threshold;
    default:
      return value <= threshold; // "<="
  }
};

/** The section index Excel displays `value` with: positive; negative;
 *  ZERO (revue HIGH 29/09, constat 7 — it was ignored); or, when the first
 *  two carry conditions (`[>=1000]`), the first whose condition holds, else
 *  the next one (SSF's `choose_fmt`). */
const selectSection = (sections: string[], value: number): number => {
  const first = CONDITION.exec(sections[0]!);
  const second = sections.length > 1 ? CONDITION.exec(sections[1]!) : null;
  if (first || second) {
    if (first && holds(value, first)) return 0;
    if (second && holds(value, second)) return 1;
    if (first && second) return sections.length > 2 ? 2 : -1;
    return sections.length > 1 ? 1 : 0;
  }
  if (value < 0 && sections.length > 1) return 1;
  if (value === 0 && sections.length > 2) return 2;
  return 0;
};

/** ECMA-376 §18.8.30 marks built-in id 14 with an asterisk: applications
 *  read it as the READING LANGUAGE's regional short date, not the fixed
 *  literal mask the standard writes out for the CODE (`mm-dd-yy`,
 *  `xlsx-cells.ts#BUILTIN_FORMATS`). DECIDED (Mikolaj, 29/09, replacing
 *  SheetJS's own id-14 table entry): read as the page's language
 *  (30/09/2026: `builtinFormat14`, US `m/d/yy` or French `dd/mm/yyyy`) — Microsoft's "Number format
 *  codes" support page marks the id `*`, regional-settings-dependent
 *  (https://support.microsoft.com/en-us/office/number-format-codes-5026bbd6-04bc-48cd-bf33-80f18b4eae68).
 *  The caller selects this BY ID (`SheetCell.builtinDate14`), never by
 *  matching this literal string against a resolved code. */
const BUILTIN_FORMAT_14_SHORT_DATE = "m/d/yy";
/** The French reading of id 14: Excel in French shows « jj/mm/aaaa »
 *  (Microsoft, « Codes de format de nombre »), `dd/mm/yyyy` in a code. */
const BUILTIN_FORMAT_14_SHORT_DATE_FR = "dd/mm/yyyy";
export const builtinFormat14 = (language: PageLanguage): string => (language === "fr" ? BUILTIN_FORMAT_14_SHORT_DATE_FR : BUILTIN_FORMAT_14_SHORT_DATE);

/** A code read once: its NUMBER sections — a trailing « @ » section of a
 *  two- or three-section code is the TEXT section, dropped (Microsoft, « How
 *  to control and understand settings in the Format Cells dialog box in
 *  Excel »: up to three sections for numbers and a fourth for text, « @ »
 *  being the text placeholder), so `0.00;@` shows a negative with section 0
 *  — and, per section, its colour-stripped text and tokens, computed on first
 *  use (`null`: not computed yet). */
interface ParsedCode {
  sections: string[];
  /** The ORIGINAL code had several sections (a dropped « @ » text section counts): an empty number section then hides. */
  multiSection: boolean;
  stripped: (string | undefined)[];
  tokens: (Token[] | undefined | null)[];
}

/** A module-level memo is acceptable: the parse is a PURE function of the
 *  code string (no clock, no randomness, no workbook state), so sharing it
 *  across workbooks changes nothing. A workbook has a few dozen distinct
 *  codes; the bound only guards a hostile file, and the memo is cleared when
 *  full (insertion order, deterministic). */
const MEMO_LIMIT = 512;
const memo = new Map<string, ParsedCode | undefined>();

const parseCode = (code: string): ParsedCode | undefined => {
  if (memo.has(code)) return memo.get(code);
  let parsed: ParsedCode | undefined;
  if (code.length <= MAX_FORMAT_CODE_CHARS) {
    let sections = splitSections(code);
    const multiSection = sections.length > 1;
    if (sections.length > 4) sections = [];
    else if ((sections.length === 2 || sections.length === 3) && hasTextPlaceholder(sections.at(-1)!)) sections = sections.slice(0, -1);
    if (sections.length > 0) parsed = { sections, multiSection, stripped: sections.map(() => undefined), tokens: sections.map(() => null) };
  }
  if (memo.size >= MEMO_LIMIT) memo.clear();
  memo.set(code, parsed);
  return parsed;
};

/** The long date of each page language, what `[$-F800]` stands for (« Wednesday, March 15, 2023 », « mercredi 15 mars 2023 »). */
const LONG_DATE: Record<PageLanguage, string> = { en: "dddd, mmmm d, yyyy", fr: "dddd d mmmm yyyy" };

/** The cell's display text, or `undefined` when the code is outside what
 *  we write (caller falls back to the raw value). */
export function formatNumberCell(value: number, code: string | undefined, date1904: boolean, language: PageLanguage = "en"): string | undefined {
  // A number under the text format « @ » displays as General in Excel.
  if (code === undefined || code === "General" || code === "@") return formatGeneral(value, language);
  const parsed = parseCode(code);
  if (parsed === undefined) return undefined;
  const { sections } = parsed;
  const index = selectSection(sections, value);
  if (index === -1) return undefined; // no section applies: Excel shows #####
  const section = sections[index]!;
  // An EMPTY matching section is the classic hide-in-place format (« ;;; »):
  // Excel displays NOTHING — publishing the raw value here breached the
  // data-exposure guard (revue HIGH 28/09 soir, constat 3). Empty only
  // counts as hiding when the code has several sections: a bare "" code
  // never reaches this function as a real format.
  if (section === "" && parsed.multiSection) return "";
  // With several sections, a negative value is written UNSIGNED: the
  // section carries its own minus sign (`\-…`), or the sign would double.
  const unsigned = value < 0 && sections.length > 1;
  const signed = unsigned ? Math.abs(value) : value;

  // « General » PRÉCÉDÉ D'UN PRÉFIXE DE LANGUE (`[$-1010409]General`, 138 cellules du corpus le 30/10/2026) : le crochet
  // dit la langue de LECTURE du classeur, dont nous ne tenons pas compte — la langue d'une page est celle du site —, et
  // le reste est le format par défaut. Sans ce chemin, la section ne tokenisait pas (un « G » n'est pas des nôtres) et
  // la cellule sortait en valeur brute.
  if (/^general$/i.test(section.replace(/\[[^\][]*\]/g, "").trim())) return formatGeneral(signed, language);

  parsed.stripped[index] ??= section.replace(/\[[^\][]*\]/g, (b) => (COLOUR.test(b.slice(1, -1)) ? "" : b));
  const fraction = writeFraction(Math.abs(signed), signed < 0 ? "-" : "", parsed.stripped[index]!);
  if (fraction !== undefined) return fraction;

  // `[$-F800]`: « the long date of the machine opening the file », unknowable here. DECIDED 06/11/2026 (Mikolaj), RETURNING the
  // 29/09 refusal: the cell is written as the long date in the PAGE language (chosen bias: a stand-in for the unknown setting,
  // written here). The raw value was a SERIAL NUMBER published in place of a date: worse than any approximation. The code
  // after the bracket is not read; it is only the fallback Excel stores beside the system setting.
  if (/^\[\$-F800\]/i.test(section)) {
    const long = tokenize(LONG_DATE[language]);
    return long === undefined ? undefined : writeDateTime(long, value, date1904, language);
  }
  if (parsed.tokens[index] === null) parsed.tokens[index] = tokenize(section);
  const tokens = parsed.tokens[index];
  if (tokens === undefined || tokens.every((t) => t.kind === "locale")) return undefined;
  if (tokens.some((t) => t.kind === "date" || TIME_KINDS.has(t.kind))) return writeDateTime(tokens, value, date1904, language);

  // A literal-only section (« "zéro" », « \- ») shows its text whatever the
  // number — the usual shape of a zero section.
  if (tokens.every((t) => t.kind === "literal" || t.kind === "locale")) return tokens.map((t) => (t.kind === "literal" ? t.text : "")).join("");
  if (tokens.some((t) => t.kind === "literal" && t.bare === true)) return undefined;
  const masks = tokens.filter((t) => t.kind === "mask");
  if (masks.length > 1) return writeSplitIntegerMask(tokens, signed, language);
  if (masks.length !== 1) return undefined;
  const exponent = tokens.find((t): t is Extract<Token, { kind: "exponent" }> => t.kind === "exponent");
  const percents = tokens.filter((t) => t.kind === "percent").length;
  if (exponent !== undefined && percents > 0) return undefined;
  const written = exponent !== undefined ? writeScientific(signed, masks[0]!.text, exponent, language) : writeNumber(signed * 100 ** percents, masks[0]!.text, language);
  if (written === undefined) return undefined;
  let out = "";
  for (const t of tokens) out += t.kind === "mask" ? written : t.kind === "literal" ? t.text : t.kind === "percent" ? "%" : "";
  return out;
}

/** The TEXT half of the hide-in-place formats (revue HIGH 28/09 soir,
 *  constat 3): a four-section code whose fourth (text) section is empty —
 *  « ;;; » being the classic — displays nothing for a text cell. */
export const hiddenTextFormat = (code: string | undefined): boolean => {
  if (code === undefined) return false;
  const sections = splitSections(code);
  return sections.length === 4 && sections[3] === "";
};
