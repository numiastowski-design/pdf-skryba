/**
 * How many runs a property test of the PDF READER does, and how long one may last: its written count times the
 * `FUZZ_RUNS_MULTIPLIER` environment value, its written budget or `FUZZ_TEST_TIMEOUT_MS` when that one is larger.
 * Decides: the two variable names as this package reads them, the cap of the multiplier, what an unreadable value means.
 * WHY A COPY. A test of a package depends on its package and on the base, never on the application that consumes
 * them, and a test support is not shipped with a package: the base's own copy (`fuzz-runs.test.support.ts`) cannot be
 * reached from another repository. This one is bound for the PDF reader and leaves this folder with it.
 * NOT here: reading `process.env` (the caller passes it), nor the long-run script that sets the two variables.
 * Called by: the property tests bound for the PDF reader.
 */

const FUZZ_RUNS_ENV = "FUZZ_RUNS_MULTIPLIER";
const FUZZ_TIMEOUT_ENV = "FUZZ_TEST_TIMEOUT_MS";

/** Hard cap (starting value, a safety net): a typo such as 10^9 must not become a night of runs. */
const FUZZ_RUNS_CAP = 1000;

/** The largest delay a 32-bit timer holds; a larger one would not wait at all. */
const LARGEST_TIMER_DELAY_MS = 2_147_483_647;

/** Absent, empty, zero, negative, fractional or non-numeric all mean "no multiplier": 1. */
function parseMultiplier(raw: string | undefined): number {
  const text = (raw ?? "").trim();
  if (!/^\d+$/.test(text)) return 1;
  const value = Number(text);
  if (!Number.isSafeInteger(value)) return FUZZ_RUNS_CAP;
  if (value < 1) return 1;
  return Math.min(value, FUZZ_RUNS_CAP);
}

/** `base` times the multiplier read from `env`; an integer of at least 1. */
export function fuzzRuns(base: number, env: Record<string, string | undefined> = {}): number {
  return Math.max(1, Math.round(base * parseMultiplier(env[FUZZ_RUNS_ENV])));
}

/** The per-test timeout of a property test: its written budget, or the long-run budget when that one is larger. A file
 *  that fixes its own timeout would otherwise cut every test of a long run at its written value. */
export function fuzzTestTimeout(base: number, env: Record<string, string | undefined> = {}): number {
  const text = (env[FUZZ_TIMEOUT_ENV] ?? "").trim();
  if (!/^\d+$/.test(text)) return base;
  const value = Number(text);
  return Number.isSafeInteger(value) && value > base ? Math.min(value, LARGEST_TIMER_DELAY_MS) : base;
}
