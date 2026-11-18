import { ShoppingCart, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RetailExchangeDialog } from "./RetailExchangeDialog";
import { RetailReturnDialog } from "./RetailReturnDialog";
import { paymentAccountValue, paymentFromAccount, RetailPaymentAccountOptions } from "./RetailPaymentAccountSelect";
import { RetailShiftPanel } from "./RetailShiftPanel";
import { RetailApprovalDialog } from "./RetailApprovalDialog";
import { RetailCustomerPicker } from "./RetailCustomerPicker";
import { RetailLineAdjustDialog, type LineAdjustment } from "./RetailLineAdjustDialog";
import { money, type RetailPaymentDraft } from "./retailPosTypes";
import { useRetailPOSState } from "./useRetailPOSState";
import { RetailPOSPosWorkspaceColumnsSection } from "./RetailPOSPosWorkspaceColumnsSection";
import { SelectContent, SelectItem, SelectTrigger, SelectValue, Select } from "@/components/ui/select";

export default function RetailPOS() {
  const {
    addItem,
    adjustLine,
    approvalMutation,
    approvalRequest,
    canCompleteSale,
    cart,
    creditAmount,
    currentShift,
    customer,
    exchangeSale,
    focusScan,
    hasCreditTender,
    isPosRole,
    itemsQuery,
    ladder,
    lastSale,
    lastScan,
    locations,
    notes,
    orderDiscount,
    orderDiscountOpen,
    paymentAccounts,
    payments,
    printReceipt,
    receiptPaperWidth,
    receiptPortal,
    refreshRetailPos,
    requiresApproval,
    returnDialogOpen,
    saleMutation,
    scanBarcode,
    scanInputRef,
    scanText,
    selectCustomer,
    selectedCompany,
    selectedLocation,
    setAdjustLine,
    setApprovalRequest,
    setCart,
    setCurrentShift,
    setExchangeSale,
    setLastSale,
    setLastScan,
    setNotes,
    setOrderDiscount,
    setOrderDiscountOpen,
    setPayments,
    setReceiptPaperWidth,
    setReturnDialogOpen,
    setScanText,
    setSelectedLocation,
    settings,
    total,
    units,
  } = useRetailPOSState();

  if (selectedCompany?.companyType !== "retail") return null;

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 p-3 pb-24 md:p-5 xl:pb-5">
      {receiptPortal}
      {/* Retail uses the normal ERP POS arrangement; posting stays on variant-aware retail services. */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b py-2">
        <h1 className="border-l-2 border-primary pl-3 text-2xl font-semibold tracking-tight">Point of Sale</h1>
        <Button
          type="button"
          variant="outline"
          onClick={() => setReturnDialogOpen(true)}
          disabled={!selectedLocation?.id}
          data-testid="retail-open-returns"
        >
          <RotateCcw className="mr-2 h-4 w-4" /> Return / Exchange
        </Button>
        <Button
          type="button"
          disabled={!canCompleteSale}
          onClick={() => saleMutation.mutate()}
          data-testid="button-save-sale"
        >
          {saleMutation.isPending ? "Saving…" : "Save"}
        </Button>
      </header>

      <div className="flex flex-wrap items-start gap-3 border-b bg-muted/10 px-1 py-2" aria-label="Retail sale details">
        <div className="space-y-1">
          <label htmlFor="retail-pos-location" className="text-xs text-muted-foreground">
            Location
          </label>
          <Select
            disabled={isPosRole}
            value={selectedLocation ? String(selectedLocation.id) : "__none__"}
            onValueChange={(v) => {
              const location = locations.find((entry) => entry.id === Number(v === "__none__" ? "" : v)) ?? null;
              setSelectedLocation(location);
            }}
          >
            <SelectTrigger id="retail-pos-location" className="h-9 min-w-[154px] max-w-[220px] text-sm">
              <SelectValue placeholder="Select location" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">Select location</SelectItem>
              {locations.map((location) => (
                <SelectItem key={location.id} value={String(location.id)}>
                  {location.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label htmlFor="retail-pos-date" className="text-xs text-muted-foreground">
            Date
          </label>
          <input
            id="retail-pos-date"
            type="date"
            className="block h-9 rounded-md border bg-muted/40 px-3 font-mono text-sm"
            value={new Date().toLocaleDateString("sv-SE")}
            readOnly
            aria-label="Sale date (set by server at checkout)"
            title="Retail sales use the actual checkout date; backdated posting is not enabled"
          />
        </div>
        <div className="min-w-[200px] space-y-1">
          <label htmlFor="retail-pos-account" className="text-xs text-muted-foreground">
            Payment account
          </label>
          <select
            id="retail-pos-account"
            className="block h-9 w-full min-w-[200px] max-w-[340px] rounded-md border bg-background px-3 text-sm"
            value={paymentAccountValue(payments[0] ?? { method: "cash", amount: 0 })}
            onChange={(event) => {
              if (!paymentAccounts) return;
              const value = event.target.value;
              setPayments((current) =>
                current.map((payment, index) =>
                  index !== 0
                    ? payment
                    : value
                      ? paymentFromAccount(value, payment.amount, paymentAccounts)
                      : ({ method: "cash", amount: payment.amount, tenderedAmount: null } as RetailPaymentDraft)
                )
              );
            }}
            data-testid="retail-pos-account"
          >
            <RetailPaymentAccountOptions
              accounts={paymentAccounts}
              allowCredit={Boolean(customer?.id)}
              customerName={customer?.legalName}
            />
          </select>
        </div>
        <div className="min-w-[190px] flex-1 xl:max-w-[350px]">
          <RetailCustomerPicker customer={customer} onSelect={selectCustomer} />
        </div>
        {hasCreditTender && (
          <span
            className="self-center text-xs font-medium text-amber-700 dark:text-amber-300"
            data-testid="retail-credit-amount"
          >
            {customer ? `On account: ${money(creditAmount)}` : "Choose a customer to post credit"}
          </span>
        )}
      </div>

      <RetailShiftPanel
        locationId={selectedLocation?.id ?? null}
        cashAccountId={payments[0]?.method === "cash" ? (payments[0].ledgerAccountId ?? null) : null}
        onShiftChange={setCurrentShift}
      />

      <RetailPOSPosWorkspaceColumnsSection
        addItem={addItem}
        canCompleteSale={canCompleteSale}
        cart={cart}
        currentShift={currentShift}
        customer={customer}
        focusScan={focusScan}
        isPosRole={isPosRole}
        itemsQuery={itemsQuery}
        ladder={ladder}
        lastSale={lastSale}
        lastScan={lastScan}
        notes={notes}
        orderDiscount={orderDiscount}
        orderDiscountOpen={orderDiscountOpen}
        paymentAccounts={paymentAccounts}
        payments={payments}
        printReceipt={printReceipt}
        receiptPaperWidth={receiptPaperWidth}
        requiresApproval={requiresApproval}
        saleMutation={saleMutation}
        scanBarcode={scanBarcode}
        scanInputRef={scanInputRef}
        scanText={scanText}
        selectedLocation={selectedLocation}
        setAdjustLine={setAdjustLine}
        setCart={setCart}
        setLastScan={setLastScan}
        setNotes={setNotes}
        setOrderDiscount={setOrderDiscount}
        setOrderDiscountOpen={setOrderDiscountOpen}
        setPayments={setPayments}
        setReceiptPaperWidth={setReceiptPaperWidth}
        setScanText={setScanText}
        settings={settings}
        total={total}
        units={units}
      />

      {cart.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 p-3 backdrop-blur-sm xl:hidden">
          <div className="mx-auto flex max-w-3xl items-center gap-3">
            <button
              type="button"
              className="min-w-0 flex-1 text-left"
              onClick={() => document.getElementById("retail-pos-cart")?.scrollIntoView({ behavior: "smooth" })}
            >
              <div className="text-xs text-muted-foreground">
                <ShoppingCart className="mr-1 inline h-3.5 w-3.5" />
                {units} · <span data-i18n-ui>View cart</span>
              </div>
              <div className="text-lg font-semibold">{money(total)}</div>
            </button>
            <Button className="h-12 px-6 text-base" disabled={!canCompleteSale} onClick={() => saleMutation.mutate()}>
              {saleMutation.isPending ? "Completing sale…" : "Complete Sale"}
            </Button>
          </div>
        </div>
      )}

      <RetailLineAdjustDialog
        line={adjustLine}
        onClose={() => setAdjustLine(null)}
        onApply={(line, adjustment: LineAdjustment) => {
          setCart((current) =>
            current.map((entry) => (entry.variantId === line.variantId ? { ...entry, ...adjustment } : entry))
          );
          setAdjustLine(null);
          focusScan();
        }}
      />

      <RetailApprovalDialog
        open={approvalRequest.open}
        reasons={approvalRequest.reasons}
        pending={approvalRequest.pending}
        error={approvalRequest.error}
        onClose={() => setApprovalRequest({ open: false, reasons: [], pending: false, error: null })}
        onApprove={(username, password) => {
          setApprovalRequest((current) => ({ ...current, pending: true, error: null }));
          approvalMutation.mutate({ username, password });
        }}
      />

      <RetailReturnDialog
        open={returnDialogOpen}
        locationId={selectedLocation?.id ?? null}
        shiftId={currentShift?.id ?? null}
        canOverride={["Admin", "Owner", "Manager", "Developer"].includes(selectedCompany?.role ?? "")}
        onOpenChange={setReturnDialogOpen}
        onExchange={setExchangeSale}
        onPrint={printReceipt}
        onCompleted={async (sale) => {
          // Make the updated sale (with its refund lines) available for reprinting.
          setLastSale(sale);
          await refreshRetailPos();
          focusScan();
        }}
      />
      <RetailExchangeDialog
        sale={exchangeSale}
        locationId={selectedLocation?.id ?? null}
        shiftId={currentShift?.id ?? null}
        canOverride={["Admin", "Owner", "Manager", "Developer"].includes(selectedCompany?.role ?? "")}
        onOpenChange={(open) => {
          if (!open) {
            setExchangeSale(null);
            focusScan();
          }
        }}
        onCompleted={async (sale) => {
          setExchangeSale(null);
          setLastSale(sale);
          await refreshRetailPos();
          focusScan();
        }}
      />
    </div>
  );
}
