import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("Phase 12 business regression suite contracts", () => {
  it("keeps a deterministic smoke boundary for the two cross-module workflows", () => {
    const runner = source("scripts/run-business-regression.mjs");
    expect(runner).toContain('"tests/workflow.test.ts"');
    expect(runner).toContain('"tests/factory-container-lifecycle.test.ts"');
    expect(runner).toContain('process.argv.includes("--smoke")');
  });

  it("covers the critical business domains in the full boundary", () => {
    const runner = source("scripts/run-business-regression.mjs");
    for (const suite of [
      "tests/pos.test.ts",
      "tests/vouchers.test.ts",
      "tests/accounting.test.ts",
      "tests/reports.test.ts",
      "tests/company-context-enforcement.test.ts",
      "tests/factory-mix-batch-stable-cost.test.ts",
      "tests/factory-locked-rate-migration.test.ts",
    ]) {
      expect(runner).toContain(suite);
    }
  });

  it("runs database-mutating suites serially and supports a non-executing list mode", () => {
    const runner = source("scripts/run-business-regression.mjs");
    expect(runner).toContain('"--maxWorkers=1"');
    expect(runner).toContain('"--no-file-parallelism"');
    expect(runner).toContain('process.argv.includes("--list")');
  });

  it("fails before execution when a required suite disappears", () => {
    const runner = source("scripts/run-business-regression.mjs");
    expect(runner).toContain("missingSuites");
    expect(runner).toContain("Phase 12 business regression suite is incomplete");
    expect(runner).toContain("process.exit(1)");
  });
});
