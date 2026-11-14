/** The time the readers may touch: the `Clock` port (the ONLY source of time outside `adapters/` and `sim/`, determinism rule,
 *  CLAUDE.md — a reader that needs the time is GIVEN one) and the two lengths a spreadsheet date and a time budget are counted in.
 *  `core/clock.ts` re-exports all three: the app keeps ONE definition, at this address.
 *  NOT here: the real clock (`adapters/clock.ts`), the simulated one (`sim/simclock.ts`), nor the helpers that read a stamp
 *  (`isoOf`, `nowIso`, `silentFor`: the app's age rules, `core/clock.ts`). A LEAF module: it imports nothing.
 *  Called by: `extractor/pptx.ts` (`Clock`, the Google Slides deck budget), `extractor/xlsx-cells.ts` and
 *  `extractor/xlsx-number-format.ts` (`DAY_MS`, the serial-date conversion); `core/clock.ts` and, through it, the app. */

/** Clock port — the ONLY source of time outside adapters (determinism rule, CLAUDE.md). */
export interface Clock {
  /** Milliseconds since epoch. */
  now(): number;
}

/** Minute length, the one place it is spelled. */
export const MINUTE_MS = 60_000;

/** Day length, the one place it is spelled. */
export const DAY_MS = 24 * 60 * MINUTE_MS;
