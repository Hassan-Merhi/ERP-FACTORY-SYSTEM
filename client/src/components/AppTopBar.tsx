import { type ReactNode, Suspense, useEffect } from "react";
import { lazyRetry as lazy } from "@/lib/lazyRetry";
import { useLocation } from "wouter";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Search } from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { CompanySelector } from "@/components/CompanySelector";
import { useApplicationDirection, useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";

const MobileWorkspaceControls = lazy(() => import("@/components/MobileWorkspaceControls"));
const WorkspaceHeaderControls = lazy(() =>
  import("@/components/MobileWorkspaceControls").then((module) => ({
    default: module.WorkspaceHeaderControls,
  }))
);

interface AppTopBarProps {
  accentColor: string;
  user: { username: string; role: string };
  onLogout: () => void;
  onSearchOpen?: () => void;
  showSearch?: boolean;
  leftContent?: ReactNode;
  extraActions?: ReactNode;
  mobileMoreOpen?: boolean;
  onMobileMoreOpenChange?: (open: boolean) => void;
  simplifyMobileNavigation?: boolean;
}

export function AppTopBar({
  accentColor,
  user,
  onLogout,
  onSearchOpen,
  showSearch = true,
  leftContent,
  extraActions,
  mobileMoreOpen,
  onMobileMoreOpenChange,
  simplifyMobileNavigation = false,
}: AppTopBarProps) {
  const [currentLocation] = useLocation();
  const { isMobile, setOpenMobile } = useSidebar();
  const direction = useApplicationDirection();
  const { t } = useApplicationLanguage();
  const dividerDirection = direction === "rtl" ? "to left" : "to right";
  const workspaceControlsFallbackClassName = simplifyMobileNavigation
    ? "hidden h-8 w-8 shrink-0 sm:block"
    : "h-10 w-10 shrink-0";

  useEffect(() => {
    if (isMobile) setOpenMobile(false);
  }, [currentLocation, isMobile, setOpenMobile]);

  return (
    <header
      data-slot="app-top-bar"
      className="relative flex min-h-14 flex-nowrap items-center justify-between gap-1.5 px-2.5 sm:gap-3 sm:px-4 no-print"
    >
      <div
        data-slot="app-top-bar-divider"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px"
        style={{
          background: `linear-gradient(${dividerDirection}, ${accentColor}cc 0%, ${accentColor}44 30%, hsl(var(--border)) 65%)`,
        }}
      />

      <div data-slot="app-top-bar-leading" className="flex min-w-0 shrink-0 items-center gap-1.5 sm:gap-2.5">
        <SidebarTrigger
          data-testid="button-sidebar-toggle"
          // ERP phones open pages from the bottom navigation's More menu, so the sidebar toggle
          // would only duplicate it there.
          className={
            simplifyMobileNavigation
              ? "hidden h-10 w-10 shrink-0 text-foreground sm:inline-flex sm:h-8 sm:w-8"
              : "!inline-flex h-10 w-10 shrink-0 text-foreground sm:h-8 sm:w-8"
          }
          aria-label={t("accessibility.toggleSidebar")}
        />
        {leftContent && <div className="hidden min-w-0 sm:block">{leftContent}</div>}
      </div>

      {simplifyMobileNavigation && (
        <div className="flex min-w-0 flex-1 justify-center sm:hidden">
          <CompanySelector showMobileName />
        </div>
      )}

      <div
        data-slot="app-top-bar-actions"
        className="ml-auto flex min-w-0 shrink-0 flex-nowrap items-center gap-0.5 sm:gap-1.5"
      >
        {extraActions && <div className="hidden items-center sm:flex">{extraActions}</div>}

        {showSearch && onSearchOpen && (
          <button
            onClick={onSearchOpen}
            data-testid="button-open-palette"
            aria-label={t("accessibility.openSearch")}
            className="hidden h-8 items-center gap-2 rounded-full border border-border/60 bg-muted/40 px-3 text-xs text-muted-foreground transition-colors hover-elevate sm:flex"
          >
            <Search className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="hidden lg:inline">Search</span>
            <kbd className="inline-flex h-4 items-center rounded border border-border bg-background px-1.5 font-mono text-[9px] leading-none">
              {typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.platform) ? "⌘ /" : "Ctrl /"}
            </kbd>
          </button>
        )}

        {!simplifyMobileNavigation && showSearch && onSearchOpen && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onSearchOpen}
            data-testid="button-open-palette-sm"
            aria-label={t("accessibility.openSearch")}
            className="h-10 w-10 shrink-0 sm:hidden"
          >
            <Search className="h-4 w-4" aria-hidden="true" />
          </Button>
        )}

        <Suspense fallback={<span className={workspaceControlsFallbackClassName} aria-hidden="true" />}>
          <WorkspaceHeaderControls
            accentColor={accentColor}
            user={user}
            onLogout={onLogout}
            simplifyMobileNavigation={simplifyMobileNavigation}
          />
        </Suspense>

        {simplifyMobileNavigation ? (
          <span className="hidden sm:block">
            <CompanySelector />
          </span>
        ) : (
          <CompanySelector />
        )}

        <span className="hidden sm:block">
          <ThemeToggle />
        </span>

        <Suspense fallback={<span className="h-10 w-10 shrink-0 sm:hidden" aria-hidden="true" />}>
          <MobileWorkspaceControls
            accentColor={accentColor}
            user={user}
            onLogout={onLogout}
            onSearchOpen={onSearchOpen}
            showSearch={showSearch}
            extraActions={extraActions}
            open={mobileMoreOpen}
            onOpenChange={onMobileMoreOpenChange}
            simplifyMobileNavigation={simplifyMobileNavigation}
          />
        </Suspense>
      </div>
    </header>
  );
}
