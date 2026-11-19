import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/page-state";
import { Skeleton } from "@/components/ui/skeleton";
import { X, ArrowLeftRight, DollarSign, Clock } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { RowsExportMenu, type RowsExportColumn } from "@/components/export/RowsExportMenu";
import { ErpListFilters } from "@/erp-core";
import { PeriodFilter } from "@/components/ui/period-filter";
import {
  StockTransfersDialogSection,
  useStockTransfersState,
  type StockTransferRow,
  type StockTransfersProps,
} from "./useStockTransfersState";
import { StockTransfersContent } from "./StockTransfersContent";

export default function StockTransfers(props: StockTransfersProps) {
  const {
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
  } = useStockTransfersState(props);

  const exportColumns: RowsExportColumn<StockTransferRow>[] = [
    ...(hideVoucherNotes ? [] : [{ header: "Voucher", value: (t: StockTransferRow) => t.voucherNumber }]),
    { header: "Date", value: (t) => formatVoucherDate(t.voucherDate) },
    { header: "From", value: (t) => t.sourceLocationName },
    { header: "To", value: (t) => t.destinationLocationName },
    { header: "Items", value: (t) => (t.stockItemNames ?? []).join(", ") },
    { header: "Total", value: (t) => t.totalAmount, type: "number" },
    { header: "Status", value: (t) => (t.inventoryApplied ? "Applied" : "Pending") },
    ...(hideVoucherNotes ? [] : [{ header: "Notes", value: (t: StockTransferRow) => t.notes }]),
  ];

  return (
    <div className="p-4 md:p-6 space-y-5 w-full">
      <PageHeader
        title="Stock Transfers"
        subtitle="All stock movement vouchers between locations"
        icon={<ArrowLeftRight className="h-5 w-5" />}
      >
        <RowsExportMenu
          title="Stock Transfers"
          rows={filtered}
          columns={exportColumns}
          resource="erp.stock_transfers"
          period={{ from: period.fromDate ?? "", to: period.toDate ?? "" }}
        />
      </PageHeader>

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

      <ErpListFilters
        search={search}
        onSearchChange={(value) => setFilter("search", value)}
        searchPlaceholder="Search by voucher, location, notes…"
        searchTestId="input-search"
        filters={<PeriodFilter value={period} onChange={(next) => setFilter("period", next)} />}
        actions={
          hasActiveFilters ? (
            <Button variant="outline" size="sm" type="button" onClick={resetFilters} data-testid="button-reset-filters">
              <X className="mr-2 h-4 w-4" />
              Reset filters
            </Button>
          ) : undefined
        }
      />

      {/* Table */}
      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : isError && transfers.length === 0 ? (
        <ErrorState onAction={() => void refetch()} actionLabel="Try again" className="py-16" />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={ArrowLeftRight}
          title="No transfers found"
          description={search ? "Try adjusting your search or date range" : "No stock transfers in the selected period"}
          className="py-16"
        />
      ) : (
        <StockTransfersContent
          filtered={filtered}
          formatAmount={formatAmount}
          formatVoucherDate={formatVoucherDate}
          hideVoucherNotes={hideVoucherNotes}
          openVoucher={openVoucher}
          recordChanges={recordChanges}
          selectedCompany={selectedCompany}
          startEdit={startEdit}
        />
      )}

      {/* Edit Notes Dialog */}
      <StockTransfersDialogSection
        editNotes={editNotes}
        editingTransfer={editingTransfer}
        formatAmount={formatAmount}
        formatVoucherDate={formatVoucherDate}
        saveNotes={saveNotes}
        setEditNotes={setEditNotes}
        setEditingTransfer={setEditingTransfer}
        updateNotesMutation={updateNotesMutation}
      />
    </div>
  );
}
