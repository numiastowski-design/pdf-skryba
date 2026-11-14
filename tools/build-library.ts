/** Builds the PUBLISHABLE package of the reading library (étape 9 de `docs/PLAN-BIBLIOTHEQUE.md`), with esbuild, into
 *  `packages/reader/dist/`.
 *  Decides: ce que le paquet emporte et ce qu'il laisse à l'appelant — et rien d'autre. Deux entrées, celles que l'étape 8
 *  a dessinées : la porte LOURDE (`src/lib/index.ts`, qui charge les lecteurs) et la porte LÉGÈRE (`src/lib/light.ts`,
 *  qui n'en charge aucun). Deux dépendances restent EXTERNES, parce qu'un consommateur les installe lui-même et qu'en
 *  les emportant on les publierait en double.
 *
 *  POURQUOI UN BUNDLE ET NON `tsc` : les sources sont écrites en résolution « Bundler » — un import relatif n'y porte
 *  pas son extension (`./foo`, jamais `./foo.js`). Node refuse ces chemins-là. Réécrire 1 500 imports pour publier
 *  serait un changement de tout le dépôt ; un bundle les résout une fois pour toutes, et c'est déjà ce que fait
 *  `build-functions.ts` pour les fonctions Forge.
 *
 *  MESURÉ le 30/10/2026, et c'est ce qui rend l'étape possible : AUCUN fichier source de la bibliothèque n'importe
 *  `@forge/*` (le seul qui le fasse, `pipeline/translation-payload.ts`, est l'un des sept qui restent dans l'app), et
 *  `fast-xml-parser`, `jszip` et `jpeg-js` ne sont plus importés que par des TESTS — le détachement a porté.
 *  NOT here: la licence, le README et les défauts qu'il nomme (`packages/reader/`), le `package.json` publié, ni la
 *  publication elle-même (geste de Mikolaj).
 *  Called by: `npm run build:lib`, `build-library.test.ts`. */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build, type BuildOptions } from "esbuild";

/** UN DESCRIPTIF PAR PAQUET PUBLIÉ (Mikolaj, 09/11/2026 : le PDF d'un côté, les formats déclarés de l'autre).
 *  Chaque paquet est un BUNDLE : ce qu'il contient est ce que ses portes ATTEIGNENT, jamais où ses fichiers sont posés.
 *  C'est pourquoi deux paquets sortent d'un seul arbre de sources, et pourquoi un test les mesure sur l'artefact
 *  (`build-library.test.ts`) : la frontière est détectée là où elle compte, et le déménagement physique — chantier
 *  suivant — la rendra en plus impossible.
 *  `external` : les paquets qu'un consommateur installe, laissés dehors pour ne pas les dupliquer chez qui les a déjà.
 *  Le PDF n'a plus besoin de `parse5` depuis que les formats déclarés sont partis : il ne servait qu'au HTML d'un dessin
 *  Google dans un export Word. */
export interface LibraryPackage {
  /** Dossier du paquet dans le dépôt. */
  dir: string;
  /** Les portes publiées, nom de sortie → fichier source. `index` est l'entrée principale, `light` celle sans lecteur. */
  entries: { index: string; light: string };
  /** Spécificateurs laissés externes. */
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


/** Partagé avec le test, pour que le paquet mesuré soit celui qui sera publié. ESM : le dépôt est en modules, et un
 *  paquet neuf n'a aucune raison de naître en CommonJS. Non minifié, comme les fonctions Forge : une trace de pile
 *  lisible vaut mieux que quelques octets. */
export const LIBRARY_BUILD_OPTIONS = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  // AUCUN COMMENTAIRE NE SORT (revue sécurité du 30/10/2026). Le bundle en emportait six qui nommaient Mikolaj,
  // citaient des arbitrages internes, des chemins de `docs/` et jusqu'au CONTENU d'une fixture — les mots d'un vrai
  // document, exactement ce que la règle du dépôt garde hors de tout ce qui est expédié. Sans minification, esbuild
  // recopie les commentaires du source ; `legalComments` ne touche que ceux de licence. La minification est donc ce
  // qui les enlève, et c'est l'usage d'un paquet publié : qui veut lire le code lit les SOURCES, publiques sous AGPL.
  // (Les fonctions Forge restent non minifiées : leurs traces de pile vont dans NOS journaux, celles d'un
  // consommateur ne nous reviennent jamais.)
  minify: true,
  legalComments: "none",
  logLevel: "warning",
} satisfies BuildOptions;

