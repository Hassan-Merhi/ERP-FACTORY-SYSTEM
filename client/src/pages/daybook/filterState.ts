import { getDefaultPeriodValue, type PeriodFilterValue } from "@/components/ui/period-filter";

export type DaybookFiltersState = {
  periodFilter: PeriodFilterValue;
  filters: {
    voucherType: string;
    searchQuery: string;
    sortOrder: "asc" | "desc";
    minAmount: string;
    maxAmount: string;
    statusFilter: "all" | "active" | "optional";
    costCenterId: string;
  };
};

export function createDaybookFilters(): DaybookFiltersState {
  return {
    periodFilter: getDefaultPeriodValue("today"),
    filters: {
      voucherType: "all",
      searchQuery: "",
      sortOrder: "desc",
      minAmount: "",
      maxAmount: "",
      statusFilter: "all",
      costCenterId: "all",
    },
  };
}
