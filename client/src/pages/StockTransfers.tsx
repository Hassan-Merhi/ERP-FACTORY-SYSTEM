import { searchAny } from "@shared/searchNormalization";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useDebounce } from "@/hooks/use-debounce";
import { useLocation } from "wouter";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ArrowRight,
  ExternalLink,
  Pencil,
  Save,
  X,
  ArrowLeftRight,
  Search,
  Package,
  DollarSign,
  Clock,
} from "lucide-react";
import { parseISO } from "date-fns";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { PageHeader } from "@/components/PageHeader";
import { PeriodFilter, PeriodFilterValue, getDefaultPeriodValue } from "@/components/ui/period-filter";
import { useDateJump } from "@/hooks/use-date-jump";
import { usePaginatedFilterState } from "@/hooks/use-paginated-filter-state";
import { useCompany } from "@/contexts/CompanyContext";

interface StockTransferRow {
  transferId: number;
  voucherId: number;
  voucherNumber: string;
  voucherDate: string;
  notes: string | null;
  inventoryApplied: boolean | null;
  sourceLocationName: string;
  destinationLocationName: string;
  itemCount: number;
  totalAmount: number;
  stockItemNames: string[];
  createdAt: string;
}

interface StockTransfersProps {
  hideVoucherNotes?: boolean;
}

interface StockTransferFilters extends Record<string, unknown> {
  period: PeriodFilterValue;
  search: string;
}

function createStockTransferFilters(): StockTransferFilters {
  return { period: getDefaultPeriodValue(), search: "" };
}

