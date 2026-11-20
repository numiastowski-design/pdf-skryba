/** Builds ONE package that sits at the root of its repository, with esbuild, into `dist/`.
 *  Decides: which doors the package has (read from the `exports` of its own manifest, never listed twice), what stays
 *  outside the bundle (what a consumer installs: the manifest's dependencies), and the three files of a door —
 *  `<door>.js`, readable, with its source map; `<door>.min.js` when the manifest exports it; the declarations under
 *  `dist/types`, their relative imports spelled the way Node resolves them.
 *  WHY A BUNDLE AND NOT `tsc`: the sources are written in "Bundler" resolution, where a relative import carries no
 *  extension. Node refuses those paths; a bundle resolves them once.
 *  NOT here: the manifest, the licence, the publication, nor any path of this package (`build.ts` gives them).
 *  Called by: `build.ts`. */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { build, type BuildOptions } from "esbuild";

/** What the build reads of a `package.json`. */
export interface PackageManifest {
  exports?: unknown;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

export interface Door {
  /** The built file's path under `dist/`, without extension: `index` for `./dist/index.js`, `first-party/browser`
   *  for `./dist/first-party/browser.js`. */
  name: string;
  /** The source the door is bundled from, from the package root. */
  source: string;
  /** Whether the manifest also exports `<name>.min.js`. */
  minified: boolean;
}

export interface Doors {
  /** The folder the declarations are laid out from: the package root (`dist/types/src/…`) or `src` (`dist/types/…`). */
  typesRoot: "." | "src";
  doors: Door[];
}

/** A door may sit in a sub-folder of `dist/` (`./dist/first-party/browser.js`): its name keeps that folder. */
const BUILT_FILE = /^\.\/dist\/(.+?)(\.min)?\.js$/u;
const DECLARATION = /^\.\/dist\/types\/(.+)\.d\.ts$/u;

/** THE DOORS A MANIFEST DECLARES: one per `./dist/<name>.js` its `exports` name. The source of a door is the file its
 *  declaration stands for, so the manifest is the only place that lists the doors. A door without a declaration, a
 *  minified file without its readable door, or declarations laid out two ways stop the build: each would publish a
 *  package whose manifest points nowhere. */
export const doorsOf = (manifest: PackageManifest): Doors => {
  const entries =
    manifest.exports !== null && typeof manifest.exports === "object" ? Object.entries(manifest.exports) : [];
  const doors = new Map<string, Door>();
  const minified = new Set<string>();
  const roots = new Set<Doors["typesRoot"]>();
  for (const [key, value] of entries) {
    if (value === null || typeof value !== "object") continue;
    const { types, default: file } = value as { types?: unknown; default?: unknown };
    const built = typeof file === "string" ? BUILT_FILE.exec(file) : null;
    if (built === null) continue;
    const name = built[1] ?? "";
    if (built[2] !== undefined) {
      minified.add(name);
      continue;
    }
    const declared = typeof types === "string" ? DECLARATION.exec(types) : null;
    if (declared === null) throw new Error(`build: the export ${key} has no declaration under ./dist/types`);
    const path = declared[1] ?? "";
    const typesRoot = path.startsWith("src/") ? "." : "src";
    roots.add(typesRoot);
    doors.set(name, { name, source: `${typesRoot === "." ? "" : "src/"}${path}.ts`, minified: false });
  }
  for (const name of minified) {
    const door = doors.get(name);
    if (door === undefined) throw new Error(`build: ${name}.min.js is exported, its readable door ${name}.js is not`);
    door.minified = true;
  }
  if (doors.size === 0) throw new Error("build: package.json declares no built door (an export to ./dist/<name>.js)");
  if (roots.size > 1) throw new Error("build: the declarations of the doors are laid out two ways (src/… and not)");
  const [typesRoot = "."] = roots;
  return { typesRoot, doors: [...doors.values()] };
};

/** What stays outside the bundle: each package a consumer installs with this one, and its sub-paths. Carrying it would
 *  publish it twice. */
export const externalOf = (manifest: PackageManifest): string[] =>
  Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })
    .sort()
    .flatMap((name) => [name, `${name}/*`]);

/** ESM: a new package has no reason to be born CommonJS. */
export const BUILD_OPTIONS = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  legalComments: "none",
  logLevel: "warning",
} satisfies BuildOptions;

const READABLE_DOOR = { minify: false, sourcemap: "linked", sourcesContent: true } satisfies BuildOptions;
const MINIFIED_DOOR = { minify: true, sourcemap: false } satisfies BuildOptions;

const declarationFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? declarationFiles(join(dir, entry.name))
      : entry.name.endsWith(".d.ts")
        ? [join(dir, entry.name)]
        : [],
  );

