import { describe, expect, it } from "vitest";

import { auditScriptInventory } from "../scripts/audit-script-inventory.mjs";

describe("verification script inventory contract", () => {
  it("distinguishes automatic gates from manual commands and keeps debt out of automatic CI", () => {
    const report = auditScriptInventory({ run: false });

    expect(report.failures).toEqual([]);
    expect(report.summary.wired).toBeGreaterThan(0);
    expect(report.summary.manual).toBeGreaterThan(0);
    expect(report.summary.orphanCeiling).toBe(0);
    expect(report.summary.orphan).toBe(0);

    const knownTranslationDebt = report.scripts.find(
      (entry: { script: string }) => entry.script === "verify-phase9-final-i18n-baseline.mjs"
    );
    expect(knownTranslationDebt?.bucket).toBe("manual");

    for (const entry of report.scripts.filter((item: { bucket: string }) => item.bucket === "wired")) {
      expect(entry.invokedBy.some((source: string) => source.startsWith("package.json#"))).toBe(false);
      expect(
        entry.invokedBy.every(
          (source: string) => source.startsWith(".github/workflows/") || source.startsWith(".circleci/")
        )
      ).toBe(true);
    }
  });
});
