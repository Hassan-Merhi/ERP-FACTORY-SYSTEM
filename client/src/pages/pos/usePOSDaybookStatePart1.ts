// Extracted from ./POSDaybook.tsx to keep that module under the source-size cap.
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useReactToPrint } from "react-to-print";
import { format, isValid, parseISO } from "date-fns";
import { useChristmasMode } from "@/hooks/useChristmasMode";
import { useClientTablePagination } from "@/hooks/use-client-table-pagination";
import { getDefaultPeriodValue, type PeriodFilterValue } from "@/components/ui/period-filter";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useToast } from "@/hooks/use-toast";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { usePaginatedFilterState } from "@/hooks/use-paginated-filter-state";
import { sendInvoicePdfWithRetry } from "./utils/posPrintHelpers";
import type { AuthMe } from "@shared/apiTypes";
import type { Voucher, VoucherWithItems } from "./posdaybook/types";

const POS_DAYBOOK_PAGE_SIZE = 100;

export function usePOSDaybookStatePart1() {
  const { formatDisplayDate } = useDateFormat();
  const { formatCashAmount } = useCurrencyContext();
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const recordChanges = useExistingRecordChangeAccess();
  const [, navigate] = useLocation();

  const [selectedVoucher, setSelectedVoucher] = useState<Voucher | null>(null);
  const [optionalVoucher, setOptionalVoucher] = useState<Voucher | null>(null);
  const [printVoucherId, setPrintVoucherId] = useState<number | null>(null);
  const [hiddenRowIds, setHiddenRowIds] = useState<Set<number>>(new Set());
  const [transactionSearch, setTransactionSearch] = useState("");
  const [transactionKind, setTransactionKind] = useState<"all" | "sales" | "transfers">("all");
  const { settingQuery: christmasSetting } = useChristmasMode();
  const printRef = useRef<HTMLDivElement>(null);
  const printStartedRef = useRef(false);

  const urlParams = new URLSearchParams(window.location.search);
  const dateParam = urlParams.get("date");
  const voucherIdParam = urlParams.get("voucherId");

  const initialPeriod = (): PeriodFilterValue => {
    if (dateParam) {
      const parsed = parseISO(dateParam);
      if (isValid(parsed)) {
        const day = format(parsed, "yyyy-MM-dd");
        return { fromDate: day, toDate: day, preset: "custom" };
      }
    }
    return getDefaultPeriodValue("today");
  };

  const {
    filters: { periodFilter, showHidden },
    setFilter,
    resetFilters,
    hasActiveFilters,
  } = usePaginatedFilterState<{ periodFilter: PeriodFilterValue; showHidden: boolean }>({
    createInitialFilters: () => ({ periodFilter: initialPeriod(), showHidden: false }),
    storageKey: !dateParam && selectedCompany?.id ? `erp-pos-daybook-filters-v1:${selectedCompany.id}` : undefined,
  });

  const { data: currentUser, isLoading: isLoadingUser } = useQuery<AuthMe>({
    queryKey: ["/api/auth/me"],
  });

  const isAdminOrOwner = ["Admin", "Owner", "Developer"].includes(currentUser?.role ?? "");
  const isPOS = currentUser?.role === "POS";
  const daybookEditDays = Number(currentUser?.daybookEditDays || 0);
  const canEditDaybook = isAdminOrOwner || daybookEditDays > 0;
  const canSeeProfitCost = isAdminOrOwner;

  const { data: myLocations = [] } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["/api/my-locations"],
    enabled: isPOS,
  });
  const assignedLocationIds = useMemo(() => new Set(myLocations.map((location) => location.id)), [myLocations]);

  const {
    data: vouchers = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery<Voucher[]>({
    queryKey: ["/api/vouchers", selectedCompany?.id, periodFilter.fromDate, periodFilter.toDate],
    queryFn: async () => {
      const params = new URLSearchParams({
        startDate: periodFilter.fromDate,
        endDate: periodFilter.toDate,
      });
      const response = await fetch(`/api/vouchers?${params.toString()}`, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to load POS transactions");
      return response.json();
    },
    enabled: !isLoadingUser && Boolean(selectedCompany?.id),
  });

  const filteredVouchers = useMemo(
    () =>
      vouchers
        .filter((voucher) => {
          const isSupportedType = ["Sales", "Stock Transfer", "StockTransfer", "Transfer"].includes(voucher.voucherType);
          if (!isSupportedType || voucher.optional) return false;
          if (!isPOS) return true;
          // The server already validates each transfer's source/destination
          // stock legs and selects an assigned display location. Do not hide
          // receiving transfers merely because their voucher header is elsewhere.
          if (voucher.voucherType !== "Sales") return true;
          return assignedLocationIds.has(voucher.locationId);
        })
        .sort((a, b) => {
          const dateComparison = b.voucherDate.localeCompare(a.voucherDate);
          return dateComparison || b.voucherNumber.localeCompare(a.voucherNumber);
        }),
    [assignedLocationIds, isPOS, vouchers]
  );

  const visibleVouchers = showHidden
    ? filteredVouchers
    : filteredVouchers.filter((voucher) => !hiddenRowIds.has(voucher.id));

  // Keep summary totals tied to the selected date, not the text/type table search.
  const searchedVouchers = visibleVouchers.filter((voucher) => {
    const matchesKind =
      transactionKind === "all" ||
      (transactionKind === "sales" ? voucher.voucherType === "Sales" : voucher.voucherType !== "Sales");
    const term = transactionSearch.trim().toLocaleLowerCase();
    const matchesSearch =
      !term ||
      [voucher.voucherNumber, voucher.voucherType, voucher.locationName, voucher.description].some((value) =>
        String(value ?? "")
          .toLocaleLowerCase()
          .includes(term)
      );
    return matchesKind && matchesSearch;
  });
  const pagination = useClientTablePagination(searchedVouchers.length, POS_DAYBOOK_PAGE_SIZE);
  const { resetPage } = pagination;
  useEffect(() => {
    resetPage();
  }, [resetPage, periodFilter.fromDate, periodFilter.toDate, transactionKind, transactionSearch, showHidden]);

  const { data: voucherDetails, isLoading: detailsLoading } = useQuery<VoucherWithItems>({
    queryKey: selectedVoucher ? [`/api/vouchers/${selectedVoucher.id}`] : ["pos-daybook-no-selection"],
    enabled: Boolean(selectedVoucher),
  });

  const {
    data: printDetails,
    isLoading: printLoading,
    isError: printError,
  } = useQuery<VoucherWithItems>({
    queryKey: printVoucherId ? [`/api/vouchers/${printVoucherId}`] : ["pos-daybook-no-print"],
    enabled: Boolean(printVoucherId),
    retry: false,
  });

  const handlePrint = useReactToPrint({
    contentRef: printRef,
    documentTitle: printDetails?.voucherNumber ? `POS-${printDetails.voucherNumber}` : "POS-Invoice",
    onAfterPrint: () => {
      printStartedRef.current = false;
      setPrintVoucherId(null);
    },
    onPrintError: (_location, error) => {
      printStartedRef.current = false;
      setPrintVoucherId(null);
      toast({
        title: "Print failed",
        description: error?.message || "The browser could not open the print dialog.",
        variant: "destructive",
      });
    },
  });

  useEffect(() => {
    if (!printDetails || printLoading || printStartedRef.current) return;
    printStartedRef.current = true;
    const timer = window.setTimeout(() => handlePrint(), 150);
    return () => window.clearTimeout(timer);
  }, [handlePrint, printDetails, printLoading]);

  useEffect(() => {
    if (!printError || !printVoucherId) return;
    printStartedRef.current = false;
    setPrintVoucherId(null);
    toast({
      title: "Unable to print",
      description: "The sale details could not be loaded.",
      variant: "destructive",
    });
  }, [printError, printVoucherId, toast]);

  useEffect(() => {
    if (!voucherIdParam || vouchers.length === 0 || selectedVoucher) return;
    const id = Number(voucherIdParam);
    const match = filteredVouchers.find((voucher) => voucher.id === id);
    const params = new URLSearchParams(window.location.search);
    params.delete("voucherId");
    window.history.replaceState({}, "", `${window.location.pathname}${params.toString() ? `?${params}` : ""}`);
    if (match) setSelectedVoucher(match);
  }, [filteredVouchers, selectedVoucher, voucherIdParam, vouchers.length]);

  const whatsappMutation = useMutation({
    mutationFn: async (voucher: Voucher) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const result = await sendInvoicePdfWithRetry(voucher.id, voucher.locationId, {
        maxAttempts: 3,
      });
      if (!result.ok) throw new Error(result.message);
      return voucher;
    },
    onSuccess: (voucher) => {
      toast({
        title: "Sent on WhatsApp",
        description: `Receipt ${voucher.voucherNumber} was resent successfully.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "WhatsApp send failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });
  return {
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
  };
}
