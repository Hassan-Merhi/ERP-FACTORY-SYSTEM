import * as React from "react";

import { ErpMobileFilters } from "@/components/ui/erp-mobile-filters";
import { SearchField } from "@/components/ui/search-field";
import { cn } from "@/lib/utils";

export interface DataTableToolbarProps {
  search?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  searchAutoFocus?: boolean;
  searchWrapperClassName?: string;
  searchTestId?: string;
  /** Controlled filters supplied by the owning page. */
  filters?: React.ReactNode;
  actions?: React.ReactNode;
  /** Reuse the existing mobile filter sheet for complex filter controls. */
  mobileFilters?: boolean;
  filterLabel?: string;
  activeFilterCount?: number;
  onResetFilters?: () => void;
  className?: string;
  "data-testid"?: string;
}

/**
 * Canonical list toolbar. Search stays visible on phones; advanced filters
 * open in the existing ERP bottom sheet. All state/queries belong to callers.
 */
export function DataTableToolbar({
  search,
  onSearchChange,
  searchPlaceholder = "Search...",
  searchAutoFocus = false,
  searchWrapperClassName,
  searchTestId = "input-search",
  filters,
  actions,
  mobileFilters = false,
  filterLabel = "Table filters",
  activeFilterCount = 0,
  onResetFilters,
  className,
  "data-testid": testId,
}: DataTableToolbarProps) {
  const searchControl = onSearchChange ? (
    <SearchField
      value={search ?? ""}
      onValueChange={onSearchChange}
      placeholder={searchPlaceholder}
      data-testid={searchTestId}
      autoFocus={searchAutoFocus}
      wrapperClassName={cn("sm:w-72 sm:max-w-full", searchWrapperClassName)}
    />
  ) : null;

  const filterControls = filters ? <div className="flex min-w-0 flex-wrap items-center gap-2">{filters}</div> : null;

  const left =
    mobileFilters && filters ? (
      <ErpMobileFilters
        label={filterLabel}
        quick={searchControl}
        activeCount={activeFilterCount}
        canClear={activeFilterCount > 0 || Boolean(search)}
        onClear={onResetFilters}
        data-testid={testId ? `${testId}-filters` : "table-filters"}
      >
        {(layout) =>
          layout === "inline" ? (
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              {searchControl}
              {filterControls}
            </div>
          ) : (
            filterControls
          )
        }
      </ErpMobileFilters>
    ) : (
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        {searchControl}
        {filterControls}
      </div>
    );

  return (
    <div
      className={cn("mb-4 flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between", className)}
      data-testid={testId ?? "toolbar-data-table"}
    >
      {left}
      {actions ? <div className="flex min-w-0 flex-wrap items-center gap-2 sm:justify-end">{actions}</div> : null}
    </div>
  );
}
