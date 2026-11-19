/**
 * Source-text assertion ratchet.
 * -----------------------------
 * Tests that assert on the literal text of source files are a liability during
 * a file-split program: they fail when code moves even though behaviour is
 * unchanged, which trains reviewers to wave through red builds.
 *
 * This test does not ban them — several are legitimate structural guards. It
 * makes their number a tracked, one-way quantity: the count may fall as tests
 * are converted to behavioural checks, and adding a new one requires updating
 * a reviewed ratchet file deliberately.
 *
 * It also pins the reverse index of god files covered by such tests, so the
 * split phases know up front which tests to rewrite before moving code.
 *
 * Regenerate the long-lived baseline after an intentional consolidation:
 *
 *     UPDATE_SOURCE_TEXT_BASELINE=1 npm run test:backend -- source-text-assertions
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// @ts-expect-error - plain ESM audit script shared with the npm audit task.
import { auditSourceTextAssertions } from "../scripts/audit-source-text-assertions.mjs";
import { readModuleFamily } from "../scripts/lib/readModuleFamily.mjs";

interface Baseline {
  maxSourceCoupledTests: number;
  maxTotalTextAssertions: number;
  sourceCoupledTests: string[];
  structuralGuardTests: string[];
  godFileHotspots: Array<{ path: string; lines: number; pinnedBy: string[] }>;
  pinnedPathsNoLongerPresent: string[];
}

interface RatchetAllowances {
  sourceTextAssertionDelta: {
    additionalSourceCoupledTests: string[];
    maxAdditionalTextAssertions: number;
  };
}

interface AuditEntry {
  test: string;
  classification: "source-coupled" | "structural-guard";
}

interface AuditReport {
  entries: AuditEntry[];
  pinnedFiles: Array<{ path: string; lines: number; isGodFile: boolean; pinnedBy: string[] }>;
  summary: {
    sourceCoupledTests: number;
    structuralGuardTests: number;
    totalTextAssertions: number;
  };
}

const BASELINE_PATH = path.join(process.cwd(), "config/source-text-assertion-baseline.json");
const ALLOWANCES_PATH = path.join(process.cwd(), "config/ci-ratchet-allowances.json");
const report = auditSourceTextAssertions() as AuditReport;

if (process.env.UPDATE_SOURCE_TEXT_BASELINE === "1") {
  const existing = JSON.parse(readModuleFamily(BASELINE_PATH)) as Record<string, unknown>;
  const regenerated = {
    ...existing,
    maxSourceCoupledTests: report.summary.sourceCoupledTests,
    maxTotalTextAssertions: report.summary.totalTextAssertions,
    sourceCoupledTests: report.entries
      .filter((entry) => entry.classification === "source-coupled")
      .map((entry) => entry.test)
      .sort(),
    structuralGuardTests: report.entries
      .filter((entry) => entry.classification === "structural-guard")
      .map((entry) => entry.test)
      .sort(),
    godFileHotspots: report.pinnedFiles
      .filter((file) => file.isGodFile)
      .map((file) => ({ path: file.path, lines: file.lines, pinnedBy: file.pinnedBy })),
    pinnedPathsNoLongerPresent: report.pinnedFiles.filter((file) => file.lines === 0).map((file) => file.path),
  };
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(regenerated, null, 2)}\n`, "utf8");
}

const baseline = JSON.parse(readModuleFamily(BASELINE_PATH)) as Baseline;
const allowances = JSON.parse(readModuleFamily(ALLOWANCES_PATH)) as RatchetAllowances;
const sourceTextDelta = allowances.sourceTextAssertionDelta;

describe("source-text assertion ratchet", () => {
  it("finds the tests it is meant to be auditing", () => {
    // If the audit stops matching anything, every ceiling below passes for the
    // wrong reason.
    expect(report.entries.length).toBeGreaterThan(0);
    expect(baseline.sourceCoupledTests.length).toBeGreaterThan(0);
  });

  it("does not add unreviewed source-coupled tests", () => {
    const known = new Set([...baseline.sourceCoupledTests, ...sourceTextDelta.additionalSourceCoupledTests]);
    const added = report.entries
      .filter((entry) => entry.classification === "source-coupled")
      .map((entry) => entry.test)
      .filter((test) => !known.has(test));

    expect(
      added,
      "New tests assert on source text. These break when code moves, which is a poor fit for a " +
        "codebase mid-split - prefer a behavioural assertion. If the coupling is deliberate, " +
        `record it in config/ci-ratchet-allowances.json:\n${added.join("\n")}`
    ).toEqual([]);
  });

  it("does not increase literal text assertions beyond the reviewed delta", () => {
    const reviewedCeiling = baseline.maxTotalTextAssertions + sourceTextDelta.maxAdditionalTextAssertions;

    expect(
      report.summary.totalTextAssertions,
      `Literal text assertions rose to ${report.summary.totalTextAssertions} beyond the reviewed ceiling of ` +
        `${reviewedCeiling}. This ratchet is one-way.`
    ).toBeLessThanOrEqual(reviewedCeiling);
  });

  it("keeps the reviewed source-text delta exact and current", () => {
    const present = new Set(
      report.entries.filter((entry) => entry.classification === "source-coupled").map((entry) => entry.test)
    );
    const stale = sourceTextDelta.additionalSourceCoupledTests.filter((test) => !present.has(test));

    expect(stale, `Reviewed source-text allowances no longer present should be removed:\n${stale.join("\n")}`).toEqual(
      []
    );
  });

  it("does not pin additional god files", () => {
    const known = new Set(baseline.godFileHotspots.map((hotspot) => hotspot.path));
    const added = report.pinnedFiles
      .filter((file) => file.isGodFile && !known.has(file.path))
      .map((file) => `${file.path} (${file.lines} lines)`);

    expect(
      added,
      "These god files are now pinned by source-coupled tests, which makes them harder to split:\n" + added.join("\n")
    ).toEqual([]);
  });

  it("keeps the baseline free of tests that no longer exist", () => {
    const present = new Set(report.entries.map((entry) => entry.test));
    const stale = [...baseline.sourceCoupledTests, ...baseline.structuralGuardTests].filter(
      (test) => !present.has(test)
    );

    expect(
      stale,
      `Baseline references tests that no longer read source files. Regenerate the baseline:\n${stale.join("\n")}`
    ).toEqual([]);
  });
});
