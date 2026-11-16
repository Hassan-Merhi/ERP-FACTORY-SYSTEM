import {
  ArrowRight,
  BookOpen,
  ReceiptText,
  Snowflake,
  ChevronLeft,
  ChevronRight,
  DollarSign,
  Package,
  X,
} from "lucide-react";
import "@/styles/pos-daybook-modern.css";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { PeriodFilter } from "@/components/ui/period-filter";
import { Skeleton } from "@/components/ui/skeleton";
import { usePOSDaybookState } from "./usePOSDaybookState";
import { POSDaybookSection } from "./POSDaybookSection";
import { POSDaybookDialogSection } from "./POSDaybookDialogSection";

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
  const {
    canEditDaybook,
    canSeeProfitCost,
    christmasSetting,
    currentUser,
    detailsLoading,
    fmtPrint,
    formatCashAmount,
    hasActiveFilters,
    hiddenRowIds,
    isAdminOrOwner,
    isLoading,
    isLoadingUser,
    isPOS,
    navigate,
    optionalMutation,
    optionalVoucher,
    periodFilter,
    printDetails,
    printRef,
    printVoucherId,
    recordChanges,
    resetFilters,
    salesOnly,
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
    subtitle,
    totalSales,
    transactionKind,
    transactionSearch,
    transfersOnly,
    visibleVouchers,
    voucherDetails,
    whatsappMutation,
  } = usePOSDaybookState();

  return (
    <div className="pos-daybook mx-auto w-full min-w-0 max-w-[1560px] space-y-5 pb-8" data-pos-daybook="modern">
      <section
        className="pos-daybook-hero flex flex-col justify-between gap-4 sm:flex-row sm:items-center"
        aria-label="Daybook heading"
      >
        <div className="flex min-w-0 items-center gap-3">
          <span className="pos-daybook-title-icon flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl">
            <BookOpen className="h-6 w-6" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h1 className="text-xl font-bold tracking-tight sm:text-2xl" data-testid="text-page-title">
              POS Daybook
            </h1>
            <p className="mt-0.5 text-sm text-muted-foreground" data-testid="text-page-subtitle">
              {subtitle}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {christmasSetting.data?.available === true && (
            <span className="pos-daybook-seasonal-chip mr-1 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs font-medium">
              <Snowflake className="h-3.5 w-3.5" aria-hidden="true" />
              Christmas {christmasSetting.data.enabled ? "On" : "Off"}
            </span>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="rounded-xl"
            onClick={() => shiftDay(-1)}
            aria-label="Previous day"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <PeriodFilter
            value={periodFilter}
            onChange={(next) => setFilter("periodFilter", next)}
            data-testid="pos-daybook-period-filter"
          />
          <Button variant="ghost" size="icon" className="rounded-xl" onClick={() => shiftDay(1)} aria-label="Next day">
            <ChevronRight className="h-4 w-4" />
          </Button>
          {(hasActiveFilters || transactionSearch.trim() || transactionKind !== "all") && (
            <Button
              variant="outline"
              size="sm"
              className="rounded-xl"
              onClick={() => {
                resetFilters();
                setTransactionSearch("");
                setTransactionKind("all");
              }}
              data-testid="button-reset-filters"
            >
              <X className="mr-1 h-4 w-4" />
              Reset
            </Button>
          )}
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Sales summary">
        <Stat
          label="Sales"
          value={String(salesOnly.length)}
          icon={<Package className="h-5 w-5" />}
          tone="blue"
          loading={isLoading}
        />
        <Stat
          label="Total Revenue"
          value={formatCashAmount(totalSales)}
          icon={<DollarSign className="h-5 w-5" />}
          tone="violet"
          loading={isLoading}
        />
        <Stat
          label="Avg per Sale"
          value={formatCashAmount(salesOnly.length ? totalSales / salesOnly.length : 0)}
          icon={<ReceiptText className="h-5 w-5" />}
          tone="cyan"
          loading={isLoading}
        />
        <Stat
          label="Transfers"
          value={String(transfersOnly.length)}
          icon={<ArrowRight className="h-5 w-5" />}
          tone="slate"
          loading={isLoading}
        />
      </section>

      <POSDaybookSection
        currentUser={currentUser}
        formatCashAmount={formatCashAmount}
        hiddenRowIds={hiddenRowIds}
        isLoading={isLoading}
        isLoadingUser={isLoadingUser}
        isPOS={isPOS}
        navigate={navigate}
        printVoucherId={printVoucherId}
        recordChanges={recordChanges}
        searchedVouchers={searchedVouchers}
        setFilter={setFilter}
        setHiddenRowIds={setHiddenRowIds}
        setPrintVoucherId={setPrintVoucherId}
        setSelectedVoucher={setSelectedVoucher}
        setTransactionKind={setTransactionKind}
        setTransactionSearch={setTransactionSearch}
        showHidden={showHidden}
        transactionKind={transactionKind}
        transactionSearch={transactionSearch}
        visibleVouchers={visibleVouchers}
        whatsappMutation={whatsappMutation}
      />

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

      <POSDaybookDialogSection
        canEditDaybook={canEditDaybook}
        canSeeProfitCost={canSeeProfitCost}
        detailsLoading={detailsLoading}
        formatCashAmount={formatCashAmount}
        isAdminOrOwner={isAdminOrOwner}
        navigate={navigate}
        optionalMutation={optionalMutation}
        recordChanges={recordChanges}
        selectedVoucher={selectedVoucher}
        setOptionalVoucher={setOptionalVoucher}
        setPrintVoucherId={setPrintVoucherId}
        setSelectedVoucher={setSelectedVoucher}
        voucherDetails={voucherDetails}
        whatsappMutation={whatsappMutation}
      />

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
    </div>
  );
}

function Stat({
  label,
  value,
  icon,
  loading,
  tone,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  loading: boolean;
  tone: "blue" | "violet" | "cyan" | "slate";
}) {
  return (
    <div
      className={`pos-daybook-stat pos-daybook-stat--${tone} relative min-w-0 overflow-hidden rounded-2xl p-4 sm:p-5`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-muted-foreground sm:text-sm">{label}</span>
        <span
          className="pos-daybook-stat-icon flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
          aria-hidden="true"
        >
          {icon}
        </span>
      </div>
      {loading ? (
        <Skeleton className="mt-4 h-7 w-24" />
      ) : (
        <p className="mt-4 truncate text-xl font-bold tracking-tight tabular-nums sm:text-2xl" title={value}>
          {value}
        </p>
      )}
    </div>
  );
}
