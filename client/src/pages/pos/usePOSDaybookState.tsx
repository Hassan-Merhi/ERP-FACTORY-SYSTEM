// Extracted from ./POSDaybook.tsx to keep that module under the source-size cap.
import { useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import { addDays, format } from "date-fns";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useDaybookDayKeys } from "@/components/daybook/useDaybookDayKeys";
import { Skeleton } from "@/components/ui/skeleton";
import type { Voucher } from "./posdaybook/types";
import { usePOSDaybookStatePart1 } from "./usePOSDaybookStatePart1";

export function usePOSDaybookState() {
  const {
    canEditDaybook,
    canSeeProfitCost,
    christmasSetting,
    currentUser,
    detailsLoading,
    error,
    filteredVouchers,
    formatCashAmount,
    formatDisplayDate,
    hasActiveFilters,
    hiddenRowIds,
    isAdminOrOwner,
    isError,
    isLoading,
    isLoadingUser,
    isPOS,
    navigate,
    optionalVoucher,
    pagination,
    periodFilter,
    printDetails,
    printRef,
    printVoucherId,
    recordChanges,
    refetch,
    resetFilters,
    searchedVouchers,
    selectedCompany,
    selectedVoucher,
    setFilter,
    setHiddenRowIds,
    setOptionalVoucher,
    setPrintVoucherId,
    setSelectedVoucher,
    setTransactionKind,
    setTransactionSearch,
    showHidden,
    toast,
    transactionKind,
    transactionSearch,
    visibleVouchers,
    voucherDetails,
    whatsappMutation,
  } = usePOSDaybookStatePart1();
  const {
    clearAllFilters,
    fmtPrint,
    kindLabels,
    kpiValue,
    optionalMutation,
    salesOnly,
    searchTerm,
    shiftDay,
    showState,
    subtitle,
    totalSales,
    transfersOnly,
  } = usePOSDaybookStatePart2({
    filteredVouchers,
    formatDisplayDate,
    isError,
    isLoading,
    isLoadingUser,
    periodFilter,
    recordChanges,
    resetFilters,
    searchedVouchers,
    setFilter,
    setOptionalVoucher,
    setSelectedVoucher,
    setTransactionKind,
    setTransactionSearch,
    toast,
    transactionSearch,
  });
  return {
    canEditDaybook,
    canSeeProfitCost,
    christmasSetting,
    clearAllFilters,
    currentUser,
    detailsLoading,
    error,
    fmtPrint,
    formatCashAmount,
    hasActiveFilters,
    hiddenRowIds,
    isAdminOrOwner,
    isError,
    isLoading,
    isLoadingUser,
    isPOS,
    kindLabels,
    kpiValue,
    navigate,
    optionalMutation,
    optionalVoucher,
    pagination,
    periodFilter,
    printDetails,
    printRef,
    printVoucherId,
    recordChanges,
    refetch,
    salesOnly,
    searchTerm,
    searchedVouchers,
    selectedCompany,
    selectedVoucher,
    setFilter,
    setHiddenRowIds,
    setOptionalVoucher,
    setPrintVoucherId,
    setSelectedVoucher,
    setTransactionKind,
    setTransactionSearch,
    shiftDay,
    showHidden,
    showState,
    subtitle,
    totalSales,
    transactionKind,
    transactionSearch,
    transfersOnly,
    visibleVouchers,
    voucherDetails,
    whatsappMutation,
  };
}

function usePOSDaybookStatePart2({
  filteredVouchers,
  formatDisplayDate,
  isError,
  isLoading,
  isLoadingUser,
  periodFilter,
  recordChanges,
  resetFilters,
  searchedVouchers,
  setFilter,
  setOptionalVoucher,
  setSelectedVoucher,
  setTransactionKind,
  setTransactionSearch,
  toast,
  transactionSearch,
}: Pick<
  Awaited<ReturnType<typeof usePOSDaybookStatePart1>>,
  | "filteredVouchers"
  | "formatDisplayDate"
  | "isError"
  | "isLoading"
  | "isLoadingUser"
  | "periodFilter"
  | "recordChanges"
  | "resetFilters"
  | "searchedVouchers"
  | "setFilter"
  | "setOptionalVoucher"
  | "setSelectedVoucher"
  | "setTransactionKind"
  | "setTransactionSearch"
  | "toast"
  | "transactionSearch"
>) {
  const optionalMutation = useMutation({
    mutationFn: async (voucher: Voucher) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const response = await apiRequest("PATCH", `/api/vouchers/${voucher.id}/optional`, { optional: true });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.message || "Could not make this POS sale optional");
      }
      return voucher;
    },
    onSuccess: (voucher) => {
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers/optional"] });
      queryClient.invalidateQueries({ queryKey: ["/api/daybook"] });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory-by-location"] });
      queryClient.invalidateQueries({ queryKey: ["/api/location-summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/pos"] });
      setOptionalVoucher(null);
      setSelectedVoucher(null);
      toast({
        title: "POS sale made optional",
        description: `Sale ${voucher.voucherNumber} is now optional. Its inventory has been restored; restore the sale from Optional Vouchers when needed.`,
      });
    },
    onError: (error: Error) => {
      toast({ title: "POS optional change failed", description: error.message, variant: "destructive" });
    },
  });

  const salesOnly = filteredVouchers.filter((voucher) => voucher.voucherType === "Sales" && !voucher.optional);
  const transfersOnly = filteredVouchers.filter((voucher) => voucher.voucherType !== "Sales");
  const totalSales = salesOnly.reduce((sum, voucher) => sum + Number(voucher.totalAmount || 0), 0);

  const shiftDay = useCallback(
    (days: number) =>
      setFilter("periodFilter", (prev) => ({
        fromDate: format(addDays(new Date(`${prev.fromDate}T00:00:00`), days), "yyyy-MM-dd"),
        toDate: format(addDays(new Date(`${prev.toDate}T00:00:00`), days), "yyyy-MM-dd"),
        preset: "custom",
      })),
    [setFilter]
  );
  useDaybookDayKeys(shiftDay);

  const subtitle =
    periodFilter.fromDate === periodFilter.toDate
      ? `Sales transactions - ${formatDisplayDate(new Date(`${periodFilter.fromDate}T00:00:00`))}`
      : `Sales transactions - ${formatDisplayDate(new Date(`${periodFilter.fromDate}T00:00:00`))} to ${formatDisplayDate(new Date(`${periodFilter.toDate}T00:00:00`))}`;

  const fmtPrint = (value: number) => {
    const fixed = Math.abs(value).toFixed(2);
    return fixed.endsWith(".00") ? fixed.slice(0, -3) : fixed;
  };

  const kindLabels = { all: "All Types", sales: "Sales", transfers: "Transfers" } as const;
  const searchTerm = transactionSearch.trim();
  const clearAllFilters = () => {
    resetFilters();
    setTransactionSearch("");
    setTransactionKind("all");
  };
  const kpiValue = (value: string) => (isLoading ? <Skeleton className="h-7 w-24" /> : value);
  const showState = isLoadingUser || isLoading || isError || searchedVouchers.length === 0;
  return {
    clearAllFilters,
    fmtPrint,
    kindLabels,
    kpiValue,
    optionalMutation,
    salesOnly,
    searchTerm,
    shiftDay,
    showState,
    subtitle,
    totalSales,
    transfersOnly,
  };
}
