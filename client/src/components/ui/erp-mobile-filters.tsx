import * as React from "react";
import { SlidersHorizontal } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { useErpPhoneLayout } from "@/hooks/use-erp-phone-layout";
import { cn } from "@/lib/utils";

export type ErpFilterLayout = "inline" | "sheet";

export interface ErpMobileFiltersProps {
  /** Accessible name of the filter region and title of the phone sheet. */
  label: string;
  /**
   * The page's filter controls. Rendered inline on tablet/desktop exactly as the
   * page defines them, and inside a bottom sheet on phones. The layout argument
   * lets a page leave out controls it already shows as `quick` controls.
   */
  children: React.ReactNode | ((layout: ErpFilterLayout) => React.ReactNode);
  /**
   * A control important enough to stay visible on its own full-width row on
   * phones (for example the reporting period of a date-driven screen).
   */
  primary?: React.ReactNode;
  /** Controls that stay visible next to the Filters trigger on phones (for example search). */
  quick?: React.ReactNode;
  /** Number of active non-default filters, shown on the phone trigger. */
  activeCount?: number;
  /** Resets the page filters. The phone sheet offers it as "Clear filters". */
  onClear?: () => void;
  /**
   * Whether anything can be cleared. Defaults to `activeCount > 0`; pass it when
   * a quick control (such as search) is active but not counted on the trigger.
   */
  canClear?: boolean;
  /** Extra classes for the phone quick-controls row. */
  className?: string;
  "data-testid"?: string;
}

/**
 * Standard ERP filter experience.
 *
 * Tablet and desktop keep each page's existing filter bar untouched. Phones get
 * a compact row with the page's quick controls and a Filters trigger carrying
 * the active-filter count; the full filter set opens in a bottom sheet with
 * Clear filters and Apply. Filters keep their live bindings to page state, so
 * query parameters, API requests, date handling and permissions are unchanged
 * — Apply simply returns to the results.
 */
export function ErpMobileFilters({
  label,
  children,
  primary,
  quick,
  activeCount = 0,
  onClear,
  canClear,
  className,
  "data-testid": testId = "erp-filters",
}: ErpMobileFiltersProps) {
  const isPhone = useErpPhoneLayout();
  const render = (layout: ErpFilterLayout) => (typeof children === "function" ? children(layout) : children);

  // Tablet/desktop render exactly what the page defined, with no extra context requirements.
  if (!isPhone) return <>{render("inline")}</>;

  return (
    <PhoneFilters
      label={label}
      primary={primary}
      quick={quick}
      activeCount={activeCount}
      onClear={onClear}
      canClear={canClear}
      className={className}
      testId={testId}
    >
      {render("sheet")}
    </PhoneFilters>
  );
}

interface PhoneFiltersProps extends Omit<ErpMobileFiltersProps, "children" | "data-testid" | "activeCount"> {
  activeCount: number;
  children: React.ReactNode;
  testId: string;
}

function PhoneFilters({
  label,
  children,
  primary,
  quick,
  activeCount,
  onClear,
  canClear,
  className,
  testId,
}: PhoneFiltersProps) {
  const { t } = useApplicationLanguage();
  const [open, setOpen] = React.useState(false);
  const hasActive = activeCount > 0;

  return (
    <>
      <div
        role="search"
        aria-label={label}
        className={cn("flex min-w-0 flex-wrap items-center gap-2", className)}
        data-erp-filter-bar="phone"
        data-testid={testId}
      >
        {primary && <div className="w-full min-w-0">{primary}</div>}
        {quick && <div className="min-w-0 flex-1">{quick}</div>}
        <Button
          type="button"
          variant={hasActive ? "secondary" : "outline"}
          className={cn("shrink-0 gap-2", !quick && "w-full")}
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={open}
          data-testid={`${testId}-open`}
        >
          <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
          <span>{t("mobileFilters.open")}</span>
          {hasActive && (
            <Badge
              className="h-5 min-w-5 justify-center rounded-full px-1.5 text-[11px]"
              data-testid={`${testId}-active-count`}
            >
              {activeCount}
            </Badge>
          )}
        </Button>
      </div>

      <ErpFilterSheet
        open={open}
        onOpenChange={setOpen}
        label={label}
        onClear={onClear}
        canClear={canClear ?? hasActive}
        data-testid={testId}
      >
        {children}
      </ErpFilterSheet>
    </>
  );
}

export interface ErpFilterSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Sheet title and accessible name. */
  label: string;
  children: React.ReactNode;
  onClear?: () => void;
  canClear?: boolean;
  /** Test-id prefix; the sheet, clear and apply controls derive their ids from it. */
  "data-testid"?: string;
}

/**
 * Phone bottom sheet holding a page's full filter set. Used by
 * {@link ErpMobileFilters}, and directly by pages that already own a Filters
 * toggle in their toolbar.
 */
export function ErpFilterSheet({
  open,
  onOpenChange,
  label,
  children,
  onClear,
  canClear = false,
  "data-testid": testId = "erp-filters",
}: ErpFilterSheetProps) {
  const { t } = useApplicationLanguage();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        // flex-nowrap: the global phone rule that wraps `.flex.gap-*` rows would otherwise wrap this
        // height-capped column into side-by-side columns. mx-auto centres it under the dialog width cap.
        className="mx-auto max-h-[min(85dvh,calc(var(--erp-visual-viewport-height,var(--app-viewport-height))-2rem))] !flex-nowrap gap-3 rounded-t-2xl px-4 pb-[max(1rem,var(--safe-area-bottom))] pt-4"
        data-testid={`${testId}-sheet`}
      >
        <SheetHeader>
          <SheetTitle>{label}</SheetTitle>
          <SheetDescription className="sr-only">{t("mobileFilters.liveHint")}</SheetDescription>
        </SheetHeader>
        <div
          className={cn(
            "flex min-h-0 min-w-0 flex-col !flex-nowrap gap-3 overflow-y-auto",
            // Desktop filter widths do not apply inside the phone sheet.
            "[&>*]:w-full [&_[role=combobox]]:w-full [&_input]:w-full [&_button[aria-haspopup]]:w-full",
            // The sheet portals outside #main-content, so restate the phone touch-target floor.
            "[&_button]:min-h-11 [&_button]:text-sm [&_input]:min-h-11 [&_input]:text-base"
          )}
          data-erp-filter-sheet-body="true"
        >
          {children}
        </div>
        <SheetFooter className="grid grid-cols-2 gap-2 sm:flex">
          <Button
            type="button"
            variant="outline"
            onClick={() => onClear?.()}
            disabled={!onClear || !canClear}
            data-testid={`${testId}-clear`}
          >
            {t("mobileFilters.clear")}
          </Button>
          <Button type="button" onClick={() => onOpenChange(false)} data-testid={`${testId}-apply`}>
            {t("mobileFilters.apply")}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
