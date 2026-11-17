// Extracted from ./StockTransfers.tsx to keep that module under the source-size cap.
import { searchAny } from "@shared/searchNormalization";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useDebounce } from "@/hooks/use-debounce";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ArrowRight, Package, Save, X } from "lucide-react";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { ErpField, ErpFormActions, ErpPendingButton, useErpDateFormat } from "@/erp-core";
import { erpCompanyDataKey, erpRequestUrl, invalidateErpDataFamilies } from "@/erp-core/erpData";
import { getDefaultPeriodValue, PeriodFilterValue } from "@/components/ui/period-filter";
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

export interface StockTransfersProps {
  hideVoucherNotes?: boolean;
}

interface StockTransferFilters extends Record<string, unknown> {
  period: PeriodFilterValue;
  search: string;
}

function createStockTransferFilters(): StockTransferFilters {
  return { period: getDefaultPeriodValue(), search: "" };
}

export function useStockTransfersState({ hideVoucherNotes = false }: StockTransfersProps) {
  const [, setLocation] = useLocation();
  const { formatAmount } = useCurrencyContext();
  const { formatShortDate: formatDate } = useErpDateFormat();
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const recordChanges = useExistingRecordChangeAccess();

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

  const queryUrl = erpRequestUrl("/api/stock-transfers/list", { startDate, endDate });
  const {
    data: transfers = [],
    isLoading,
    isError,
    refetch,
  } = useQuery<StockTransferRow[]>({
    queryKey: erpCompanyDataKey(queryUrl, selectedCompany?.id),
    queryFn: async () => {
      const res = await fetch(queryUrl, { credentials: "include" });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    enabled: selectedCompany?.id != null,
  });

  const updateNotesMutation = useMutation({
    mutationFn: async ({ transferId, notes }: { transferId: number; notes: string }) => {
      const res = await apiRequest("PATCH", `/api/stock-transfers/${transferId}`, { notes });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Notes updated" });
      void invalidateErpDataFamilies(queryClient, ["/api/stock-transfers/list"]);
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
      return formatDate(d);
    } catch {
      return d;
    }
  };

  const totalValue = transfers.reduce((s, t) => s + (t.totalAmount || 0), 0);
  const pendingCount = transfers.filter((t) => !t.inventoryApplied).length;
  return {
    refetch,
    isError,
    editNotes,
    editingTransfer,
    filtered,
    formatAmount,
    formatVoucherDate,
    hasActiveFilters,
    hideVoucherNotes,
    isLoading,
    openVoucher,
    pendingCount,
    period,
    recordChanges,
    resetFilters,
    saveNotes,
    search,
    selectedCompany,
    setEditNotes,
    setEditingTransfer,
    setFilter,
    startEdit,
    totalValue,
    transfers,
    updateNotesMutation,
  };
}

export function StockTransfersDialogSection({
  editNotes,
  editingTransfer,
  formatAmount,
  formatVoucherDate,
  saveNotes,
  setEditNotes,
  setEditingTransfer,
  updateNotesMutation,
}: Pick<
  ReturnType<typeof useStockTransfersState>,
  | "editNotes"
  | "editingTransfer"
  | "formatAmount"
  | "formatVoucherDate"
  | "saveNotes"
  | "setEditNotes"
  | "setEditingTransfer"
  | "updateNotesMutation"
>) {
  return (
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
          <ErpField id="transfer-notes" label="Notes">
            {(control) => (
              <Textarea
                {...control}
                value={editNotes}
                onChange={(e) => setEditNotes(e.target.value)}
                placeholder="Transfer notes…"
                className="min-h-28 resize-none"
                data-testid="input-edit-notes"
              />
            )}
          </ErpField>
        </div>
        <ErpFormActions layout="dialog" className="gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setEditingTransfer(null)}
            disabled={updateNotesMutation.isPending}
            data-testid="button-cancel-edit"
          >
            <X className="h-4 w-4 mr-2" />
            Cancel
          </Button>
          <ErpPendingButton
            onClick={saveNotes}
            pending={updateNotesMutation.isPending}
            pendingLabel="Saving…"
            data-testid="button-save-notes"
          >
            <Save className="h-4 w-4 mr-2" />
            Save
          </ErpPendingButton>
        </ErpFormActions>
      </DialogContent>
    </Dialog>
  );
}
