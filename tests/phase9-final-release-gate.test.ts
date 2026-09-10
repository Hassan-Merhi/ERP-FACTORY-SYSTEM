import fs from "node:fs";
import { describe, expect, it } from "vitest";

function read(path: string) {
  return fs.readFileSync(path, "utf8");
}

describe("Phase 9 final verification and release contract", () => {
  it("enforces a reviewed current-main untranslated-text ratchet", () => {
    const approved = JSON.parse(read("config/i18n-phase9-final-release.json"));
    const verifier = read("scripts/verify-phase9-final-i18n-baseline.mjs");

    expect(approved.schemaVersion).toBe(2);
    expect(approved.detectorVersion).toBe(9);
    expect(approved.policy.unclassifiedMustEqual).toBe(0);
    expect(approved.policy.totalActionableMustNotExceed).toBe(12545);
    expect(approved.policy.requireExactModuleSet).toBe(true);
    expect(approved.modules["backend-messages"]).toEqual({ maxActionable: 0, mustRemainZero: true });
    expect(approved.modules["shared-ui"]).toEqual({ maxActionable: 0, mustRemainZero: true });
    expect(verifier).toContain("report.totals.actionable > totalActionableCap");
    expect(verifier).toContain("actual > rule.maxActionable");
    expect(verifier).toContain("rule.mustRemainZero === true && actual !== 0");
    expect(verifier).toContain("Unclassified findings changed");
    expect(verifier).not.toContain("report.totals.candidates !== approved.totals.candidates");
  });

  it("tests English Arabic and French browser direction across responsive viewports", () => {
    const smoke = read("scripts/run-phase9-language-browser-smoke.mjs");

    expect(smoke).toContain('{ code: "en", direction: "ltr"');
    expect(smoke).toContain('{ code: "ar", direction: "rtl"');
    expect(smoke).toContain('{ code: "fr", direction: "ltr"');
    expect(smoke).toContain('{ name: "phone", width: 390, height: 844');
    expect(smoke).toContain('{ name: "tablet", width: 768, height: 1024');
    expect(smoke).toContain('{ name: "desktop", width: 1440, height: 900');
    expect(smoke).toContain("state.ltrViolations.length > 0");
    expect(smoke).toContain("state.horizontalOverflow");
    expect(smoke).toContain('await page.keyboard.press("Enter");');
    expect(smoke).toContain('activeElementId !== "main-content"');
    expect(smoke).toContain("assertSidebarEdge");
    expect(smoke).toContain("ERP_SMOKE_REQUIRE_AUTHENTICATED");
    expect(smoke).toContain("Authenticated browser coverage is required");
    expect(smoke).toContain('"[data-money-value]"');
    expect(smoke).toContain('"[data-quantity-value]"');
  });

  it("keeps the complete release matrix manual and current-main scoped", () => {
    const workflow = read(".github/workflows/release-verification.yml");
    const currentMainVerifier = read("scripts/verify-phase9-current-main-release.mjs");

    for (const token of [
      "workflow_dispatch:",
      "TypeScript",
      "Production build",
      "Lint",
      "Current-main multilingual reconciliation",
      "Prepare disposable PostgreSQL schema",
      "Prepare disposable authenticated browser fixture",
      "Application startup and multilingual browser smoke",
      "Full backend tests",
      "Backend coverage thresholds",
      "Full frontend tests",
      "Frontend coverage thresholds",
      "API smoke sweep",
      "Final untranslated-text release ratchet",
      "Focused security checks",
      "Critical production dependency audit",
      "Verified secret scan",
      "Final production readiness",
      "scripts/verify-multilingual-phases-4-7-current-main.mjs",
      "scripts/verify-phase8-current-main-reconciliation.mjs",
      "scripts/verify-phase9-current-main-release.mjs",
      'ERP_SMOKE_REQUIRE_AUTHENTICATED: "1"',
      'ERP_SMOKE_REQUIRE_EXACT_ROUTES: "1"',
      "BROWSER_FIXTURE: ${{ steps.browser_fixture.outcome }}",
      "PHASE9_ERP_SMOKE_USERNAME",
      "PHASE9_ERP_SMOKE_PASSWORD",
      "scripts/prepare-phase9-browser-smoke-fixture.mjs",
    ]) {
      expect(workflow).toContain(token);
    }

    expect(workflow).toContain("postgres:18");
    expect(workflow).toContain("scripts/run-phase9-language-browser-smoke.mjs");
    expect(workflow).toContain("scripts/verify-phase9-final-i18n-baseline.mjs");
    expect(workflow).toContain("Record and enforce final release result");
    expect(workflow).toContain("RECONCILIATION: ${{ steps.reconciliation.outcome }}");
    expect(workflow).toContain("INSTALL: ${{ steps.install.outcome }}");
    expect(workflow).toContain("SECRET_SCAN: ${{ steps.secret_scan.outcome }}");
    expect(workflow).toContain("set -euo pipefail");
    expect(workflow).toContain('test "$status" = "success"');
    expect(workflow).not.toContain("pull_request:");
    expect(workflow).not.toContain("push:");
    expect(workflow).not.toContain("steps.release_result.outputs.status");

    expect(currentMainVerifier).toContain("Phase 9 final release must remain manual-only");
    expect(currentMainVerifier).toContain("Obsolete Phase 9 formatting probe still exists");
    expect(currentMainVerifier).toContain('"productionReleaseAttested": false');
  });
});
