import { useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { erpPageAccessQueryOptions } from "@/app/erpAccessQuery";
import { readCostCenterApi, type CostCenterCatalog } from "@/api/costCentersApi";
import { canAccessErpFeature, type ErpFeatureAccess } from "@/app/erpAccess";
import { DaybookFilterBar, type DaybookFilterChip } from "@/components/daybook/DaybookFilterBar";
import type { PeriodFilterValue } from "@/components/ui/period-filter";
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
  onPrevDay,
  onNextDay,
}: DaybookFiltersProps) {
  const { selectedCompany } = useCompany();
  // The cost-center filter reveals allocations, so it follows the same ERP
  // Accounts grant the server enforces on /api/cost-centers and ?costCenterId.
  const { data: erpAccess } = useQuery<ErpFeatureAccess>({
    ...erpPageAccessQueryOptions(selectedCompany?.id, true),
    staleTime: 30_000,
  });
  const canFilterByCostCenter =
    ["Admin", "Owner", "Developer", "Manager"].includes(selectedCompany?.role || "") &&
    !!erpAccess &&
    canAccessErpFeature(erpAccess, "accounts");
  const { data: centerCatalog } = useQuery<CostCenterCatalog>({
    queryKey: ["/api/cost-centers", selectedCompany?.id, false],
    queryFn: () => readCostCenterApi<CostCenterCatalog>("/api/cost-centers"),
    enabled: !!selectedCompany?.id && canFilterByCostCenter,
    staleTime: 30000,
  });
  const centers = centerCatalog?.costCenters || [];
  const hasActiveNonPeriodFilters =
    filters.voucherType !== "all" ||
    !!filters.searchQuery ||
    !!filters.minAmount ||
    !!filters.maxAmount ||
    filters.statusFilter !== "all" ||
    (filters.costCenterId || "all") !== "all";

  const costCenterId = filters.costCenterId || "all";
  const activeFilterCount = [
    filters.voucherType !== "all",
    filters.statusFilter !== "all",
    filters.costCenterId !== "all",
    !!filters.minAmount,
    !!filters.maxAmount,
  ].filter(Boolean).length;
  const chips: DaybookFilterChip[] = [
    ...(filters.voucherType !== "all"
      ? [
          {
            id: "type",
            label: filters.voucherType,
            onRemove: () => setFilters({ ...filters, voucherType: "all" }),
            testId: "chip-type",
          },
        ]
      : []),
    ...(costCenterId !== "all"
      ? [
          {
            id: "cost-center",
            label: <>Cost center: {centers.find((c) => String(c.id) === costCenterId)?.name || costCenterId}</>,
            onRemove: () => setFilters({ ...filters, costCenterId: "all" }),
          },
        ]
      : []),
    ...(filters.statusFilter !== "all"
      ? [
          {
            id: "status",
            label: filters.statusFilter === "active" ? "Active Only" : "Optional Only",
            onRemove: () => setFilters({ ...filters, statusFilter: "all" }),
            testId: "chip-status",
          },
        ]
      : []),
    ...(filters.minAmount
      ? [
          {
            id: "min",
            label: <>Min: {filters.minAmount}</>,
            onRemove: () => setFilters({ ...filters, minAmount: "" }),
            testId: "chip-min",
          },
        ]
      : []),
    ...(filters.maxAmount
      ? [
          {
            id: "max",
            label: <>Max: {filters.maxAmount}</>,
            onRemove: () => setFilters({ ...filters, maxAmount: "" }),
            testId: "chip-max",
          },
        ]
      : []),
    ...(filters.searchQuery
      ? [
          {
            id: "search",
            label: <>Search: {filters.searchQuery}</>,
            onRemove: () => setFilters({ ...filters, searchQuery: "" }),
            testId: "chip-search",
          },
        ]
      : []),
  ];

  return (
    <DaybookFilterBar
      period={periodFilter}
      onPeriodChange={setPeriodFilter}
      onPrevDay={onPrevDay}
      onNextDay={onNextDay}
      search={filters.searchQuery}
      onSearchChange={(value) => setFilters({ ...filters, searchQuery: value })}
      searchPlaceholder="Voucher # or description..."
      activeCount={activeFilterCount}
      chips={chips}
      hasActiveFilters={!!hasActiveFilters || hasActiveNonPeriodFilters}
      onClearFilters={onResetFilters}
    >
      <Select value={filters.voucherType} onValueChange={(value) => setFilters({ ...filters, voucherType: value })}>
        <SelectTrigger id="voucher-type" data-testid="select-voucher-type" className="daybook-filter-control w-full">
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
        <SelectTrigger id="status-filter" data-testid="select-status-filter" className="daybook-filter-control w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Status</SelectItem>
          <SelectItem value="active">Active Only</SelectItem>
          <SelectItem value="optional">Optional Only</SelectItem>
        </SelectContent>
      </Select>

      {canFilterByCostCenter && (
        <Select value={costCenterId} onValueChange={(value) => setFilters({ ...filters, costCenterId: value })}>
          <SelectTrigger
            id="cost-center-filter"
            data-testid="select-daybook-cost-center"
            className="daybook-filter-control w-full"
          >
            <SelectValue placeholder="All Cost Centers" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Cost Centers</SelectItem>
            {centers.map((center) => (
              <SelectItem key={center.id} value={String(center.id)}>
                {center.code} — {center.name}
              </SelectItem>
            ))}
            {costCenterId !== "all" && !centers.some((c) => String(c.id) === costCenterId) && (
              <SelectItem value={costCenterId}>Selected Cost Center #{costCenterId}</SelectItem>
            )}
          </SelectContent>
        </Select>
      )}
    </DaybookFilterBar>
  );
}
