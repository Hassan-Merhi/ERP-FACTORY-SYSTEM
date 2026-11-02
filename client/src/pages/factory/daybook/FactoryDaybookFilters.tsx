/**
 * Filter bar for the Factory Daybook transactions tab.
 *
 * Pure presentation over the page model: only transaction types available
 * for the selected period appear in the type dropdown.
 */
import { ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PeriodFilter } from "@/components/ui/period-filter";
import { ErpMobileFilters } from "@/components/ui/erp-mobile-filters";
import type { FactoryDaybookModel } from "./useFactoryDaybookModel";
import { formatTxType } from "./daybookUtils";

export function FactoryDaybookFilters({ model }: { model: FactoryDaybookModel }) {
  const search = (
    <div className="relative w-full min-w-0 sm:w-56">
      <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        placeholder="Search..."
        value={model.searchQuery}
        onChange={(e) => model.setSearchQuery(e.target.value)}
        data-testid="input-search"
        className="h-10 w-full rounded-xl border-border/70 bg-background/80 pl-9 text-sm shadow-sm focus-visible:ring-blue-500/30"
      />
    </div>
  );
  // Inline (tablet/desktop) the stepper's controls sit directly in the filter row as before; on
  // phones they share one full-width row with the period picker taking the free space.
  const dayStepper = (inline: boolean) => (
    <div className={inline ? "contents" : "flex min-w-0 items-center gap-1 rounded-xl"}>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => model.stepPeriod(-1)}
        title="Previous day (−)"
        aria-label="Previous day"
        data-testid="button-prev-day"
        className="h-9 w-9 shrink-0 rounded-lg text-muted-foreground hover:bg-blue-500/10 hover:text-blue-600 dark:hover:text-sky-400"
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
        className="h-9 w-9 shrink-0 rounded-lg text-muted-foreground hover:bg-blue-500/10 hover:text-blue-600 dark:hover:text-sky-400"
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );
  const typeSelect = (
    <Select value={model.txTypeFilter} onValueChange={model.setTxTypeFilter}>
      <SelectTrigger className="h-10 w-full rounded-xl border-border/70 bg-background/80 text-sm shadow-sm sm:w-40" data-testid="select-tx-type">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="ALL">All Types</SelectItem>
        {model.availableTxTypes.map((type) => (
          <SelectItem key={type} value={type}>
            {formatTxType(type)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  const statusSelect = (
    <Select value={model.statusFilter} onValueChange={(v) => model.setStatusFilter(v as "all" | "exclude" | "only")}>
      <SelectTrigger className="h-10 w-full rounded-xl border-border/70 bg-background/80 text-sm shadow-sm sm:w-40" data-testid="select-status-filter">
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
    <Card className="rounded-2xl border border-sky-200/60 bg-gradient-to-r from-white to-slate-50/80 shadow-sm dark:border-blue-500/20 dark:from-slate-900/90 dark:to-slate-950/80">
      <CardContent className="px-3 py-3 sm:px-4">
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
              <div className="flex flex-wrap items-center gap-2.5">
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
                    className="h-9 gap-1 rounded-lg text-sm text-muted-foreground hover:text-blue-600"
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
