import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { auditToolchainCoherence } from "../scripts/audit-toolchain-coherence.mjs";
import { auditScriptInventory } from "../scripts/audit-script-inventory.mjs";

const inventoryConfig = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "config/script-inventory.json"), "utf8")
) as { orphanCeiling: number; knownFailing: Record<string, string> };

describe("toolchain coherence", () => {
  it("states one Node version everywhere", () => {
    const report = auditToolchainCoherence();

    // Seven sources used to disagree, and the README — the one a new
    // contributor reads first — was the one that was wrong. A fresh clone
    // followed literally produced an environment violating engines.node.
    expect(report.failures, report.failures.join("\n")).toEqual([]);
  });

  it("checks every source that states a Node version", () => {
    const report = auditToolchainCoherence();

    // Guards against the audit silently checking nothing: if the workflow
    // scan stopped matching, or CircleCI's image moved to a form the regex
    // misses, coherence would pass vacuously.
    expect(report.summary.sourcesChecked).toBeGreaterThanOrEqual(10);
  });
});

describe("script inventory", () => {
  it("keeps every wired gate passing", () => {
    const report = auditScriptInventory();

    // A script wired into CI that cannot pass is either broken or lying, and
    // either way CI is not checking what its name claims. Gates already broken
    // when this audit was written are listed in knownFailing with a reason.
    expect(report.failures, report.failures.join("\n")).toEqual([]);
  });

  it("never lets the orphan count grow", () => {
    const report = auditScriptInventory({ run: false });

    expect(
      report.summary.orphan,
      `${report.summary.orphan} verify/audit scripts are invoked by nothing; ceiling is ${inventoryConfig.orphanCeiling}.`
    ).toBeLessThanOrEqual(inventoryConfig.orphanCeiling);
  });

  it("still classifies most scripts as wired or chained", () => {
    const report = auditScriptInventory({ run: false });

    // If the invoker scan broke, everything would look orphaned and the
    // ceiling would be the only thing failing — this says so directly.
    expect(report.summary.wired + report.summary.chained).toBeGreaterThan(report.summary.orphan);
  });

  it("keeps the known-failing list shrinking, never growing", () => {
    // Five gates were already red when this was written. The list is a
    // ratchet: a script that starts passing has to come off it, which the
    // audit enforces, and nothing new may be added without a reason.
    expect(Object.keys(inventoryConfig.knownFailing).length).toBeLessThanOrEqual(5);
    for (const reason of Object.values(inventoryConfig.knownFailing)) {
      expect(reason.length, "every known-failing entry needs a stated reason").toBeGreaterThan(20);
    }
  });
});
