// Extracted from ./LedgerVouchers.tsx
import { useState, useEffect } from "react";
import { useLocation, useRoute } from "wouter";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";
import { useQuery } from "@tanstack/react-query";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { format, startOfMonth, endOfMonth } from "date-fns";
import { PeriodFilterValue } from "@/components/ui/period-filter";
import { useDateJump } from "@/hooks/use-date-jump";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { getInitialPeriodValue, type LedgerVouchersData } from "./LedgerVouchersHelpers";

export function useLedgerVouchersState() {
  const [, navigate] = useLocation();
  const [, params] = useRoute("/ledger-vouchers/:accountId/:year/:month");
  const { formatAmountRaw: formatAmount } = useCurrencyContext();
  const { formatShortDate } = useDateFormat();

  const accountId = params?.accountId ? parseInt(params.accountId) : null;
  const year = params?.year ? parseInt(params.year) : null;
  const month = params?.month ? parseInt(params.month) : null;

  useEscapeToParent();

  const [periodFilter, setPeriodFilter] = useState<PeriodFilterValue>(() => getInitialPeriodValue(year, month));
  useDateJump((date) => setPeriodFilter({ fromDate: date, toDate: date, preset: "custom" }));

  useEffect(() => {
    if (year && month) {
      const monthDate = new Date(year, month - 1, 1);
      setPeriodFilter({
        fromDate: format(startOfMonth(monthDate), "yyyy-MM-dd"),
        toDate: format(endOfMonth(monthDate), "yyyy-MM-dd"),
        preset: "custom",
      });
    }
  }, [year, month]);

  const { data, isLoading, isError, refetch } = useQuery<LedgerVouchersData>({
    queryKey: ["/api/reports/ledger-vouchers", accountId, year, month, periodFilter.fromDate, periodFilter.toDate],
    queryFn: async () => {
      const searchParams = new URLSearchParams({
        startDate: periodFilter.fromDate,
        endDate: periodFilter.toDate,
      });
      const response = await fetch(`/api/reports/ledger-vouchers/${accountId}/${year}/${month}?${searchParams}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to fetch ledger vouchers");
      return response.json();
    },
    enabled: !!accountId && !!year && !!month,
  });

  const handleVoucherClick = (voucherId: number) => {
    window.open(`/voucher-detail/${voucherId}`, "_blank");
  };
  return {
    navigate,
    formatAmount,
    formatShortDate,
    accountId,
    year,
    month,
    periodFilter,
    setPeriodFilter,
    data,
    isLoading,
    isError,
    refetch,
    handleVoucherClick,
  };
}
