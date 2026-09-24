import type { Dispatch, SetStateAction } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  ChevronsDownUp,
  ChevronsUpDown,
  LayoutList,
  Receipt,
  SlidersHorizontal,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import type { PLBasis, PLFilter } from "../types";

type ItemColumnId =
  | "qty"
  | "costPrice"
  | "hassanPrice"
  | "pricePerBale"
  | "costProfitBale"
  | "hassanProfitBale"
  | "costProfitTotal"
  | "hassanProfitTotal";

interface SalesReportDetailHeaderProps {
  handleBack: () => void;
  displayDate: string;
  isCreditSaleParam: string | null;
  creditCustomerLabel: string | null;
  grouping: string;
  searchTerm: string;
  plFilter: PLFilter;
  setPlFilter: Dispatch<SetStateAction<PLFilter>>;
  viewMode: "items" | "bySale";
  setViewMode: Dispatch<SetStateAction<"items" | "bySale">>;
  voucherGroups: { voucherId: number }[];
  expandedVouchers: Set<number>;
  setExpandedVouchers: Dispatch<SetStateAction<Set<number>>>;
  itemGroups: { stockItemId: number }[];
  expandedItems: Set<string>;
  setExpandedItems: Dispatch<SetStateAction<Set<string>>>;
  setExpandedLocations: Dispatch<SetStateAction<Set<string>>>;
  hiddenColumns: Set<ItemColumnId>;
  setHiddenColumns: Dispatch<SetStateAction<Set<ItemColumnId>>>;
  ITEM_COLUMNS: readonly { id: ItemColumnId; label: string }[];
  toggleColumn: (id: ItemColumnId) => void;
  plBasis: PLBasis;
  setPlBasis: Dispatch<SetStateAction<PLBasis>>;
}

