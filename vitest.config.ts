/** How this package's tests run: one project, every test file under `src/`.
 *  Decides: the deadline of a test, the share of the machine the run takes, and the setup every worker loads.
 *  NOT here: the tests. Called by: `npm test`. */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Vitest 5 defaults `clearMocks` to true; the suite was written for the v4 default (calls and results kept
    // between tests).
    clearMocks: false,
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // Half the cores: with more workers the files that read whole documents contend, and their deadlines fire on the
    // load, not on the code.
    maxWorkers: "50%",
    // 30 s, not vitest's 5 s: some tests read real documents end to end, and a loaded machine doubles their time. A
    // deadline that fires on load tells nothing about the code.
    testTimeout: 30_000,
    setupFiles: ["./scripts/no-native-canvas-setup.ts"],
  },
});
