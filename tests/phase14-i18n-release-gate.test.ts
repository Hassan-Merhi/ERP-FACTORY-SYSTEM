import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("Phase 14 trilingual release gate", () => {
  it("loads RTL hardening globally", () => {
    const app = fs.readFileSync("client/src/App.tsx", "utf8");
    const css = fs.readFileSync("client/src/styles/rtl-hardening.css", "utf8");
    expect(app).toContain('import "@/styles/rtl-hardening.css"');
    expect(css).toContain('html[dir="rtl"]');
    expect(css).toContain("unicode-bidi: isolate");
    expect(css).toContain("[data-business-value]");
    expect(css).toContain("[data-account-code]");
    expect(css).toContain('[data-slot="sidebar-container"]');
    expect(css).toContain('[data-slot="dialog-close"]');
    expect(css).toContain('[data-slot="app-top-bar-actions"]');
    expect(css).toContain("prefers-reduced-motion");
    expect(css).toContain("forced-colors");
  });

  it("keeps a classified audit and reviewed per-module ratchet", () => {
    const audit = fs.readFileSync("scripts/audit-i18n-phase14.mjs", "utf8");
    const classifier = fs.readFileSync("scripts/verify-i18n-audit-classifier.mjs", "utf8");
    const policy = JSON.parse(fs.readFileSync("config/i18n-audit-policy.json", "utf8"));
    const baseline = JSON.parse(fs.readFileSync("config/i18n-phase14-baseline.json", "utf8"));
    const workflow = fs.readFileSync(".github/workflows/ui-quality.yml", "utf8");

    expect(audit).toContain("compatibility-covered");
    expect(audit).toContain("applicationTranslations.ts");
    expect(audit).toContain("reportsExportsPhase6Translations.part4.ts");
    expect(audit).toContain("backendMessagesPhase7Translations.part8.ts");
    expect(audit).toContain("enforceBaseline");
    expect(audit).toContain("process.exit(1)");
    expect(classifier).toContain("I18n audit classifier contract verified");
    expect(policy.ignoredPathRules.every((rule: { reason?: string }) => Boolean(rule.reason))).toBe(true);
    expect(baseline.schemaVersion).toBe(2);
    expect(baseline.detectorVersion).toBe(9);
    // Ratchet ceilings, not exact pins: the audit fails the build whenever the
    // measured count exceeds `baseline.maxActionable`, so a *lower* baseline is
    // a strictly stronger gate. Phase 3 drove the classified backlog to zero,
    // and asserting equality with the old reviewed ceiling would have made
    // finishing the translation work fail this guard.
    expect(baseline.maxActionable).toBeLessThanOrEqual(11995);
    expect(baseline.maxUnclassified).toBe(0);
    expect(Object.keys(baseline.modules)).toHaveLength(14);
    expect(baseline.modules["shared-ui"].maxActionable).toBeLessThanOrEqual(4);
    expect(baseline.modules["supplier-partner"].maxActionable).toBeLessThanOrEqual(39);
    expect(baseline.modules["properties-rentals"].maxActionable).toBe(0);
    expect(baseline.modules["reports-exports"].maxActionable).toBeLessThanOrEqual(2);
    expect(baseline.modules["backend-messages"].maxActionable).toBeLessThanOrEqual(15);
    expect(workflow).toContain("verify-i18n-audit-classifier.mjs");
    expect(workflow).toContain("--json-out");
    // Actions are SHA-pinned for supply-chain hardening, so match either the
    // bare tag or a commit SHA carrying the `# v7` comment.
    expect(workflow).toMatch(/actions\/upload-artifact@(?:v7\b|[0-9a-f]{40} # v7\b)/);
    expect(workflow).not.toContain("--no-enforce");
  });

  it("preserves business identifiers while translating interface attributes", () => {
    const translator = fs.readFileSync("client/src/components/ApplicationInterfaceTranslator.tsx", "utf8");
    expect(translator).toContain('"aria-label"');
    expect(translator).toContain('"placeholder"');
    expect(translator).toContain('"title"');
    expect(translator).toContain('"[data-account-code]"');
    expect(translator).toContain('"[data-container-number]"');
    expect(translator).toContain('"[data-voucher-number]"');
    expect(translator).toContain('"[data-property-name]"');
    expect(translator).toContain('"[data-unit-name]"');
    expect(translator).toContain('"[data-tenant-name]"');
    expect(translator).toContain("translatePhase6ReportsExportsText");
    expect(translator).toContain("translatePhase7BackendMessageText");
  });

  it("supports all three languages and Arabic-only RTL", () => {
    const contract = fs.readFileSync("shared/applicationLanguageContract.ts", "utf8");
    const direction = fs.readFileSync("client/src/i18n/applicationDirection.ts", "utf8");
    const context = fs.readFileSync("client/src/contexts/ApplicationLanguageContext.tsx", "utf8");
    expect(contract).toContain('"en"');
    expect(contract).toContain('"ar"');
    expect(contract).toContain('"fr"');
    expect(contract).toContain('language === "ar"');
    expect(direction).toContain("applyApplicationLanguageToDocument");
    expect(direction).toContain("targetDocument.body.dir = direction");
    expect(context).toContain('data-testid="application-language-announcement"');
  });

  it("keeps keyboard skip navigation in every application mode", () => {
    for (const path of [
      "client/src/app/ErpShell.tsx",
      "client/src/app/FactoryShell.tsx",
      "client/src/app/PropertiesShell.tsx",
      "client/src/app/PosShell.tsx",
    ]) {
      const source = fs.readFileSync(path, "utf8");
      expect(source).toContain('<SkipLink>{t("accessibility.skipToMainContent")}</SkipLink>');
      expect(source).toContain('id="main-content"');
      expect(source).toContain("tabIndex={-1}");
    }
  });
});
