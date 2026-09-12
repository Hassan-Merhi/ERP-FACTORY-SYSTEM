import { Search, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CoreErpFilterGrid } from "@/components/ui/core-erp-mobile";
import { Input } from "@/components/ui/input";
import { PeriodFilter, PeriodFilterValue } from "@/components/ui/period-filter";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { FilterStateAction } from "@/hooks/use-paginated-filter-state";
import type { DaybookFiltersState } from "./filterState";

interface DaybookFiltersProps {
  periodFilter: PeriodFilterValue;
  setPeriodFilter: (v: PeriodFilterValue) => void;
  /**
   * The full filter slice from filterState.ts, including `sortOrder`. The
   * sort order itself is rendered by the table header, but the spread-based
   * `setFilters({ ...filters, ... })` calls below need it to survive.
   */
  filters: DaybookFiltersState["filters"];
  setFilters: (v: FilterStateAction<DaybookFiltersState["filters"]>) => void;
  hasActiveFilters?: boolean;
  onResetFilters?: () => void;
  onPrevDay?: () => void;
  onNextDay?: () => void;
}

export function DaybookFilters({
  periodFilter,
  setPeriodFilter,
  filters,
  setFilters,
  hasActiveFilters,
  onResetFilters,
}: DaybookFiltersProps) {
  const hasActiveNonPeriodFilters =
    filters.voucherType !== "all" ||
    !!filters.searchQuery ||
    !!filters.minAmount ||
    !!filters.maxAmount ||
    filters.statusFilter !== "all";

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <CoreErpFilterGrid className="gap-2 p-2 sm:p-3" label="Daybook filters">
        <PeriodFilter value={periodFilter} onChange={setPeriodFilter} data-testid="period-filter" />

        <Select value={filters.voucherType} onValueChange={(value) => setFilters({ ...filters, voucherType: value })}>
          <SelectTrigger id="voucher-type" data-testid="select-voucher-type" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            <SelectItem value="Sales">Sales</SelectItem>
            <SelectItem value="Purchase">Purchase</SelectItem>
            <SelectItem value="Payment">Payment</SelectItem>
            <SelectItem value="Receipt">Receipt</SelectItem>
            <SelectItem value="Journal">Journal</SelectItem>
            <SelectItem value="Contra">Contra</SelectItem>
            <SelectItem value="Offload">Offload</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={filters.statusFilter}
          onValueChange={(value) => setFilters({ ...filters, statusFilter: value as "all" | "active" | "optional" })}
        >
          <SelectTrigger id="status-filter" data-testid="select-status-filter" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="active">Active Only</SelectItem>
            <SelectItem value="optional">Optional Only</SelectItem>
          </SelectContent>
        </Select>

        <div className="relative w-full min-w-0 lg:col-span-2 xl:col-span-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="search"
            placeholder="Voucher # or description..."
            value={filters.searchQuery}
            onChange={(e) => setFilters({ ...filters, searchQuery: e.target.value })}
            data-testid="input-search"
            className="w-full pl-9"
          />
        </div>
      </CoreErpFilterGrid>

      {(hasActiveFilters || hasActiveNonPeriodFilters) && (
        <div
          className="flex max-w-full items-center gap-1.5 overflow-x-auto overscroll-x-contain pb-1"
          aria-label="Active Daybook filters"
        >
          <span className="shrink-0 text-xs text-muted-foreground">Active:</span>
          {filters.voucherType !== "all" && (
            <Badge
              variant="secondary"
              className="shrink-0 cursor-pointer gap-1 text-xs"
              onClick={() => setFilters({ ...filters, voucherType: "all" })}
              data-testid="chip-type"
            >
              {filters.voucherType}
              <X className="h-3 w-3" />
            </Badge>
          )}
          {filters.statusFilter !== "all" && (
            <Badge
              variant="secondary"
              className="shrink-0 cursor-pointer gap-1 text-xs"
              onClick={() => setFilters({ ...filters, statusFilter: "all" })}
              data-testid="chip-status"
            >
              {filters.statusFilter === "active" ? "Active Only" : "Optional Only"}
              <X className="h-3 w-3" />
            </Badge>
          )}
          {filters.minAmount && (
            <Badge
              variant="secondary"
              className="shrink-0 cursor-pointer gap-1 text-xs"
              onClick={() => setFilters({ ...filters, minAmount: "" })}
              data-testid="chip-min"
            >
              Min: {filters.minAmount}
              <X className="h-3 w-3" />
            </Badge>
          )}
          {filters.maxAmount && (
            <Badge
              variant="secondary"
              className="shrink-0 cursor-pointer gap-1 text-xs"
              onClick={() => setFilters({ ...filters, maxAmount: "" })}
              data-testid="chip-max"
            >
              Max: {filters.maxAmount}
              <X className="h-3 w-3" />
            </Badge>
          )}
          {!!filters.searchQuery && (
            <Badge
              variant="secondary"
              className="shrink-0 cursor-pointer gap-1 text-xs"
              onClick={() => setFilters({ ...filters, searchQuery: "" })}
              data-testid="chip-search"
            >
              Search: {filters.searchQuery}
              <X className="h-3 w-3" />
            </Badge>
          )}
          {onResetFilters && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 shrink-0 gap-1 px-2 text-xs"
              onClick={onResetFilters}
              data-testid="button-reset-filters"
            >
              <X className="h-3 w-3" />
              Reset Filters
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
