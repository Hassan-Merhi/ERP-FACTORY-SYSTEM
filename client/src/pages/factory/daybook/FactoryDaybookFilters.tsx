/**
 * Filter bar for the Factory Daybook transactions tab, on the shared Daybook
 * filter bar. Pure presentation over the page model: only transaction types
 * available for the selected period appear in the type dropdown.
 */
import { DaybookFilterBar, type DaybookFilterChip } from "@/components/daybook/DaybookFilterBar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { FactoryDaybookModel } from "./useFactoryDaybookModel";
import { formatTxType } from "./daybookUtils";

const STATUS_LABELS = { all: "All Entries", exclude: "Exclude Optional", only: "Only Optional" } as const;

export function FactoryDaybookFilters({ model }: { model: FactoryDaybookModel }) {
  const chips: DaybookFilterChip[] = [
    ...(model.txTypeFilter !== "ALL"
      ? [
          {
            id: "type",
            label: formatTxType(model.txTypeFilter),
            onRemove: () => model.setTxTypeFilter("ALL"),
            testId: "chip-type",
          },
        ]
      : []),
    ...(model.statusFilter !== "all"
      ? [
          {
            id: "status",
            label: STATUS_LABELS[model.statusFilter],
            onRemove: () => model.setStatusFilter("all"),
            testId: "chip-status",
          },
        ]
      : []),
    ...(model.searchQuery
      ? [
          {
            id: "search",
            label: <>Search: {model.searchQuery}</>,
            onRemove: () => model.setSearchQuery(""),
            testId: "chip-search",
          },
        ]
      : []),
  ];

  return (
    <DaybookFilterBar
      period={model.periodFilter}
      onPeriodChange={model.setPeriodFilter}
      onPrevDay={() => model.stepPeriod(-1)}
      onNextDay={() => model.stepPeriod(1)}
      search={model.searchQuery}
      onSearchChange={model.setSearchQuery}
      searchPlaceholder="Search..."
      searchLabel="Search factory transactions"
      activeCount={(model.txTypeFilter !== "ALL" ? 1 : 0) + (model.statusFilter !== "all" ? 1 : 0)}
      chips={chips}
      hasActiveFilters={model.hasActiveFilters}
      onClearFilters={model.clearFilters}
      data-testid="factory-daybook-filters"
    >
      <Select value={model.txTypeFilter} onValueChange={model.setTxTypeFilter}>
        <SelectTrigger className="daybook-filter-control w-full" data-testid="select-tx-type">
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
      <Select value={model.statusFilter} onValueChange={(v) => model.setStatusFilter(v as "all" | "exclude" | "only")}>
        <SelectTrigger className="daybook-filter-control w-full" data-testid="select-status-filter">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(STATUS_LABELS) as (keyof typeof STATUS_LABELS)[]).map((value) => (
            <SelectItem key={value} value={value}>
              {STATUS_LABELS[value]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </DaybookFilterBar>
  );
}
