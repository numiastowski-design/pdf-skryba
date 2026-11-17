/** Builds the PUBLISHABLE packages of the reading library (step 9 of `docs/PLAN-BIBLIOTHEQUE.md`), with esbuild, each
 *  into its own `dist/` (`PACKAGES` names them).
 *  Decides: what each package carries and what it leaves to the caller, and nothing else. Two entries per package: the
 *  HEAVY door, which loads the readers, and the LIGHT door, which loads none. What `external` names stays outside,
 *  because a consumer installs it itself and carrying it would publish it twice.
 *
 *  WHY A BUNDLE AND NOT `tsc`: the sources are written in "Bundler" resolution, where a relative import carries no
 *  extension (`./foo`, never `./foo.js`). Node refuses those paths. Rewriting 1,500 imports to publish would change the
 *  whole repository; a bundle resolves them once and for all, and it is already what `build-functions.ts` does for the
 *  Forge functions.
 *
 *  MEASURED on 30/10/2026, which is what makes the step possible: NO source file of the library imports `@forge/*` (the
 *  only one that does, `pipeline/translation-payload.ts`, is one of the seven that stay in the app), and
 *  `fast-xml-parser`, `jszip` and `jpeg-js` are now imported only by TESTS and by the bench: the detachment held.
 *  NOT here: the licence, the README and the defects it names (each package's folder), the published `package.json`,
 *  nor the publication itself (the maintainer's gesture).
 *  Called by: `npm run build:lib`, `build-library.test.ts`. */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build, type BuildOptions } from "esbuild";

/** ONE DESCRIPTOR PER PUBLISHED PACKAGE (09/11/2026: the PDF on one side, the declared formats on the other).
 *  Each package is a BUNDLE: what it holds is what its doors REACH, never where its files sit.
 *  That is why two packages come out of a single source tree, and why a test measures them on the artefact
 *  (`build-library.test.ts`): the boundary is detected where it counts, and the physical move — the next step —
 *  will also make it impossible to cross.
 *  `external`: the packages a consumer installs, left outside so that they are not duplicated for whoever already has them.
 *  The PDF no longer needs `parse5` since the declared formats left: it was used only for the HTML of a Google drawing
 *  in a Word export. */
export interface LibraryPackage {
  /** The package's folder in the repository. */
  dir: string;
  /** The published doors, output name → source file. `index` is the main entry, `light` the one with no reader. */
  entries: { index: string; light: string };
  /** Specifiers left external. */
  external: readonly string[];
}

export const PACKAGES: Record<"pdf" | "docs", LibraryPackage> = {
  pdf: {
    dir: "packages/reader",
    entries: { index: "packages/doc-read/src/lib/pdf.ts", light: "packages/doc-read/src/lib/pdf-light.ts" },
    external: ["@cantoo/pdf-lib"],
  },
  docs: {
    dir: "packages/docs-scribe",
    entries: { index: "packages/doc-read/src/lib/docs.ts", light: "packages/doc-read/src/lib/docs-light.ts" },
    external: ["parse5"],
  },
};

export const distDirOf = (pkg: LibraryPackage): string => join(pkg.dir, "dist");
export const tsconfigOf = (pkg: LibraryPackage): string => join(pkg.dir, "tsconfig.build.json");


/** Shared with the test, so that the package measured is the one that will be published. ESM: the repository is in
 *  modules, and a new package has no reason to be born CommonJS. */
export const LIBRARY_BUILD_OPTIONS = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  legalComments: "none",
  logLevel: "warning",
} satisfies BuildOptions;

/** THREE FILES PER DOOR, AS `pdfjs-dist` SHIPS THEM (decided 17/11/2026): `<door>.js`, readable, the one a consumer gets;
 *  `<door>.js.map`, its source map, the sources in clear; `<door>.min.js`, the same code minified, for whoever asks.
 *  THIS REVERSES the security review of 30/10/2026, which shipped the minified file ALONE so that no comment left: the
 *  bundle carried six that named the maintainer, cited internal arbitrations, `docs/` paths and the words of a fixture.
 *  Its reason is gone: the sources are public since 14/11/2026, comments included. What a publication must still never
 *  carry — a person's name, a path of the author's machine, a test file — is held by `build-library.test.ts` on the
 *  built files, map included.
 *  (The Forge functions stay unminified for another reason: their stack traces go to OUR logs.) */
const READABLE_DOOR = { minify: false, sourcemap: "linked", sourcesContent: true } satisfies BuildOptions;
const MINIFIED_DOOR = { minify: true, sourcemap: false } satisfies BuildOptions;

/** What the bundle REALLY swallowed, as told by esbuild itself: the repository files it carried, and the packages it
 *  left outside. Returned rather than re-read from the bundle's text: esbuild's own account is the one that cannot drift
 *  from what it wrote. */
export interface BuiltGraph {
  /** Repository paths, separators normalised (`packages/doc-read/src/extractor/pdf.ts`). */
  inputs: string[];
  /** Specifiers left external, as written (`@cantoo/pdf-lib`). */
  external: string[];
}

/** The DECLARATIONS, emitted by tsc into `types/`, under the folder of the bundles. They are part of the package (its `types`
 *  field), so they are built with it: leaving them to the author's machine's `npm run build:lib` broke the CI, where
 *  `dist/` does not exist — git ignores it (30/10/2026). The compiler is called by its path in `node_modules`, never
 *  through `npx`: an offline CI would fetch nothing. */
