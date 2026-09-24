import { Children, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { WorkspaceActions } from "@/components/ui/workspace-layout";
import { ArrowLeft, ChevronUp, ChevronDown } from "lucide-react";
import { useCursorNav } from "@/contexts/CursorNavContext";
import { useBackToParent } from "@/hooks/use-back-to-parent";
import { getParentRoute } from "@/lib/parent-routes";
import { canGoBackToPreviousErpLocation } from "@/lib/erp-navigation-history";
import { useAppMode } from "@/contexts/AppModeContext";
import { useLocation } from "wouter";

export interface PageHeaderProps {
  title: React.ReactNode;
  /**
   * Explanatory copy. Hidden on ERP phones to keep the task title and actions in
   * view; use `meta` for contextual information that must stay visible.
   */
  subtitle?: React.ReactNode;
  /**
   * Contextual line (record name, period, company, status badges) that stays
   * visible at every width, unlike the explanatory `subtitle`.
   */
  meta?: React.ReactNode;
  /** Optional icon rendered inline next to the title. */
  icon?: React.ReactNode;
  showBackButton?: boolean;
  /** Optional deterministic Back target. When omitted, the parent-route registry is used. */
  backTarget?: string | null;
  /**
   * Page-specific Back behaviour (for example returning to a tab with its query
   * state). Replaces the shared history/parent-route handler when provided.
   */
  onBack?: () => void;
  /** Stable test id for the Back control; legacy pages keep their historical ids. */
  backButtonTestId?: string;
  /** @deprecated — Dashboard button has been removed globally. This prop is kept for backward compatibility but has no effect. */
  showHomeButton?: boolean;
  showCursorNavButtons?: boolean;
  children?: React.ReactNode;
}

function isManualPageBackControl(element: HTMLElement): boolean {
  const testId = element.getAttribute("data-testid")?.toLowerCase() || "";
  if (testId.includes("button-back") || testId.startsWith("back-") || testId.endsWith("-back")) return true;

  const label = (element.getAttribute("aria-label") || element.getAttribute("title") || element.textContent || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  return /^back(?:\s+to\b|\s*$)/.test(label);
}

export function PageHeader({
  title,
  subtitle,
  meta,
  icon,
  showBackButton = true,
  backTarget,
  onBack,
  backButtonTestId = "button-back",
  showCursorNavButtons = true,
  children,
}: PageHeaderProps) {
  const { config } = useCursorNav();
  const [location] = useLocation();
  const mode = useAppMode();
  const headerRef = useRef<HTMLElement>(null);
  const [hasNearbyManualBack, setHasNearbyManualBack] = useState(false);
  const resolvedBackTarget = backTarget === undefined ? getParentRoute(location) : backTarget;
  const hasTrackedErpBack = mode === "erp" && canGoBackToPreviousErpLocation();
  const handleSharedBack = useBackToParent(resolvedBackTarget);
  const handleBack = onBack ?? handleSharedBack;

  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;

    // Some legacy pages still own a page-level Back control while they are being
    // migrated to PageHeader. Suppress the shared control whenever one exists in
    // the same page container. Using the nearest page/main container avoids
    // unrelated Back controls rendered in dialogs, portals, tables, or sidebars.
    const scope =
      header.closest<HTMLElement>("[data-page-back-scope], main, [role='main'], .container") ??
      header.parentElement ??
      header;

    const detectManualBack = () => {
      const hasManualBack = Array.from(scope.querySelectorAll<HTMLElement>("button, a")).some((element) => {
        if (header.contains(element)) return false;
        return isManualPageBackControl(element);
      });
      setHasNearbyManualBack(hasManualBack);
    };

    detectManualBack();
    const observer = new MutationObserver(detectManualBack);
    observer.observe(scope, {
      attributes: true,
      attributeFilter: ["aria-label", "title", "data-testid"],
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => observer.disconnect();
  }, [location]);

  const hasBack = showBackButton && !hasNearbyManualBack && (!!onBack || !!resolvedBackTarget || hasTrackedErpBack);
  const hasNav = hasBack || (showCursorNavButtons && !!config);
  const isErp = mode === "erp";
  // Permission-gated actions render `false`/`null`; only reserve the action row
  // when at least one action is actually visible.
  const hasActions = Children.toArray(children).length > 0;

  const hasCursorNav = showCursorNavButtons && !!config;
  const navContent = hasNav ? (
    <>
      {hasBack && (
        <Button
          variant="ghost"
          size="sm"
          onClick={handleBack}
          className="gap-1 text-muted-foreground hover:text-foreground"
          data-testid={backButtonTestId}
          data-page-back-owner="shared"
          aria-label="Back"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          <span className="hidden sm:inline">Back</span>
        </Button>
      )}

      {hasCursorNav && (
        <>
          <Button
            variant="ghost"
            size="icon"
            onClick={config.onUp}
            disabled={!config.canNavigateUp}
            aria-label="Previous record"
            data-testid="button-cursor-up"
          >
            <ChevronUp className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={config.onDown}
            disabled={!config.canNavigateDown}
            aria-label="Next record"
            data-testid="button-cursor-down"
          >
            <ChevronDown className="h-4 w-4" aria-hidden="true" />
          </Button>
        </>
      )}
    </>
  ) : null;

  // ERP phones hide explanatory copy; `meta` carries anything that must stay visible.
  const subtitleLayout = cn("max-w-3xl", isErp && "hidden sm:block");
  const titleContent = (
    <>
      <h1
        className={cn(
          "flex min-w-0 items-center gap-2 font-bold tracking-tight sm:text-2xl",
          isErp ? "text-lg" : "text-xl"
        )}
        data-testid="text-page-title"
      >
        {icon && <span className="inline-flex shrink-0 text-muted-foreground">{icon}</span>}
        <span className="min-w-0 break-words">{title}</span>
      </h1>
      {subtitle && (
        <p className={cn("mt-1 text-sm text-muted-foreground", subtitleLayout)} data-testid="text-page-subtitle">
          {subtitle}
        </p>
      )}
      {meta && (
        <div
          className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-5 text-muted-foreground sm:text-sm"
          data-testid="text-page-meta"
        >
          {meta}
        </div>
      )}
    </>
  );

  if (!isErp) {
    // Factory / Properties / POS headers keep their established layout.
    return (
      <header
        ref={headerRef}
        className="mb-5 flex min-w-0 flex-col gap-3 border-b border-border pb-4"
        data-testid="page-header"
      >
        {hasNav && (
          <nav className="-ml-2 flex flex-wrap items-center gap-1" aria-label="Page navigation">
            {navContent}
          </nav>
        )}
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
          <div className="min-w-0 flex-1 border-l-[3px] border-primary pl-3">{titleContent}</div>
          {hasActions && (
            <WorkspaceActions className="shrink-0" data-testid="page-header-actions">
              {children}
            </WorkspaceActions>
          )}
        </div>
      </header>
    );
  }

  // ERP mobile contract. One grid serves every width:
  //  - phones: a lone Back control sits inline before the title (no separate
  //    navigation row) and actions wrap into shared, evenly filled rows below;
  //  - sm and up: navigation keeps its own row above a title/actions row whose
  //    actions align to the end, matching the established desktop header. The
  //    actions column shrinks to what the title leaves (at least 12rem) and its
  //    buttons wrap, so a tablet content area beside the sidebar never clips them.
  const inlineNav = hasNav && !hasCursorNav;
  const titleRow = hasNav ? "sm:row-start-2" : "sm:row-start-1";
  return (
    <header
      ref={headerRef}
      className="mb-3 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-1 gap-y-2 border-b border-border pb-3 sm:mb-5 sm:grid-cols-[minmax(min(12rem,100%),1fr)_minmax(0,max-content)] sm:gap-x-4 sm:gap-y-3 sm:pb-4"
      data-testid="page-header"
      data-erp-mobile-header="true"
    >
      {hasNav && (
        <nav
          className={cn(
            "-ms-2 flex items-center gap-1 sm:col-span-2 sm:col-start-1 sm:row-start-1 sm:flex-wrap",
            inlineNav ? "col-start-1 row-start-1" : "col-span-2 row-start-1 flex-wrap"
          )}
          aria-label="Page navigation"
        >
          {navContent}
        </nav>
      )}
      <div
        className={cn(
          "min-w-0 self-center border-l-[3px] border-primary pl-3 sm:col-span-1 sm:col-start-1 sm:self-end",
          titleRow,
          inlineNav ? "col-start-2 row-start-1" : hasNav ? "col-span-2 row-start-2" : "col-span-2 row-start-1"
        )}
      >
        {titleContent}
      </div>
      {hasActions && (
        <div
          role="group"
          aria-label="Page actions"
          className={cn(
            "col-span-2 flex min-w-0 flex-wrap items-center gap-2 sm:col-span-1 sm:col-start-2 sm:justify-end sm:self-end",
            titleRow,
            // Phone: fill each wrapped row evenly; each action keeps its full label.
            "[&>*]:min-w-0 [&>*]:flex-auto sm:[&>*]:flex-none",
            "[&>button]:justify-center [&>[data-slot]]:justify-center"
          )}
          data-testid="page-header-actions"
        >
          {children}
        </div>
      )}
    </header>
  );
}
