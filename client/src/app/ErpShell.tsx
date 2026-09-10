import { useEffect, useState, useRef } from "react";
import { useLocation } from "wouter";
import { useMainContentFocus } from "@/hooks/use-main-content-focus";
import { useWorkspaceWheelScroll } from "@/hooks/use-workspace-wheel-scroll";
import { useCompany } from "@/contexts/CompanyContext";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { AppModeProvider } from "@/contexts/AppModeContext";
import { SidebarProvider } from "@/components/ui/sidebar";
import { DailyRateModal } from "@/components/DailyRateModal";
import { AppSidebar } from "@/components/AppSidebar";
import { AppTopBar } from "@/components/AppTopBar";
import { OfflineBanner } from "@/components/OfflineBanner";
import { CommandPalette } from "@/components/CommandPalette";
import { SkipLink } from "@/components/ui/responsive-accessibility";
import { WorkspaceRouteBoundary } from "@/components/ui/workspace-route-boundary";
import { Router } from "@/routes/AppRoutes";
import { installErpNavigationHistory } from "@/lib/erp-navigation-history";
import { canUseAdminSearch, type ShellUser } from "./shellUser";
import { ErpAccessBoundary } from "./ErpAccessBoundary";
import { MODULE_ACCENT } from "@/components/sidebar/sidebarPrimitives";
import "@/erp-mobile-operations.css";

interface ErpShellProps {
  user: ShellUser;
  hasErpAccess: boolean;
  handleLogout: () => void;
  leaveConfirmDialog: React.ReactNode;
}

function CompanyDailyRateModal() {
  const { selectedCompany } = useCompany();
  if (!selectedCompany?.id) return null;
  return <DailyRateModal companyId={selectedCompany.id} />;
}

export function ErpShell({ user, hasErpAccess, handleLogout, leaveConfirmDialog }: ErpShellProps) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [currentLocation] = useLocation();
  const { t } = useApplicationLanguage();
  const style = { "--sidebar-width": "16rem", "--sidebar-width-icon": "3rem" };
  const hasAdminSearch = canUseAdminSearch(user);
  const erpContainerRef = useRef<HTMLDivElement>(null);
  const routePath = currentLocation.split("?")[0] || "/";
  useMainContentFocus(currentLocation);
  useWorkspaceWheelScroll(erpContainerRef);

  useEffect(() => installErpNavigationHistory(), []);

  return (
    <AppModeProvider mode="erp">
      <ErpAccessBoundary user={user}>
        <SkipLink>{t("accessibility.skipToMainContent")}</SkipLink>
        <SidebarProvider style={style as React.CSSProperties}>
          <div ref={erpContainerRef} className="flex h-full w-full min-w-0 overflow-hidden">
            <CompanyDailyRateModal />
            <AppSidebar user={user} />
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
              <OfflineBanner />
              <AppTopBar
                accentColor={MODULE_ACCENT.erp}
                user={{ username: user.username, role: user.role ?? "" }}
                onLogout={handleLogout}
                onSearchOpen={() => setPaletteOpen(true)}
              />
              <main
                id="main-content"
                tabIndex={-1}
                aria-label={t("workspace.controls")}
                className="flex-1 overflow-y-auto overscroll-y-contain p-3 outline-none sm:p-6"
              >
                <WorkspaceRouteBoundary
                  resetKey={currentLocation}
                  loadingTitle="Loading workspace"
                  loadingDescription="Preparing the latest ERP information."
                >
                  <div data-erp-route={routePath} className="w-full min-w-0 max-w-full">
                    <Router user={user} />
                  </div>
                </WorkspaceRouteBoundary>
              </main>
            </div>
          </div>
        </SidebarProvider>
        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          hasErpAccess={hasErpAccess}
          hasFactoryAccess={false}
          isAdminOwner={hasAdminSearch}
          user={user}
        />
        {leaveConfirmDialog}
      </ErpAccessBoundary>
    </AppModeProvider>
  );
}
