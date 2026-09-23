import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
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
  subtitle?: React.ReactNode;
  /** Optional icon rendered inline next to the title. */
  icon?: React.ReactNode;
  showBackButton?: boolean;
  /** Optional deterministic Back target. When omitted, the parent-route registry is used. */
  backTarget?: string | null;
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
  icon,
  showBackButton = true,
  backTarget,
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
  const handleBack = useBackToParent(resolvedBackTarget);

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

  const hasBack = showBackButton && !hasNearbyManualBack && (!!resolvedBackTarget || hasTrackedErpBack);
  const hasNav = hasBack || (showCursorNavButtons && !!config);
  const isErp = mode === "erp";

  return (
    <header
      ref={headerRef}
      className="mb-3 flex min-w-0 flex-col gap-2 border-b border-border pb-3 sm:mb-5 sm:gap-3 sm:pb-4"
      data-testid="page-header"
      data-erp-mobile-header={isErp ? "true" : undefined}
    >
      {hasNav && (
        <nav className="-ml-2 flex flex-wrap items-center gap-1" aria-label="Page navigation">
          {hasBack && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleBack}
              className="gap-1 text-muted-foreground hover:text-foreground"
              data-testid="button-back"
              data-page-back-owner="shared"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">Back</span>
            </Button>
          )}

          {showCursorNavButtons && config && (
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
        </nav>
      )}
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
        <div className="min-w-0 flex-1 border-l-[3px] border-primary pl-3">
          <h1
            className="flex min-w-0 items-center gap-2 text-lg font-bold tracking-tight sm:text-2xl"
            data-testid="text-page-title"
          >
            {icon && <span className="inline-flex shrink-0 text-muted-foreground">{icon}</span>}
            <span className="min-w-0 break-words">{title}</span>
          </h1>
          {subtitle && (
            <p
              className={
                isErp
                  ? "mt-1 hidden max-w-3xl text-sm leading-5 text-muted-foreground sm:block"
                  : "mt-1 max-w-3xl text-sm leading-5 text-muted-foreground"
              }
              data-testid="text-page-subtitle"
            >
              {subtitle}
            </p>
          )}
        </div>
        {children && <WorkspaceActions className="shrink-0">{children}</WorkspaceActions>}
      </div>
    </header>
  );
}
