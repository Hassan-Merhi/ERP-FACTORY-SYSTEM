import type { useFactorySuppliersModel } from "./useFactorySuppliersModel";

type FactorySuppliersModel = ReturnType<typeof useFactorySuppliersModel>;
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowRightLeft, Globe, Info } from "lucide-react";
import { SupplierWithBalance } from "./factorySupplierTypes";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface SupplierPaymentFxDialogsProps {
  paymentDialogSupplier: SupplierWithBalance | null;
  setPaymentDialogSupplier: (val: SupplierWithBalance | null) => void;
  paymentForm: FactorySuppliersModel["paymentForm"];
  setPaymentForm: FactorySuppliersModel["setPaymentForm"];
  allSuppliers: SupplierWithBalance[];
  ledgerAccounts: FactorySuppliersModel["ledgerAccounts"];
  paymentMutation: FactorySuppliersModel["paymentMutation"];
  paymentAmtUsd: number;
  paymentBalanceUsd: number;
  isOverpayment: boolean;
  overpaymentUsd: number;
  formatNum: (val: string) => string;

  fxConversionOpen: boolean;
  setFxConversionOpen: (val: boolean) => void;
  fxConversionForm: FactorySuppliersModel["fxConversionForm"];
  setFxConversionForm: FactorySuppliersModel["setFxConversionForm"];
  fxSourceType: "supplier" | "commission" | "both";
  setFxSourceType: (val: "supplier" | "commission" | "both") => void;
  fxConversionMutation: FactorySuppliersModel["fxConversionMutation"];
  wrapAdminAction: (fn: () => void, title: string) => void;
}

