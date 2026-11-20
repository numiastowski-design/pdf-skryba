/** Builds this package into `dist/`: `npm run build`, and `prepack` before every archive.
 *  Decides: where the package is (the folder above this one) and which configuration emits its declarations.
 *  NOT here: what a door is, what stays outside the bundle (`build-core.ts`).
 *  Called by: `npm run build`. */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildPackage, type PackageManifest } from "./build-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageManifest;

for (const file of await buildPackage({ root, manifest, tsconfig: "tsconfig.build.json" }))
  process.stdout.write(`built ${file}\n`);
