/** Our number-format writer for spreadsheet cells: a stored number and its format code become the text a reader of the
 *  sheet sees, in the PAGE's language (`PageLanguage`, features/page-language.feature): English (`1,234.50`) or French
 *  (`1 234,50`, U+00A0 between thousands).
 *  Decides which codes we write: « General », numbers (grouping, scaling, zero padding), percentages, dates and times,
 *  scientific, fractions, currency and locale brackets, condition brackets that select a section. A locale written in a
 *  code (`[$-40C]`) governs the WORDS only (month and day names), never the separators. Any other code answers
 *  `undefined`: the caller keeps the raw value, nothing is invented. A trailing `@` section of a two- or three-section
 *  code is the TEXT section (numbers use the earlier ones); more than 30 decimals answers `undefined`, and so does a
 *  code longer than 1024 characters.
 *  NOT here: which cell carries which code (`xlsx-cells.ts`), the detection of the document language (`xlsx.ts`), nor
 *  where the page language comes from (the connection's `pageLanguage`).
 *  Called by: `extractor/xlsx.ts`, `extractor/pptx-reader/chart.ts`, `pipeline/source-reading-chart.ts`,
 *  `tools/bench/render.ts`. */

import { DAY_MS } from "../lib/clock";
import type { PageLanguage } from "doc-ir/lib/reader-types";

type Token =
  | { readonly kind: "mask"; readonly text: string }
  /** A locale written in the code (`[$-40C]`): zero width, words only. */
  | { readonly kind: "locale"; readonly words: PageLanguage }
  | { readonly kind: "literal"; readonly text: string; readonly isBare?: true }
  | { readonly kind: "percent" }
  | { readonly kind: "date"; readonly text: string }
  | { readonly kind: "minute"; readonly text: string }
  | { readonly kind: "hour"; readonly text: string }
  | { readonly kind: "second"; readonly text: string }
  | { readonly kind: "ampm"; readonly am: string; readonly pm: string }
  | { readonly kind: "elapsed"; readonly unit: "h" | "m" | "s"; readonly width: number }
  | { readonly kind: "exponent"; readonly sign: "+" | "-"; readonly digits: number }
  | { readonly kind: "subsecond"; readonly digits: number };

/** Colour tags: styling, never content. */
const COLOUR = /^(black|blue|cyan|green|magenta|red|white|yellow|color\s?\d{1,2})$/i;
/** A condition bracket, applied at section selection. */
const CONDITION = /\[(=|>=?|<[>=]?)(-?\d+(?:\.\d*)?)\]/;
/** `[$symbol-locale]`: the symbol shows; the locale (a hex LCID or a language
 *  label such as `fr-FR`) only chooses the WORDS of a date. The locale never touches the separators (our reading, no
 *  source found for more). Tried then dropped: the locale governing everything; the page language alone gives the
 *  separators. */
const CURRENCY = /^\$([^-]*)(?:-([0-9A-Za-z]+(?:-[0-9A-Za-z]+)*))?$/;
/** Hex locale ids that stand for the machine's date or time settings, not a language (`[$-F800]`, `[$-F400]`): we do not
 *  read them. `[$-F800]` is answered earlier, as the page language's long date (`formatNumberCell`, 06/11/2026); the
 *  others stay refused. */
const SYSTEM_LOCALE_IDS = new Set([0xf800, 0xf400]);
/** The primary language of a language id is its 10 low bits (MS-LCID):
 *  `0x0C` is French, whatever the region (040C fr-FR … 3C0C fr-HT). */
const FRENCH_PRIMARY_LANGUAGE = 0x0c;

/** The language of the WORDS a locale written in a code asks for. `null`: a
 *  locale we do not read (the system date, an `x-` extension) — the whole
 *  code then answers `undefined`. Anything that is not French is English. */
const readLocaleWords = (locale: string): PageLanguage | null => {
  if (/^[0-9A-Fa-f]+$/.test(locale)) {
    const languageId = parseInt(locale, 16);
    if (SYSTEM_LOCALE_IDS.has(languageId & 0xffff)) return null;
    return (languageId & 0x3ff) === FRENCH_PRIMARY_LANGUAGE ? "fr" : "en";
  }
  if (/^x(-|$)/i.test(locale)) return null;
  return /^fr(-|$)/i.test(locale) ? "fr" : "en";
};
const ELAPSED = /^(h+|m+|s+)$/i;
/** Most decimal places written (our bound): a mask asking for more answers `undefined` (the raw value) instead of
 *  growing the output with the code. */
const MAX_DECIMALS = 30;
/** Longest format code read at all — STARTING VALUE TO CALIBRATE. No
 *  Microsoft source was found for a code-length limit; 1024 is chosen far
 *  above any real code seen. It bounds by construction every part that grows
 *  with the code (integer padding, elapsed width, exponent digits): a longer
 *  code answers `undefined`, the raw value is published, no text is lost. */
const MAX_FORMAT_CODE_CHARS = 1024;

const isSecond = (token: Token | undefined): boolean =>
  token?.kind === "second" || (token?.kind === "elapsed" && token.unit === "s");

/** What a reader of one token answers: the position after it, or `undefined`
 *  when the whole section is a shape we do not treat. Each reader pushes its
 *  token(s) on `tokens` before answering. */
type TokenRead = number | undefined;

/** `"text"`: a literal. */
const readQuoted = (section: string, position: number, tokens: Token[]): TokenRead => {
  const end = section.indexOf('"', position + 1);
  if (end === -1) return undefined;
  tokens.push({ kind: "literal", text: section.slice(position + 1, end) });
  return end + 1;
};

/** `\x`: the next character, as a literal. */
const readEscaped = (section: string, position: number, tokens: Token[]): TokenRead => {
  if (position + 1 >= section.length) return undefined;
  tokens.push({ kind: "literal", text: section[position + 1]! });
  return position + 2;
};

