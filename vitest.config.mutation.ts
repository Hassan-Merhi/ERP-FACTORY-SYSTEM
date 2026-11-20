/**
 * Test set for mutation testing (stryker.config.mjs).
 *
 * Only the database-free tests listed in config/mutation-testing.json run,
 * in parallel, so every mutant is checked in seconds. They inherit the backend
 * plugins, setup files and aliases. (mergeConfig would append to the backend
 * include list rather than replace it, so the test block is rebuilt here.)
 */
import { readFileSync } from "fs";
import path from "path";
import { defineConfig } from "vitest/config";

import backend from "./vitest.config";

const { tests } = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "config/mutation-testing.json"), "utf8")
) as { tests: string[] };

const { coverage: _coverage, exclude: _exclude, ...backendTest } = backend.test ?? {};

export default defineConfig({
  ...backend,
  test: {
    ...backendTest,
    include: tests,
    fileParallelism: true,
  },
});
