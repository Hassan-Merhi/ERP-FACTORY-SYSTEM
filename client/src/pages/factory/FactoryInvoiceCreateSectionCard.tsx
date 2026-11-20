import { UnifiedAccountPicker } from "@/components/accounts/UnifiedAccountPicker";
// Extracted from ./FactoryInvoiceCreateSection.tsx
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Trash2 } from "lucide-react";
import { useFactoryInvoiceCreateState } from "./useFactoryInvoiceCreateState";

export function FactoryInvoiceCreateSectionCard({
  addChargeMutation,
  chargeAmount,
  chargeLedgerAccountId,
  chargeName,
  charges,
  chargeType,
  handleAddCharge,
  ledgerAccounts,
  orderDetail,
  orderId,
  relinkVouchersMutation,
  removeChargeMutation,
  setChargeAmount,
  setChargeLedgerAccountId,
  setChargeName,
  setChargeType,
}: Pick<
  Pick<
    ReturnType<typeof useFactoryInvoiceCreateState>,
    | "activeProforma"
    | "addBaleMutation"
    | "addChargeMutation"
    | "bales"
    | "chargeAmount"
    | "chargeLedgerAccountId"
    | "chargeName"
    | "chargeType"
    | "charges"
    | "customerId"
    | "customers"
    | "finalizeMutation"
    | "freightCharges"
    | "grandTotal"
    | "handleAddCharge"
    | "handleCustomerChange"
    | "handleDateChange"
    | "handleScan"
    | "ledgerAccounts"
    | "locations"
    | "orderDate"
    | "orderDetail"
    | "orderId"
    | "otherCharges"
    | "proformaSummaries"
    | "relinkVouchersMutation"
    | "removeChargeMutation"
    | "repriceMutation"
    | "scanCode"
    | "scanInputClass"
    | "scannerRef"
    | "selectedCustomerId"
    | "selectedLocationId"
    | "setChargeAmount"
    | "setChargeLedgerAccountId"
    | "setChargeName"
    | "setChargeType"
    | "setScanCode"
    | "setSelectedLocationId"
    | "setShowFinalizeDialog"
    | "subtotal"
  >,
  | "addChargeMutation"
  | "chargeAmount"
  | "chargeLedgerAccountId"
  | "chargeName"
  | "charges"
  | "chargeType"
  | "handleAddCharge"
  | "ledgerAccounts"
  | "orderDetail"
  | "orderId"
  | "relinkVouchersMutation"
  | "removeChargeMutation"
  | "setChargeAmount"
  | "setChargeLedgerAccountId"
  | "setChargeName"
  | "setChargeType"
>) {
  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="font-semibold text-sm">Charges</h3>
        {orderDetail?.status === "FINALIZED" && charges.some((c) => !c.voucherId) && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => relinkVouchersMutation.mutate()}
            disabled={relinkVouchersMutation.isPending}
            data-testid="button-relink-charge-vouchers"
          >
            {relinkVouchersMutation.isPending ? "Linking..." : "Fix Ledger Entries"}
          </Button>
        )}
      </div>

      {charges.length > 0 && (
        <div className="space-y-1">
          {charges.map((charge) => (
            <div
              key={charge.id}
              className="flex items-center justify-between gap-2"
              data-testid={`row-charge-${charge.id}`}
            >
              <span className="text-sm">{charge.name}</span>
              <div className="flex items-center gap-1">
                <span className="font-mono text-sm" data-testid={`text-charge-amount-${charge.id}`}>
                  {parseFloat(charge.amount).toLocaleString(undefined, {
                    minimumFractionDigits: 0,
                    maximumFractionDigits: 2,
                  })}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => removeChargeMutation.mutate(charge.id)}
                  disabled={removeChargeMutation.isPending}
                  data-testid={`button-remove-charge-${charge.id}`}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-2">
        <Select value={chargeType} onValueChange={setChargeType}>
          <SelectTrigger data-testid="select-charge-type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="FREIGHT">Freight</SelectItem>
            <SelectItem value="OTHER">Other</SelectItem>
          </SelectContent>
        </Select>

        {chargeType === "OTHER" && (
          <Input
            value={chargeName}
            onChange={(e) => setChargeName(e.target.value)}
            placeholder="Charge name..."
            data-testid="input-charge-name"
          />
        )}

        <UnifiedAccountPicker
 options={ledgerAccounts.map((account) => ({ value: String(account.id), name: account.name }))}
 value={chargeLedgerAccountId}
 onChange={setChargeLedgerAccountId}
 placeholder={chargeType !== "FREIGHT" ? "Select account (required)..." : "Select account (optional)..."}
 testId={"select-charge-ledger-account"}
 />
        {chargeType !== "FREIGHT" && !chargeLedgerAccountId && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            A ledger account is required so the charge posts to accounting.
          </p>
        )}

        <div className="flex items-center gap-2">
          <Input
            type="number"
            step="0.01"
            value={chargeAmount}
            onChange={(e) => setChargeAmount(e.target.value)}
            placeholder="Amount"
            disabled={!orderId}
            data-testid="input-charge-amount"
          />
          <Button
            variant="outline"
            onClick={handleAddCharge}
            disabled={
              !orderId ||
              !chargeAmount ||
              (chargeType !== "FREIGHT" && !chargeLedgerAccountId) ||
              addChargeMutation.isPending
            }
            data-testid="button-add-charge"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </Card>
  );
}
