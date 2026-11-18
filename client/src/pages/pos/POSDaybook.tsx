import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useReactToPrint } from "react-to-print";
import { addDays, format, isValid, parseISO } from "date-fns";
import {
  ArrowRight,
  ReceiptText,
  ShoppingCart,
  Snowflake,
  DollarSign,
  Eye,
  EyeOff,
  Lock,
  MessageCircle,
  Package,
  Pencil,
  Printer,
  Undo2,
  X,
} from "lucide-react";

import { useChristmasMode } from "@/hooks/useChristmasMode";
import "@/styles/pos-daybook-modern.css";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import {
  DaybookHeader,
  DaybookKpiStrip,
  DaybookPage,
  DaybookResults,
  DaybookShowHiddenButton,
  DaybookTableState,
} from "@/components/daybook/DaybookFrame";
import { DaybookFilterBar } from "@/components/daybook/DaybookFilterBar";
import { useDaybookDayKeys } from "@/components/daybook/useDaybookDayKeys";
import { PaginationBar } from "@/components/PaginationBar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ErpListTable } from "@/erp-core";
import { useClientTablePagination } from "@/hooks/use-client-table-pagination";
import { Button } from "@/components/ui/button";
import { ExportButton } from "@/components/export/ReportExportMenu";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { type PeriodFilterValue, getDefaultPeriodValue } from "@/components/ui/period-filter";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useToast } from "@/hooks/use-toast";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { usePaginatedFilterState } from "@/hooks/use-paginated-filter-state";
import { formatNumber } from "@/lib/formatNumber";
import { sendInvoicePdfWithRetry } from "./utils/posPrintHelpers";
import type { AuthMe } from "@shared/apiTypes";
import type { Voucher, VoucherWithItems } from "./posdaybook/types";

const POS_DAYBOOK_PAGE_SIZE = 100;

const offscreenPrintStyle: React.CSSProperties = {
  position: "fixed",
  left: "-10000px",
  top: 0,
  width: "210mm",
  background: "white",
  color: "black",
  pointerEvents: "none",
};

