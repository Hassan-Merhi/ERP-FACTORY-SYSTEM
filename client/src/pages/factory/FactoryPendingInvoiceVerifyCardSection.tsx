// Extracted from ./FactoryPendingInvoiceVerify.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Check, ChevronsUpDown, Package, Plus, Trash2, Truck } from "lucide-react";
import { fmtNum } from "./factorypendinginvoiceverify/utils";
import { useFactoryPendingInvoiceVerifyState } from "./FactoryPendingInvoiceVerifyPageHeaderSection";
export { FactoryPendingInvoiceVerifyCardSection2 } from "./FactoryPendingInvoiceVerifyCardSection2";

export function FactoryPendingInvoiceVerifyCardSection({
  addChargeMutation,
  canChange,
  chargeAccountOpen,
  chargeAmount,
  chargeLedgerAccountId,
  chargeName,
  chargeType,
  charges,
  handleAddCharge,
  ledgerAccounts,
  recordChanges,
  removeChargeMutation,
  setChargeAccountOpen,
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

          <Popover open={chargeAccountOpen} onOpenChange={setChargeAccountOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                role="combobox"
                aria-expanded={chargeAccountOpen}
                className="w-full justify-between font-normal"
                data-testid="select-charge-account"
              >
                <span className="truncate text-left">
                  {chargeLedgerAccountId
                    ? (ledgerAccounts.find((a) => String(a.id) === chargeLedgerAccountId)?.name ?? "Select account...")
                    : chargeType !== "FREIGHT"
                      ? "Select account (required)..."
                      : "Select account (optional)..."}
                </span>
                <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[min(320px,calc(100vw-2rem))] p-0" align="start">
              <Command>
                <CommandInput placeholder="Search accounts..." data-testid="input-charge-account-search" />
                <CommandList>
                  <CommandEmpty>No account found.</CommandEmpty>
                  <CommandGroup>
                    {ledgerAccounts.map((acct) => (
                      <CommandItem
                        key={acct.id}
                        value={`${acct.name} ${acct.code}`}
                        onSelect={() => {
                          setChargeLedgerAccountId(String(acct.id));
                          setChargeAccountOpen(false);
                        }}
                        data-testid={`option-account-${acct.id}`}
                      >
                        <Check
                          className={`mr-2 h-4 w-4 shrink-0 ${String(acct.id) === chargeLedgerAccountId ? "opacity-100" : "opacity-0"}`}
                        />
                        <span className="flex-1 truncate">{acct.name}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
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
