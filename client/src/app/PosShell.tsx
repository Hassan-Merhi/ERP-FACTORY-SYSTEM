import { useState, useRef } from "react";
import { useLocation } from "wouter";
import { useMainContentFocus } from "@/hooks/use-main-content-focus";
import { useDocumentAppShell } from "@/hooks/use-document-app-shell";
import { useVisualViewportMetrics } from "@/hooks/use-visual-viewport-metrics";
import { useCompany } from "@/contexts/CompanyContext";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { SidebarProvider } from "@/components/ui/sidebar";
import { PhoneSheetDialogs } from "@/components/ui/phone-sheet";
import { AppTopBar } from "@/components/AppTopBar";
import { DailyRateModal } from "@/components/DailyRateModal";
import { OfflineBanner } from "@/components/OfflineBanner";
import { CommandPalette } from "@/components/CommandPalette";
import { ModuleIdentity } from "@/components/navigation/module-identity";
import { MODULE_ACCENT } from "@/components/sidebar/sidebarPrimitives";
import { Router } from "@/routes/AppRoutes";
import { Button } from "@/components/ui/button";
import { SkipLink } from "@/components/ui/responsive-accessibility";
import { WorkspaceRouteBoundary } from "@/components/ui/workspace-route-boundary";
import { ArrowLeft, Search, ShoppingCart, TreePine } from "lucide-react";
import { PosSidebar } from "./PosSidebar";
import { canUseAdminSearch, type ShellUser } from "./shellUser";
import { useChristmasMode } from "@/hooks/useChristmasMode";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import "@/styles/pos-sidebar-modern.css";

interface PosShellProps {
  user: ShellUser;
  posImportEnabled: boolean;
  chatUnread: { count: number } | undefined;
  handleGoBack: () => void;
  handleLogout: () => void;
  leaveConfirmDialog: React.ReactNode;
}

const posWorkspaceClasses = [
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
  "[&_table]:min-w-max",
  "[&_th]:whitespace-nowrap",
  "[&_td]:align-middle",
  "**:[[role=dialog]]:max-w-[calc(100vw-1rem)]",
  "**:[[role=listbox]]:max-h-[min(24rem,70dvh)]",
  "**:data-pos-mobile-page:max-w-full",
  "**:data-table-scroll-region:max-w-full",
  "[&_.tabular-nums]:font-variant-numeric-tabular-nums",
].join(" ");

/**
 * Routes that fill the workspace instead of scrolling it: the sale screens (ERP and Retail) and
 * the containers board. They keep their own internal scrolling and pinned checkout bars, so the
 * shell gives them a fixed-height, unpadded content area (the POS "focus" layout).
 */
function isPosFullHeightRoute(location: string): boolean {
  return (
    location === "/" ||
    location === "/pos" ||
    location === "/pos/" ||
    location === "/retail/pos" ||
    location === "/pos-containers" ||
    location.startsWith("/pos/edit/")
  );
}

/**
 * The POS role's app chrome, built from the shared shell pieces (sidebar primitives, AppTopBar,
 * phone sheets) that ERP, Factory and Properties use. Navigation items and route access still come
 * from `usePosNavigationItems` and `PosRoutes`, so what a POS user can open is unchanged.
 */
