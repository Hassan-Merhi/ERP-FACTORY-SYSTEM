import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Filter, SlidersHorizontal } from "lucide-react";

import type { ShippingColId } from "../types";
import { SHIPPING_COLS } from "../utils";
import { SearchField } from "@/components/ui/search-field";

interface ShippingToolbarProps {
  search: string;
  onSearch: (value: string) => void;
  filterStatus: string;
  onFilterStatus: (value: string) => void;
  destinationFilter: string;
  onDestinationFilter: (value: string) => void;
  destinations: string[];
  shippingCompanyFilter: string;
  onShippingCompanyFilter: (value: string) => void;
  shippingCompanies: string[];
  showFilters: boolean;
  onToggleFilters: () => void;
  hasActiveFilters: boolean;
  colVis: Record<ShippingColId, boolean>;
  toggleCol: (id: ShippingColId) => void;
  showAllCols: () => void;
  hiddenCount: number;
  /** The page's export menu, shown after the column picker. */
  exportMenu?: ReactNode;
}

/** Compact search, status/destination/company selects, filter toggle and column picker of the shipping page. */
export function ShippingToolbar({
  search,
  onSearch,
  filterStatus,
  onFilterStatus,
  destinationFilter,
  onDestinationFilter,
  destinations,
  shippingCompanyFilter,
  onShippingCompanyFilter,
  shippingCompanies,
  showFilters,
  onToggleFilters,
  hasActiveFilters,
  colVis,
  toggleCol,
  showAllCols,
  hiddenCount,
  exportMenu,
}: ShippingToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-card p-2.5 shadow-sm dark:bg-[hsl(var(--factory-hue)_50%_13%)]">
      <SearchField
        placeholder="Search invoice, client, container, destination…"
        wrapperClassName="min-w-[200px] flex-[2_1_260px]"
        className="h-9 rounded-lg bg-background/80 text-xs"
        value={search}
        onValueChange={onSearch}
        data-testid="input-search"
      />
      <Select value={filterStatus} onValueChange={onFilterStatus}>
        <SelectTrigger
          className="h-9 min-w-[110px] flex-[1_1_110px] rounded-lg text-xs"
          data-testid="shipping-select-status"
        >
          <SelectValue placeholder="All statuses" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All statuses</SelectItem>
          <SelectItem value="LOADING">Loading</SelectItem>
          <SelectItem value="VERIFIED">Verified</SelectItem>
          <SelectItem value="FINALIZED">Finalized</SelectItem>
          <SelectItem value="DRAFT">Draft</SelectItem>
          <SelectItem value="CANCELLED">Cancelled</SelectItem>
        </SelectContent>
      </Select>
      <Select value={destinationFilter} onValueChange={onDestinationFilter}>
        <SelectTrigger
          className="h-9 min-w-[125px] flex-[1_1_125px] rounded-lg text-xs"
          data-testid="shipping-select-destination"
        >
          <SelectValue placeholder="All destinations" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All destinations</SelectItem>
          {destinations.map((value) => (
            <SelectItem key={value} value={value}>
              {value}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={shippingCompanyFilter} onValueChange={onShippingCompanyFilter}>
        <SelectTrigger
          className="h-9 min-w-[130px] flex-[1_1_130px] rounded-lg text-xs"
          data-testid="shipping-select-company"
        >
          <SelectValue placeholder="All shipping companies" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All shipping companies</SelectItem>
          {shippingCompanies.map((value) => (
            <SelectItem key={value} value={value}>
              {value}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        variant={showFilters ? "secondary" : "outline"}
        className="h-9 rounded-lg text-xs"
        onClick={onToggleFilters}
        data-testid="button-toggle-filters"
      >
        <Filter className="h-4 w-4 mr-1" />
        Filters
        {hasActiveFilters && <span className="ml-1 h-2 w-2 rounded-full bg-primary inline-block" />}
      </Button>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" className="h-9 rounded-lg text-xs" data-testid="button-toggle-columns">
            <SlidersHorizontal className="h-4 w-4 mr-1" />
            Columns
            {hiddenCount > 0 && (
              <span className="ml-1 text-xs bg-primary text-primary-foreground rounded-full px-1.5 py-0.5 leading-none">
                {hiddenCount}
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-60 max-h-[min(75vh,540px)] overflow-y-auto p-2">
          <div className="mb-2 flex items-center justify-between gap-2 px-1">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Show / Hide Columns</p>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={showAllCols}
              data-testid="button-show-all-columns"
            >
              Show all
            </Button>
          </div>
          <div className="space-y-0.5">
            {SHIPPING_COLS.map((col) => (
              <label
                key={col.id}
                className="flex items-center gap-2 px-2 py-1.5 rounded-md hover-elevate cursor-pointer text-sm"
                data-testid={`col-toggle-${col.id}`}
              >
                <Checkbox checked={colVis[col.id]} onCheckedChange={() => toggleCol(col.id)} />
                {col.label}
              </label>
            ))}
          </div>
        </PopoverContent>
      </Popover>
      {exportMenu}
    </div>
  );
}
