import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

describe("Wave 2 frontend speed contracts", () => {
  it("keeps English off the DOM translation runtime and lazy-loads non-English catalogs", () => {
    const provider = source("client/src/contexts/ApplicationLanguageContext.tsx");
    const translator = source("client/src/components/ApplicationInterfaceTranslator.tsx");
    const vite = source("vite.config.ts");

    expect(provider).not.toContain("import { ApplicationInterfaceTranslator }");
    expect(provider).toContain('import("@/components/ApplicationInterfaceTranslator")');
    expect(provider).toContain("loadApplicationTranslationCatalog(language)");
    expect(provider).toContain('language !== "en" && translationReady');

    expect(translator).toContain('if (language === "en") return;');
    expect(translator).toContain("portalObserver.observe(document.body, { childList: true });");
    expect(translator).not.toContain("portalObserver.observe(document.body, { childList: true, subtree: true });");

    expect(vite).not.toContain('return "application-translations"');
  });

  it("keeps public login and native authentication libraries out of authenticated startup", () => {
    const app = source("client/src/App.tsx");
    const login = source("client/src/pages/Login.tsx");
    const authSession = source("client/src/app/useAuthenticatedUser.ts");

    expect(app).not.toContain('import Login from "@/pages/Login"');
    expect(app).toContain('lazy(() => import("@/pages/Login"))');
    expect(authSession).not.toContain('from "@/pages/Login"');
    expect(authSession).toContain('from "@/lib/biometricCredentials"');

    for (const staticImport of [
      'from "@capacitor/core"',
      'from "@capacitor/preferences"',
      'from "@aparajita/capacitor-biometric-auth"',
      'from "@simplewebauthn/browser"',
    ]) {
      expect(login).not.toContain(staticImport);
    }

    // Stored-credential reads moved to biometricCredentials, which the auth
    // session imports eagerly, so its Preferences import must stay dynamic.
    const credentials = source("client/src/lib/biometricCredentials.ts");
    expect(credentials).not.toContain('from "@capacitor/preferences"');
    expect(credentials).toContain('import("@capacitor/preferences")');
    expect(login).toContain('import("@aparajita/capacitor-biometric-auth")');
    expect(login).toContain('import("@simplewebauthn/browser")');
  });

  it("keeps authenticated utility and remote-support code off the immediate boot path", () => {
    const app = source("client/src/App.tsx");
    const overlays = source("client/src/app/AuthenticatedAppOverlays.tsx");
    const screenFeed = source("client/src/hooks/use-screen-feed.ts");

    for (const staticImport of [
      'import { ChatWidget } from "@/components/ChatWidget"',
      'import { UserNotesPanel } from "@/components/UserNotesPanel"',
      'import { DateJumpDialog } from "@/components/DateJumpDialog"',
      'import { KeyboardShortcuts } from "@/components/KeyboardShortcuts"',
    ]) {
      expect(app).not.toContain(staticImport);
    }

    expect(app).toContain("useIdleAuthenticatedUtilities");
    expect(app).toContain('import("@/components/ChatWidget")');
    expect(overlays).toContain("useDeferredRemoteSupport");
    expect(overlays).toContain('import("@/components/RemoteSupportRuntime")');

    expect(screenFeed).not.toContain("  captureAndUploadScreenFrame,");
    expect(screenFeed).toContain('import("./screen-feed-capture-engine")');
  });

  it("keeps broad mutation scanning and polling out of the optimized translation/dialog bridges", () => {
    const translator = source("client/src/components/ApplicationInterfaceTranslator.tsx");
    const dialogFix = source("client/src/hooks/use-dialog-scroll-fix.ts");
    const baleBridge = source("client/src/components/BaleProductArabicEditBridge.tsx");

    expect(translator).toContain("existing.contains(node)");
    expect(dialogFix).not.toContain('"style"]');
    expect(dialogFix).toContain('attributeFilter: ["data-state", "aria-hidden"]');
    expect(baleBridge).not.toContain("setInterval(sync, 300)");
    expect(baleBridge).toContain("requestAnimationFrame");
  });

  it("virtualizes only the known large table surfaces and leaves the threshold high", () => {
    const tracking = source("client/src/pages/git-containers/ContainerTable.tsx");
    const accounts = source("client/src/pages/accounts/AccountTransactionRows.tsx");
    const hook = source("client/src/hooks/useBoundedTableRows.ts");

    expect(tracking).toContain("minimumRows: 100");
    expect(accounts).toContain("minimumRows: 120");
    expect(hook).toContain("minimumRows = 120");
    expect(hook).toContain("rowCount > minimumRows");
  });

  it("memoizes reusable KPI primitives and expensive large-table derivations", () => {
    expect(source("client/src/components/StatCard.tsx")).toContain("memo(StatCardComponent)");
    expect(source("client/src/components/KPICard.tsx")).toContain("memo(KPICardComponent)");
    expect(source("client/src/components/FactoryKpiCard.tsx")).toContain("memo(FactoryKpiCardComponent)");
    expect(source("client/src/components/FinancialSummaryCard.tsx")).toContain("memo(FinancialSummaryCardComponent)");

    expect(source("client/src/pages/accounts/AccountTransactionRows.tsx")).toContain("useMemo(() =>");
    expect(source("client/src/pages/git-containers/ContainerTable.tsx")).toContain("React.useMemo(");
  });

  it("keeps export-heavy report and POS detail routes lazy", () => {
    const erpRoutes = source("client/src/routes/ErpRoutes.tsx");
    const posRoutes = source("client/src/routes/PosRoutes.tsx");
    const posDetail = source("client/src/pages/pos/POSContainerDetail.tsx");
    const lazyPages = source("client/src/lazyPages.ts");

    expect(erpRoutes).not.toContain('import StockInSalesReport from "@/pages/StockInSalesReport"');
    expect(lazyPages).toContain('StockInSalesReport = lazy(() => import("@/pages/StockInSalesReport"))');

    expect(posRoutes).not.toContain('import POSContainerDetail from "@/pages/pos/POSContainerDetail"');
    expect(lazyPages).toContain('POSContainerDetail = lazy(() => import("@/pages/pos/POSContainerDetail"))');
    expect(posDetail).not.toContain('import { ExcelJS } from "@/lib/excelHelper"');
    expect(posDetail).toContain('await import("@/lib/excelHelper")');
  });

  it("enforces heavy-library startup boundaries during production builds", () => {
    const audit = source("build/viteInitialChunkAuditPlugin.ts");
    const vite = source("vite.config.ts");

    for (const marker of [
      "/node_modules/exceljs/",
      "/node_modules/@fortune-sheet/",
      "/node_modules/xlsx-js-style/",
      "/node_modules/jspdf/",
      "/node_modules/html2canvas/",
      "/node_modules/recharts/",
    ]) {
      expect(audit).toContain(marker);
    }

    expect(audit).toContain("staticJsKiB");
    expect(audit).toContain("wave2-initial-chunk-audit.json");
    expect(vite).toContain("initialChunkAuditPlugin()");
  });
});