/** Ce que le bundle a VRAIMENT avalé, dit par esbuild lui-même : les fichiers du dépôt qu'il a emportés, et les paquets
 *  qu'il a laissés dehors. Rendu plutôt que relu dans le texte du bundle — minifié, celui-ci ne porte plus ni
 *  commentaire de provenance ni mise en forme sur laquelle s'appuyer (revue sécurité du 30/10/2026). */
export interface BuiltGraph {
  /** Chemins du dépôt, séparateurs normalisés (`src/extractor/pdf.ts`). */
  inputs: string[];
  /** Spécificateurs laissés externes, tels qu'ils sont écrits (`@cantoo/pdf-lib`). */
  external: string[];
}

/** Les DÉCLARATIONS, émises par tsc dans le même dossier que les bundles. Elles font partie du paquet (c'est son champ
 *  `types`), donc elles se construisent avec lui : les laisser au `npm run build:lib` de la machine de l'auteur a fait
 *  tomber la CI, où `dist/` n'existe pas — il est ignoré par git (30/10/2026). Le compilateur est appelé par son
 *  chemin dans `node_modules`, jamais par `npx` : une CI hors ligne n'irait rien chercher. */
const buildTypes = (pkg: LibraryPackage, outDir: string): void => {
  const tsc = resolve("node_modules", "typescript", "bin", "tsc");
  const result = spawnSync(process.execPath, [tsc, "--project", tsconfigOf(pkg), "--outDir", resolve(outDir, "types")], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`les déclarations n'ont pas été émises : ${result.stdout || result.stderr}`);
  inlineWorkspaceSpecifiers(resolve(outDir, "types"));
};

/** 🔴 UN PAQUET PRIVÉ NE S'INSTALLE PAS, DONC SON NOM NE DOIT PAS SURVIVRE DANS LES DÉCLARATIONS PUBLIÉES.
 *  Depuis le déménagement du 09/11/2026, le noyau vit dans `packages/doc-ir`, importé par son nom npm. Le BUNDLE de
 *  code l'emporte (esbuild le résout et l'inline : zéro occurrence mesurée). Les DÉCLARATIONS, elles, gardent le
 *  spécificateur tel quel — tsc ne réécrit jamais un chemin de module — et 36 fichiers de `skryba` annonçaient donc
 *  `from "doc-ir/lib/ir"` à un consommateur qui ne peut pas l'installer : le paquet s'installait et ses types ne
 *  résolvaient rien. Mesuré sur l'artefact avant d'écrire ces lignes.
 *  Ici, chaque spécificateur d'un paquet de l'espace de travail devient le chemin RELATIF du fichier émis à côté :
 *  `tsc` a émis les deux arbres sous `dist/types` (grâce à `rootDir` sur la racine du dépôt), donc la cible existe.
 *  Déterministe, et tenu par un garde : aucune déclaration publiée ne nomme un paquet privé
 *  (`build-library.test.ts`). */
/** 🔴 CONSTRUITE À CHAQUE FICHIER, JAMAIS PARTAGÉE. Une regex globale porte son `lastIndex` d'un appel au suivant : la
 *  même expression, gardée en module, a répondu « ne matche pas » sur un fichier dont le contenu matchait parfaitement
 *  hors du build — 155 déclarations lues, zéro réécrite, et aucune erreur pour le dire. Mesuré le 09/11/2026, trouvé
 *  en comptant les fichiers réécrits au lieu de croire le code. */
const workspaceSpecifier = (): RegExp => /(from\s*|import\s*\(\s*)(["'])(doc-ir)\/([^"']+)\2/g;

const inlineWorkspaceSpecifiers = (typesDir: string): void => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith(".d.ts") ? [join(dir, entry.name)] : [],
    );
  for (const file of walk(typesDir)) {
    const text = readFileSync(file, "utf8");
    const rewritten = text.replace(workspaceSpecifier(), (_whole, lead: string, quote: string, pkgName: string, sub: string) => {
      const target = join(typesDir, "packages", pkgName, "src", `${sub}`);
      const relative = posixRelative(dirname(file), target);
      return `${lead}${quote}${relative}${quote}`;
    });
    if (rewritten !== text) writeFileSync(file, rewritten);
  }
};

/** Un chemin relatif de module : séparateurs POSIX, et le `./` explicite qu'un spécificateur exige. */
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
    const result = await build({ ...LIBRARY_BUILD_OPTIONS, external: [...pkg.external], entryPoints: [entry], outfile: join(outDir, `${name}.js`), metafile: true });
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