const buildTypes = (pkg: LibraryPackage, outDir: string): void => {
  const tsc = resolve("node_modules", "typescript", "bin", "tsc");
  const result = spawnSync(process.execPath, [tsc, "--project", tsconfigOf(pkg), "--outDir", resolve(outDir, "types")], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`les déclarations n'ont pas été émises : ${result.stdout || result.stderr}`);
  inlineWorkspaceSpecifiers(resolve(outDir, "types"));
};

/** 🔴 A PRIVATE PACKAGE CANNOT BE INSTALLED, SO ITS NAME MUST NOT SURVIVE IN THE PUBLISHED DECLARATIONS.
 *  Since the move of 09/11/2026, the core lives in `packages/doc-ir`, imported by its npm name. The code BUNDLE carries
 *  it away (esbuild resolves and inlines it: zero occurrences measured). The DECLARATIONS keep the specifier as it is —
 *  tsc never rewrites a module path — so 36 files of `skryba` told a consumer who cannot install it
 *  `from "doc-ir/lib/ir"`: the package installed and its types resolved nothing. Measured on the artefact before
 *  these lines were written.
 *  Here, each specifier of a PRIVATE workspace package becomes the RELATIVE path of the file emitted beside it: `tsc`
 *  emitted every tree under `dist/types` (thanks to `rootDir` on the repository root), so the target exists.
 *  Deterministic. The private packages are read from the workspace, never listed: the list once named `doc-ir` alone,
 *  and `doc-gate` went out in the declarations of two published versions (found on 15/11/2026). */
const privateWorkspacePackages = (): Map<string, string> => {
  const directoryOfName = new Map<string, string>();
  for (const entry of readdirSync("packages", { withFileTypes: true })) {
    const manifestPath = join("packages", entry.name, "package.json");
    if (!entry.isDirectory() || !existsSync(manifestPath)) continue;
    // A manifest that does not parse throws here: skipping it would let its specifiers out.
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: string; private?: boolean };
    // A specifier carries the package's NAME; the emitted tree is laid out by DIRECTORY.
    if (manifest.private === true && manifest.name !== undefined) directoryOfName.set(manifest.name, entry.name);
  }
  return directoryOfName;
};

const escapeForRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/** 🔴 BUILT FOR EACH FILE, NEVER SHARED. A global regex carries its `lastIndex` from one call to the next: the same
 *  expression, kept at module level, answered « no match » on a file whose content matched perfectly outside the
 *  build — 155 declarations read, none rewritten, and no error to say so. Measured on 09/11/2026, found by counting
 *  the rewritten files instead of trusting the code. */
const workspaceSpecifier = (packageNames: readonly string[]): RegExp =>
  new RegExp(String.raw`(from\s*|import\s*\(\s*)(["'])(${packageNames.map(escapeForRegExp).join("|")})\/([^"']+)\2`, "g");

const inlineWorkspaceSpecifiers = (typesDir: string): void => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith(".d.ts") ? [join(dir, entry.name)] : [],
    );
  const directoryOfName = privateWorkspacePackages();
  const packageNames = [...directoryOfName.keys()].sort();
  if (packageNames.length === 0) throw new Error("build-library: no private workspace package was found under packages/");
  for (const file of walk(typesDir)) {
    const text = readFileSync(file, "utf8");
    const rewritten = text.replace(workspaceSpecifier(packageNames), (_whole, lead: string, quote: string, pkgName: string, sub: string) => {
      const target = join(typesDir, "packages", directoryOfName.get(pkgName) ?? pkgName, "src", `${sub}`);
      const relative = posixRelative(dirname(file), target);
      return `${lead}${quote}${relative}${quote}`;
    });
    if (rewritten !== text) writeFileSync(file, rewritten);
  }
};

/** A relative module path: POSIX separators, and the explicit `./` that a specifier requires. */
const posixRelative = (from: string, to: string): string => {
  const path = relative(from, to).replaceAll("\\", "/");
  return path.startsWith(".") ? path : `./${path}`;
};

export const buildLibrary = async (pkg: LibraryPackage, outDir = distDirOf(pkg)): Promise<BuiltGraph> => {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  buildTypes(pkg, outDir);
  const inputs = new Set<string>();
  const external = new Set<string>();
  for (const [name, entry] of Object.entries(pkg.entries)) {
    const door = { ...LIBRARY_BUILD_OPTIONS, external: [...pkg.external], entryPoints: [entry] } satisfies BuildOptions;
    const result = await build({ ...door, ...READABLE_DOOR, outfile: join(outDir, `${name}.js`), metafile: true });
    // The same graph, minified: what it swallowed is read from the readable build alone.
    await build({ ...door, ...MINIFIED_DOOR, outfile: join(outDir, `${name}.min.js`) });
    for (const file of Object.keys(result.metafile.inputs)) inputs.add(file.replaceAll("\\", "/"));
    for (const output of Object.values(result.metafile.outputs)) {
      for (const imported of output.imports) if (imported.external === true) external.add(imported.path);
    }
  }
  return { inputs: [...inputs].sort(), external: [...external].sort() };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const pkg of Object.values(PACKAGES)) {
    await buildLibrary(pkg);
    process.stdout.write(`paquet construit dans ${distDirOf(pkg)}\n`);
  }
}