export function SalesReportDetailHeader(props: SalesReportDetailHeaderProps) {
  const {
    handleBack,
    displayDate,
    isCreditSaleParam,
    creditCustomerLabel,
    grouping,
    searchTerm,
    plFilter,
    setPlFilter,
    viewMode,
    setViewMode,
    voucherGroups,
    expandedVouchers,
    setExpandedVouchers,
    itemGroups,
    expandedItems,
    setExpandedItems,
    setExpandedLocations,
    hiddenColumns,
    setHiddenColumns,
    ITEM_COLUMNS,
    toggleColumn,
    plBasis,
    setPlBasis,
  } = props;
  return (
    <div className="space-y-3">
      <PageHeader
        title={`Sales Details — ${displayDate}`}
        onBack={handleBack}
        backButtonTestId="button-back-to-sales-report"
        meta={
          <>
            {isCreditSaleParam === "true" && (
              <Badge
                variant="outline"
                className="text-amber-600 border-amber-400 dark:text-amber-400 dark:border-amber-600"
              >
                Credit Sales{creditCustomerLabel ? ` · ${creditCustomerLabel}` : ""}
              </Badge>
            )}
            <span>
              All items sold{" "}
              {grouping === "daily" ? "on this day" : grouping === "monthly" ? "this month" : "this year"}
              {searchTerm && <span className="ml-1 text-muted-foreground/70">· filtered by "{searchTerm}"</span>}
            </span>
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-col gap-1 items-end" data-testid="filter-pl-toggle">
          <div className="flex items-center gap-1 rounded-md border p-1">
            <Button
              variant="ghost"
              size="sm"
              className={plFilter === "all" ? "toggle-elevate toggle-elevated" : "toggle-elevate"}
              onClick={() => setPlFilter("all")}
              data-testid="button-filter-all"
            >
              <LayoutList className="h-3.5 w-3.5 mr-1" />
              All
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={plFilter === "gain" ? "toggle-elevate toggle-elevated text-green-600" : "toggle-elevate"}
              onClick={() => setPlFilter("gain")}
              data-testid="button-filter-gaining"
            >
              <TrendingUp className="h-3.5 w-3.5 mr-1" />
              Gaining
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={plFilter === "loss" ? "toggle-elevate toggle-elevated text-red-600" : "toggle-elevate"}
              onClick={() => setPlFilter("loss")}
              data-testid="button-filter-losing"
            >
              <TrendingDown className="h-3.5 w-3.5 mr-1" />
              Losing
            </Button>
            <div className="w-px h-5 bg-border mx-0.5" />
            <Button
              variant="ghost"
              size="sm"
              className={viewMode === "bySale" ? "toggle-elevate toggle-elevated" : "toggle-elevate"}
              onClick={() => setViewMode(viewMode === "bySale" ? "items" : "bySale")}
              data-testid="button-view-by-sale"
            >
              <Receipt className="h-3.5 w-3.5 mr-1" />
              MHD
            </Button>
          </div>
          <div className="flex items-center gap-1">
            {viewMode === "bySale" && voucherGroups.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const allExpanded = expandedVouchers.size >= voucherGroups.length;
                  if (allExpanded) {
                    setExpandedVouchers(new Set());
                  } else {
                    setExpandedVouchers(new Set(voucherGroups.map((v) => v.voucherId)));
                  }
                }}
                data-testid="button-expand-collapse-all"
              >
                {expandedVouchers.size >= voucherGroups.length ? (
                  <>
                    <ChevronsDownUp className="h-3.5 w-3.5 mr-1" />
                    Collapse All
                  </>
                ) : (
                  <>
                    <ChevronsUpDown className="h-3.5 w-3.5 mr-1" />
                    Expand All
                  </>
                )}
              </Button>
            )}
            {viewMode === "items" && itemGroups.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const allExpanded = expandedItems.size >= itemGroups.length;
                  if (allExpanded) {
                    setExpandedItems(new Set());
                    setExpandedLocations(new Set());
                  } else {
                    setExpandedItems(new Set(itemGroups.map((g) => String(g.stockItemId))));
                  }
                }}
                data-testid="button-expand-collapse-all-items"
              >
                {expandedItems.size >= itemGroups.length ? (
                  <>
                    <ChevronsDownUp className="h-3.5 w-3.5 mr-1" />
                    Collapse All
                  </>
                ) : (
                  <>
                    <ChevronsUpDown className="h-3.5 w-3.5 mr-1" />
                    Expand All
                  </>
                )}
              </Button>
            )}
            {viewMode === "bySale" && (
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" data-testid="button-toggle-columns">
                    <SlidersHorizontal className="h-3.5 w-3.5 mr-1" />
                    Columns
                    {hiddenColumns.size > 0 && (
                      <span className="ml-1 text-xs text-muted-foreground">({hiddenColumns.size} hidden)</span>
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-56 p-2" align="end">
                  <p className="text-xs font-medium text-muted-foreground px-2 pb-1">Show / hide columns</p>
                  <div className="space-y-1">
                    {ITEM_COLUMNS.map((c) => (
                      <div
                        key={c.id}
                        className="flex items-center gap-2 px-2 py-1.5 rounded hover-elevate cursor-pointer"
                        onClick={() => toggleColumn(c.id)}
                        data-testid={`toggle-col-${c.id}`}
                      >
                        <Checkbox checked={!hiddenColumns.has(c.id)} className="h-4 w-4 pointer-events-none" />
                        <span className="text-sm">{c.label}</span>
                      </div>
                    ))}
                  </div>
                  {hiddenColumns.size > 0 && (
                    <div className="border-t mt-1 pt-1 px-2">
                      <button
                        className="text-xs text-muted-foreground hover:text-foreground cursor-pointer"
                        onClick={() => setHiddenColumns(new Set())}
                        data-testid="button-show-all-columns"
                      >
                        Show all
                      </button>
                    </div>
                  )}
                </PopoverContent>
              </Popover>
            )}
          </div>
          {plFilter !== "all" && (
            <div className="flex items-center gap-1 rounded-md border p-1" data-testid="filter-basis-toggle">
              <span className="text-xs text-muted-foreground px-1">by:</span>
              <Button
                variant="ghost"
                size="sm"
                className={plBasis === "config" ? "toggle-elevate toggle-elevated" : "toggle-elevate"}
                onClick={() => setPlBasis("config")}
                data-testid="button-basis-config"
              >
                Hassan's P/L
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={plBasis === "cost" ? "toggle-elevate toggle-elevated" : "toggle-elevate"}
                onClick={() => setPlBasis("cost")}
                data-testid="button-basis-cost"
              >
                Cost P/L
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