export function PosShell({
  user,
  posImportEnabled,
  chatUnread,
  handleGoBack,
  handleLogout,
  leaveConfirmDialog,
}: PosShellProps) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [currentLocation] = useLocation();
  const { settingQuery: christmasSetting, updatePersonalPreference } = useChristmasMode();
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const { t } = useApplicationLanguage();
  const style = { "--sidebar-width": "16rem", "--sidebar-width-icon": "3rem" };
  const isFullHeightRoute = isPosFullHeightRoute(currentLocation);
  const hasAdminSearch = canUseAdminSearch(user);
  const userMenuUser = { username: user.username, role: user.role ?? "POS" };
  const stationName = user.posStation ? `POS ${user.posStation}` : "Point of Sale";
  const posContainerRef = useRef<HTMLDivElement>(null);
  useMainContentFocus(currentLocation, isFullHeightRoute);
  // Shell-scoped dialog styling keys off this marker, as in the other shells.
  useDocumentAppShell("pos");
  // Phone sheets and dialogs size to the visible viewport, so the keyboard never hides their actions.
  useVisualViewportMetrics();

  const christmasSwitch =
    christmasSetting.data?.available === true ? (
      <label
        className="pos-christmas-switch flex items-center gap-2"
        title="Your personal Christmas Mode preference — controlled by the Developer master setting"
      >
        <TreePine className="h-4 w-4" aria-hidden="true" />
        <span className="hidden xl:inline">Christmas Mode</span>
        <Switch
          aria-label="Show Christmas Mode on my account"
          data-testid="switch-pos-christmas-mode"
          checked={christmasSetting.data.preferenceEnabled === true}
          disabled={updatePersonalPreference.isPending}
          onCheckedChange={(enabled) =>
            updatePersonalPreference.mutate(enabled, {
              onSuccess: () => toast({ title: enabled ? "Christmas Mode preference on" : "Christmas Mode turned off" }),
              onError: (error) =>
                toast({
                  title: "Could not change Christmas Mode",
                  description: error.message,
                  variant: "destructive",
                }),
            })
          }
        />
      </label>
    ) : null;

  return (
    <PhoneSheetDialogs>
      <SkipLink>{t("accessibility.skipToMainContent")}</SkipLink>
      <SidebarProvider style={style as React.CSSProperties}>
        <div
          ref={posContainerRef}
          data-pos-shell="true"
          className="flex h-full w-full min-w-0 overflow-hidden bg-background"
        >
          {selectedCompany?.id && <DailyRateModal companyId={selectedCompany.id} />}
          <PosSidebar
            user={user}
            posImportEnabled={posImportEnabled}
            chatUnread={chatUnread}
            onLogout={handleLogout}
            identity={
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 shrink-0 rounded-lg border border-sidebar-border/60"
                  onClick={handleGoBack}
                  aria-label="Go back"
                  data-testid="button-pos-back"
                >
                  <ArrowLeft data-directional-icon="true" className="h-4 w-4" aria-hidden="true" />
                </Button>
                <ModuleIdentity
                  compact
                  moduleName={user.posStation ? `POS ${user.posStation}` : "POS"}
                  companyName={selectedCompany?.name}
                  icon={ShoppingCart}
                  tone="pos"
                  className="min-w-0 flex-1 border-0 bg-transparent p-0 shadow-none"
                />
              </>
            }
          />
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <OfflineBanner />
            <AppTopBar
              accentColor={MODULE_ACCENT.pos}
              user={userMenuUser}
              onLogout={handleLogout}
              onSearchOpen={hasAdminSearch ? () => setPaletteOpen(true) : undefined}
              showSearch={hasAdminSearch}
              // POS sessions have no notifications feed (its API is outside the POS scope).
              showNotifications={false}
              leftContent={
                <span className="flex min-w-0 items-center gap-3">
                  <span className="block min-w-0 max-w-48">
                    <span data-business-value="true" dir="auto" className="block truncate text-sm font-semibold">
                      {stationName}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">{selectedCompany?.name}</span>
                  </span>
                  {currentLocation === "/pos-containers" && (
                    <button
                      type="button"
                      className="pos-top-search hidden min-w-0 items-center gap-2 lg:flex"
                      onClick={() =>
                        document.querySelector<HTMLInputElement>('[data-testid="input-pos-container-search"]')?.focus()
                      }
                      aria-label="Focus container search"
                      data-testid="button-pos-focus-container-search"
                    >
                      <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate text-left">Search containers, suppliers, trucks...</span>
                      <kbd className="pos-top-search-key">Search</kbd>
                    </button>
                  )}
                </span>
              }
              extraActions={
                christmasSwitch ? <span data-slot="pos-top-bar-actions">{christmasSwitch}</span> : undefined
              }
            />
            <main
              id="main-content"
              tabIndex={-1}
              aria-label="Point of sale workspace"
              data-pos-workspace="true"
              className={`${posWorkspaceClasses} outline-hidden ${
                isFullHeightRoute
                  ? "flex-1 min-w-0 overflow-hidden overscroll-contain"
                  : "flex-1 min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:p-6"
              }`}
            >
              <WorkspaceRouteBoundary
                resetKey={currentLocation}
                loadingTitle="Loading point of sale"
                loadingDescription="Preparing the latest sales workspace."
                fill={isFullHeightRoute}
              >
                <Router user={user} posImportEnabled={posImportEnabled} />
              </WorkspaceRouteBoundary>
            </main>
          </div>
        </div>
      </SidebarProvider>
      {hasAdminSearch && <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} isPOS={true} user={user} />}
      {leaveConfirmDialog}
    </PhoneSheetDialogs>
  );
}