/** `[$symbol-locale]`: the symbol is a literal, the locale a zero-width token. */
const pushCurrency = (currency: RegExpExecArray, tokens: Token[]): boolean => {
  if (currency[1]!.length > 0) tokens.push({ kind: "literal", text: currency[1]! });
  if (currency[2] !== undefined) {
    const words = readLocaleWords(currency[2]);
    if (words === null) return false;
    tokens.push({ kind: "locale", words });
  }
  return true;
};

/** `[...]`: a colour or a condition (styling), a currency/locale, or an
 *  elapsed-time unit; any other bracket is not ours. */
const readBracket = (section: string, position: number, tokens: Token[]): TokenRead => {
  const end = section.indexOf("]", position);
  if (end === -1) return undefined;
  const inner = section.slice(position + 1, end);
  const currency = CURRENCY.exec(inner);
  const elapsed = ELAPSED.exec(inner);
  // styling, or a condition already applied by `selectSection`
  if (COLOUR.test(inner) || CONDITION.test(`[${inner}]`)) return end + 1;
  if (currency) return pushCurrency(currency, tokens) ? end + 1 : undefined;
  if (elapsed) {
    tokens.push({ kind: "elapsed", unit: inner[0]!.toLowerCase() as "h" | "m" | "s", width: inner.length });
    return end + 1;
  }
  // Any other bracket (DBNum, locale-only calendars…) changes the display in a way we do not write: dropping it silently
  // would publish a wrong text, so the section is refused.
  return undefined;
};

/** `_x` and `*x` are alignment padding (a space the width of x; x repeated). We have no column to align: published as
 *  nothing (choice of 29/09/2026: no stray padding around the words; a text cell under the same format is published as
 *  its bare text too). */
const skipAlignment = (section: string, position: number): TokenRead =>
  position + 1 >= section.length ? undefined : position + 2;

/** A run of digit placeholders and separators (`#,##0.00`). */
const readMask = (section: string, position: number, tokens: Token[]): TokenRead => {
  let end = position;
  while (end < section.length && "#0?,.".includes(section[end]!)) end++;
  tokens.push({ kind: "mask", text: section.slice(position, end) });
  return end;
};

/** `E+00`, `e-0` right after a mask. */
const readExponent = (section: string, position: number, tokens: Token[]): TokenRead => {
  const exponent = /^[Ee]([+-])(0+)/.exec(section.slice(position));
  if (!exponent || tokens.at(-1)?.kind !== "mask") return undefined; // `e` alone, not after a mask, is not an exponent: not ours
  tokens.push({ kind: "exponent", sign: exponent[1] as "+" | "-", digits: exponent[2]!.length });
  return position + exponent[0].length;
};

/** A run of one date or time letter (`yyyy`, `mm`, `hh`, `s`). */
const readDateLetters = (section: string, position: number, letter: string, tokens: Token[]): TokenRead => {
  let end = position;
  while (end < section.length && section[end]!.toLowerCase() === letter) end++;
  const text = section.slice(position, end).toLowerCase();
  if ((letter === "h" || letter === "s") && text.length > 2) return undefined;
  if (letter === "h") tokens.push({ kind: "hour", text });
  else if (letter === "s") tokens.push({ kind: "second", text });
  else tokens.push({ kind: "date", text });
  return end;
};

/** `AM/PM` or `A/P`. */
const readAmPm = (section: string, position: number, tokens: Token[]): TokenRead => {
  if (section.slice(position, position + 5).toUpperCase() === "AM/PM") {
    tokens.push({ kind: "ampm", am: "AM", pm: "PM" });
    return position + 5;
  }
  if (section.slice(position, position + 3).toUpperCase() === "A/P") {
    tokens.push({ kind: "ampm", am: section[position]!, pm: section[position + 2]! });
    return position + 3;
  }
  return undefined;
};

/** Fractions of a second right after the seconds (`ss.00`, `[ss].000`). */
const readSubsecond = (section: string, position: number, tokens: Token[]): TokenRead => {
  let end = position + 1;
  while (end < section.length && section[end] === "0") end++;
  tokens.push({ kind: "subsecond", digits: end - position - 1 });
  return end;
};

/** Characters we write as themselves wherever they stand in a code. */
const SHOWN_AS_THEMSELVES = new Set(["/", " ", "-", ":", "$", "+", "(", ")"]);
/** The letters that open a date or time token. */
const DATE_TIME_LETTERS = new Set(["d", "m", "y", "h", "s"]);
/** The characters that open a digit mask. */
const MASK_OPENERS = new Set(["#", "0", "?"]);

/** What is left once the structural characters and the letters are ruled out:
 *  fractions of a second, characters shown as themselves, bare separators. */
const readPunctuation = (section: string, position: number, character: string, tokens: Token[]): TokenRead => {
  if (character === "." && /^\.0/.test(section.slice(position)) && isSecond(tokens.at(-1)))
    return readSubsecond(section, position, tokens);
  if (SHOWN_AS_THEMSELVES.has(character)) {
    tokens.push({ kind: "literal", text: character });
    return position + 1;
  }
  if (character === "." || character === ",") {
    // Outside a digit mask: a separator in a date (« d. mmmm, yyyy »),
    // meaningless in a number section — flagged so the number path refuses.
    tokens.push({ kind: "literal", text: character, isBare: true });
    return position + 1;
  }
  return undefined; // @, G, any other letter … : not ours
};

/** One token at `position`, pushed on `tokens`; the position after it, or `undefined`. */
const readToken = (section: string, position: number, tokens: Token[]): TokenRead => {
  const character = section[position]!;
  const lowercaseCharacter = character.toLowerCase();
  if (character === '"') return readQuoted(section, position, tokens);
  if (character === "\\") return readEscaped(section, position, tokens);
  if (character === "[") return readBracket(section, position, tokens);
  if (character === "_" || character === "*") return skipAlignment(section, position);
  if (MASK_OPENERS.has(character)) return readMask(section, position, tokens);
  if (lowercaseCharacter === "e") return readExponent(section, position, tokens);
  if (character === "%") {
    tokens.push({ kind: "percent" });
    return position + 1;
  }
  if (DATE_TIME_LETTERS.has(lowercaseCharacter)) return readDateLetters(section, position, lowercaseCharacter, tokens);
  if (lowercaseCharacter === "a") return readAmPm(section, position, tokens);
  return readPunctuation(section, position, character, tokens);
};

