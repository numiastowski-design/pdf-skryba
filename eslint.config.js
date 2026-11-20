// The lint of this package: type-aware, zero warning (`npm run lint`).
// Determinism is load-bearing: a reader gives the same result for the same bytes, so randomness and time never enter
// the sources; tests may use both.
import { readFileSync } from "node:fs";
import sonarjs from "eslint-plugin-sonarjs";
import tseslint from "typescript-eslint";

// Node strips the types of this file when it loads it (Node 24 and later).
import { FRENCH_COMMENT_RULE, localPlugin } from "./scripts/french-comments.ts";

/** The sonarjs rules held as errors. */
const SONAR_ENFORCED = JSON.parse(readFileSync(new URL("./scripts/sonar-enforced.json", import.meta.url), "utf8"));

/** The package's own code, tests included: linted with type information. */
const SOURCES = ["src/**/*.ts"];
const TESTS = ["src/**/*.test.ts"];
/** The build and test tooling: the base rules, without type information. */
const TOOLING = ["scripts/**/*.ts"];

export default tseslint.config(
  // `dist` is built. The vendored code is a third party's, kept as published: its lint findings are not ours to fix.
  { ignores: ["node_modules/**", "dist/**", "coverage/**", "src/extractor/codecs/vendor/**"] },
  ...tseslint.configs.recommended,
  {
    // Some `eslint-disable` comments justify a triaged false positive of a sonarjs rule this configuration does not
    // enable; they look unused here.
    linterOptions: { reportUnusedDisableDirectives: "off" },
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-console": "error",
      "no-restricted-properties": [
        "error",
        { object: "Math", property: "random", message: "Determinism rule: no randomness in a reader." },
        { object: "Date", property: "now", message: "Determinism rule: no clock in a reader." },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: "Determinism rule: no clock in a reader.",
        },
      ],
    },
  },
  {
    files: ["src/**/*.ts"],
    ignores: TESTS,
    plugins: { sonarjs },
    rules: Object.fromEntries(SONAR_ENFORCED.map((rule) => [rule, "error"])),
  },
  // Comments are written in English. The rule's own file is left out: its comments quote the French words it looks for.
  {
    files: [...SOURCES, ...TOOLING],
    ignores: ["scripts/french-comments.ts"],
    plugins: { local: localPlugin },
    rules: { [FRENCH_COMMENT_RULE]: "error" },
  },
  // Type-aware rules. An implicit `any` needs no rule: `strict` already makes it a type error.
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({ ...config, files: SOURCES })),
  {
    files: SOURCES,
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      // A written `default:` is a choice: it makes a switch over a union exhaustive.
      "@typescript-eslint/switch-exhaustiveness-check": ["error", { considerDefaultExhaustiveForUnions: true }],
      "@typescript-eslint/no-floating-promises": "error",
      // A key taken out by destructuring to keep the rest is not an unused variable.
      "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],
      // Removing `async` from a function with no `await` would turn a rejected promise into a synchronous throw.
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    files: TESTS,
    rules: { "no-restricted-properties": "off", "no-restricted-syntax": "off", "no-console": "off" },
  },
);
