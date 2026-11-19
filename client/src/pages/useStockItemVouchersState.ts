// Extracted from ./StockItemVouchers.tsx
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { voucherEditPath } from "@/pages/daybook/voucherEditRoute";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";
import { PeriodFilterValue, getDefaultPeriodValue } from "@/components/ui/period-filter";
import { useDateJump } from "@/hooks/use-date-jump";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import type { Transaction, VouchersData } from "./StockItemVouchersTypes";

export function useStockItemVouchersState() {
  const { formatDisplayDate } = useDateFormat();
  const { formatAmount } = useCurrencyContext();
  const params = useParams();
  const stockItemId = parseInt(params.id || "0");
  const year = parseInt(params.year || "0");
  const month = parseInt(params.month || "0");
  const [, navigate] = useLocation();
  useEscapeToParent();

  const [periodFilter, setPeriodFilter] = useState<PeriodFilterValue>(() => getDefaultPeriodValue("this_month"));
  useDateJump((date) => setPeriodFilter({ fromDate: date, toDate: date, preset: "custom" }));

  const { data, isLoading, isError, refetch } = useQuery<VouchersData>({
    queryKey: [
      `/api/stock-items/${stockItemId}/vouchers/${year}/${month}`,
      { startDate: periodFilter.fromDate, endDate: periodFilter.toDate },
    ],
    queryFn: async () => {
      const params = new URLSearchParams({
        startDate: periodFilter.fromDate,
        endDate: periodFilter.toDate,
      });
      const res = await fetch(`/api/stock-items/${stockItemId}/vouchers/${year}/${month}?${params}`);
      if (!res.ok) throw new Error("Failed to fetch vouchers");
      return res.json();
    },
    enabled: stockItemId > 0 && year > 0 && month > 0,
  });

  const formatNumber = (num: number, decimals = 2) => {
    if (num === 0) return "";
    return num.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  };

  const formatDate = (dateStr: string) => {
    try {
      return formatDisplayDate(new Date(dateStr));
    } catch {
      return dateStr;
    }
  };

  const getTransactionEditUrl = (txn: Transaction): string | null => {
    if (txn.isOpeningBalance) return null;

    const vchType = txn.vchType.toLowerCase();

    if (vchType === "purchase import") {
      return txn.poId ? `/purchase-orders/${txn.poId}/edit` : null;
    }

    if (vchType === "production" || vchType === "consumption") {
      const voucherType = vchType === "production" ? "Production" : "Consumption";
      return txn.voucherId ? voucherEditPath({ id: txn.voucherId, voucherType }) : null;
    }

    if (vchType.startsWith("pos") || vchType.includes("pos")) {
      return txn.voucherId ? `/pos/edit/${txn.voucherId}` : null;
    }

    if (vchType.startsWith("stock transfer")) {
      return txn.voucherId ? voucherEditPath({ id: txn.voucherId, voucherType: "Stock Transfer" }) : null;
    }

    if (vchType === "sales") {
      return txn.voucherId ? voucherEditPath({ id: txn.voucherId, voucherType: "Sales" }) : null;
    }

    return null;
  };

  const handleParticularsClick = (txn: Transaction) => {
    const url = getTransactionEditUrl(txn);
    if (url) {
      navigate(url);
    }
  };
  return {
    formatAmount,
    stockItemId,
    navigate,
    periodFilter,
    setPeriodFilter,
    isLoading,
    isError,
    data,
    refetch,
    formatNumber,
    formatDate,
    getTransactionEditUrl,
    handleParticularsClick,
  };
}