/** Built for each file, never shared: a global expression carries its `lastIndex` from one call to the next. */
const relativeSpecifier = (): RegExp => /(from\s*|import\s*\(\s*|import\s+)(["'])(\.{1,2}\/[^"'\n]*)\2/g;

/** A CONSUMER IN `node16`/`nodenext` RESOLUTION RESOLVES A DECLARATION'S IMPORTS THE WAY NODE RESOLVES ES MODULES: no
 *  extension is guessed, no folder index is looked for. tsc copies the specifiers as written, in "Bundler" style, so
 *  each relative specifier is rewritten to the JavaScript file it stands for (`./docx.js`, `./reader/index.js`), which
 *  every resolution mode maps to the `.d.ts` beside it. A specifier that matches neither file stops the build. */
export const explicitRelativeSpecifiers = (typesDir: string): void => {
  for (const file of declarationFiles(typesDir)) {
    const text = readFileSync(file, "utf8");
    const rewritten = text.replace(relativeSpecifier(), (whole, lead: string, quote: string, specifier: string) => {
      if (specifier.endsWith(".js")) return whole;
      const target = join(dirname(file), specifier);
      if (existsSync(`${target}.d.ts`)) return `${lead}${quote}${specifier}.js${quote}`;
      if (existsSync(join(target, "index.d.ts"))) return `${lead}${quote}${specifier}/index.js${quote}`;
      throw new Error(
        `build: ${relative(typesDir, file).replaceAll("\\", "/")} imports ${specifier}, which no emitted declaration matches`,
      );
    });
    if (rewritten !== text) writeFileSync(file, rewritten);
  }
};

export interface BuildRequest {
  /** The package root: the folder of its `package.json`. */
  root: string;
  manifest: PackageManifest;
  /** The configuration the declarations are emitted with, from the root. */
  tsconfig: string;
}

/** The configuration of one emission, written beside the manifest for the time of the build: tsc takes its files from
 *  a project or from the command line, never both, and the files here are the doors the manifest declares. */
const DOORS_TSCONFIG = "tsconfig.doors.json";

/** The declarations of the doors and of what they reach, emitted by tsc. The compiler is called by its path in
 *  `node_modules`, never through `npx`: an offline machine would fetch nothing. */
const buildTypes = ({ root, tsconfig }: BuildRequest, { typesRoot, doors }: Doors, typesDir: string): void => {
  const tsc = resolve(root, "node_modules", "typescript", "bin", "tsc");
  const project = resolve(root, DOORS_TSCONFIG);
  const config = {
    extends: `./${tsconfig}`,
    compilerOptions: { rootDir: typesRoot, outDir: relative(root, typesDir).replaceAll("\\", "/") },
    include: [],
    files: doors.map((door) => door.source),
  };
  writeFileSync(project, `${JSON.stringify(config, null, 2)}\n`);
  try {
    const result = spawnSync(process.execPath, [tsc, "--project", project], { cwd: root, encoding: "utf8" });
    if (result.status !== 0)
      throw new Error(`build: the declarations were not emitted: ${result.stdout || result.stderr}`);
  } finally {
    rmSync(project, { force: true });
  }
  explicitRelativeSpecifiers(typesDir);
};

/** Every file the manifest's `exports` point at, as paths from the root. */
const exportedFiles = (value: unknown): string[] =>
  typeof value === "string"
    ? [value]
    : value !== null && typeof value === "object"
      ? Object.values(value).flatMap(exportedFiles)
      : [];

/** Builds the package and returns the files written for its doors, from the root. A file the manifest exports from
 *  `dist/` and the build did not write stops it: the published package would point at nothing. */
export const buildPackage = async (request: BuildRequest): Promise<string[]> => {
  const { root, manifest } = request;
  const declared = doorsOf(manifest);
  const outDir = resolve(root, "dist");
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  buildTypes(request, declared, join(outDir, "types"));
  const written: string[] = [];
  for (const door of declared.doors) {
    const options = {
      ...BUILD_OPTIONS,
      absWorkingDir: resolve(root),
      external: externalOf(manifest),
      entryPoints: [door.source],
    } satisfies BuildOptions;
    await build({ ...options, ...READABLE_DOOR, outfile: join(outDir, `${door.name}.js`) });
    written.push(`dist/${door.name}.js`);
    if (!door.minified) continue;
    await build({ ...options, ...MINIFIED_DOOR, outfile: join(outDir, `${door.name}.min.js`) });
    written.push(`dist/${door.name}.min.js`);
  }
  const missing = exportedFiles(manifest.exports).filter(
    (file) => file.startsWith("./dist/") && !existsSync(resolve(root, file)),
  );
  if (missing.length > 0) throw new Error(`build: exported and not built: ${missing.join(", ")}`);
  return written;
};