export default function POSDaybook() {
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
    queryKey: ["/api/vouchers", periodFilter.fromDate, periodFilter.toDate],
    queryFn: async () => {
      const params = new URLSearchParams({
        startDate: periodFilter.fromDate,
        endDate: periodFilter.toDate,
      });
      const response = await fetch(`/api/vouchers?${params.toString()}`, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to load POS transactions");
      return response.json();
    },
    enabled: !isLoadingUser,
  });

  const filteredVouchers = useMemo(
    () =>
      vouchers
        .filter((voucher) => {
          const isSupportedType = ["Sales", "Stock Transfer", "StockTransfer"].includes(voucher.voucherType);
          if (!isSupportedType || voucher.optional) return false;
          if (!isPOS) return true;
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

  return (
    <DaybookPage className="mx-auto w-full max-w-[1560px] pb-8" data-pos-daybook="modern">
      <DaybookHeader
        title="POS Daybook"
        meta={
          <>
            <span>{subtitle}</span>
            {christmasSetting.data?.available === true && (
              <span className="pos-daybook-seasonal-chip inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium">
                <Snowflake className="h-3.5 w-3.5" aria-hidden="true" />
                Christmas {christmasSetting.data.enabled ? "On" : "Off"}
              </span>
            )}
          </>
        }
      />

      <DaybookKpiStrip
        label="Sales summary"
        items={[
          { id: "sales", label: "Sales", value: kpiValue(String(salesOnly.length)), icon: Package, tone: "count" },
          {
            id: "revenue",
            label: "Total Revenue",
            value: kpiValue(formatCashAmount(totalSales)),
            icon: DollarSign,
            tone: "value",
          },
          {
            id: "average",
            label: "Avg per Sale",
            value: kpiValue(formatCashAmount(salesOnly.length ? totalSales / salesOnly.length : 0)),
            icon: ReceiptText,
            tone: "active",
          },
          {
            id: "transfers",
            label: "Transfers",
            value: kpiValue(String(transfersOnly.length)),
            icon: ArrowRight,
            tone: "optional",
          },
        ]}
      />

      <DaybookFilterBar
        period={periodFilter}
        onPeriodChange={(next) => setFilter("periodFilter", next)}
        periodTestId="pos-daybook-period-filter"
        onPrevDay={() => shiftDay(-1)}
        onNextDay={() => shiftDay(1)}
        search={transactionSearch}
        onSearchChange={setTransactionSearch}
        searchPlaceholder="Search transactions..."
        searchLabel="Search POS transactions"
        searchTestId="pos-daybook-search"
        activeCount={transactionKind !== "all" ? 1 : 0}
        chips={[
          ...(transactionKind !== "all"
            ? [{ id: "type", label: kindLabels[transactionKind], onRemove: () => setTransactionKind("all") }]
            : []),
          ...(searchTerm
            ? [{ id: "search", label: <>Search: {searchTerm}</>, onRemove: () => setTransactionSearch("") }]
            : []),
        ]}
        hasActiveFilters={hasActiveFilters || !!searchTerm || transactionKind !== "all"}
        onClearFilters={clearAllFilters}
        data-testid="pos-daybook-filters"
      >
        <Select value={transactionKind} onValueChange={(value) => setTransactionKind(value as typeof transactionKind)}>
          <SelectTrigger className="daybook-filter-control w-full" aria-label="Transaction type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            <SelectItem value="sales">Sales</SelectItem>
            <SelectItem value="transfers">Transfers</SelectItem>
          </SelectContent>
        </Select>
      </DaybookFilterBar>

      <DaybookResults
        count={searchedVouchers.length}
        tools={
          <DaybookShowHiddenButton
            showHidden={showHidden}
            onToggle={() => setFilter("showHidden", (value) => !value)}
            hiddenCount={hiddenRowIds.size}
          />
        }
        footer={
          !showState && (
            <PaginationBar
              page={pagination.page}
              totalPages={pagination.totalPages}
              total={searchedVouchers.length}
              pageSize={pagination.pageSize}
              onPageChange={pagination.setPage}
              noun="transactions"
            />
          )
        }
      >
        {showState ? (
          <DaybookTableState
            isLoading={isLoadingUser || isLoading}
            errorMessage={isError ? (error instanceof Error ? error.message : "Failed to load POS transactions") : null}
            onRetry={() => void refetch()}
            isEmpty={searchedVouchers.length === 0}
            emptyTitle={visibleVouchers.length === 0 ? "No transactions found" : "No matching transactions"}
            emptyDescription={
              visibleVouchers.length === 0
                ? "There are no visible POS sales or transfers for the selected date."
                : "Try a different search term or transaction type."
            }
            emptyAction={
              isPOS ? (
                <Button className="mt-3 rounded-xl shadow-sm" onClick={() => navigate("/pos")}>
                  <ShoppingCart className="mr-2 h-4 w-4" />
                  New Sale
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ErpListTable pageKey="pos-daybook" scrollLabel="POS daybook">
            <TableHeader>
              <TableRow>
                <TableHead className="whitespace-nowrap">Time</TableHead>
                <TableHead className="whitespace-nowrap">Receipt #</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="hidden sm:table-cell">Location</TableHead>
                <TableHead className="whitespace-nowrap text-right">Amount</TableHead>
                <TableHead className="hidden md:table-cell">Notes</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pagination.paginate(searchedVouchers).map((voucher) => {
                const isOwnVoucher = !isPOS || voucher.userId === currentUser?.id;
                const canAct = isOwnVoucher;
                const isSending = whatsappMutation.isPending && whatsappMutation.variables?.id === voucher.id;
                const isPrinting = printVoucherId === voucher.id;
                const isHidden = hiddenRowIds.has(voucher.id);
                return (
                  <TableRow key={voucher.id} className={isHidden && showHidden ? "opacity-50" : ""}>
                    <TableCell className="whitespace-nowrap text-xs font-medium tabular-nums">
                      {voucher.createdAt && isValid(new Date(voucher.createdAt))
                        ? format(new Date(voucher.createdAt), "MMM dd, hh:mm a")
                        : "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm font-semibold tabular-nums">
                      {voucher.voucherNumber}
                    </TableCell>
                    <TableCell>
                      <Badge
                        className={
                          voucher.voucherType === "Sales" ? "pos-daybook-sale-badge" : "pos-daybook-transfer-badge"
                        }
                      >
                        {voucher.voucherType === "Sales" ? "Sale" : "Transfer"}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      {voucher.locationName || `Location ${voucher.locationId}`}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right font-semibold tabular-nums">
                      {formatCashAmount(Number(voucher.totalAmount || 0))}
                    </TableCell>
                    <TableCell
                      className="hidden max-w-[220px] truncate text-muted-foreground md:table-cell"
                      title={voucher.description || ""}
                    >
                      {voucher.description || "—"}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        {voucher.voucherType === "Sales" && (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-9 w-9 rounded-lg"
                              disabled={!canAct || isPrinting}
                              onClick={() => setPrintVoucherId(voucher.id)}
                              title={canAct ? "Print receipt" : "You can only print your own sales"}
                              aria-label={`Print receipt ${voucher.voucherNumber}`}
                            >
                              <Printer className={`h-4 w-4 ${isPrinting ? "animate-pulse" : ""}`} />
                            </Button>
                            {recordChanges.allowed && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-9 w-9 rounded-lg"
                                disabled={!canAct || isSending}
                                onClick={() => whatsappMutation.mutate(voucher)}
                                title={canAct ? "Resend receipt on WhatsApp" : "You can only resend your own sales"}
                                aria-label={`Resend ${voucher.voucherNumber} on WhatsApp`}
                              >
                                <MessageCircle className={`h-4 w-4 ${isSending ? "animate-pulse" : ""}`} />
                              </Button>
                            )}
                          </>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-9 w-9 rounded-lg"
                          disabled={!canAct}
                          onClick={() => canAct && setSelectedVoucher(voucher)}
                          title={canAct ? "View full sale details" : "You can only view your own sales"}
                          aria-label={`View ${voucher.voucherNumber}`}
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-9 w-9 rounded-lg"
                          onClick={() =>
                            setHiddenRowIds((previous) => {
                              const next = new Set(previous);
                              if (next.has(voucher.id)) next.delete(voucher.id);
                              else next.add(voucher.id);
                              return next;
                            })
                          }
                          title={isHidden ? "Unhide row" : "Hide row"}
                          aria-label={`${isHidden ? "Unhide" : "Hide"} ${voucher.voucherNumber}`}
                        >
                          {isHidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </ErpListTable>
        )}
      </DaybookResults>

      <div style={offscreenPrintStyle} aria-hidden="true">
        <div ref={printRef} className="bg-white p-6 text-black">
          <style>{`@page { margin: 10mm; } @media print { body { background: white !important; } }`}</style>
          <div className="mb-4 text-center text-2xl font-black tracking-wider">POS INVOICE</div>
          <div className="mb-3 flex justify-between border-y-2 border-black py-2 text-sm font-bold">
            <span>Receipt: {printDetails?.voucherNumber || "—"}</span>
            <span>Date: {printDetails?.voucherDate || "—"}</span>
          </div>
          <div className="mb-3 text-sm">
            <div>Location: {printDetails?.locationName || `Location ${printDetails?.locationId || "—"}`}</div>
            {printDetails?.customerName && <div>Customer: {printDetails.customerName}</div>}
            {printDetails?.isCreditSale && <div className="font-bold">CREDIT SALE</div>}
          </div>
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className="border border-black p-2 text-left">Item</th>
                <th className="border border-black p-2 text-right">Qty</th>
                <th className="border border-black p-2 text-right">Price</th>
                <th className="border border-black p-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {(printDetails?.salesItems || []).map((item) => {
                const qty = Number(item.quantity || 0);
                const price = Number(item.sellingPrice || 0);
                return (
                  <tr key={item.id}>
                    <td className="border border-black p-2">{item.stockItemName || `Item ${item.stockItemId}`}</td>
                    <td className="border border-black p-2 text-right">{fmtPrint(qty)}</td>
                    <td className="border border-black p-2 text-right">${fmtPrint(price)}</td>
                    <td className="border border-black p-2 text-right">${fmtPrint(qty * price)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="mt-4 flex justify-between border-t-2 border-black pt-3 text-lg font-black">
            <span>TOTAL PAID</span>
            <span>{formatCashAmount(Number(printDetails?.totalAmount || 0))}</span>
          </div>
          {printDetails?.description && (
            <div className="mt-3 border border-black p-2 text-sm">Note: {printDetails.description}</div>
          )}
          {selectedCompany?.name && <div className="mt-5 text-center text-sm font-bold">{selectedCompany.name}</div>}
        </div>
      </div>

      <Dialog open={Boolean(selectedVoucher)} onOpenChange={(open) => !open && setSelectedVoucher(null)}>
        <DialogContent className="flex max-h-[85vh] w-[95vw] max-w-4xl flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>POS Sale Details - {selectedVoucher?.voucherNumber}</DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto">
            {detailsLoading ? (
              <div className="space-y-2">
                {[0, 1, 2].map((key) => (
                  <Skeleton key={key} className="h-14 w-full" />
                ))}
              </div>
            ) : voucherDetails ? (
              <div className="space-y-4">
                <div className="grid gap-2 rounded-lg border p-3 text-sm sm:grid-cols-2">
                  <div>
                    <span className="text-muted-foreground">Receipt:</span> {voucherDetails.voucherNumber}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Date:</span> {voucherDetails.voucherDate}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Location:</span>{" "}
                    {voucherDetails.locationName || `Location ${voucherDetails.locationId}`}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Type:</span> {voucherDetails.voucherType}
                  </div>
                  {voucherDetails.customerName && (
                    <div>
                      <span className="text-muted-foreground">Customer:</span> {voucherDetails.customerName}
                    </div>
                  )}
                  {voucherDetails.isCreditSale && <div className="font-semibold">Credit sale</div>}
                  {voucherDetails.description && (
                    <div className="sm:col-span-2">
                      <span className="text-muted-foreground">Notes:</span> {voucherDetails.description}
                    </div>
                  )}
                </div>
                <div className="table-responsive">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Item</TableHead>
                        <TableHead className="text-right">Qty</TableHead>
                        <TableHead className="text-right">Price</TableHead>
                        <TableHead className="text-right">Total</TableHead>
                        {canSeeProfitCost && <TableHead className="text-right">Cost</TableHead>}
                        {canSeeProfitCost && <TableHead className="text-right">Profit</TableHead>}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(voucherDetails.salesItems || []).map((item) => (
                        <TableRow key={item.id}>
                          <TableCell>{item.stockItemName || `Item ${item.stockItemId}`}</TableCell>
                          <TableCell className="text-right font-mono">
                            {formatNumber(Number(item.quantity || 0), 0)}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {formatCashAmount(Number(item.sellingPrice || 0))}
                          </TableCell>
                          <TableCell className="text-right font-mono font-semibold">
                            {formatCashAmount(Number(item.totalSales || 0))}
                          </TableCell>
                          {canSeeProfitCost && (
                            <TableCell className="text-right font-mono">
                              {formatCashAmount(Number(item.costPrice || 0))}
                            </TableCell>
                          )}
                          {canSeeProfitCost && (
                            <TableCell className="text-right font-mono">
                              {formatCashAmount(Number(item.profit || 0))}
                            </TableCell>
                          )}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <div className="flex justify-end text-lg font-semibold">
                  Total: {formatCashAmount(Number(voucherDetails.totalAmount || 0))}
                </div>
              </div>
            ) : (
              <div className="py-8 text-center text-muted-foreground">Sale details could not be loaded.</div>
            )}
          </div>
          <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
            <Button variant="outline" onClick={() => setSelectedVoucher(null)}>
              <X className="mr-2 h-4 w-4" />
              Close
            </Button>
            <ExportButton
              kind="print"
              variant="outline"
              disabled={!voucherDetails}
              onClick={() => voucherDetails && setPrintVoucherId(voucherDetails.id)}
            />
            {recordChanges.allowed && (
              <Button
                variant="outline"
                disabled={!voucherDetails || whatsappMutation.isPending}
                onClick={() => voucherDetails && whatsappMutation.mutate(voucherDetails)}
              >
                <MessageCircle className="mr-2 h-4 w-4" />
                Resend WhatsApp
              </Button>
            )}
            {recordChanges.allowed &&
              isAdminOrOwner &&
              selectedVoucher?.voucherType === "Sales" &&
              !selectedVoucher.optional && (
                <Button
                  variant="outline"
                  disabled={optionalMutation.isPending}
                  onClick={() => setOptionalVoucher(selectedVoucher)}
                  data-testid="pos-daybook-make-optional"
                >
                  <Undo2 className="mr-2 h-4 w-4" />
                  Make Optional
                </Button>
              )}
            {recordChanges.allowed && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span>
                      <Button
                        disabled={!canEditDaybook || !selectedVoucher}
                        onClick={() => selectedVoucher && navigate(`/pos/edit/${selectedVoucher.id}`)}
                      >
                        {canEditDaybook ? <Pencil className="mr-2 h-4 w-4" /> : <Lock className="mr-2 h-4 w-4" />}
                        Edit Transaction
                      </Button>
                    </span>
                  </TooltipTrigger>
                  {!canEditDaybook && <TooltipContent>Editing is disabled in Settings for this user.</TooltipContent>}
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(optionalVoucher)}
        onOpenChange={(open) => !open && setOptionalVoucher(null)}
        title={`Make POS ${optionalVoucher?.voucherNumber ?? ""} optional?`}
        description="This suspends the sale from ERP accounting and POS totals and restores its sold items to the original stock location at their recorded cost. Only make a posted sale optional when it is genuinely canceled or being corrected. You can reactivate it from Optional Vouchers, subject to stock and accounting-period checks."
        tone="warning"
        confirmText="Make POS Optional"
        loading={optionalMutation.isPending}
        confirmDisabled={!optionalVoucher}
        onConfirm={async () => {
          if (!optionalVoucher) return;
          await optionalMutation.mutateAsync(optionalVoucher);
        }}
      />
    </DaybookPage>
  );
}
