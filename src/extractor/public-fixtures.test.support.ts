/** Test helper: the test documents this package may read when it reads a whole set of them — the rows `fixtures/PUBLIC.tsv` calls
 *  `public`, and those alone. A test that names its documents needs no helper; a test that used to list a folder asks here instead, so
 *  that a document enters a sweep the day its row says `public`, and never because it sits in a folder.
 *  The same file lives in each reader's package, word for word: a public repository cannot borrow a test helper from another one.
 *  NOT here: which document is public (the list). Called by: the tests that read every public document of a kind. */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** The rows a list text calls `public` whose name ends with one of the extensions, in the order of the text. Apart from the
 *  file so that a test can hand it a list holding a row of another status: the real list may hold none. */
export const publicRowsOf = (list: string, extensions: readonly string[]): string[] =>
  list
    .split(/\r?\n/u)
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => line.split("\t"))
    .filter(
      ([path = "", status]) =>
        status === "public" && extensions.some((extension) => path.toLowerCase().endsWith(extension)),
    )
    .map(([path = ""]) => path);

/** The public documents whose name ends with one of the extensions (lower case, with the dot), as paths from the root of the
 *  repository, in the order of the list. */
export const publicFixtures = (...extensions: string[]): string[] =>
  publicRowsOf(readFileSync(join(ROOT, "fixtures", "PUBLIC.tsv"), "utf8"), extensions);

/** Where a document of the list is on disk. */
export const publicFixturePath = (path: string): string => join(ROOT, path);