/** The token before (`step` -1) or after (+1) `from`, literals and locales skipped. */
const findMeaningfulNeighbour = (tokens: readonly Token[], from: number, step: 1 | -1): Token | undefined => {
  for (let neighbourIndex = from + step; neighbourIndex >= 0 && neighbourIndex < tokens.length; neighbourIndex += step)
    if (tokens[neighbourIndex]!.kind !== "literal" && tokens[neighbourIndex]!.kind !== "locale")
      return tokens[neighbourIndex];
  return undefined;
};

/** We read `m`/`mm` as MINUTES right after an hour or right before a second (literals between do not count), as months
 *  otherwise. */
const resolveMinutes = (tokens: readonly Token[]): Token[] =>
  tokens.map((token, tokenIndex) => {
    if (token.kind !== "date" || (token.text !== "m" && token.text !== "mm")) return token;
    const before = findMeaningfulNeighbour(tokens, tokenIndex, -1);
    const after = findMeaningfulNeighbour(tokens, tokenIndex, 1);
    const afterHour = before?.kind === "hour" || (before?.kind === "elapsed" && before.unit === "h");
    const beforeSecond = after?.kind === "second" || (after?.kind === "elapsed" && after.unit === "s");
    return afterHour || beforeSecond ? { kind: "minute", text: token.text } : token;
  });

/** Splits one SECTION into tokens; undefined = a shape we do not treat. */
const tokenize = (section: string): Token[] | undefined => {
  const tokens: Token[] = [];
  let position = 0;
  while (position < section.length) {
    const next = readToken(section, position, tokens);
    if (next === undefined) return undefined;
    position = next;
  }
  return resolveMinutes(tokens);
};

/** The last day number we write as a date, 9999-12-31; above it the raw value is kept. */
const LAST_DISPLAYABLE_DAY = 2_958_465;

/** Day number of the 1900 date system → UTC date, honouring the fictitious 1900-02-29 (§18.17.4.1): days 1..59 are the
 *  real calendar, day 60 is the fictitious day, and every day after it is numbered one higher than the real calendar. */
const dateOfDays = (days: number): Date | undefined => {
  if (days < 1 || days > LAST_DISPLAYABLE_DAY) return undefined; // before day 1 or past 9999-12-31: no display
  const adjusted = days >= 60 ? days - 1 : days; // skip the fictitious 29/02/1900
  const date = new Date(Date.UTC(1899, 11, 31) + adjusted * DAY_MS);
  return Number.isNaN(date.getTime()) ? undefined : date; // not finite: no display
};

/** The page language's separators (decided Q3, 30/09/2026: the French thousands separator is the NO-BREAK space U+00A0;
 *  its effect on Confluence search is not measured). */
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
  return integer.slice(0, from) + [...groups].reverse().join(separator);
};

/** A run of decimal digits plus one, carrying right to left; a carry out of the leftmost digit adds a leading `1`. */
const incrementDigits = (digits: string): string => {
  const incremented = digits.split("");
  let digitIndex = incremented.length - 1;
  while (digitIndex >= 0 && incremented[digitIndex] === "9") incremented[digitIndex--] = "0";
  if (digitIndex >= 0) incremented[digitIndex] = String(Number(incremented[digitIndex]) + 1);
  else incremented.unshift("1");
  return incremented.join("");
};

/** `absoluteValue` (≥ 0) rounded to `decimals` places, half AWAY from zero on its DECIMAL reading, the 15 significant
 *  digits (`toExponential(14)`): `toFixed` rounds the binary double, so 1.005 (stored 1.00499…) would give « 1.00 »
 *  where the decimal reading gives « 1.01 ». Returns [integer digits, fraction digits]. */
const roundDecimal = (absoluteValue: number, decimals: number): [string, string] => {
  const [mantissa = "0", exponent = "0"] = absoluteValue.toExponential(14).split("e");
  const digits = mantissa.replace(".", "");
  const keep = Number(exponent) + 1 + decimals; // digits left of the cut
  let kept: string;
  if (keep < 0) kept = "0";
  else if (keep >= digits.length) kept = digits + "0".repeat(keep - digits.length);
  else {
    kept = digits.slice(0, keep) || "0";
    if (digits[keep]! >= "5") kept = incrementDigits(kept);
  }
  const padded = kept.padStart(decimals + 1, "0");
  const integer = padded.slice(0, padded.length - decimals).replace(/^0+(?=\d)/, "");
  return [integer, padded.slice(padded.length - decimals)];
};

// The run of trailing commas is counted by hand, from the end: `/,+$/` is quadratic on a long run (the sonarjs ratchet
// refused it), and a format code is text the document chooses.
const countTrailingCommas = (mask: string): number => {
  let count = 0;
  while (count < mask.length && mask[mask.length - 1 - count] === ",") count++;
  return count;
};

