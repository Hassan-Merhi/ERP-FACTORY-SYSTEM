import { Suspense, useState, useRef } from "react";
import { useLocation } from "wouter";
import { useMainContentFocus } from "@/hooks/use-main-content-focus";
import { useWorkspaceWheelScroll } from "@/hooks/use-workspace-wheel-scroll";
import { useButtonClickFeedback } from "@/hooks/use-button-click-feedback";
import { useCompany } from "@/contexts/CompanyContext";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { AppModeProvider } from "@/contexts/AppModeContext";
import { SidebarProvider } from "@/components/ui/sidebar";
import { DailyRateModal } from "@/components/DailyRateModal";
import { FactorySidebar } from "@/components/FactorySidebar";
import { FactoryRoutes } from "@/components/FactoryRoutes";
import { FactoryCatalogLanguageSwitch } from "@/components/FactoryCatalogLanguageSwitch";
import { AppTopBar } from "@/components/AppTopBar";
import { OfflineBanner } from "@/components/OfflineBanner";
import { MODULE_ACCENT } from "@/components/sidebar/sidebarPrimitives";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { CommandPalette } from "@/components/CommandPalette";
import { SkipLink } from "@/components/ui/responsive-accessibility";
import { WorkspaceRouteBoundary } from "@/components/ui/workspace-route-boundary";
import type { MyAccess } from "./factoryAccessGuard";
import { canUseAdminSearch, type ShellUser } from "./shellUser";
import { lazyRetry as lazy } from "@/lib/lazyRetry";
import { useDocumentAppShell } from "@/hooks/use-document-app-shell";
import { useVisualViewportMetrics } from "@/hooks/use-visual-viewport-metrics";
import "@/mobile-shell-dialogs.css";
import "@/factory-mobile-operations.css";

const FactoryFrenchCatalogManager = lazy(() =>
  import("@/components/FactoryFrenchCatalogManager").then((module) => ({
    default: module.FactoryFrenchCatalogManager,
  }))
);
const FactoryBilingualDocumentActions = lazy(() =>
  import("@/components/FactoryBilingualDocumentActions").then((module) => ({
    default: module.FactoryBilingualDocumentActions,
  }))
);
const HistoricalReplaySafetyPanel = lazy(() =>
  import("@/components/HistoricalReplaySafetyPanel").then((module) => ({
    default: module.HistoricalReplaySafetyPanel,
  }))
);
const HistoricalReplayNetEffectPanel = lazy(() =>
  import("@/components/HistoricalReplayNetEffectPanel").then((module) => ({
    default: module.HistoricalReplayNetEffectPanel,
  }))
);

interface FactoryShellProps {
  user: ShellUser;
  myAccess: MyAccess | undefined;
  factoryDefaultPage: string;
  handleLogout: () => void;
  leaveConfirmDialog: React.ReactNode;
}

const factoryWorkspaceClasses = [
  "[&_button]:touch-manipulation",
  "max-sm:[&_button]:min-h-11",
  "max-sm:[&_input]:min-h-11",
  "max-sm:[&_input]:text-base",
  "max-sm:[&_select]:min-h-11",
  "max-sm:[&_textarea]:min-h-24",
  "[&_form]:min-w-0",
  "[&_form]:max-w-full",
  "[&_fieldset]:min-w-0",
  "[&_img]:max-w-full",
  "[&_[role=tablist]]:max-w-full",
  "[&_[role=listbox]]:max-h-[min(24rem,70dvh)]",
  "[&_[data-mobile-data-list]]:max-w-full",
  "[&_[data-table-scroll-region]]:max-w-full",
].join(" ");

export function FactoryShell({
  user,
  myAccess,
  factoryDefaultPage,
  handleLogout,
  leaveConfirmDialog,
}: FactoryShellProps) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [currentLocation] = useLocation();
  const { selectedCompany } = useCompany();
  const { language, t } = useApplicationLanguage();
  const factoryContainerRef = useRef<HTMLDivElement>(null);
  useButtonClickFeedback(factoryContainerRef);

  const style = { "--sidebar-width": "16rem", "--sidebar-width-icon": "3rem" };
  const isRawStockRecalculateRoute =
    currentLocation === "/factory/raw-stock/recalculate" ||
    currentLocation.startsWith("/factory/raw-stock/recalculate?");
  const isBilingualDocumentRoute =
    /^\/factory\/sales\/pending-invoices\/\d+\/verify(?:\?|$)/.test(currentLocation) ||
    /^\/factory\/invoices\/\d+\/loading-scan(?:\?|$)/.test(currentLocation);
  useMainContentFocus(currentLocation);
  useWorkspaceWheelScroll(factoryContainerRef);
  // Phone dialogs open as bottom sheets sized to the visible viewport (mobile-shell-dialogs.css),
  // so the on-screen keyboard never hides their actions.
  useDocumentAppShell("factory");
  useVisualViewportMetrics();
  const hasAdminSearch = canUseAdminSearch(user);

  return (
    <AppModeProvider mode="factory">
      <SkipLink>{t("accessibility.skipToMainContent")}</SkipLink>
      <SidebarProvider style={style as React.CSSProperties}>
        <div ref={factoryContainerRef} className="flex h-full w-full min-w-0 overflow-hidden">
          {selectedCompany?.id && <DailyRateModal companyId={selectedCompany.id} />}
          <FactorySidebar user={user} onLogout={handleLogout} />
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <OfflineBanner />
            <AppTopBar
              accentColor={MODULE_ACCENT.factory}
              user={{ username: user.username, role: user.role ?? "" }}
              onLogout={handleLogout}
              onSearchOpen={() => setPaletteOpen(true)}
            />
            <main
              id="main-content"
              tabIndex={-1}
              aria-label="Factory and inventory workspace"
              data-factory-workspace="true"
              className={`flex-1 overflow-y-auto overscroll-y-contain p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] outline-none sm:p-6 ${factoryWorkspaceClasses}`}
            >
              <WorkspaceRouteBoundary
                resetKey={currentLocation}
                loadingTitle="Loading factory workspace"
                loadingDescription="Preparing the latest factory and inventory information."
              >
                <FactoryCatalogLanguageSwitch />
                <Suspense fallback={null}>
                  {language === "fr" ? <FactoryFrenchCatalogManager /> : null}
                  {isBilingualDocumentRoute ? <FactoryBilingualDocumentActions /> : null}
                  <ErrorBoundary resetKey={`${currentLocation}:historical-replay-preview`}>
                    {isRawStockRecalculateRoute ? (
                      <>
                        <HistoricalReplaySafetyPanel />
                        <HistoricalReplayNetEffectPanel />
                      </>
                    ) : null}
                  </ErrorBoundary>
                </Suspense>
                <FactoryRoutes user={user} myAccess={myAccess} factoryDefaultPage={factoryDefaultPage} />
              </WorkspaceRouteBoundary>
            </main>
          </div>
        </div>
      </SidebarProvider>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        hasErpAccess={false}
        hasFactoryAccess={true}
        isAdminOwner={hasAdminSearch}
        user={user}
      />
      {leaveConfirmDialog}
    </AppModeProvider>
  );
}