export default function StockTransfers({ hideVoucherNotes = false }: StockTransfersProps) {
  const [, setLocation] = useLocation();
  const { formatAmount } = useCurrencyContext();
  const { formatShortDate: formatDate } = useDateFormat();
  const { toast } = useToast();
  const { selectedCompany } = useCompany();

  const {
    filters: { period, search },
    setFilter,
    resetFilters,
    hasActiveFilters,
  } = usePaginatedFilterState<StockTransferFilters>({
    createInitialFilters: createStockTransferFilters,
    storageKey: selectedCompany?.id ? `erp-stock-transfers-filters-v1:${selectedCompany.id}` : undefined,
  });
  useDateJump((date) => setFilter("period", { fromDate: date, toDate: date, preset: "custom" }));
  const debouncedSearch = useDebounce(search, 300);
  const [editingTransfer, setEditingTransfer] = useState<StockTransferRow | null>(null);
  const [editNotes, setEditNotes] = useState("");

  const startDate = period.fromDate ?? "";
  const endDate = period.toDate ?? "";

  const params = new URLSearchParams();
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  const queryString = params.toString();

  const { data: transfers = [], isLoading } = useQuery<StockTransferRow[]>({
    queryKey: ["/api/stock-transfers/list", startDate, endDate],
    queryFn: async () => {
      const res = await fetch(`/api/stock-transfers/list${queryString ? `?${queryString}` : ""}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
  });

  const updateNotesMutation = useMutation({
    mutationFn: async ({ transferId, notes }: { transferId: number; notes: string }) => {
      const res = await apiRequest("PATCH", `/api/stock-transfers/${transferId}`, { notes });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Notes updated" });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-transfers/list"] });
      setEditingTransfer(null);
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update notes", description: err.message, variant: "destructive" });
    },
  });

  const filtered = transfers.filter((t) => {
    if (!debouncedSearch.trim()) return true;
    return searchAny(
      debouncedSearch,
      t.voucherNumber,
      t.sourceLocationName,
      t.destinationLocationName,
      t.notes,
      ...(t.stockItemNames ?? [])
    );
  });

  const openVoucher = (voucherId: number) => {
    setLocation(`/daybook?voucherId=${voucherId}`);
  };

  const startEdit = (t: StockTransferRow) => {
    setEditingTransfer(t);
    setEditNotes(t.notes ?? "");
  };

  const saveNotes = () => {
    if (!editingTransfer) return;
    updateNotesMutation.mutate({ transferId: editingTransfer.transferId, notes: editNotes });
  };

  const formatVoucherDate = (d: string) => {
    try {
      return formatDate(parseISO(d));
    } catch {
      return d;
    }
  };

  const totalValue = transfers.reduce((s, t) => s + (t.totalAmount || 0), 0);
  const pendingCount = transfers.filter((t) => !t.inventoryApplied).length;

  return (
    <div className="p-4 md:p-6 space-y-5 w-full">
      <PageHeader
        title="Stock Transfers"
        subtitle="All stock movement vouchers between locations"
        icon={<ArrowLeftRight className="h-5 w-5" />}
      />

      {/* Stats pill bar */}
      <div className="flex flex-wrap gap-3">
        <div className="rounded-lg border bg-muted/40 px-4 py-2.5 flex items-center gap-3">
          <ArrowLeftRight className="h-4 w-4 text-muted-foreground shrink-0" />
          <div>
            <p className="text-xs text-muted-foreground leading-none mb-0.5">Transfers</p>
            {isLoading ? (
              <Skeleton className="h-5 w-10 mt-0.5" />
            ) : (
              <p className="text-lg font-semibold leading-none">{transfers.length}</p>
            )}
          </div>
        </div>
        <div className="rounded-lg border bg-muted/40 px-4 py-2.5 flex items-center gap-3">
          <DollarSign className="h-4 w-4 text-muted-foreground shrink-0" />
          <div>
            <p className="text-xs text-muted-foreground leading-none mb-0.5">Total Value</p>
            {isLoading ? (
              <Skeleton className="h-5 w-20 mt-0.5" />
            ) : (
              <p className="text-lg font-semibold leading-none font-mono">{formatAmount(totalValue)}</p>
            )}
          </div>
        </div>
        <div className="rounded-lg border bg-muted/40 px-4 py-2.5 flex items-center gap-3">
          <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
          <div>
            <p className="text-xs text-muted-foreground leading-none mb-0.5">Pending</p>
            {isLoading ? (
              <Skeleton className="h-5 w-10 mt-0.5" />
            ) : (
              <p className="text-lg font-semibold leading-none">{pendingCount}</p>
            )}
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <PeriodFilter value={period} onChange={(next) => setFilter("period", next)} />
        <div className="relative flex-1 min-w-48 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by voucher, location, notes…"
            value={search}
            onChange={(e) => setFilter("search", e.target.value)}
            className="pl-8"
            data-testid="input-search"
          />
        </div>
        {hasActiveFilters && (
          <Button variant="outline" size="sm" onClick={resetFilters} data-testid="button-reset-filters">
            <X className="mr-2 h-4 w-4" />
            Reset filters
          </Button>
        )}
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <ArrowLeftRight className="h-12 w-12 mx-auto mb-4 opacity-40" />
          <p className="text-base font-medium">No transfers found</p>
          <p className="text-sm mt-1">
            {search ? "Try adjusting your search or date range" : "No stock transfers in the selected period"}
          </p>
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block border rounded-xl overflow-hidden">
            <div className="table-responsive">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    {!hideVoucherNotes && <TableHead className="text-xs whitespace-nowrap">Voucher</TableHead>}
                    <TableHead className="text-xs whitespace-nowrap">Date</TableHead>
                    <TableHead className="text-xs whitespace-nowrap">Route</TableHead>
                    <TableHead className="text-xs whitespace-nowrap">Items</TableHead>
                    <TableHead className="text-xs whitespace-nowrap text-right">Total</TableHead>
                    <TableHead className="text-xs whitespace-nowrap">Status</TableHead>
                    {!hideVoucherNotes && <TableHead className="text-xs whitespace-nowrap">Notes</TableHead>}
                    <TableHead className="text-xs whitespace-nowrap text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((t) => (
                    <TableRow
                      key={t.transferId}
                      className="hover-elevate cursor-pointer"
                      onClick={() => openVoucher(t.voucherId)}
                      data-testid={`row-transfer-${t.transferId}`}
                    >
                      {!hideVoucherNotes && (
                        <TableCell className="font-mono text-sm font-medium whitespace-nowrap">
                          {t.voucherNumber}
                        </TableCell>
                      )}
                      <TableCell className="whitespace-nowrap text-sm">{formatVoucherDate(t.voucherDate)}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm">
                        <span className="flex items-center gap-1.5">
                          <span>{t.sourceLocationName}</span>
                          <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
                          <span>{t.destinationLocationName}</span>
                        </span>
                      </TableCell>
                      <TableCell className="text-sm max-w-52">
                        <TooltipProvider>
                          {(t.stockItemNames ?? []).length === 0 ? (
                            <span className="text-muted-foreground/50 italic">—</span>
                          ) : (t.stockItemNames ?? []).length <= 2 ? (
                            <span>{(t.stockItemNames ?? []).join(", ")}</span>
                          ) : (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="cursor-default underline decoration-dotted underline-offset-2">
                                  {(t.stockItemNames ?? [])[0]}{" "}
                                  <span className="text-muted-foreground text-xs">
                                    +{(t.stockItemNames ?? []).length - 1} more
                                  </span>
                                </span>
                              </TooltipTrigger>
                              <TooltipContent side="top" className="max-w-xs">
                                <ul className="text-xs space-y-0.5">
                                  {(t.stockItemNames ?? []).map((n, i) => (
                                    <li key={i}>{n}</li>
                                  ))}
                                </ul>
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </TooltipProvider>
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm tabular-nums whitespace-nowrap">
                        {formatAmount(t.totalAmount)}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={t.inventoryApplied ? "default" : "secondary"}
                          className="text-xs whitespace-nowrap"
                        >
                          {t.inventoryApplied ? "Applied" : "Pending"}
                        </Badge>
                      </TableCell>
                      {!hideVoucherNotes && (
                        <TableCell className="max-w-44 text-sm text-muted-foreground truncate">
                          {t.notes || <span className="italic text-muted-foreground/40">—</span>}
                        </TableCell>
                      )}
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                          <Button
                            size="icon"
                            variant="ghost"
                            title="Edit notes"
                            onClick={() => startEdit(t)}
                            data-testid={`button-edit-${t.transferId}`}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            title="Open voucher"
                            onClick={() => openVoucher(t.voucherId)}
                            data-testid={`button-open-${t.transferId}`}
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden space-y-2">
            {filtered.map((t) => (
              <div
                key={t.transferId}
                className="border rounded-xl p-3 cursor-pointer"
                onClick={() => openVoucher(t.voucherId)}
                data-testid={`card-transfer-${t.transferId}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    {!hideVoucherNotes && (
                      <div className="font-mono text-xs font-medium text-muted-foreground mb-0.5">
                        {t.voucherNumber}
                      </div>
                    )}
                    <div className="flex items-center gap-1 text-sm font-medium flex-wrap">
                      <span>{t.sourceLocationName}</span>
                      <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
                      <span>{t.destinationLocationName}</span>
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">{formatVoucherDate(t.voucherDate)}</div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-mono text-sm font-medium">{formatAmount(t.totalAmount)}</div>
                    <div className="flex items-center justify-end gap-1 mt-1">
                      {t.itemCount > 0 && (
                        <span
                          className="text-xs text-muted-foreground"
                          data-testid={`text-item-count-mobile-${t.transferId}`}
                        >
                          {t.itemCount} {t.itemCount === 1 ? "item" : "items"}
                        </span>
                      )}
                      <Badge variant={t.inventoryApplied ? "default" : "secondary"} className="text-xs">
                        {t.inventoryApplied ? "Applied" : "Pending"}
                      </Badge>
                    </div>
                  </div>
                </div>
                {((t.stockItemNames ?? []).length > 0 || (!hideVoucherNotes && t.notes)) && (
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <div className="text-xs text-muted-foreground truncate">
                      {(t.stockItemNames ?? []).join(", ")}
                      {!hideVoucherNotes && t.notes && <span className="ml-1 italic">{t.notes}</span>}
                    </div>
                    <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                      <Button
                        size="icon"
                        variant="ghost"
                        title="Edit notes"
                        onClick={() => startEdit(t)}
                        data-testid={`button-edit-mobile-${t.transferId}`}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        title="Open voucher"
                        onClick={() => openVoucher(t.voucherId)}
                        data-testid={`button-open-mobile-${t.transferId}`}
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                )}
                {(t.stockItemNames ?? []).length === 0 && (hideVoucherNotes || !t.notes) && (
                  <div className="mt-2 flex justify-end" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        title="Edit notes"
                        onClick={() => startEdit(t)}
                        data-testid={`button-edit-mobile-${t.transferId}`}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        title="Open voucher"
                        onClick={() => openVoucher(t.voucherId)}
                        data-testid={`button-open-mobile-${t.transferId}`}
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {/* Edit Notes Dialog */}
      <Dialog
        open={!!editingTransfer}
        onOpenChange={(open) => {
          if (!open) setEditingTransfer(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Transfer Notes — {editingTransfer?.voucherNumber}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-1">
            {editingTransfer && (
              <div className="rounded-lg border bg-muted/40 px-3 py-2.5 space-y-1">
                <div className="flex items-center gap-1.5 text-sm font-medium">
                  <span>{editingTransfer.sourceLocationName}</span>
                  <ArrowRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span>{editingTransfer.destinationLocationName}</span>
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span>{formatVoucherDate(editingTransfer.voucherDate)}</span>
                  {editingTransfer.stockItemNames?.length > 0 && (
                    <>
                      <span>·</span>
                      <span className="flex items-center gap-1">
                        <Package className="h-3 w-3" />
                        {editingTransfer.stockItemNames.length} item
                        {editingTransfer.stockItemNames.length !== 1 ? "s" : ""}
                      </span>
                    </>
                  )}
                  <span>·</span>
                  <span>{formatAmount(editingTransfer.totalAmount)}</span>
                </div>
              </div>
            )}
            <Textarea
              value={editNotes}
              onChange={(e) => setEditNotes(e.target.value)}
              placeholder="Transfer notes…"
              className="min-h-28 resize-none"
              data-testid="input-edit-notes"
            />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setEditingTransfer(null)} data-testid="button-cancel-edit">
              <X className="h-4 w-4 mr-2" />
              Cancel
            </Button>
            <Button onClick={saveNotes} disabled={updateNotesMutation.isPending} data-testid="button-save-notes">
              <Save className="h-4 w-4 mr-2" />
              {updateNotesMutation.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
