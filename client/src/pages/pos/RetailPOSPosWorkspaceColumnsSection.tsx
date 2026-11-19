// Extracted from ./RetailPOS.tsx to keep that module under the source-size cap.
import { Percent } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { PosWorkspaceColumns } from "./pos-components/PosWorkspaceColumns";
import { PosSaleSubmitButton } from "./pos-components/PosSaleHeader";
import { PosSaleGridWrap, PosSaleNotes, PosSalePanel } from "./pos-components/PosSaleLayout";
import { RetailErpPosItemPicker, RetailErpPosSaleGrid } from "./RetailErpPosWorkspace";
import { RetailPaymentPanel } from "./RetailPaymentPanel";
import { RetailLastSaleSummary } from "./RetailPOSPanels";
import { money, scanBeep } from "./retailPosTypes";
import { useRetailPOSState } from "./useRetailPOSState";
import { SelectContent, SelectItem, SelectTrigger, SelectValue, Select } from "@/components/ui/select";

export function RetailPOSPosWorkspaceColumnsSection({
  addItem,
  canCompleteSale,
  cart,
  currentShift,
  customer,
  focusScan,
  isPosRole,
  itemsQuery,
  ladder,
  lastSale,
  lastScan,
  notes,
  orderDiscount,
  orderDiscountOpen,
  paymentAccounts,
  payments,
  printReceipt,
  receiptPaperWidth,
  requiresApproval,
  saleMutation,
  scanBarcode,
  scanInputRef,
  scanText,
  selectedLocation,
  setAdjustLine,
  setCart,
  setLastScan,
  setNotes,
  setOrderDiscount,
  setOrderDiscountOpen,
  setPayments,
  setReceiptPaperWidth,
  setScanText,
  settings,
  total,
  units,
}: Pick<
  ReturnType<typeof useRetailPOSState>,
  | "addItem"
  | "canCompleteSale"
  | "cart"
  | "currentShift"
  | "customer"
  | "focusScan"
  | "isPosRole"
  | "itemsQuery"
  | "ladder"
  | "lastSale"
  | "lastScan"
  | "notes"
  | "orderDiscount"
  | "orderDiscountOpen"
  | "paymentAccounts"
  | "payments"
  | "printReceipt"
  | "receiptPaperWidth"
  | "requiresApproval"
  | "saleMutation"
  | "scanBarcode"
  | "scanInputRef"
  | "scanText"
  | "selectedLocation"
  | "setAdjustLine"
  | "setCart"
  | "setLastScan"
  | "setNotes"
  | "setOrderDiscount"
  | "setOrderDiscountOpen"
  | "setPayments"
  | "setReceiptPaperWidth"
  | "setScanText"
  | "settings"
  | "total"
  | "units"
>) {
  const { t } = useApplicationLanguage();
  return (
    <PosWorkspaceColumns layout="retail">
      <PosSalePanel className="gap-1">
        <PosSaleGridWrap>
          <RetailErpPosSaleGrid
            cart={cart}
            pricingLines={ladder?.lines ?? []}
            units={units}
            total={total}
            onDecrease={(variantId) =>
              setCart((current) =>
                current.map((line) =>
                  line.variantId === variantId ? { ...line, cartQuantity: Math.max(1, line.cartQuantity - 1) } : line
                )
              )
            }
            onIncrease={(line) => {
              const outcome = addItem(line);
              setLastScan(outcome);
              if (outcome.status !== "added") scanBeep(false);
            }}
            onAdjust={setAdjustLine}
            onRemove={(variantId) => setCart((current) => current.filter((line) => line.variantId !== variantId))}
          />
        </PosSaleGridWrap>
        <PosSaleNotes
          id="retail-pos-notes"
          label={t("pos.modern.notes")}
          optionalLabel={t("pos.modern.optional")}
          placeholder={t("pos.modern.notesPlaceholder")}
          value={notes}
          maxLength={2000}
          onChange={setNotes}
          testId="retail-pos-notes"
          className="px-3"
        />
        <div className="mx-3 mb-3 rounded-lg border bg-background p-3" aria-label="Retail checkout">
          <div className="space-y-2 border-t pt-3">
            <div className="rounded-lg border p-2">
              <button
                type="button"
                className="flex w-full items-center justify-between text-sm"
                onClick={() => setOrderDiscountOpen((value) => !value)}
                data-testid="retail-order-discount-toggle"
              >
                <span className="flex items-center gap-1.5">
                  <Percent className="h-3.5 w-3.5" /> Whole-sale discount
                </span>
                <span className="text-muted-foreground">
                  {orderDiscount.type === "none"
                    ? "None"
                    : orderDiscount.type === "percent"
                      ? `${orderDiscount.value}%`
                      : money(orderDiscount.value)}
                </span>
              </button>
              {orderDiscountOpen && (
                <div className="mt-2 space-y-2">
                  <div className="flex gap-2">
                    <Select
                      value={orderDiscount.type}
                      onValueChange={(v) =>
                        setOrderDiscount((current) => ({
                          ...current,
                          type: v as "none" | "percent" | "fixed",
                        }))
                      }
                    >
                      <SelectTrigger
                        className="h-9 flex-1 text-sm"
                        data-testid="retail-order-discount-type"
                        aria-label="Order discount type"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No discount</SelectItem>
                        <SelectItem value="percent">Percent</SelectItem>
                        <SelectItem value="fixed">Fixed amount</SelectItem>
                      </SelectContent>
                    </Select>
                    {orderDiscount.type !== "none" && (
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        className="h-9 w-28"
                        value={Number.isFinite(orderDiscount.value) && orderDiscount.value ? orderDiscount.value : ""}
                        onChange={(event) =>
                          setOrderDiscount((current) => ({ ...current, value: Number(event.target.value) }))
                        }
                        data-testid="retail-order-discount-value"
                      />
                    )}
                  </div>
                  {orderDiscount.type !== "none" && (
                    <Input
                      className="h-9"
                      placeholder="Reason (required)"
                      value={orderDiscount.reason}
                      onChange={(event) => setOrderDiscount((current) => ({ ...current, reason: event.target.value }))}
                      data-testid="retail-order-discount-reason"
                    />
                  )}
                </div>
              )}
            </div>
            <div className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Subtotal</span>
                <span data-testid="cart-list-subtotal">
                  {money(ladder?.listSubtotal ?? cart.reduce((sum, line) => sum + line.price * line.cartQuantity, 0))}
                </span>
              </div>
              {Boolean(ladder && ladder.discountTotal > 0) && (
                <>
                  <div className="flex justify-between text-destructive" data-testid="cart-discount-total">
                    <span>Discount</span>
                    <span>-{money(ladder!.discountTotal)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Net</span>
                    <span>{money(ladder!.subtotal)}</span>
                  </div>
                </>
              )}
              {settings?.taxEnabled && (
                <div className="flex justify-between" data-testid="cart-tax">
                  <span className="text-muted-foreground">
                    {settings.taxLabel}
                    {settings.taxRatePercent
                      ? ` (${settings.taxRatePercent}%${settings.taxInclusive ? ", incl." : ""})`
                      : ""}
                  </span>
                  <span>{money(ladder?.taxAmount ?? 0)}</span>
                </div>
              )}
            </div>
            <div className="flex items-center justify-between border-t pt-2 text-lg font-semibold">
              <span>Total</span>
              <span data-testid="cart-total">{money(total)}</span>
            </div>
            {requiresApproval && (
              <div
                className="rounded-md border border-amber-400 bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
                data-testid="retail-approval-hint"
              >
                Manager approval will be requested when the sale is completed.
              </div>
            )}
          </div>

          {cart.length > 0 && (
            <RetailPaymentPanel
              total={total}
              value={payments}
              onChange={setPayments}
              canUseCredit={Boolean(customer?.id)}
              accounts={paymentAccounts}
              customerName={customer?.legalName}
            />
          )}
          {isPosRole && !currentShift && cart.length > 0 && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-sm">
              Open a cashier shift before completing this sale.
            </div>
          )}
          <PosSaleSubmitButton
            type="button"
            size="lg"
            className="mt-3 h-11 w-full"
            disabled={!canCompleteSale}
            onClick={() => saleMutation.mutate()}
            pending={saleMutation.isPending}
            pendingLabel="Completing sale…"
            label="Complete Sale"
          />
          {lastSale && (
            <RetailLastSaleSummary
              sale={lastSale}
              onPrint={() => printReceipt(lastSale)}
              paperWidth={receiptPaperWidth}
              onPaperWidthChange={setReceiptPaperWidth}
            />
          )}
        </div>
      </PosSalePanel>
      <RetailErpPosItemPicker
        items={itemsQuery.data ?? []}
        loading={itemsQuery.isLoading}
        hasLocation={Boolean(selectedLocation?.id)}
        searchText={scanText}
        onSearchChange={setScanText}
        onBarcodeSubmit={(barcode) => void scanBarcode(barcode)}
        scanInputRef={scanInputRef}
        lastScan={lastScan}
        onPick={(item) => {
          const outcome = addItem(item);
          setLastScan(outcome);
          if (outcome.status !== "added") scanBeep(false);
          focusScan();
        }}
      />
    </PosWorkspaceColumns>
  );
}
