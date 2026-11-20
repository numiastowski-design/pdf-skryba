/** Hides `@napi-rs/canvas` from every test worker, so the tests run the way production does (Forge never gets it).
 *  NOT here: the guard that this hiding works (`tools/no-native-canvas.test.ts`).
 *  Called by: `vitest.config.ts`, as a setup file of every project. */

import { createRequire } from "node:module";

type Resolve = ((request: string, ...rest: unknown[]) => string) & { [HIDDEN]?: true };
const HIDDEN = Symbol.for("d2c.no-native-canvas");
const Module = createRequire(import.meta.url)("node:module") as { _resolveFilename: Resolve };
const resolve = Module._resolveFilename;

// Vitest reruns a setup file before every test file; with `isolate: false` (the pdf project) the same process would wrap
// the resolver once per file. Wrapped once only.
if (!resolve[HIDDEN])
  Module._resolveFilename = Object.assign(
    function (this: unknown, request: string, ...rest: unknown[]): string {
      if (request === "@napi-rs/canvas" || request.startsWith("@napi-rs/canvas-")) {
        throw Object.assign(new Error("Cannot find module '@napi-rs/canvas' (hidden in tests, as in production)"), {
          code: "MODULE_NOT_FOUND",
        });
      }
      return resolve.call(this, request, ...rest);
    },
    { [HIDDEN]: true as const },
  );
