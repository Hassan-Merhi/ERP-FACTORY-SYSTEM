import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useReactToPrint } from "react-to-print";
import { addDays, format, isValid, parseISO } from "date-fns";
import {
  ArrowRight,
  Calendar,
  ChevronLeft,
  ChevronRight,
  DollarSign,
  Eye,
  EyeOff,
  Lock,
  MessageCircle,
  Package,
  Pencil,
  Printer,
  X,
} from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PeriodFilter, type PeriodFilterValue, getDefaultPeriodValue } from "@/components/ui/period-filter";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useToast } from "@/hooks/use-toast";
import { usePaginatedFilterState } from "@/hooks/use-paginated-filter-state";
import { formatNumber } from "@/lib/formatNumber";
import type { AuthMe } from "@shared/apiTypes";
import { sendInvoicePdfWithRetry } from "./utils/posPrintHelpers";
import type { AuthMe } from "@shared/apiTypes";
import type { Voucher, VoucherWithItems } from "./posdaybook/types";

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
  const [, navigate] = useLocation();

  const [selectedVoucher, setSelectedVoucher] = useState<Voucher | null>(null);
  const [printVoucherId, setPrintVoucherId] = useState<number | null>(null);
  const [hiddenRowIds, setHiddenRowIds] = useState<Set<number>>(new Set());
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

  const { data: vouchers = [], isLoading } = useQuery<Voucher[]>({
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
          if (!isSupportedType) return false;
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

  const salesOnly = filteredVouchers.filter((voucher) => voucher.voucherType === "Sales");
  const transfersOnly = filteredVouchers.filter((voucher) => voucher.voucherType !== "Sales");
  const totalSales = salesOnly.reduce((sum, voucher) => sum + Number(voucher.totalAmount || 0), 0);

  const shiftDay = (days: number) => {
    const from = addDays(new Date(`${periodFilter.fromDate}T00:00:00`), days);
    const to = addDays(new Date(`${periodFilter.toDate}T00:00:00`), days);
    setFilter("periodFilter", {
      fromDate: format(from, "yyyy-MM-dd"),
      toDate: format(to, "yyyy-MM-dd"),
      preset: "custom",
    });
  };

  const subtitle =
    periodFilter.fromDate === periodFilter.toDate
      ? `Sales transactions - ${formatDisplayDate(new Date(`${periodFilter.fromDate}T00:00:00`))}`
      : `Sales transactions - ${formatDisplayDate(new Date(`${periodFilter.fromDate}T00:00:00`))} to ${formatDisplayDate(new Date(`${periodFilter.toDate}T00:00:00`))}`;

  const fmtPrint = (value: number) => {
    const fixed = Math.abs(value).toFixed(2);
    return fixed.endsWith(".00") ? fixed.slice(0, -3) : fixed;
  };

  return (
    <div className="container mx-auto space-y-4 p-4 md:space-y-6 md:p-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <PageHeader title="POS Daybook" subtitle={subtitle} />
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" onClick={() => shiftDay(-1)} title="Previous day">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <PeriodFilter
            value={periodFilter}
            onChange={(next) => setFilter("periodFilter", next)}
            data-testid="pos-daybook-period-filter"
          />
          <Button variant="ghost" size="icon" onClick={() => shiftDay(1)} title="Next day">
            <ChevronRight className="h-4 w-4" />
          </Button>
          {hasActiveFilters && (
            <Button variant="outline" size="sm" onClick={resetFilters} data-testid="button-reset-filters">
              <X className="mr-1 h-4 w-4" />
              Reset filters
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <Stat
          label="Sales"
          value={String(salesOnly.length)}
          icon={<Package className="h-4 w-4" />}
          loading={isLoading}
        />
        <Stat
          label="Total Revenue"
          value={formatCashAmount(totalSales)}
          icon={<DollarSign className="h-4 w-4" />}
          loading={isLoading}
        />
        <Stat
          label="Avg per Sale"
          value={formatCashAmount(salesOnly.length ? totalSales / salesOnly.length : 0)}
          icon={<Calendar className="h-4 w-4" />}
          loading={isLoading}
        />
        <Stat
          label="Transfers"
          value={String(transfersOnly.length)}
          icon={<ArrowRight className="h-4 w-4" />}
          loading={isLoading}
        />
      </div>

      <div>
        <div className="mb-3 flex items-center justify-between gap-2">
          <p className="text-sm font-semibold">Transactions</p>
          <Button
            variant={showHidden ? "secondary" : "outline"}
            size="sm"
            onClick={() => setFilter("showHidden", (value) => !value)}
            disabled={hiddenRowIds.size === 0}
          >
            {showHidden ? <Eye className="mr-1 h-4 w-4" /> : <EyeOff className="mr-1 h-4 w-4" />}
            {showHidden ? "Showing hidden" : "Show hidden"}
          </Button>
        </div>

        {isLoadingUser || isLoading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((key) => (
              <Skeleton key={key} className="h-12 w-full" />
            ))}
          </div>
        ) : visibleVouchers.length === 0 ? (
          <div className="py-12 text-center text-muted-foreground">No transactions found</div>
        ) : (
          <div className="overflow-hidden rounded-xl border">
            <div className="table-responsive">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40">
                    <TableHead>Time</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="hidden sm:table-cell">Location</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="hidden md:table-cell">Notes</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleVouchers.map((voucher) => {
                    const isOwnVoucher = !isPOS || voucher.userId === currentUser?.id;
                    const canAct = isOwnVoucher;
                    const isSending = whatsappMutation.isPending && whatsappMutation.variables?.id === voucher.id;
                    const isPrinting = printVoucherId === voucher.id;
                    const isHidden = hiddenRowIds.has(voucher.id);
                    return (
                      <TableRow key={voucher.id} className={isHidden && showHidden ? "opacity-50" : ""}>
                        <TableCell className="font-mono text-xs">
                          {voucher.createdAt && isValid(new Date(voucher.createdAt))
                            ? format(new Date(voucher.createdAt), "MMM dd, hh:mm a")
                            : "—"}
                        </TableCell>
                        <TableCell>
                          <Badge variant={voucher.voucherType === "Sales" ? "default" : "outline"}>
                            {voucher.voucherType === "Sales" ? "Sale" : "Transfer"}
                          </Badge>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">
                          {voucher.locationName || `Location ${voucher.locationId}`}
                        </TableCell>
                        <TableCell className="text-right font-mono font-semibold">
                          {formatCashAmount(Number(voucher.totalAmount || 0))}
                        </TableCell>
                        <TableCell className="hidden max-w-xs truncate md:table-cell">
                          {voucher.description || "-"}
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-1">
                            {voucher.voucherType === "Sales" && (
                              <>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  disabled={!canAct || isPrinting}
                                  onClick={() => setPrintVoucherId(voucher.id)}
                                  title={canAct ? "Print receipt" : "You can only print your own sales"}
                                >
                                  <Printer className={`h-4 w-4 ${isPrinting ? "animate-pulse" : ""}`} />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  disabled={!canAct || isSending}
                                  onClick={() => whatsappMutation.mutate(voucher)}
                                  title={canAct ? "Resend receipt on WhatsApp" : "You can only resend your own sales"}
                                >
                                  <MessageCircle className={`h-4 w-4 ${isSending ? "animate-pulse" : ""}`} />
                                </Button>
                              </>
                            )}
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled={!canAct}
                              onClick={() => canAct && setSelectedVoucher(voucher)}
                              title={canAct ? "View full sale details" : "You can only view your own sales"}
                            >
                              <Eye className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() =>
                                setHiddenRowIds((previous) => {
                                  const next = new Set(previous);
                                  if (next.has(voucher.id)) next.delete(voucher.id);
                                  else next.add(voucher.id);
                                  return next;
                                })
                              }
                              title={isHidden ? "Unhide row" : "Hide row"}
                            >
                              {isHidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </div>

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
            <Button
              variant="outline"
              disabled={!voucherDetails}
              onClick={() => voucherDetails && setPrintVoucherId(voucherDetails.id)}
            >
              <Printer className="mr-2 h-4 w-4" />
              Print
            </Button>
            <Button
              variant="outline"
              disabled={!voucherDetails || whatsappMutation.isPending}
              onClick={() => voucherDetails && whatsappMutation.mutate(voucherDetails)}
            >
              <MessageCircle className="mr-2 h-4 w-4" />
              Resend WhatsApp
            </Button>
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
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Stat({
  label,
  value,
  icon,
  loading,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  loading: boolean;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-muted/40 px-4 py-2.5">
      <div className="text-muted-foreground">{icon}</div>
      <div>
        <p className="mb-0.5 text-xs leading-none text-muted-foreground">{label}</p>
        {loading ? (
          <Skeleton className="mt-1 h-5 w-16" />
        ) : (
          <p className="font-mono text-lg font-semibold leading-none">{value}</p>
        )}
      </div>
    </div>
  );
}
