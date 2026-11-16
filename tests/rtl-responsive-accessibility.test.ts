import fs from "node:fs";
import { describe, expect, it } from "vitest";

function read(path: string) {
  return fs.readFileSync(path, "utf8");
}

describe("Phase 8 RTL responsive accessibility contract", () => {
  it("synchronizes the language and direction across html and body", () => {
    const direction = read("client/src/i18n/applicationDirection.ts");
    const context = read("client/src/contexts/ApplicationLanguageContext.tsx");

    expect(direction).toContain("applyApplicationLanguageToDocument");
    expect(direction).toContain("root.dataset.applicationLanguage");
    expect(direction).toContain("root.dataset.applicationDirection");
    expect(direction).toContain("targetDocument.body.dir = direction");
    expect(context).toContain("applyApplicationLanguageToDocument(language)");
    expect(context).toContain('data-testid="application-language-announcement"');
    expect(context).toContain("<LiveRegion");
  });

  it("runs the release contracts without database startup side effects", () => {
    const config = read("vitest.config.i18n-contracts.ts");

    expect(config).toContain('"tests/i18n-release-gate.test.ts"');
    expect(config).toContain('"tests/rtl-responsive-accessibility.test.ts"');
    expect(config).not.toContain("setupFiles");
    expect(config).not.toContain("supplierCompanyScopeBridge");
  });

  it("keeps business values isolated while forcing codes and numbers to LTR", () => {
    const css = read("client/src/styles/rtl-hardening.css");

    for (const token of [
      "[data-business-value]",
      "[data-stock-name]",
      "[data-stock-item-name]",
      "[data-stock-group]",
      "[data-stock-group-name]",
      "[data-company-name]",
      "[data-account-name]",
      "[data-article-code]",
      "[data-container-number]",
      "[data-voucher-number]",
      "[data-currency-value]",
      "[data-money-value]",
      "[data-quantity-value]",
      'input[inputmode="decimal"]',
      "unicode-bidi: isolate",
      "direction: ltr",
    ]) {
      expect(css).toContain(token);
    }
  });

  it("hardens shared overlays, sidebars, top bars and horizontal data", () => {
    const css = read("client/src/styles/rtl-hardening.css");
    const dialog = read("client/src/components/ui/dialog.tsx");
    const sheet = read("client/src/components/ui/sheet.tsx");
    const topBar = read("client/src/components/AppTopBar.tsx");
    const responsive = read("client/src/components/ui/responsive-accessibility.tsx");

    for (const token of [
      '[data-slot="dialog-close"]',
      '[data-slot="sheet-close"]',
      '[data-slot="sidebar-container"]',
      '[data-slot="sidebar-trigger"]',
      '[data-slot="app-top-bar-actions"]',
      '[data-slot="pos-top-bar-actions"]',
      "[data-horizontal-scroll-region]",
      "prefers-reduced-motion",
      "forced-colors",
      "pointer: coarse",
      "focus-visible",
      "scrollbar-gutter: stable both-edges",
    ]) {
      expect(css).toContain(token);
    }

    expect(dialog).toContain('data-slot="dialog-content"');
    expect(dialog).toContain('data-slot="dialog-close"');
    expect(dialog).toContain('data-slot="dialog-header"');
    expect(dialog).toContain('data-slot="dialog-footer"');
    expect(dialog).not.toContain("handleCloseAutoFocus");
    expect(dialog).not.toContain("onCloseAutoFocus={handleCloseAutoFocus}");
    expect(sheet).toContain('data-slot="sheet-content"');
    expect(sheet).toContain('data-slot="sheet-close"');
    expect(sheet).toContain("data-sheet-side={side}");
    expect(topBar).toContain("useApplicationDirection");
    expect(topBar).toContain('data-slot="app-top-bar-actions"');
    expect(responsive).toContain('data-horizontal-scroll-region="true"');
    expect(responsive).toContain('aria-keyshortcuts="ArrowLeft ArrowRight"');
    expect(responsive).toContain("event.currentTarget.scrollBy");
  });

  it("focuses the actual main landmark when skip navigation is activated", () => {
    const responsive = read("client/src/components/ui/responsive-accessibility.tsx");

    expect(responsive).toContain("getHashTarget");
    expect(responsive).toContain("target.focus({ preventScroll: true })");
    expect(responsive).toContain('target.scrollIntoView({ block: "start" })');
    expect(responsive).toContain("history.replaceState");
  });

  it("mirrors left and right sheets and sidebars independently", () => {
    const css = read("client/src/styles/rtl-hardening.css");

    for (const token of [
      '[data-slot="sheet-content"][data-sheet-side="left"]',
      '[data-slot="sheet-content"][data-sheet-side="right"]',
      '[data-slot="sidebar"][data-side="left"]',
      '[data-slot="sidebar"][data-side="right"]',
      '[data-mobile="true"][data-sheet-side="left"]',
      '[data-mobile="true"][data-sheet-side="right"]',
      "--tw-enter-translate-x: 100%",
      "--tw-enter-translate-x: -100%",
    ]) {
      expect(css).toContain(token);
    }
  });

  it("provides translated skip navigation in every application shell", () => {
    for (const path of [
      "client/src/app/ErpShell.tsx",
      "client/src/app/FactoryShell.tsx",
      "client/src/app/PropertiesShell.tsx",
      "client/src/app/PosShell.tsx",
    ]) {
      const source = read(path);
      expect(source).toContain("useApplicationLanguage");
      expect(source).toContain('<SkipLink>{t("accessibility.skipToMainContent")}</SkipLink>');
      expect(source).toContain('id="main-content"');
      expect(source).toContain("tabIndex={-1}");
    }
  });

  it("mirrors only intentional directional controls in POS", () => {
    const pos = read("client/src/app/PosShell.tsx");
    const css = read("client/src/styles/rtl-hardening.css");

    expect(pos).toContain('data-directional-icon="true"');
    expect(pos).toContain('data-slot="pos-top-bar-actions"');
    expect(pos).toContain('data-business-value="true"');
    expect(pos).toContain('dir="auto"');
    expect(css).toContain('[data-directional-icon="true"]');
    expect(css).not.toContain('html[dir="rtl"] svg {');
  });
});
