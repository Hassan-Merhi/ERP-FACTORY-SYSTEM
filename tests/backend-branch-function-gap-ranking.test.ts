import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("backend branch/function gap ranking", () => {
  it("ranks branches and functions independently instead of line-first", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coverage-rank-"));
    const summaryPath = path.join(dir, "coverage-summary.json");
    const jsonPath = path.join(dir, "ranked.json");

    fs.writeFileSync(
      summaryPath,
      JSON.stringify({
        total: {
          lines: { total: 100, covered: 50, skipped: 0, pct: 50 },
          branches: { total: 100, covered: 50, skipped: 0, pct: 50 },
          functions: { total: 100, covered: 50, skipped: 0, pct: 50 },
        },
        "/workspace/server/routes/branch-heavy.ts": {
          lines: { total: 50, covered: 45, skipped: 0, pct: 90 },
          branches: { total: 90, covered: 10, skipped: 0, pct: 11.11 },
          functions: { total: 10, covered: 9, skipped: 0, pct: 90 },
        },
        "/workspace/server/services/accounting/function-heavy.ts": {
          lines: { total: 90, covered: 20, skipped: 0, pct: 22.22 },
          branches: { total: 20, covered: 15, skipped: 0, pct: 75 },
          functions: { total: 70, covered: 2, skipped: 0, pct: 2.85 },
        },
        "/workspace/server/lib/zero-function.ts": {
          lines: { total: 5, covered: 5, skipped: 0, pct: 100 },
          branches: { total: 2, covered: 2, skipped: 0, pct: 100 },
          functions: { total: 3, covered: 0, skipped: 0, pct: 0 },
        },
      })
    );

    execFileSync(
      process.execPath,
      [
        path.join(process.cwd(), "scripts/rank-backend-branch-function-gaps.mjs"),
        summaryPath,
        "--json-output",
        jsonPath,
        "--source-sha",
        "fixture-sha",
      ],
      { stdio: "pipe" }
    );

    const report = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    expect(report.sourceSha).toBe("fixture-sha");
    expect(report.topBranches[0].path).toBe("server/routes/branch-heavy.ts");
    expect(report.topFunctions[0].path).toBe("server/services/accounting/function-heavy.ts");
    expect(report.topFunctions[0].uncoveredFunctions).toBe(68);
    expect(report.zeroCoverage.some((entry: { path: string }) => entry.path === "server/lib/zero-function.ts")).toBe(
      true
    );
    expect(report.categories.Accounting.uncoveredFunctions).toBe(68);
  });
});
