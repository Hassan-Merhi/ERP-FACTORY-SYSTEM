import { ArrowRight, ReceiptText, Snowflake, DollarSign, Package } from "lucide-react";
import "@/styles/pos-daybook-modern.css";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DaybookHeader, DaybookKpiStrip, DaybookPage } from "@/components/daybook/DaybookFrame";
import { DaybookFilterBar } from "@/components/daybook/DaybookFilterBar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePOSDaybookState } from "./usePOSDaybookState";
import { POSDaybookDaybookResultsSection } from "./POSDaybookDaybookResultsSection";
import { POSDaybookDialogSection } from "./POSDaybookDialogSection";
import { formatPosVoucherAmount, formatPosZmwUnitPrice, formatPosZmwLineTotal } from "./posdaybook/zmwDisplay";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { formatMoneyDisplay } from "@/lib/moneyDisplay";

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
  } = usePOSDaybookState();
  const { selectedCurrency } = useCurrencyContext();
  const totalNativeZmw = selectedCurrency === "ZMW" && salesOnly.length > 0 &&
    salesOnly.every((sale) => sale.currency === "ZMW" && sale.nativeZmwTotal != null)
      ? salesOnly.reduce((sum, sale) => sum + Number(sale.nativeZmwTotal), 0)
      : null;
  const formatRevenue = (amount: number) => totalNativeZmw === null
    ? formatCashAmount(amount)
    : formatMoneyDisplay(amount, { currency: "ZMW" });

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
            value: kpiValue(formatRevenue(totalNativeZmw ?? totalSales)),
            icon: DollarSign,
            tone: "value",
          },
          {
            id: "average",
            label: "Avg per Sale",
            value: kpiValue(formatRevenue(salesOnly.length ? (totalNativeZmw ?? totalSales) / salesOnly.length : 0)),
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

      <POSDaybookDaybookResultsSection
        currentUser={currentUser}
        error={error}
        formatCashAmount={formatCashAmount}
        hiddenRowIds={hiddenRowIds}
        isError={isError}
        isLoading={isLoading}
        isLoadingUser={isLoadingUser}
        isPOS={isPOS}
        navigate={navigate}
        pagination={pagination}
        printVoucherId={printVoucherId}
        recordChanges={recordChanges}
        refetch={refetch}
        searchedVouchers={searchedVouchers}
        setFilter={setFilter}
        setHiddenRowIds={setHiddenRowIds}
        setPrintVoucherId={setPrintVoucherId}
        setSelectedVoucher={setSelectedVoucher}
        showHidden={showHidden}
        showState={showState}
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
                    <td className="border border-black p-2 text-right">{formatPosZmwUnitPrice(printDetails, price, (usd) => `${fmtPrint(usd)}`)}</td>
                    <td className="border border-black p-2 text-right">{formatPosZmwLineTotal(printDetails, qty, price, (usd) => `${fmtPrint(usd)}`)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="mt-4 flex justify-between border-t-2 border-black pt-3 text-lg font-black">
            <span>TOTAL PAID</span>
            <span>{formatPosVoucherAmount(printDetails, formatCashAmount)}</span>
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
    </DaybookPage>
  );
}
