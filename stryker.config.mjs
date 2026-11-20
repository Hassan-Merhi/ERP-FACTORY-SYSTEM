// Mutation testing: Stryker changes the code in small ways (a + becomes a -,
// a < becomes <=, a branch is skipped) and runs the tests against each change.
// A change no test notices ("survived") is a gap in the tests, not in the code.
// What is mutated, which tests run and the score floors live in
// config/mutation-testing.json; scripts/check-mutation-floors.mjs enforces them.
import { readFileSync } from "node:fs";

const { mutate } = JSON.parse(readFileSync(new URL("./config/mutation-testing.json", import.meta.url), "utf8"));

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  vitest: { configFile: "vitest.config.mutation.ts", related: false },
  mutate,
  coverageAnalysis: "perTest",
  ignoreStatic: true,
  concurrency: 4,
  timeoutMS: 20000,
  reporters: ["clear-text", "progress", "json", "html"],
  jsonReporter: { fileName: "artifacts/mutation/mutation-report.json" },
  htmlReporter: { fileName: "artifacts/mutation/mutation-report.html" },
  tempDirName: ".stryker-tmp",
  cleanTempDir: "always",
  thresholds: { high: 80, low: 60, break: null },
};
