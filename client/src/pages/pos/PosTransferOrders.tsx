import { PageHeader } from "@/components/PageHeader";
import { RowsExportMenu } from "@/components/export/RowsExportMenu";
import { CheckCircle2, X, Clock, Package2, CalendarIcon, Plus, ClipboardList, ShoppingCart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/page-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import "@/styles/pos-orders-premium.css";

import type { PosTransferOrdersProps } from "./postransferorders/types";
import { formatDate } from "./postransferorders/utils";
import { TransferOrderDetail } from "./postransferorders/components/TransferOrderDetail";
import { CreateTransferDialog } from "./postransferorders/components/CreateTransferDialog";
import { ViewTransferDialog } from "./postransferorders/components/ViewTransferDialog";
import { PosTransferApprovalQueue } from "./postransferorders/components/PosTransferApprovalQueue";
import { SearchField } from "@/components/ui/search-field";
import { usePosTransferOrdersState } from "./usePosTransferOrdersState";
import { PosTransferOrdersContent } from "./PosTransferOrdersContent";

export default function PosTransferOrders({ posUser }: PosTransferOrdersProps) {
  const {
    editVoucherId,
    setEditVoucherId,
    viewVoucherId,
    setViewVoucherId,
    viewDialogOpen,
    setViewDialogOpen,
    setCreateOpen,
    createOpen,
    search,
    setSearch,
    statusFilter,
    setStatusFilter,
    dateFilter,
    setDateFilter,
    myLocations,
    isLoading,
    isError,
    allTransfers,
    refetch,
    transfers,
    openView,
    clearFilters,
    hasFilters,
    appliedCount,
    pendingCount,
  } = usePosTransferOrdersState();

  if (editVoucherId !== null) {
    return (
      <div className="flex min-h-0 flex-col">
        <TransferOrderDetail voucherId={editVoucherId} posUser={posUser} onBack={() => setEditVoucherId(null)} />
      </div>
    );
  }

  return (
    <section className="pos-orders-page min-w-0 max-w-full space-y-4" data-pos-transfer-orders="true">
      <div className="pos-orders-hero">
        <PageHeader
          title="Orders"
          subtitle="Review and adjust quantities for your location"
          icon={<ClipboardList className="h-5 w-5" />}
          showBackButton={false}
        >
          {myLocations.length > 1 && (
            <Button
              className="pos-orders-new-button min-h-11 w-full gap-1.5 sm:w-auto"
              onClick={() => setCreateOpen(true)}
              data-testid="button-new-transfer"
            >
              <Plus className="mr-1.5 h-4 w-4" />
              New Transfer
            </Button>
          )}
        </PageHeader>
        <div className="pos-orders-stats" aria-label="Order summary">
          <div className="pos-orders-stat pos-orders-stat-total" data-testid="pos-orders-total">
            <span className="pos-orders-stat-icon">
              <ShoppingCart className="h-5 w-5" aria-hidden="true" />
            </span>
            <span className="pos-orders-stat-copy">
              <span className="pos-orders-stat-label">Total orders</span>
              <strong className="pos-orders-stat-value tabular-nums">{isLoading ? "—" : transfers.length}</strong>
            </span>
          </div>
          <div className="pos-orders-stat pos-orders-stat-applied" data-testid="pos-orders-applied">
            <span className="pos-orders-stat-icon">
              <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
            </span>
            <span className="pos-orders-stat-copy">
              <span className="pos-orders-stat-label">Applied</span>
              <strong className="pos-orders-stat-value tabular-nums">{isLoading ? "—" : appliedCount}</strong>
            </span>
          </div>
          <div className="pos-orders-stat pos-orders-stat-pending" data-testid="pos-orders-pending">
            <span className="pos-orders-stat-icon">
              <Clock className="h-5 w-5" aria-hidden="true" />
            </span>
            <span className="pos-orders-stat-copy">
              <span className="pos-orders-stat-label">Pending</span>
              <strong className="pos-orders-stat-value tabular-nums">{isLoading ? "—" : pendingCount}</strong>
            </span>
          </div>
        </div>
      </div>

      <PosTransferApprovalQueue />

      <div
        role="search"
        aria-label="Transfer order filters"
        className="pos-orders-filters grid min-w-0 grid-cols-1 gap-3 rounded-2xl border p-3 sm:grid-cols-2 lg:grid-cols-[10rem_9rem_minmax(12rem,1fr)_auto] lg:items-end"
      >
        <div className="min-w-0 space-y-1">
          <label htmlFor="pos-transfer-date-filter" className="text-xs font-medium text-muted-foreground">
            Date
          </label>
          <div className="relative min-w-0">
            <CalendarIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              id="pos-transfer-date-filter"
              type="date"
              value={dateFilter}
              onChange={(event) => setDateFilter(event.target.value)}
              className="pos-orders-control min-h-11 w-full min-w-0 rounded-lg border bg-background pl-10 pr-2 text-base outline-hidden focus:ring-2 focus:ring-ring lg:min-h-10 lg:text-sm"
              data-testid="input-date-filter"
            />
          </div>
        </div>

        <div className="min-w-0 space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Status</label>
          <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as typeof statusFilter)}>
            <SelectTrigger
              className="pos-orders-control min-h-11 w-full lg:min-h-10"
              data-testid="select-status-filter"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="applied">Applied</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="min-w-0 space-y-1 sm:col-span-2 lg:col-span-1">
          <label htmlFor="pos-transfer-list-search" className="text-xs font-medium text-muted-foreground">
            Search
          </label>
          <SearchField
            id="pos-transfer-list-search"
            placeholder="Voucher number or item"
            value={search}
            onValueChange={setSearch}
            className="pos-orders-control min-h-11 text-base sm:min-h-11 lg:min-h-10 lg:text-sm"
            data-testid="input-list-search"
          />
        </div>

        <Button
          variant="outline"
          onClick={clearFilters}
          disabled={!hasFilters}
          className="pos-orders-clear min-h-11 w-full gap-1.5 sm:col-span-2 lg:col-span-1 lg:min-h-10 lg:w-auto"
          data-testid="button-clear-filters"
        >
          <X className="h-4 w-4" aria-hidden="true" />
          Clear
        </Button>
      </div>

      <div className="pos-orders-list-heading flex items-center justify-between px-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {isLoading ? "Loading…" : `${transfers.length} ${transfers.length === 1 ? "order" : "orders"}`}
        </span>
        <RowsExportMenu
          title="Transfer Orders"
          period={{ from: dateFilter, to: dateFilter }}
          rows={transfers}
          columns={[
            { header: "Voucher", value: (transfer) => transfer.voucherNumber },
            { header: "Date", value: (transfer) => formatDate(transfer.voucherDate) },
            { header: "Status", value: (transfer) => (transfer.inventoryApplied ? "Applied" : "Pending") },
            { header: "From", value: (transfer) => transfer.sourceLocationName },
            { header: "To", value: (transfer) => transfer.destinationLocationName },
            { header: "Items", value: (transfer) => transfer.itemCount, type: "number" },
          ]}
          resource="retail.transfers"
          data-testid="button-export-transfer-orders"
        />
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((item) => (
            <div
              key={item}
              className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 sm:flex-row sm:items-center"
            >
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <Skeleton className="h-3 w-3 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-4 w-36 max-w-full" />
                  <Skeleton className="h-3 w-52 max-w-full" />
                </div>
              </div>
              <Skeleton className="h-11 w-full sm:w-24" />
            </div>
          ))}
        </div>
      ) : isError && allTransfers.length === 0 ? (
        <ErrorState onAction={() => void refetch()} actionLabel="Try again" className="rounded-2xl py-14" />
      ) : transfers.length === 0 ? (
        <EmptyState
          className="pos-orders-empty rounded-2xl py-14"
          data-testid="text-empty"
          icon={Package2}
          title="No transfer orders found"
          description={hasFilters ? "Try clearing your filters." : undefined}
        />
      ) : (
        <PosTransferOrdersContent openView={openView} setEditVoucherId={setEditVoucherId} transfers={transfers} />
      )}

      <ViewTransferDialog
        voucherId={viewVoucherId}
        open={viewDialogOpen}
        onClose={() => {
          setViewDialogOpen(false);
          setViewVoucherId(null);
        }}
      />

      <CreateTransferDialog open={createOpen} onClose={() => setCreateOpen(false)} myLocations={myLocations} />
    </section>
  );
}
