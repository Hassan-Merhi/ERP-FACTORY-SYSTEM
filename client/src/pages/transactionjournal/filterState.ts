import { getDefaultPeriodValue, type PeriodFilterValue } from "@/components/ui/period-filter";

export type TransactionJournalFilters = {
  periodFilter: PeriodFilterValue;
  selectedCos: number[];
  voucherType: string;
  currency: string;
  optionalFilter: string;
  includeFactory: boolean;
  searchInput: string;
  search: string;
};

export function createTransactionJournalFilters(): TransactionJournalFilters {
  return {
    periodFilter: getDefaultPeriodValue("today"),
    selectedCos: [],
    voucherType: "all",
    currency: "all",
    optionalFilter: "active",
    includeFactory: false,
    searchInput: "",
    search: "",
  };
}
