import { usePaginatedFilterState, type FilterStateAction } from "@/hooks/use-paginated-filter-state";
import type { SupplierDateFilter } from "./ledgerSummaries";

interface SuppliersFilters extends Record<string, unknown> {
  companyFilter: string;
  hideZeroBalance: boolean;
  searchTerm: string;
  dateFilter: SupplierDateFilter;
  hidePayments: boolean;
}

export function useSuppliersFilters(companyId: number | undefined, isProperties = false) {
  const state = usePaginatedFilterState<SuppliersFilters>({
    createInitialFilters: () => ({
      companyFilter: "all",
      hideZeroBalance: !isProperties,
      searchTerm: "",
      dateFilter: "all",
      hidePayments: false,
    }),
    storageKey: companyId ? `${isProperties ? "properties" : "erp"}-suppliers-filters-v1:${companyId}` : undefined,
  });

  return {
    ...state,
    setCompanyFilter: (next: string) => state.setFilter("companyFilter", next),
    setDateFilter: (next: SupplierDateFilter) => state.setFilter("dateFilter", next),
    setHidePayments: (next: FilterStateAction<boolean>) => state.setFilter("hidePayments", next),
  };
}
