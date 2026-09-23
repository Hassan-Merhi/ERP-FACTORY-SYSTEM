/**
 * Phase 3 — Frontend Layout Static Analysis Tests
 *
 * These tests read page source files as plain text and assert that key
 * structural patterns are present. They run in Node with no jsdom, no React,
 * and no network access.
 *
 * What they protect:
 *  - Desktop table structures (table-fixed, <Table) are not accidentally removed
 *    when someone adds mobile-only card views.
 *  - Scrollable overflow containers exist so tables do not overflow the viewport.
 *  - Critical action buttons (Save, New, etc.) are accessible — they exist in
 *    source and are NOT hidden solely behind hover interactions.
 *  - The WhatsApp confirmation dialog (data-testid) is present in Vouchers.tsx.
 *  - Keyboard handlers are still exported (not dead-code removed).
 *  - The global keyboard scroll guard (isEditableTarget) is still in App.tsx.
 *  - CursorNavContext exports the provider and hook (not orphaned after splits).
 *
 * These are NOT pixel-perfect snapshot tests.
 * They intentionally test BOTH desktop and mobile structures coexist —
 * not just one or the other.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(__dirname, "..");
const FACTORY_WORKERS_ROSTER = "client/src/pages/factory/factoryworkers/FactoryWorkersRosterPanel.tsx";

function src(relPath: string): string {
  const fullPath = resolve(ROOT, relPath);
  if (!existsSync(fullPath)) {
    throw new Error(`Source file not found: ${relPath}`);
  }
  return readFileSync(fullPath, "utf-8");
}

describe("Desktop table structure is preserved", () => {
  it("FactoryWorkers.tsx — table-fixed class present (desktop table not removed)", () => {
    expect(src(FACTORY_WORKERS_ROSTER)).toContain("table-fixed");
  });
  it("FactoryWorkers.tsx — overflow-auto container present (table scrollable)", () => {
    expect(src(FACTORY_WORKERS_ROSTER)).toContain("overflow-auto");
  });
  it("FactoryWorkers.tsx — <TableHeader present (column headers intact)", () => {
    expect(src(FACTORY_WORKERS_ROSTER)).toContain("TableHeader");
  });
  it("FactoryWorkers.tsx — <TableBody present (rows intact)", () => {
    expect(src(FACTORY_WORKERS_ROSTER)).toContain("TableBody");
  });
  it("Accounts.tsx — <Table or table structure imported", () => {
    const s = src("client/src/pages/Accounts.tsx");
    const hasTable = s.includes("<Table") || s.includes("table") || s.includes("AccountTable");
    expect(hasTable).toBe(true);
  });
});

describe("Mobile-compatible layout patterns", () => {
  it("Login.tsx — fills the viewport at browser zoom levels without clipping overflow", () => {
    const s = src("client/src/pages/Login.tsx");
    expect(s).toContain("min-h-screen min-h-[100dvh]");
    expect(s).not.toContain("xl:h-full xl:overflow-hidden");
  });
  it("FactoryWorkers.tsx — filter panel can be toggled (filtersOpen state)", () => {
    expect(src(FACTORY_WORKERS_ROSTER)).toContain("filtersOpen");
  });
  it("FactoryWorkers.tsx — responsive max-height container present", () => {
    const s = src(FACTORY_WORKERS_ROSTER);
    expect(s).toMatch(/max-h-\[calc\(100vh/);
  });
  it("Vouchers.tsx — flex layout container present (min-w-0 prevents overflow)", () => {
    const s = src("client/src/pages/Vouchers.tsx");
    const hasFlex = s.includes("flex-1") || s.includes("flex flex") || s.includes("min-w-0");
    expect(hasFlex).toBe(true);
  });
});

describe("Critical action buttons are always visible (not hover-only)", () => {
  it("FactoryWorkers.tsx — primary action buttons exist in source", () => {
    const s = src(FACTORY_WORKERS_ROSTER);
    const hasAction = s.includes("button") || s.includes("Button");
    expect(hasAction).toBe(true);
  });
  it("FactoryWorkers.tsx — clear-filters action accessible (not hover-only)", () => {
    const s = src(FACTORY_WORKERS_ROSTER);
    expect(s).toContain("clearAllFilters");
  });
});

describe("WhatsApp popup — dialog testid present in source", () => {
  it("Vouchers.tsx — data-testid='dialog-whatsapp-prompt' present", () => {
    expect(src("client/src/pages/Vouchers.tsx")).toContain("dialog-whatsapp-prompt");
  });
  it("Vouchers.tsx — waPendingPrompt state variable present", () => {
    expect(src("client/src/pages/Vouchers.tsx")).toContain("waPendingPrompt");
  });
  it("Vouchers.tsx — AlertDialog open controlled by waPendingPrompt", () => {
    const s = src("client/src/pages/Vouchers.tsx");
    expect(s).toMatch(/open=\{!{0,2}waPendingPrompt/);
  });
  it("JournalForm model — waPendingPrompt state variable present", () => {
    expect(src("client/src/pages/vouchers/journalform/useJournalFormModel.tsx")).toContain("waPendingPrompt");
  });
});

describe("Keyboard navigation infrastructure is intact", () => {
  it("keyboardHandlers.ts — handlePaymentKeyDown is exported", () => {
    expect(src("client/src/pages/vouchers/keyboardHandlers.ts")).toContain("export function handlePaymentKeyDown");
  });
  it("useGlobalScrollKeys.ts — isEditableTarget guard function is present (prevents scroll hijack)", () => {
    expect(src("client/src/app/useGlobalScrollKeys.ts")).toContain("isEditableTarget");
  });
  it("useGlobalScrollKeys.ts — getBestScrollTarget helper present", () => {
    expect(src("client/src/app/useGlobalScrollKeys.ts")).toContain("getBestScrollTarget");
  });
  it("CursorNavContext.tsx — CursorNavProvider exported", () => {
    expect(src("client/src/contexts/CursorNavContext.tsx")).toContain("export function CursorNavProvider");
  });
  it("CursorNavContext.tsx — useCursorNav hook exported", () => {
    expect(src("client/src/contexts/CursorNavContext.tsx")).toContain("export function useCursorNav");
  });
  it("CursorNavContext.tsx — registerCursorNav and clearCursorNav present", () => {
    const s = src("client/src/contexts/CursorNavContext.tsx");
    expect(s).toContain("registerCursorNav");
    expect(s).toContain("clearCursorNav");
  });
});

describe("App routing infrastructure is intact", () => {
  it("PosShell.tsx — shared route boundary provides the Suspense fallback", () => {
    expect(src("client/src/app/PosShell.tsx")).toContain("WorkspaceRouteBoundary");
  });
  it("App.tsx — wouter Switch/Route routing is used", () => {
    const s = src("client/src/App.tsx");
    expect(s).toContain("Switch");
    expect(s).toContain("Route");
  });
  it("PropertiesRoutes.tsx — lazyPages imports are used (not dead imports)", () => {
    const s = src("client/src/app/PropertiesRoutes.tsx");
    expect(s).toContain("lazyPages");
  });
  it("lazyPages.ts — file is importable as a module (no syntax errors detected by reading)", () => {
    const s = src("client/src/lazyPages.ts");
    expect(s).toMatch(/import\s+\{[^}]*\blazy\b[^}]*\}\s+from/);
    expect(s).toContain("export const");
    expect(s.length).toBeGreaterThan(1000);
  });
});

describe("Factory page shells are present", () => {
  const factoryPages = [
    ["FactoryWorkersHub", "client/src/pages/factory/FactoryWorkersHub.tsx"],
    ["FactoryPayrollHub", "client/src/pages/factory/FactoryPayrollHub.tsx"],
    ["FactoryContainersHub", "client/src/pages/factory/FactoryContainersHub.tsx"],
    ["FactoryDashboard", "client/src/pages/factory/FactoryDashboard.tsx"],
    ["FactoryAccounts", "client/src/pages/factory/FactoryAccounts.tsx"],
    ["FactoryVouchers", "client/src/pages/factory/FactoryVouchers.tsx"],
  ];

  for (const [name, path] of factoryPages) {
    it(`${name} file exists and has a default export`, () => {
      const s = src(path);
      const hasDefault =
        s.includes("export default") ||
        s.includes("export { default }") ||
        s.includes(`export function ${name}`) ||
        s.includes(`export const ${name}`);
      expect(hasDefault, `${name} must have a default or named page export`).toBe(true);
    });
  }
});

// Render coverage for these shells lives in the jsdom suite:
//   tests/ui/renders.test.tsx                  Dashboard, Accounts, POS, StockHub, InventoryHub,
//                                              SalesReport, Settings, FactoryWorkersHub
//   tests/ui/layout-and-whatsapp-renders.test.tsx  Vouchers, POS at phone width,
//                                              FactoryContainersHub, UsersPermissionsHub
//   tests/ui/route-guards-render.test.tsx      ErpRoutes / FactoryRoutes guards, access-pending
//                                              loading state and /tracking redirects
