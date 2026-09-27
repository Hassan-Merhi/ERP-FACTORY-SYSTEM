/**
 * Filter bar for the Factory Daybook transactions tab.
 *
 * Pure presentation over the page model: same controls, same test ids, same
 * transaction-type option list and ordering as the inline markup it replaces.
 */
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PeriodFilter } from "@/components/ui/period-filter";
import { ErpMobileFilters } from "@/components/ui/erp-mobile-filters";
import type { FactoryDaybookModel } from "./useFactoryDaybookModel";

const TX_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "ALL", label: "All Types" },
  { value: "PAYMENT", label: "Payment" },
  { value: "RECEIPT", label: "Receipt" },
  { value: "JOURNAL", label: "Journal" },
  { value: "INVOICE", label: "Invoice" },
  { value: "BALE_TRANSFER", label: "Bale Transfer" },
  { value: "CONTAINER_IMPORT", label: "Container Import" },
  { value: "OFFLOAD_RAW_STOCK", label: "Offload Raw Stock" },
  { value: "COMMISSION", label: "Commission" },
  { value: "BALE_PRESSING", label: "Bale Pressing" },
  { value: "BALE_FINALIZE", label: "Bale Finalize" },
  { value: "BALE_STOCK_ENTRY", label: "Bale Stock Entry" },
  { value: "BALE_REMOVAL", label: "Bale Removal" },
  { value: "FREIGHT_PAYMENT", label: "Freight Payment" },
  { value: "SUPPLIER_PAYMENT", label: "Supplier Payment" },
  { value: "PAYROLL_PAYMENT", label: "Payroll Payment" },
  { value: "DOC_UPLOAD", label: "Doc Upload" },
  { value: "DOC_DELETE", label: "Doc Delete" },
  { value: "FREIGHT_ADD", label: "Freight Add" },
];

export function FactoryDaybookFilters({ model }: { model: FactoryDaybookModel }) {
  const search = (
    <Input
      placeholder="Search..."
      value={model.searchQuery}
      onChange={(e) => model.setSearchQuery(e.target.value)}
      data-testid="input-search"
      className="h-8 w-full text-sm sm:w-44"
    />
  );
  // Inline (tablet/desktop) the stepper's controls sit directly in the filter row as before; on
  // phones they share one full-width row with the period picker taking the free space.
  const dayStepper = (inline: boolean) => (
    <div className={inline ? "contents" : "flex min-w-0 items-center gap-1"}>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => model.stepPeriod(-1)}
        title="Previous day (−)"
        aria-label="Previous day"
        data-testid="button-prev-day"
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <div className={inline ? undefined : "min-w-0 flex-1"}>
        <PeriodFilter value={model.periodFilter} onChange={model.setPeriodFilter} data-testid="period-filter" />
      </div>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => model.stepPeriod(1)}
        title="Next day (+)"
        aria-label="Next day"
        data-testid="button-next-day"
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );
  const typeSelect = (
    <Select value={model.txTypeFilter} onValueChange={model.setTxTypeFilter}>
      <SelectTrigger className="h-8 w-full text-sm sm:w-36" data-testid="select-tx-type">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {TX_TYPE_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  const statusSelect = (
    <Select value={model.statusFilter} onValueChange={(v) => model.setStatusFilter(v as "all" | "exclude" | "only")}>
      <SelectTrigger className="h-8 w-full text-sm sm:w-36" data-testid="select-status-filter">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All Entries</SelectItem>
        <SelectItem value="exclude">Exclude Optional</SelectItem>
        <SelectItem value="only">Only Optional</SelectItem>
      </SelectContent>
    </Select>
  );
  const sheetFilterCount = (model.txTypeFilter !== "ALL" ? 1 : 0) + (model.statusFilter !== "all" ? 1 : 0);

  return (
    <Card>
      <CardContent className="pt-4 pb-3">
        {/* Phones: day stepper and search stay visible, entry type and status open in the filter
            sheet. Tablet/desktop keep the single wrapping row. */}
        <ErpMobileFilters
          label="Daybook filters"
          primary={dayStepper(false)}
          quick={search}
          activeCount={sheetFilterCount}
          onClear={model.clearFilters}
          canClear={model.hasActiveFilters}
          data-testid="factory-daybook-filters"
        >
          {(layout) =>
            layout === "sheet" ? (
              <>
                {typeSelect}
                {statusSelect}
              </>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                {search}
                {dayStepper(true)}
                {typeSelect}
                {statusSelect}
                {model.hasActiveFilters && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={model.clearFilters}
                    data-testid="button-clear-filters"
                    className="h-8 gap-1 text-sm"
                  >
                    <X className="w-3.5 h-3.5" />
                    Clear
                  </Button>
                )}
              </div>
            )
          }
        </ErpMobileFilters>
      </CardContent>
    </Card>
  );
}
