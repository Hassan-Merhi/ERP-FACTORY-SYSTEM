import { CalendarDays, MapPin, ShoppingCart, RotateCcw, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { PosCheckoutField, PosCheckoutPanel } from "./pos-components/PosCheckoutPanel";
import { PosSaleHeader, PosSaleSubmitButton } from "./pos-components/PosSaleHeader";
import { PosSaleScreen } from "./pos-components/PosSaleLayout";
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
  const { t } = useApplicationLanguage();

  if (selectedCompany?.companyType !== "retail") return null;

  return (
    <PosSaleScreen variant="retail">
      {receiptPortal}
      {/* Retail shares the ERP POS header, fields, cart grid and buttons; posting stays on variant-aware retail services. */}
      <PosSaleHeader
        title="Point of Sale"
        subtitle={t("pos.modern.createSale")}
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              onClick={() => setReturnDialogOpen(true)}
              disabled={!selectedLocation?.id}
              data-testid="retail-open-returns"
            >
              <RotateCcw className="mr-2 h-4 w-4" /> Return / Exchange
            </Button>
            <PosSaleSubmitButton
              type="button"
              disabled={!canCompleteSale}
              onClick={() => saleMutation.mutate()}
              data-testid="button-save-sale"
              pending={saleMutation.isPending}
              pendingLabel="Saving…"
              label="Save"
            />
          </>
        }
      />

      <PosCheckoutPanel ariaLabel={t("pos.modern.saleSettings")}>
        <PosCheckoutField field="location" icon={MapPin} label={t("pos.modern.location")} htmlFor="retail-pos-location">
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
        </PosCheckoutField>
        <PosCheckoutField field="date" icon={CalendarDays} label={t("pos.modern.date")} htmlFor="retail-pos-date">
          <input
            id="retail-pos-date"
            type="date"
            className="block h-9 w-full rounded-md border bg-muted/40 px-3 font-mono text-sm"
            value={new Date().toLocaleDateString("sv-SE")}
            readOnly
            aria-label="Sale date (set by server at checkout)"
            title="Retail sales use the actual checkout date; backdated posting is not enabled"
          />
        </PosCheckoutField>
        <PosCheckoutField field="account" icon={Wallet} label={t("pos.modern.account")} htmlFor="retail-pos-account">
          <select
            id="retail-pos-account"
            className="block h-9 w-full rounded-md border bg-background px-3 text-sm"
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
        </PosCheckoutField>
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
      </PosCheckoutPanel>

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
            <PosSaleSubmitButton
              className="h-12 px-6 text-base"
              disabled={!canCompleteSale}
              onClick={() => saleMutation.mutate()}
              pending={saleMutation.isPending}
              pendingLabel="Completing sale…"
              label="Complete Sale"
              showIcon={false}
            />
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
    </PosSaleScreen>
  );
}
