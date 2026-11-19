/**
 * The one Daybook filter bar (ERP, Properties, Factory and POS Daybooks).
 *
 * Period with day stepper, search, the page's own type/status dropdowns and the
 * active-filter chip row. Pure presentation: every value and handler belongs to
 * the page, so what is filtered and how stays with each company type.
 */
import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CoreErpFilterGrid } from "@/components/ui/core-erp-mobile";
import { ErpMobileFilters } from "@/components/ui/erp-mobile-filters";
import { PeriodFilter, type PeriodFilterValue } from "@/components/ui/period-filter";
import { SearchField } from "@/components/ui/search-field";

export interface DaybookFilterChip {
  id: string;
  label: ReactNode;
  onRemove: () => void;
  testId?: string;
}

export interface DaybookFilterBarProps {
  period: PeriodFilterValue;
  onPeriodChange: (value: PeriodFilterValue) => void;
  periodTestId?: string;
  /** Previous/next day buttons, shown on both sides of the period picker when given. */
  onPrevDay?: () => void;
  onNextDay?: () => void;
  search: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder: string;
  searchLabel?: string;
  searchTestId?: string;
  /** Number of active dropdown filters (shown on the phone Filters trigger). */
  activeCount: number;
  /** Removable chips for the active filters, shown under the bar. */
  chips?: readonly DaybookFilterChip[];
  hasActiveFilters: boolean;
  onClearFilters?: () => void;
  /** The page's own dropdowns (type, status, cost center...). */
  children?: ReactNode;
  "data-testid"?: string;
}

export function DaybookFilterBar({
  period,
  onPeriodChange,
  periodTestId = "period-filter",
  onPrevDay,
  onNextDay,
  search,
  onSearchChange,
  searchPlaceholder,
  searchLabel,
  searchTestId = "input-search",
  activeCount,
  chips = [],
  hasActiveFilters,
  onClearFilters,
  children,
  "data-testid": testId = "daybook-filters",
}: DaybookFilterBarProps) {
  const periodControl = (
    <div className="flex min-w-0 items-center gap-1">
      {onPrevDay && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-9 w-9 shrink-0 rounded-lg"
          onClick={onPrevDay}
          title="Previous day (−)"
          aria-label="Previous day"
          data-testid="button-prev-day"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </Button>
      )}
      <div className="min-w-0 flex-1">
        <PeriodFilter value={period} onChange={onPeriodChange} data-testid={periodTestId} />
      </div>
      {onNextDay && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-9 w-9 shrink-0 rounded-lg"
          onClick={onNextDay}
          title="Next day (+)"
          aria-label="Next day"
          data-testid="button-next-day"
        >
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </Button>
      )}
    </div>
  );

  const searchControl = (
    <SearchField
      value={search}
      onValueChange={onSearchChange}
      placeholder={searchPlaceholder}
      aria-label={searchLabel}
      wrapperClassName="lg:col-span-2 xl:col-span-1"
      className="daybook-filter-search"
      data-testid={searchTestId}
    />
  );

  return (
    <div className="daybook-filter-panel">
      <div className="flex min-w-0 flex-col gap-2">
        <ErpMobileFilters
          label="Daybook filters"
          primary={periodControl}
          quick={searchControl}
          activeCount={activeCount}
          onClear={onClearFilters}
          canClear={hasActiveFilters}
          data-testid={testId}
        >
          {(layout) => (
            <CoreErpFilterGrid
              className={
                layout === "sheet" ? "gap-3 border-0 bg-transparent p-0" : "daybook-filter-grid gap-2 p-2 sm:p-3"
              }
              label="Daybook filters"
            >
              {layout === "inline" && periodControl}
              {children}
              {layout === "inline" && searchControl}
            </CoreErpFilterGrid>
          )}
        </ErpMobileFilters>

        {hasActiveFilters && (
          <div
            className="flex max-w-full items-center gap-1.5 overflow-x-auto overscroll-x-contain pb-1"
            aria-label="Active Daybook filters"
          >
            <span className="shrink-0 text-xs text-muted-foreground">Active:</span>
            {chips.map((chip) => (
              <Badge
                key={chip.id}
                variant="secondary"
                className="shrink-0 cursor-pointer gap-1 text-xs"
                onClick={chip.onRemove}
                data-testid={chip.testId}
              >
                {chip.label}
                <X className="h-3 w-3" />
              </Badge>
            ))}
            {onClearFilters && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 shrink-0 gap-1 px-2 text-xs"
                onClick={onClearFilters}
                data-testid="button-reset-filters"
              >
                <X className="h-3 w-3" />
                Reset Filters
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