export function SupplierPaymentFxDialogs({
  paymentDialogSupplier,
  setPaymentDialogSupplier,
  paymentForm,
  setPaymentForm,
  allSuppliers,
  ledgerAccounts,
  paymentMutation,
  paymentAmtUsd,
  paymentBalanceUsd,
  isOverpayment,
  overpaymentUsd,
  formatNum,
  fxConversionOpen,
  setFxConversionOpen,
  fxConversionForm,
  setFxConversionForm,
  fxSourceType,
  setFxSourceType,
  fxConversionMutation,
  wrapAdminAction,
}: SupplierPaymentFxDialogsProps) {
  return (
    <>
      <Dialog
        open={!!paymentDialogSupplier}
        onOpenChange={(open) => {
          if (!open) setPaymentDialogSupplier(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Record Payment</DialogTitle>
            <DialogDescription>
              {paymentDialogSupplier
                ? `Pay to: ${paymentDialogSupplier.name} — Balance: $${formatNum(paymentDialogSupplier.totalValue)}`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {paymentDialogSupplier &&
              (() => {
                const children = allSuppliers.filter((s) => s.parentId === paymentDialogSupplier.id);
                if (children.length === 0) return null;
                return (
                  <div>
                    <Label>Pay to (account)</Label>
                    <Select
                      value={String(paymentForm.supplierId)}
                      onValueChange={(v) => setPaymentForm((prev) => ({ ...prev, supplierId: parseInt(v) }))}
                    >
                      <SelectTrigger data-testid="select-payment-target">
                        <SelectValue placeholder="Select account" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={String(paymentDialogSupplier.id)}>
                          {paymentDialogSupplier.name} (broker)
                        </SelectItem>
                        {children.map((c) => (
                          <SelectItem key={c.id} value={String(c.id)}>
                            {c.name} (linked supplier)
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                );
              })()}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Entry Date</Label>
                <Input
                  type="date"
                  value={paymentForm.date}
                  onChange={(e) => setPaymentForm((prev) => ({ ...prev, date: e.target.value }))}
                  data-testid="input-payment-date"
                />
              </div>
              <div>
                <Label>
                  Effective Date <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  type="date"
                  value={paymentForm.effectiveDate}
                  onChange={(e) => setPaymentForm((prev) => ({ ...prev, effectiveDate: e.target.value }))}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Currency</Label>
                <Select
                  value={paymentForm.currencyCode}
                  onValueChange={(v) =>
                    setPaymentForm((prev) => ({
                      ...prev,
                      currencyCode: v,
                      fxRateToUsd: v === "USD" ? "1" : prev.fxRateToUsd,
                    }))
                  }
                >
                  <SelectTrigger data-testid="select-payment-currency">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="USD">USD</SelectItem>
                    <SelectItem value="EUR">EUR</SelectItem>
                    <SelectItem value="GBP">GBP</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Amount ({paymentForm.currencyCode})</Label>
                <Input
                  type="number"
                  step="any"
                  value={paymentForm.amount}
                  onChange={(e) => setPaymentForm((prev) => ({ ...prev, amount: e.target.value }))}
                  data-testid="input-payment-amount"
                />
              </div>
            </div>

            {paymentForm.currencyCode !== "USD" && (
              <div>
                <Label>FX Rate (Amount per 1 USD)</Label>
                <Input
                  type="number"
                  step="any"
                  value={paymentForm.fxRateToUsd}
                  onChange={(e) => setPaymentForm((prev) => ({ ...prev, fxRateToUsd: e.target.value }))}
                  data-testid="input-payment-fx-rate"
                />
                {paymentForm.amount && paymentForm.fxRateToUsd && parseFloat(paymentForm.fxRateToUsd) > 0 && (
                  <p className="text-sm font-medium mt-1.5 text-primary">
                    = $
                    {(parseFloat(paymentForm.amount) / parseFloat(paymentForm.fxRateToUsd)).toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}{" "}
                    USD
                  </p>
                )}
              </div>
            )}

            {isOverpayment && (
              <div className="p-3 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-900/50">
                <div className="flex items-center gap-2 text-amber-800 dark:text-amber-300 font-semibold mb-1">
                  <Info className="h-4 w-4" />
                  Overpayment Detected
                </div>
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  Total USD payout (${paymentAmtUsd.toFixed(2)}) exceeds the current USD balance ($
                  {paymentBalanceUsd.toFixed(2)}). Remaining{" "}
                  <span className="font-bold">${overpaymentUsd.toFixed(2)}</span> will be recorded as a credit (CR) on
                  the supplier's statement.
                </p>
              </div>
            )}

            <div>
              <Label>Paid From Account</Label>
              <Select
                value={paymentForm.paidFromAccountId}
                onValueChange={(v) => setPaymentForm((prev) => ({ ...prev, paidFromAccountId: v }))}
              >
                <SelectTrigger data-testid="select-payment-account">
                  <SelectValue placeholder="Select account" />
                </SelectTrigger>
                <SelectContent>
                  {ledgerAccounts?.map((acc) => (
                    <SelectItem key={acc.id} value={String(acc.id)}>
                      {acc.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label>Notes</Label>
              <Input
                value={paymentForm.notes}
                onChange={(e) => setPaymentForm((prev) => ({ ...prev, notes: e.target.value }))}
                data-testid="input-payment-notes"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPaymentDialogSupplier(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => wrapAdminAction(() => paymentMutation.mutate(paymentForm), "Record Payment")}
              disabled={!paymentForm.amount || !paymentForm.paidFromAccountId || paymentMutation.isPending}
              data-testid="button-submit-payment"
            >
              {paymentMutation.isPending ? "Recording..." : "Record Payment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={fxConversionOpen}
        onOpenChange={(open) => {
          if (!open) setFxConversionOpen(false);
        }}
      >
        <DialogContent className="max-w-md">
          {(() => {
            const isSelf = fxConversionForm.toSupplierId === fxConversionForm.fromSupplierId;
            return (
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <ArrowRightLeft className="h-4 w-4" />
                  {fxConversionForm.selectedCurrency === "USD"
                    ? parseFloat(fxConversionForm.commissionBalance || "0") > 0
                      ? isSelf
                        ? "Settle Commission"
                        : "Transfer Commission to Broker"
                      : isSelf
                        ? "Settle Freight"
                        : "Transfer Freight to Broker"
                    : isSelf
                      ? `Settle ${fxConversionForm.selectedCurrency} → USD`
                      : `Settle ${fxConversionForm.selectedCurrency} to Broker`}
                </DialogTitle>
                <DialogDescription>
                  {fxConversionForm.selectedCurrency === "USD"
                    ? parseFloat(fxConversionForm.commissionBalance || "0") > 0
                      ? isSelf
                        ? "Direct settlement: records this USD commission as settled. Not a voucher payment."
                        : "Direct transfer: moves this USD commission from the linked supplier to the broker at 1:1 rate. Not a voucher payment."
                      : isSelf
                        ? "Direct settlement: records this USD freight obligation as settled. Not a voucher payment."
                        : "Direct transfer: moves this USD freight obligation from the linked supplier to the broker at 1:1 rate. Not a voucher payment."
                    : isSelf
                      ? "Internal settlement: records the USD amount paid to settle this supplier's foreign currency balance. Not a voucher payment."
                      : "Internal settlement: records the USD cost of settling this linked supplier's foreign currency balance into the broker's pool. Not a voucher payment."}
                </DialogDescription>
              </DialogHeader>
            );
          })()}
          <div className="space-y-4">
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Settlement Source</Label>
              <div className="flex gap-2">
                {(["supplier", "commission", "both"] as const).map((t) => {
                  const labels: Record<string, string> = {
                    supplier: "Supplier Balance",
                    commission: "Commission",
                    both: "Both",
                  };
                  const getAvail = (src: string) => {
                    const s = parseFloat(fxConversionForm.supplierBalance || "0");
                    const c = parseFloat(fxConversionForm.commissionBalance || "0");
                    if (src === "supplier") return s.toFixed(2);
                    if (src === "commission") return c.toFixed(2);
                    return (s + c).toFixed(2);
                  };
                  return (
                    <Button
                      key={t}
                      type="button"
                      variant={fxSourceType === t ? "default" : "outline"}
                      size="sm"
                      onClick={() => {
                        setFxSourceType(t);
                        const newAvail = getAvail(t);
                        setFxConversionForm((prev) => ({ ...prev, availableBalance: newAvail, amount: newAvail }));
                      }}
                      data-testid={`fx-source-${t}`}
                    >
                      {labels[t]}
                    </Button>
                  );
                })}
              </div>
            </div>
            <div className="flex items-center gap-2 p-3 rounded-md bg-muted/50">
              <Globe className="h-4 w-4 text-muted-foreground shrink-0" />
              <span className="text-sm font-medium">{fxConversionForm.selectedCurrency} balance being settled</span>
            </div>

            <div>
              <Label>Amount ({fxConversionForm.selectedCurrency})</Label>
              <Input
                type="number"
                step="any"
                min="0"
                placeholder="0.00"
                value={fxConversionForm.amount}
                onChange={(e) => setFxConversionForm((prev) => ({ ...prev, amount: e.target.value }))}
                data-testid="input-fx-amount"
              />
            </div>

            {fxConversionForm.selectedCurrency === "USD" ? (
              <div className="flex items-center gap-2 p-3 rounded-md bg-muted/50 text-sm text-muted-foreground">
                <span>
                  Rate: <span className="font-medium text-foreground">1 USD = 1 USD</span> (direct transfer, no FX
                  conversion)
                </span>
              </div>
            ) : (
              <div>
                <Label>Exchange Rate (USD per 1 {fxConversionForm.selectedCurrency})</Label>
                <Input
                  type="number"
                  step="any"
                  min="0"
                  placeholder={`e.g. 1.10 (USD per 1 ${fxConversionForm.selectedCurrency})`}
                  value={fxConversionForm.fxRateToUsd}
                  onChange={(e) => setFxConversionForm((prev) => ({ ...prev, fxRateToUsd: e.target.value }))}
                  data-testid="input-fx-rate"
                />
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Entry Date</Label>
                <Input
                  type="date"
                  value={fxConversionForm.date}
                  onChange={(e) => setFxConversionForm((prev) => ({ ...prev, date: e.target.value }))}
                  data-testid="input-fx-date"
                />
              </div>
            </div>

            <div>
              <Label>Notes</Label>
              <Input
                placeholder="Conversion note"
                value={fxConversionForm.notes}
                onChange={(e) => setFxConversionForm((prev) => ({ ...prev, notes: e.target.value }))}
                data-testid="input-fx-notes"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFxConversionOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                wrapAdminAction(() => {
                  fxConversionMutation.mutate({
                    ...fxConversionForm,
                    sourceType: fxSourceType,
                  });
                }, "Record FX Conversion")
              }
              disabled={
                !fxConversionForm.amount ||
                !fxConversionForm.fxRateToUsd ||
                parseFloat(fxConversionForm.amount) <= 0 ||
                parseFloat(fxConversionForm.fxRateToUsd) <= 0 ||
                fxConversionMutation.isPending
              }
              data-testid="button-submit-fx-conversion"
            >
              {fxConversionMutation.isPending
                ? "Recording..."
                : fxConversionForm.selectedCurrency === "USD"
                  ? "Record Transfer"
                  : "Record Settlement"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