const writeNumber = (value: number, signedMask: string, language: PageLanguage): string | undefined => {
  // THE SCALING COMMA (written 30/10/2026): we divide the value by 1000 for each comma AFTER the last digit placeholder. It
  // was REFUSED before, rightly: writing it as plain grouping published figures 1000× the displayed value. Only a run at the
  // very END of the mask scales: a comma anywhere else that is not followed by a digit placeholder stays unknown, and
  // unknown is still `undefined`.
  // A NON-FINITE VALUE IS NOT WRITTEN (security review 30/10/2026). `%` repeated 200 times overflows the multiplication to
  // `Infinity`, and the decimal rounding produced the STRING « NaN », published as is in a cell. A format code is text the
  // DOCUMENT chooses: it does not decide what we display.
  if (!Number.isFinite(value)) return undefined;
  const scale = countTrailingCommas(signedMask);
  const mask = scale === 0 ? signedMask : signedMask.slice(0, -scale);
  if (/,(?![#0])/.test(mask)) return undefined;
  const scaledValue = value / 1000 ** scale;
  const isGrouped = mask.includes(",");
  if (isGrouped && mask.includes("?")) return undefined; // grouping over space-padded digits: not ours
  const dot = mask.indexOf(".");
  const decimals = dot === -1 ? 0 : mask.length - dot - 1;
  const fractionMask = dot === -1 ? "" : mask.slice(dot + 1);
  if (dot !== -1 && !/^[#0?]+$/.test(fractionMask)) return undefined;
  if (decimals > MAX_DECIMALS) return undefined;
  const [rounded, fraction] = roundDecimal(Math.abs(scaledValue), decimals);
  // A '#'-only integer mask writes NOTHING for a zero integer part (« # » on 0 is blank, « #,##0 » shows 0).
  const integerMask = dot === -1 ? mask : mask.slice(0, dot);
  let integer = rounded === "0" && !integerMask.includes("0") ? "" : rounded;
  // Placeholders beyond the digits: `0` is written as a zero ((000) on 12 → (012)), `?` as a space, `#` as nothing, on the
  // left of the integer and for the trailing zeros of the decimals.
  const placeholders = integerMask.replaceAll(",", "");
  if (integer.length < placeholders.length) {
    integer =
      placeholders
        .slice(0, placeholders.length - integer.length)
        .replaceAll("#", "")
        .replaceAll("?", " ") + integer;
  }
  const decimalsOut = fraction.split("");
  for (
    let decimalIndex = decimalsOut.length - 1;
    decimalIndex >= 0 && decimalsOut[decimalIndex] === "0" && fractionMask[decimalIndex] !== "0";
    decimalIndex--
  )
    decimalsOut[decimalIndex] = fractionMask[decimalIndex] === "?" ? " " : "";
  const { thousands, decimal } = SEPARATORS[language];
  const written =
    (isGrouped ? groupThousands(integer, thousands) : integer) +
    (decimals > 0 ? `${decimal}${decimalsOut.join("")}` : "");
  return scaledValue < 0 ? `-${written}` : written;
};

/** An integer mask cut by escaped literals, `#\ ##0`: the digits fill the placeholders from the right, a literal stays
 *  where the code puts it, and digits beyond the placeholders pile up in the leftmost one (1234567 → « 1234 567 », not a
 *  regrouping). Decided 06/11/2026: the cell is written, no longer left as its raw value. Integer placeholders only; any
 *  other shape answers `undefined`. */
const writeSplitIntegerMask = (tokens: readonly Token[], value: number, language: PageLanguage): string | undefined => {
  if (
    !tokens.every(
      (token) =>
        token.kind === "locale" || token.kind === "literal" || (token.kind === "mask" && /^[#0?]+$/.test(token.text)),
    )
  )
    return undefined;
  const whole = writeNumber(
    Math.abs(value),
    tokens.map((token) => (token.kind === "mask" ? token.text : "")).join(""),
    language,
  );
  if (whole === undefined) return undefined;
  let digits = whole;
  let written = "";
  for (let tokenIndex = tokens.length - 1; tokenIndex >= 0; tokenIndex--) {
    const token = tokens[tokenIndex]!;
    if (token.kind === "literal") written = token.text + written;
    else if (token.kind === "mask") {
      const isLeftmost = !tokens.slice(0, tokenIndex).some((earlier) => earlier.kind === "mask");
      const take = isLeftmost ? digits.length : Math.min(token.text.length, digits.length);
      written = digits.slice(digits.length - take) + written;
      digits = digits.slice(0, digits.length - take);
    }
  }
  return value < 0 ? `-${written}` : written;
};

/** `0.00E+00`, and engineering `##0.0E+0` (built-in id 48, §18.8.30): n integer placeholders make the exponent a
 *  multiple of n and the mantissa 1 to n digits (`#0.0E+0` on 12,200,000 → `12.2E+6`). Zeros only after the point. Same
 *  decimal rounding. */
const writeScientific = (
  value: number,
  mask: string,
  exponent: Extract<Token, { kind: "exponent" }>,
  language: PageLanguage,
): string | undefined => {
  if (!Number.isFinite(value)) return undefined; // same reason as in `writeNumber`: never « NaN » in a cell
  if (!/^[#0]+(\.0*)?$/.test(mask)) return undefined;
  const dot = mask.indexOf(".");
  const step = dot === -1 ? mask.length : dot;
  const decimals = dot === -1 ? 0 : mask.length - dot - 1;
  if (decimals > MAX_DECIMALS) return undefined;
  let power = 0;
  let integer = "0";
  let fraction = "0".repeat(decimals);
  if (value !== 0) {
    const [mantissaText = "0", exponentText = "0"] = Math.abs(value).toExponential(14).split("e");
    power = Math.floor(Number(exponentText) / step) * step;
    [integer, fraction] = roundDecimal(Number(mantissaText) * 10 ** (Number(exponentText) - power), decimals);
    if (integer.length > step) {
      // Rounding reached 10^step (999.96 → 1000.0): next exponent step.
      power += step;
      [integer, fraction] = roundDecimal(Number(`${integer}.${fraction}`) / 10 ** step, decimals);
    }
  }
  let sign = "";
  if (power < 0) sign = "-";
  else if (exponent.sign === "+") sign = "+";
  const mantissa = integer + (decimals > 0 ? `${SEPARATORS[language].decimal}${fraction}` : "");
  return `${value < 0 ? "-" : ""}${mantissa}E${sign}${String(Math.abs(power)).padStart(exponent.digits, "0")}`;
};

/** Best rational approximation with a denominator ≤ `maxDenominator` (continued fractions, after SheetJS SSF's
 *  `SSF_frac`, Apache-2.0). Returns [whole, numerator, denominator] of the absolute value, the whole part split off when
 *  `isMixed`. */
const approximate = (absoluteValue: number, maxDenominator: number, isMixed: boolean): [number, number, number] => {
  // `p`/`q` are the numerator and denominator of the current convergent of the continued fraction, `p1`/`q1` and
  // `p2`/`q2` the two before it: the usual terms of that method.
  let remainder = absoluteValue;
  let p2 = 0;
  let p1 = 1;
  let p = 0;
  let q2 = 1;
  let q1 = 0;
  let q = 0;
  while (q1 < maxDenominator) {
    const integerPart = Math.floor(remainder);
    p = integerPart * p1 + p2;
    q = integerPart * q1 + q2;
    if (remainder - integerPart < 0.00000005) break;
    remainder = 1 / (remainder - integerPart);
    p2 = p1;
    p1 = p;
    q2 = q1;
    q1 = q;
  }
  if (q > maxDenominator) {
    if (q1 > maxDenominator) {
      q = q2;
      p = p2;
    } else {
      q = q1;
      p = p1;
    }
  }
  if (!isMixed) return [0, p, q];
  const whole = Math.floor(p / q);
  return [whole, p - whole * q, q];
};

/** Fractions: `# ?/?`, `# ??/??` (denominator up to 9, 99…), `# ?/4` (a
 *  fixed denominator, never reduced), `?/?` (no whole part). The `?`
 *  placeholders pad with spaces. */
const writeFraction = (absoluteValue: number, sign: string, section: string): string | undefined => {
  const shape = /^(?:(#+|0+) )?(\?+)\/(\?+|\d+)$/.exec(section);
  if (!shape) return undefined;
  const whole = shape[1];
  const numerator = shape[2]!;
  const denominator = shape[3]!;
  if (/^\d+$/.test(denominator)) {
    if (whole === undefined) return undefined;
    const fixedDenominator = Number(denominator);
    if (fixedDenominator === 0) return undefined;
    const scaled = Math.round(absoluteValue * fixedDenominator);
    const base = Math.floor(scaled / fixedDenominator);
    const numeratorValue = scaled - base * fixedDenominator;
    return `${sign}${base === 0 ? "" : base} ${numeratorValue === 0 ? " ".repeat(numerator.length + 1 + denominator.length) : `${String(numeratorValue).padStart(numerator.length, " ")}/${denominator}`}`;
  }
  if (whole === undefined) {
    const width = Math.min(denominator.length, 7);
    const [, numeratorValue, denominatorValue] = approximate(absoluteValue, 10 ** width - 1, false);
    return `${sign}${String(numeratorValue).padStart(numerator.length, " ")}/${String(denominatorValue).padEnd(width, " ")}`;
  }
  const width = Math.min(Math.max(numerator.length, denominator.length), 7);
  const [base, numeratorValue, denominatorValue] = approximate(absoluteValue, 10 ** width - 1, true);
  let head = "0";
  if (base !== 0) head = String(base);
  else if (numeratorValue !== 0) head = "";
  return `${sign}${head} ${numeratorValue !== 0 ? `${String(numeratorValue).padStart(width, " ")}/${String(denominatorValue).padEnd(width, " ")}` : " ".repeat(2 * width + 1)}`;
};

/** Month and day names per language: full, then abbreviated. French names are lowercase, points included, and an
 *  abbreviation is never a slice of the full name (« janv. », not « jan »). */
interface Names {
  readonly months: readonly string[];
  readonly monthsShort: readonly string[];
  readonly days: readonly string[];
  readonly daysShort: readonly string[];
}
const NAMES: Record<PageLanguage, Names> = {
  en: {
    months: [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ],
    monthsShort: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
    days: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
    daysShort: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  },
  fr: {
    months: [
      "janvier",
      "février",
      "mars",
      "avril",
      "mai",
      "juin",
      "juillet",
      "août",
      "septembre",
      "octobre",
      "novembre",
      "décembre",
    ],
    monthsShort: ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."],
    days: ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"],
    daysShort: ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."],
  },
};
const padToTwoDigits = (value: number): string => String(value).padStart(2, "0");
const TIME_KINDS: ReadonlySet<Token["kind"]> = new Set(["hour", "minute", "second", "ampm", "elapsed", "subsecond"]);

/** What every token of one value is written from. */
interface DateTimeContext {
  /** Day number of the date system (carry of the rounded time included). */
  readonly days: number;
  readonly secondOfDay: number;
  readonly hour: number;
  /** Seconds since the serial's zero, for the elapsed units. */
  readonly totalSeconds: number;
  /** The shown fraction of a second, zero-padded to its digits. */
  readonly subsecond: string;
  readonly isTwelveHour: boolean;
  /** Present exactly when a token asks for a date part. */
  readonly date: Date | undefined;
  readonly names: Names;
  readonly language: PageLanguage;
}

/** The value split into days and clock parts, once for all its tokens. With
 *  a time on show, the value is read to the nearest second — or to the shown
 *  fraction of a second (`ss.00`, at most 3 digits, our bound) — a
 *  carry can reach the next day; a pure DATE format shows the date part
 *  (a datetime is not refused).
 *  `undefined`: more than 3 digits of a second, or a date part that has no
 *  date (before day 1 or past the last date we write, 9999-12-31), or a time too
 *  large to count. Huge elapsed `[h]` values: past 2^53 ticks the value cannot
 *  be counted exactly, so the raw value is kept. */
const dateTimeContextOf = (
  tokens: readonly Token[],
  value: number,
  date1904: boolean,
  names: Names,
  language: PageLanguage,
): DateTimeContext | undefined => {
  const serial = date1904 ? value + 1462 : value;
  const hasTime = tokens.some((token) => TIME_KINDS.has(token.kind));
  const subsecondDigits =
    tokens.find((token): token is Extract<Token, { kind: "subsecond" }> => token.kind === "subsecond")?.digits ?? 0;
  if (subsecondDigits > 3) return undefined;
  const ticksPerSecond = 10 ** subsecondDigits;
  const totalTicks = hasTime ? Math.round(value * 86_400 * ticksPerSecond) : 0;
  if (!Number.isSafeInteger(totalTicks)) return undefined; // too large (or not finite) to count exactly: no display
  const totalSeconds = Math.floor(totalTicks / ticksPerSecond);
  const subsecond = String(totalTicks - totalSeconds * ticksPerSecond).padStart(subsecondDigits, "0");
  const secondsSinceSerialZero = date1904 ? totalSeconds + 1462 * 86_400 : totalSeconds;
  const days = hasTime ? Math.floor(secondsSinceSerialZero / 86_400) : Math.floor(serial);
  const secondOfDay = totalSeconds % 86_400;
  const isTwelveHour = tokens.some((token) => token.kind === "ampm");
  const hasDateToken = tokens.some((token) => token.kind === "date");
  const date = hasDateToken ? dateOfDays(days) : undefined;
  if (hasDateToken && date === undefined) return undefined;
  return {
    days,
    secondOfDay,
    hour: Math.floor(secondOfDay / 3600),
    totalSeconds,
    subsecond,
    isTwelveHour,
    date,
    names,
    language,
  };
};

/** A clock number: two digits when the token is two letters wide. */
const writeClockNumber = (text: string, value: number): string =>
  text.length === 2 ? padToTwoDigits(value) : String(value);

const writeElapsed = (token: Extract<Token, { kind: "elapsed" }>, totalSeconds: number): string => {
  let total = totalSeconds;
  if (token.unit === "h") total = Math.floor(totalSeconds / 3600);
  else if (token.unit === "m") total = Math.floor(totalSeconds / 60);
  return String(total).padStart(token.width, "0");
};

/** `m` run: 1-2 letters a number, 3 the short name, 5 the initial, else the full name. */
const writeMonth = (month: number, letterCount: number, names: Names): string => {
  if (letterCount === 1) return String(month + 1);
  if (letterCount === 2) return padToTwoDigits(month + 1);
  if (letterCount === 3) return names.monthsShort[month]!;
  return letterCount === 5 ? names.months[month]![0]!.toUpperCase() : names.months[month]!;
};

/** `d` run: 1-2 letters the day of the month, 3 the short weekday, else the full one. */
const writeDay = (date: Date, days: number, letterCount: number, names: Names): string => {
  if (letterCount === 1) return String(date.getUTCDate());
  if (letterCount === 2) return padToTwoDigits(date.getUTCDate());
  // We follow the 1900 date system's weekdays: day 1 is a Sunday, so before the fictitious 29/02 (day 60) the weekday sits
  // one lower than the real calendar's.
  const weekday = days < 60 ? (date.getUTCDay() + 6) % 7 : date.getUTCDay();
  return letterCount === 3 ? names.daysShort[weekday]! : names.days[weekday]!;
};

/** A `d`, `m` or `y` run: its width picks number, short name or full name. */
const writeDateToken = (text: string, date: Date, days: number, names: Names): string => {
  const letter = text[0];
  const letterCount = text.length;
  if (letter === "y")
    return letterCount <= 2
      ? padToTwoDigits(date.getUTCFullYear() % 100)
      : String(date.getUTCFullYear() % 10_000).padStart(4, "0");
  if (letter === "m") return writeMonth(date.getUTCMonth(), letterCount, names);
  return writeDay(date, days, letterCount, names);
};

/** The text of one token; `null`: a token that has no place in a date. */
const writeDateTimeToken = (token: Token, context: DateTimeContext): string | null => {
  switch (token.kind) {
    case "literal":
      return token.text;
    case "locale":
      return "";
    case "hour":
      return writeClockNumber(token.text, context.isTwelveHour ? 1 + ((context.hour + 11) % 12) : context.hour);
    case "minute":
      return writeClockNumber(token.text, Math.floor(context.secondOfDay / 60) % 60);
    case "second":
      return writeClockNumber(token.text, context.secondOfDay % 60);
    case "ampm":
      return context.hour >= 12 ? token.pm : token.am;
    case "subsecond":
      return `${SEPARATORS[context.language].decimal}${context.subsecond}`;
    case "elapsed":
      return writeElapsed(token, context.totalSeconds);
    case "date":
      return writeDateToken(token.text, context.date!, context.days, context.names);
    case "mask":
    case "percent":
    case "exponent":
      return null; // a digit mask, a percent or an exponent inside a date: not ours
    default:
      // Exhaustive: `token` is `never`, so a new token kind does not compile until it is handled above. Only
      // `readToken` and `resolveMinutes` build tokens, and they build the kinds above.
      throw new Error("writeDateTimeToken: a token of an unknown kind");
  }
};

/** Dates and times. A negative value is not written as a date or time, in either date system: `undefined` keeps the raw
 *  value, our rule for what we cannot write faithfully. */
const writeDateTime = (
  tokens: readonly Token[],
  value: number,
  date1904: boolean,
  language: PageLanguage,
): string | undefined => {
  if (value < 0) return undefined;
  // The words follow a locale written in the code, else the page language.
  const locale = tokens.filter((token): token is Extract<Token, { kind: "locale" }> => token.kind === "locale").at(-1);
  const names = NAMES[locale?.words ?? language];
  const context = dateTimeContextOf(tokens, value, date1904, names, language);
  if (context === undefined) return undefined;
  let written = "";
  for (const token of tokens) {
    const piece = writeDateTimeToken(token, context);
    if (piece === null) return undefined;
    written += piece;
  }
  return written;
};

/** A decimal text without its trailing zeros (`1.500` → `1.5`, `2.000` → `2`). */
const trimDecimal = (text: string): string =>
  text.includes(".") ? text.replace(/(?:\.0*|(\.\d*[1-9])0+)$/, "$1") : text;
/** An `E` form with its mantissa trimmed and its exponent written with at least two digits. */
const normalizeExponent = (text: string): string =>
  text.includes("E")
    ? text
        .replace(/(?:\.0*|(\.\d*[1-9])0+)E/, "$1E")
        .replace(/(E[+-])(\d)$/, (_whole, sign: string, digit: string) => `${sign}0${digit}`)
    : text;
/** « General » for a number: at most 11 characters (12 with a minus sign), trailing zeros trimmed, scientific notation
 *  past that width (`String(v)` would publish 0.30000000000000004 and 1e+21). Ported from SheetJS SSF's
 *  `SSF_general_num` (Apache-2.0): 1/3 gives 0.333333333, 123456789012 gives 1.23457E+11. */
export const formatGeneralNumber = (value: number, language: PageLanguage = "en"): string => {
  const written = writeGeneralDigits(value);
  return language === "en" ? written : written.replace(".", SEPARATORS[language].decimal);
};
const writeGeneralDigits = (value: number): string => {
  if (Number.isInteger(value) && Math.abs(value) <= 2_147_483_647) return String(value === 0 ? 0 : value);
  if (!Number.isFinite(value)) return String(value); // reached only by a direct call with a non-finite value: every product caller checks finiteness first
  const width = value < 0 ? 12 : 11;
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  return trimDecimal(normalizeExponent(writeGeneralText(value, width, magnitude).toUpperCase()));
};
/** The digits of « General » before the common clean-up, by decade of the value; `width` is the column width in characters. */
const writeGeneralText = (value: number, width: number, magnitude: number): string => {
  if (magnitude >= -4 && magnitude <= -1) return value.toPrecision(10 + magnitude);
  if (Math.abs(magnitude) <= 9) {
    const fixed = trimDecimal(value.toFixed(12));
    if (fixed.length <= width) return fixed;
    const precise = value.toPrecision(10);
    return precise.length > width ? value.toExponential(5) : precise;
  }
  if (magnitude === 10) return value.toFixed(10).slice(0, 12);
  const fixed = trimDecimal(value.toFixed(11));
  return fixed.length > width || fixed === "0" || fixed === "-0" ? value.toPrecision(6) : fixed;
};

/** A code's sections, split on `;` outside quotes and escapes. */
const splitSections = (code: string): string[] => {
  const sections: string[] = [];
  let from = 0;
  let isQuoted = false;
  for (let position = 0; position < code.length; position++) {
    const character = code[position]!;
    if (character === "\\" && !isQuoted && position + 1 < code.length) {
      position++;
      continue;
    }
    if (character === '"') isQuoted = !isQuoted;
    if (character === ";" && !isQuoted) {
      sections.push(code.slice(from, position));
      from = position + 1;
    }
  }
  sections.push(code.slice(from));
  return sections;
};

/** Whether a section carries the text placeholder « @ » outside quotes and
 *  escapes: a TEXT section, never a number one. */
const hasTextPlaceholder = (section: string): boolean => {
  let isQuoted = false;
  for (let position = 0; position < section.length; position++) {
    const character = section[position]!;
    if (character === "\\" && !isQuoted) position++;
    else if (character === '"') isQuoted = !isQuoted;
    else if (character === "@" && !isQuoted) return true;
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

/** The index of the section that writes `value`: positive; negative; zero; or, when the first two carry conditions
 *  (`[>=1000]`), the first whose condition holds, else the next one (after SheetJS SSF's `choose_fmt`). */
const selectSection = (sections: readonly string[], value: number): number => {
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

/** Built-in id 14 (§18.8.30) is written as the short date of the page language, not as the fixed literal mask the
 *  standard lists for its code (`mm-dd-yy`, `xlsx-cells.ts#BUILTIN_FORMATS`). Our decision (29/09/2026; 30/09/2026:
 *  `selectBuiltinNumFmt14`, US `m/d/yy` or French `dd/mm/yyyy`). The caller selects this BY ID (`WorksheetCell.isBuiltinNumFmt14`),
 *  never by matching this literal string against a resolved code. */
const BUILTIN_FORMAT_14_SHORT_DATE = "m/d/yy";
/** The French short date of id 14, `dd/mm/yyyy` in a code. */
const BUILTIN_FORMAT_14_SHORT_DATE_FR = "dd/mm/yyyy";
export const selectBuiltinNumFmt14 = (language: PageLanguage): string =>
  language === "fr" ? BUILTIN_FORMAT_14_SHORT_DATE_FR : BUILTIN_FORMAT_14_SHORT_DATE;

/** A code read once: its NUMBER sections — a trailing « @ » section of a two- or three-section code is the TEXT section,
 *  dropped, so `0.00;@` writes a negative with section 0 — and, per section, its colour-stripped text and tokens,
 *  computed on first use (`null`: not computed yet). */
interface ParsedCode {
  readonly sections: readonly string[];
  /** The ORIGINAL code had several sections (a dropped « @ » text section counts): an empty number section then hides. */
  readonly hasSeveralSections: boolean;
  stripped: (string | undefined)[];
  tokens: (Token[] | undefined | null)[];
}

/** A module-level memo is acceptable: the parse is a PURE function of the
 *  code string (no clock, no randomness, no workbook state), so sharing it
 *  across workbooks changes nothing. A workbook has a few dozen distinct
 *  codes; the bound only guards a hostile file, and the memo is cleared when
 *  full (insertion order, deterministic). */
const MEMO_LIMIT = 512;
const parsedCodeMemo = new Map<string, ParsedCode | undefined>();

const parseCode = (code: string): ParsedCode | undefined => {
  if (parsedCodeMemo.has(code)) return parsedCodeMemo.get(code);
  const parsed = code.length <= MAX_FORMAT_CODE_CHARS ? parseSections(code) : undefined;
  if (parsedCodeMemo.size >= MEMO_LIMIT) parsedCodeMemo.clear();
  parsedCodeMemo.set(code, parsed);
  return parsed;
};

/** The number sections of a code of acceptable length; `undefined` for more than four sections. */
const parseSections = (code: string): ParsedCode | undefined => {
  const allSections = splitSections(code);
  const hasSeveralSections = allSections.length > 1;
  if (allSections.length > 4) return undefined;
  const hasTextSection =
    (allSections.length === 2 || allSections.length === 3) && hasTextPlaceholder(allSections.at(-1)!);
  const sections = hasTextSection ? allSections.slice(0, -1) : allSections;
  return { sections, hasSeveralSections, stripped: sections.map(() => undefined), tokens: sections.map(() => null) };
};

/** The long date of each page language, what `[$-F800]` stands for (« Wednesday, March 15, 2023 », « mercredi 15 mars 2023 »). */
const LONG_DATE: Record<PageLanguage, string> = { en: "dddd, mmmm d, yyyy", fr: "dddd d mmmm yyyy" };

/** The cell's display text, or `undefined` when the code is outside what
 *  we write (caller falls back to the raw value). */
export function formatNumberCell(
  value: number,
  code: string | undefined,
  date1904: boolean,
  language: PageLanguage = "en",
): string | undefined {
  // A number under the text format « @ » is written as General.
  if (code === undefined || code === "General" || code === "@") return formatGeneralNumber(value, language);
  const parsed = parseCode(code);
  if (parsed === undefined) return undefined;
  const { sections } = parsed;
  const index = selectSection(sections, value);
  if (index === -1) return undefined; // no section applies: the raw value is kept
  const section = sections[index]!;
  // An EMPTY matching section is the hide-in-place format (« ;;; »): we write nothing, since publishing the raw value would
  // expose what the author chose to hide. Empty only counts as hiding when the code has several sections: a bare "" code
  // never reaches this function as a real format.
  if (section === "" && parsed.hasSeveralSections) return "";
  // With several sections, a negative value is written UNSIGNED: the
  // section carries its own minus sign (`\-…`), or the sign would double.
  const isWrittenUnsigned = value < 0 && sections.length > 1;
  const signed = isWrittenUnsigned ? Math.abs(value) : value;

  // « General » PRECEDED BY A LANGUAGE PREFIX (`[$-1010409]General`, 30/10/2026): the bracket names a language, which we
  // ignore (a page's language is the site's), and the rest is the default format. Without this path the section did not
  // tokenise (a « G » is not ours) and the cell came out as its raw value.
  if (/^general$/i.test(section.replace(/\[[^\][]*\]/g, "").trim())) return formatGeneralNumber(signed, language);

  parsed.stripped[index] ??= section.replace(/\[[^\][]*\]/g, (bracket) =>
    COLOUR.test(bracket.slice(1, -1)) ? "" : bracket,
  );
  const fraction = writeFraction(Math.abs(signed), signed < 0 ? "-" : "", parsed.stripped[index]);
  if (fraction !== undefined) return fraction;

  // `[$-F800]`: « the long date of the machine opening the file », unknowable here. DECIDED 06/11/2026, RETURNING the
  // 29/09 refusal: the cell is written as the long date in the PAGE language (chosen bias: a stand-in for the unknown setting,
  // written here). The raw value was a SERIAL NUMBER published in place of a date: worse than any approximation. The code
  // after the bracket is not read.
  if (/^\[\$-F800\]/i.test(section)) {
    const longDate = tokenize(LONG_DATE[language]);
    return longDate === undefined ? undefined : writeDateTime(longDate, value, date1904, language);
  }
  if (parsed.tokens[index] === null) parsed.tokens[index] = tokenize(section);
  const tokens = parsed.tokens[index];
  if (tokens === undefined) return undefined;
  return writeTokens(tokens, value, signed, date1904, language);
}

/** The text of a number written by the tokens of its section; `value` is the stored number, `signed` the number the section shows (unsigned when the section carries its own minus). */
const writeTokens = (
  tokens: readonly Token[],
  value: number,
  signed: number,
  date1904: boolean,
  language: PageLanguage,
): string | undefined => {
  if (tokens.every((token) => token.kind === "locale")) return undefined;
  if (tokens.some((token) => token.kind === "date" || TIME_KINDS.has(token.kind)))
    return writeDateTime(tokens, value, date1904, language);

  // A literal-only section (« "zéro" », « \- ») shows its text whatever the number.
  if (tokens.every((token) => token.kind === "literal" || token.kind === "locale"))
    return tokens.map((token) => (token.kind === "literal" ? token.text : "")).join("");
  if (tokens.some((token) => token.kind === "literal" && token.isBare === true)) return undefined;
  const masks = tokens.filter((token) => token.kind === "mask");
  if (masks.length > 1) return writeSplitIntegerMask(tokens, signed, language);
  if (masks.length !== 1) return undefined;
  const exponent = tokens.find((token): token is Extract<Token, { kind: "exponent" }> => token.kind === "exponent");
  const percentCount = tokens.filter((token) => token.kind === "percent").length;
  if (exponent !== undefined && percentCount > 0) return undefined;
  const written =
    exponent !== undefined
      ? writeScientific(signed, masks[0]!.text, exponent, language)
      : writeNumber(signed * 100 ** percentCount, masks[0]!.text, language);
  if (written === undefined) return undefined;
  let text = "";
  for (const token of tokens) {
    if (token.kind === "mask") text += written;
    else if (token.kind === "literal") text += token.text;
    else if (token.kind === "percent") text += "%";
  }
  return text;
};

/** The TEXT half of the hide-in-place formats: a four-section code whose fourth (text) section is empty (« ;;; » being
 *  the classic) is written empty for a text cell. */
export const isHiddenTextFormatCode = (code: string | undefined): boolean => {
  if (code === undefined) return false;
  const sections = splitSections(code);
  return sections.length === 4 && sections[3] === "";
};
