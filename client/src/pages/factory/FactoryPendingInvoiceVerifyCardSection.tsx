import { UnifiedAccountPicker } from "@/components/accounts/UnifiedAccountPicker";
// Extracted from ./FactoryPendingInvoiceVerify.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Package, Plus, Trash2, Truck } from "lucide-react";
import { fmtNum } from "./factorypendinginvoiceverify/utils";
import { useFactoryPendingInvoiceVerifyState } from "./FactoryPendingInvoiceVerifyPageHeaderSection";
export { FactoryPendingInvoiceVerifyCardSection2 } from "./FactoryPendingInvoiceVerifyCardSection2";

export function FactoryPendingInvoiceVerifyCardSection({
  addChargeMutation,
  canChange,
  chargeAmount,
  chargeLedgerAccountId,
  chargeName,
  chargeType,
  charges,
  handleAddCharge,
  ledgerAccounts,
  recordChanges,
  removeChargeMutation,
  setChargeAmount,
  setChargeLedgerAccountId,
  setChargeName,
  setChargeType,
}: Pick<
  ReturnType<typeof useFactoryPendingInvoiceVerifyState>,
  | "addChargeMutation"
  | "canChange"
  | "chargeAccountOpen"
  | "chargeAmount"
  | "chargeLedgerAccountId"
  | "chargeName"
  | "chargeType"
  | "charges"
  | "handleAddCharge"
  | "ledgerAccounts"
  | "recordChanges"
  | "removeChargeMutation"
  | "setChargeAccountOpen"
  | "setChargeAmount"
  | "setChargeLedgerAccountId"
  | "setChargeName"
  | "setChargeType"
>) {
  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="text-sm">Freight &amp; Charges</CardTitle>
        <p className="text-xs text-muted-foreground">
          These will be billed to the customer and posted to the selected account
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {charges.length > 0 && (
          <div className="space-y-1">
            {charges.map((charge) => {
              const acct = ledgerAccounts.find((a) => a.id === charge.ledgerAccountId);
              return (
                <div
                  key={charge.id}
                  className="flex items-center justify-between gap-2"
                  data-testid={`row-charge-${charge.id}`}
                >
                  <div className="flex flex-col min-w-0">
                    <span className="text-sm font-medium">{charge.name}</span>
                    {acct && <span className="text-xs text-muted-foreground">{acct.name}</span>}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <span className="font-mono text-sm" data-testid={`text-charge-amount-${charge.id}`}>
                      {fmtNum(parseFloat(charge.amount))}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => removeChargeMutation.mutate(charge.id)}
                      disabled={removeChargeMutation.isPending || !canChange}
                      title={recordChanges.reason ?? undefined}
                      data-testid={`button-remove-charge-${charge.id}`}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="space-y-2 pt-2 border-t">
          <p className="text-xs font-medium text-muted-foreground">Add Charge</p>
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
            testId="select-charge-account"
            searchTestId="input-charge-account-search"
            optionTestId={(id) => `option-account-${id}`}
          /></Popover>
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
              data-testid="input-charge-amount"
            />
            <Button
              variant="outline"
              onClick={handleAddCharge}
              disabled={
                !canChange ||
                !chargeAmount ||
                (chargeType !== "FREIGHT" && !chargeLedgerAccountId) ||
                addChargeMutation.isPending
              }
              title={recordChanges.reason ?? undefined}
              data-testid="button-add-charge"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function FactoryPendingInvoiceVerifySection({
  totalNotLoadedBales,
  totalNotLoadedWeight,
  verification,
}: Pick<
  ReturnType<typeof useFactoryPendingInvoiceVerifyState>,
  "totalNotLoadedBales" | "totalNotLoadedWeight" | "verification"
>) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Total Loaded Bales</CardTitle>
          <Package className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold" data-testid="text-total-loaded-bales">
            {verification?.totalLoadedBales ?? 0} bales
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Total Weight</CardTitle>
          <Truck className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold" data-testid="text-total-weight">
            {fmtNum(verification?.totalLoadedWeight ?? 0)} kg
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Total Not Loaded</CardTitle>
          <Package className="h-4 w-4 text-amber-500" />
        </CardHeader>
        <CardContent>
          <div
            className="text-2xl font-bold text-amber-600 dark:text-amber-400"
            data-testid="text-total-not-loaded-bales"
          >
            {totalNotLoadedBales} bales
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Not Loaded Weight</CardTitle>
          <Truck className="h-4 w-4 text-amber-500" />
        </CardHeader>
        <CardContent>
          <div
            className="text-2xl font-bold text-amber-600 dark:text-amber-400"
            data-testid="text-total-not-loaded-weight"
          >
            {fmtNum(totalNotLoadedWeight)} kg
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
