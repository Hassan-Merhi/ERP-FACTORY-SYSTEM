/**
 * CI has one GitHub Actions owner and one real CircleCI owner.
 *
 * Coverage already executes the complete Vitest suites. Running the plain
 * commands immediately before coverage doubles the work without adding a
 * correctness gate. The old GitHub-hosted CircleCI clone had the same problem
 * at the provider level, so these assertions keep both forms of duplication
 * from returning.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const GITHUB_CI = ".github/workflows/ci.yml";
const CIRCLECI = ".circleci/config.yml";
const SHADOW_CIRCLECI = ".github/workflows/circleci-parity.yml";

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function commandCount(source: string, command: string): number {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line === command || line.startsWith(`${command} `)).length;
}

describe("CI ownership", () => {
  it("keeps one canonical GitHub workflow and the real CircleCI pipeline", () => {
    expect(fs.existsSync(path.join(process.cwd(), GITHUB_CI))).toBe(true);
    expect(fs.existsSync(path.join(process.cwd(), CIRCLECI))).toBe(true);
    expect(fs.existsSync(path.join(process.cwd(), SHADOW_CIRCLECI))).toBe(false);
  });

  it("runs each GitHub suite once through its coverage command", () => {
    const workflow = read(GITHUB_CI);

    expect(commandCount(workflow, "npm run test:backend")).toBe(0);
    expect(commandCount(workflow, "npm run test:backend:coverage")).toBe(1);
    expect(commandCount(workflow, "npm run test:frontend")).toBe(0);
    expect(commandCount(workflow, "npm run test:frontend:coverage")).toBe(1);
  });

  it("preserves the coverage ratchet and CircleCI production gates", () => {
    const github = read(GITHUB_CI);
    const circle = read(CIRCLECI);

    expect(github).toContain("npm run audit:coverage-ratchet");
    expect(circle).toContain("full-erp-verification:");
    expect(circle).toContain("static-build:");
    expect(circle).toContain("postgres-regression:");
    expect(circle).toContain("security-readiness:");
    // "Run CircleCI compatibility checks only on main" (7547ee9) made these jobs
    // main-only on purpose, alongside the same move for GitHub Actions. Assert the
    // filters are present rather than absent, so the policy stays deliberate.
    expect(circle).toMatch(/branches:\s*\n\s*only:\s*main/);
  });
});
