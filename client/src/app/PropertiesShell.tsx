import { useState, useRef } from "react";
import { useMainContentFocus } from "@/hooks/use-main-content-focus";
import { useWorkspaceWheelScroll } from "@/hooks/use-workspace-wheel-scroll";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { AppModeProvider } from "@/contexts/AppModeContext";
import { SidebarProvider } from "@/components/ui/sidebar";
import { PropertiesSidebar } from "@/components/PropertiesSidebar";
import { AppTopBar } from "@/components/AppTopBar";
import { OfflineBanner } from "@/components/OfflineBanner";
import { CommandPalette } from "@/components/CommandPalette";
import { SkipLink } from "@/components/ui/responsive-accessibility";
import { WorkspaceRouteBoundary } from "@/components/ui/workspace-route-boundary";
import { PropertiesRoutes } from "@/app/PropertiesRoutes";
import { canUseAdminSearch, type ShellUser } from "./shellUser";
import { MODULE_ACCENT } from "@/components/sidebar/sidebarPrimitives";

interface PropertiesShellProps {
  user: ShellUser;
  currentLocation: string;
  handleLogout: () => void;
  leaveConfirmDialog: React.ReactNode;
}

export function PropertiesShell({ user, currentLocation, handleLogout, leaveConfirmDialog }: PropertiesShellProps) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { t } = useApplicationLanguage();
  const style = { "--sidebar-width": "16rem", "--sidebar-width-icon": "3rem" };
  const propertiesContainerRef = useRef<HTMLDivElement>(null);
  useMainContentFocus(currentLocation);
  useWorkspaceWheelScroll(propertiesContainerRef);
  const hasAdminSearch = canUseAdminSearch(user);

  return (
    <AppModeProvider mode="properties">
      <SkipLink>{t("accessibility.skipToMainContent")}</SkipLink>
      <SidebarProvider style={style as React.CSSProperties}>
        <div ref={propertiesContainerRef} className="flex h-full w-full min-w-0 overflow-hidden">
          <PropertiesSidebar user={user} onLogout={handleLogout} />
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <OfflineBanner />
            <AppTopBar
              accentColor={MODULE_ACCENT.properties}
              user={{ username: user.username, role: user.role ?? "" }}
              onLogout={handleLogout}
              onSearchOpen={() => setPaletteOpen(true)}
            />
            <main
              id="main-content"
              tabIndex={-1}
              aria-label="Properties workspace"
              className="flex-1 overflow-y-auto overscroll-y-contain p-3 outline-none sm:p-6"
            >
              <WorkspaceRouteBoundary
                resetKey={currentLocation}
                loadingTitle="Loading properties workspace"
                loadingDescription="Preparing the latest property and rental information."
              >
                <PropertiesRoutes user={user} />
              </WorkspaceRouteBoundary>
            </main>
          </div>
        </div>
      </SidebarProvider>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        hasErpAccess={false}
        hasFactoryAccess={false}
        hasPropertiesAccess={true}
        isAdminOwner={hasAdminSearch}
        user={user}
      />
      {leaveConfirmDialog}
    </AppModeProvider>
  );
}
