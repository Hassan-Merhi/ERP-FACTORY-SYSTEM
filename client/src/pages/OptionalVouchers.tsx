import { ErpListFilters, ErpConfirmDialog } from "@/erp-core";
import { Button } from "@/components/ui/button";
import { PeriodFilter } from "@/components/ui/period-filter";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/page-state";
import { PageHeader } from "@/components/PageHeader";
import { FileText, X } from "lucide-react";
import { OptionalVoucherDetailsDialog } from "./optional-vouchers/OptionalVoucherDetailsDialog";
import { useOptionalVouchersState } from "./useOptionalVouchersState";
import { OptionalVouchersContent } from "./OptionalVouchersContent";

export default function OptionalVouchers() {
  const {
    clearFilters,
    deleteMutation,
    deleteVoucherId,
    endDate,
    error,
    finalizeMutation,
    finalizeVoucherId,
    formatShortDate,
    getTypeBadgeVariant,
    grandTotal,
    handleEdit,
    hasFilters,
    isError,
    isLoading,
    orderedVouchers,
    search,
    selectedCompany,
    setDeleteVoucherId,
    setEndDate,
    setFinalizeVoucherId,
    setSearch,
    setStartDate,
    setTypeFilter,
    setViewVoucher,
    startDate,
    typeFilter,
    viewVoucher,
    voucherTypes,
    vouchers,
  } = useOptionalVouchersState();

  return (
    <div className="flex flex-col gap-4 sm:p-4 md:p-6">
      {/* ── Header ── */}
      <PageHeader
        title="Optional Vouchers"
        subtitle="Draft vouchers pending edit or finalization"
        icon={<FileText className="h-5 w-5" />}
        meta={
          !isLoading &&
          !isError &&
          vouchers.length > 0 && (
            <Badge variant="secondary" className="text-xs sm:text-sm px-2 py-0.5" data-testid="text-voucher-count">
              {vouchers.length} draft{vouchers.length !== 1 ? "s" : ""}
            </Badge>
          )
        }
      />

      {/* Shared ERP search, desktop filters and phone filter sheet. */}
      <ErpListFilters
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search voucher #, notes..."
        searchTestId="input-search-vouchers"
        mobileFilters
        filterLabel="Optional voucher filters"
        activeFilterCount={[typeFilter !== "all", !!startDate, !!endDate].filter(Boolean).length}
        onResetFilters={clearFilters}
        data-testid="optional-voucher"
        filters={
          <>
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="w-40" data-testid="select-voucher-type">
                <SelectValue placeholder="All Types" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                {voucherTypes.map((type) => (
                  <SelectItem key={type} value={type}>
                    {type}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <PeriodFilter
              value={{ fromDate: startDate, toDate: endDate, preset: startDate || endDate ? "custom" : "all_time" }}
              onChange={(v) => {
                setStartDate(v.fromDate);
                setEndDate(v.toDate);
              }}
              data-testid="optional-voucher-period"
            />
          </>
        }
        actions={
          hasFilters ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={clearFilters}
              data-testid="button-clear-filters"
              className="gap-1.5"
            >
              <X className="h-4 w-4" />
              Clear
            </Button>
          ) : undefined
        }
      />

      {/* ── Stats pill bar ── */}
      {!isLoading && !isError && vouchers.length > 0 && (
        <div className="flex flex-wrap gap-3">
          <div className="rounded-lg border bg-muted/40 px-3 py-2 text-sm flex items-center gap-2">
            <FileText className="h-4 w-4 text-muted-foreground" />
            <span className="text-muted-foreground">Drafts</span>
            <span className="font-semibold">{vouchers.length}</span>
          </div>
          <div className="rounded-lg border bg-muted/40 px-3 py-2 text-sm flex items-center gap-2">
            <span className="text-muted-foreground">Grand Total</span>
            <span className="font-semibold" data-testid="text-optional-grand-total">
              {grandTotal.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
            </span>
          </div>
        </div>
      )}

      {/* ── States ── */}
      {isLoading ? (
        <div className="border rounded-xl overflow-hidden">
          <div className="h-11 bg-muted/40 border-b" />
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-3 border-b last:border-0">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-5 w-20 rounded-full" />
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-20 ml-auto" />
            </div>
          ))}
        </div>
      ) : isError ? (
        <div
          className="flex flex-col items-center justify-center py-20 gap-3 text-destructive"
          data-testid="text-optional-vouchers-error"
        >
          <FileText className="h-10 w-10 opacity-30" />
          <p className="text-sm font-medium">Failed to load optional vouchers</p>
          <p className="text-xs text-muted-foreground">{error?.message}</p>
        </div>
      ) : vouchers.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No optional vouchers found"
          description={hasFilters ? "Try adjusting your filters" : "All vouchers have been finalized"}
          className="py-20"
          data-testid="text-no-optional-vouchers"
        />
      ) : (
        <OptionalVouchersContent
          formatShortDate={formatShortDate}
          getTypeBadgeVariant={getTypeBadgeVariant}
          grandTotal={grandTotal}
          handleEdit={handleEdit}
          orderedVouchers={orderedVouchers}
          selectedCompany={selectedCompany}
          setDeleteVoucherId={setDeleteVoucherId}
          setFinalizeVoucherId={setFinalizeVoucherId}
          setViewVoucher={setViewVoucher}
          vouchers={vouchers}
        />
      )}

      <OptionalVoucherDetailsDialog
        voucher={viewVoucher}
        open={viewVoucher !== null}
        onOpenChange={(open) => {
          if (!open) setViewVoucher(null);
        }}
        onEdit={(voucher) => {
          setViewVoucher(null);
          handleEdit(voucher);
        }}
      />

      <ErpConfirmDialog
        open={finalizeVoucherId !== null}
        onOpenChange={(open) => !open && setFinalizeVoucherId(null)}
        title="Finalize Voucher"
        description="Are you sure you want to finalize this voucher? Once posted, it will be included in all financial calculations and reports. This cannot be undone easily."
        confirmText={finalizeMutation.isPending ? "Finalizing..." : "Finalize"}
        loading={finalizeMutation.isPending}
        onConfirm={() => {
          if (finalizeVoucherId) finalizeMutation.mutate(finalizeVoucherId);
        }}
      />

      <ErpConfirmDialog
        open={deleteVoucherId !== null}
        onOpenChange={(open) => !open && setDeleteVoucherId(null)}
        title="Delete Voucher"
        description="Are you sure you want to delete this optional voucher? This action will remove it from the system."
        tone="destructive"
        confirmText={deleteMutation.isPending ? "Deleting..." : "Delete"}
        loading={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteVoucherId) deleteMutation.mutate(deleteVoucherId);
        }}
      />
    </div>
  );
}
