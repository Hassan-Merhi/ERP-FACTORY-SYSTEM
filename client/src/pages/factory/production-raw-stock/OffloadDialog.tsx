import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { formatNumber } from "@/lib/formatNumber";
import { Button } from "@/components/ui/button";
import { Plus, Info, Lock, ChevronsUpDown, Check } from "lucide-react";
import { buildOffloadPayload } from "./offloadFormCalculations";
import { useOffloadFormState } from "./useOffloadFormState";
import { OffloadChargeFields } from "./OffloadChargeFields";
import type { OffloadDialogProps } from "./offloadDialogTypes";

export function OffloadDialog({
  open,
  onOpenChange,
  availableContainers,
  factorySuppliers,
  ledgerAccounts,
  offloadMutation,
  wrapAdminAction,
  mixBatches: _mixBatches,
}: OffloadDialogProps) {
  const {
    idempotencyKeyRef,
    fields,
    selectedContainer,
    isSubsequentReceipt,
    partialReceiptInfo,
    receiptValue,
    estimatedAvgCostKg,
    setOffloadDate,
    setActualReceivedKg,
    setCostPerKg,
    setFreight,
    setFreightAccountId,
    setOtherCharges,
    setOtherChargesAccountId,
    setFreightCurrencyCode,
    setOtherChargesCurrencyCode,
    setDutyAmount,
    setDutyPending,
    handleContainerSelect,
    handleAddAdditionalCharge,
    handleRemoveAdditionalCharge,
    handleUpdateAdditionalCharge,
  } = useOffloadFormState(open, availableContainers, factorySuppliers);

  const [containerComboOpen, setContainerComboOpen] = useState(false);

  const handleSubmit = () => {
    if (!fields.selectedContainerId) return;

    // Generate idempotency key lazily on first submit; reuse on retries until dialog closes.
    if (!idempotencyKeyRef.current) {
      idempotencyKeyRef.current = crypto.randomUUID();
    }
    const payload = buildOffloadPayload(fields, idempotencyKeyRef.current);

    offloadMutation.mutate(payload);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="h-5 w-5 text-emerald-600" />
            Offload Container
          </DialogTitle>
          <DialogDescription>
            Register received weight and link container costs to production raw stock.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-6 py-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Select Container</Label>
              <Popover open={containerComboOpen} onOpenChange={setContainerComboOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={containerComboOpen}
                    className="w-full justify-between font-normal"
                  >
                    <span className="truncate">
                      {fields.selectedContainerId
                        ? (() => {
                            const c = availableContainers.find((x) => x.id.toString() === fields.selectedContainerId);
                            return c
                              ? `${c.containerNumber} (${c.totalKg} kg — ${c.supplierName})${c.status === "PARTIALLY_RECEIVED" ? " [Partial]" : ""}`
                              : "Select container...";
                          })()
                        : "Select container..."}
                    </span>
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="p-0" style={{ width: "var(--radix-popover-trigger-width)" }} align="start">
                  <Command>
                    <CommandInput placeholder="Search container number or supplier..." />
                    <CommandList>
                      <CommandEmpty>No container found.</CommandEmpty>
                      <CommandGroup>
                        {availableContainers.map((c) => (
                          <CommandItem
                            key={c.id}
                            value={`${c.containerNumber} ${c.supplierName}`}
                            onSelect={() => {
                              handleContainerSelect(c.id.toString());
                              setContainerComboOpen(false);
                            }}
                          >
                            <Check
                              className={`mr-2 h-4 w-4 shrink-0 ${fields.selectedContainerId === c.id.toString() ? "opacity-100" : "opacity-0"}`}
                            />
                            <span className="truncate">
                              {c.containerNumber} ({c.totalKg} kg — {c.supplierName})
                              {c.status === "PARTIALLY_RECEIVED" ? " [Partial]" : ""}
                            </span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>
            <div className="space-y-2">
              <Label>Offload Date</Label>
              <Input type="date" value={fields.offloadDate} onChange={(e) => setOffloadDate(e.target.value)} />
            </div>
          </div>

          {/* Subsequent receipt info banner */}
          {isSubsequentReceipt && partialReceiptInfo && (
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 space-y-2">
              <div className="flex items-center gap-2 text-blue-700 font-semibold text-sm">
                <Info className="h-4 w-4" />
                Subsequent Receipt — Partial Container
              </div>
              <div className="grid grid-cols-3 gap-2 text-sm text-blue-800">
                <span>
                  Declared: <strong>{formatNumber(partialReceiptInfo.declared)} kg</strong>
                </span>
                <span>
                  Already received: <strong>{formatNumber(partialReceiptInfo.alreadyReceived)} kg</strong>
                </span>
                <span>
                  Remaining: <strong>{formatNumber(partialReceiptInfo.remaining)} kg</strong>
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm text-blue-800">
                <span>
                  Fixed Landed Cost/KG (USD):{" "}
                  <strong>
                    {selectedContainer?.fixedCostPerKgUsd
                      ? formatNumber(parseFloat(selectedContainer.fixedCostPerKgUsd), 6)
                      : "—"}{" "}
                    USD/kg
                  </strong>
                </span>
                <span>
                  Value of This Receipt:{" "}
                  <strong>{receiptValue != null ? `${formatNumber(receiptValue, 2)} USD` : "—"}</strong>
                </span>
              </div>
              <p className="text-xs text-blue-600 flex items-center gap-1">
                <Lock className="h-3 w-3" />
                Freight, charges, and commission are locked — they were posted on the first receipt. Only the received
                weight applies here.
              </p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>
                Received Weight (KG)
                {isSubsequentReceipt && partialReceiptInfo
                  ? ` (max ${formatNumber(partialReceiptInfo.remaining)} kg remaining)`
                  : ""}
              </Label>
              <Input
                type="number"
                step="0.001"
                value={fields.actualReceivedKg}
                onChange={(e) => setActualReceivedKg(e.target.value)}
                placeholder="0.000"
              />
            </div>
            <div className="space-y-2">
              <Label>Base Cost per KG ({fields.currencyCode})</Label>
              <Input
                type="number"
                step="0.0001"
                value={fields.costPerKg}
                onChange={(e) => setCostPerKg(e.target.value)}
                placeholder="0.0000"
                disabled={isSubsequentReceipt}
              />
              {isSubsequentReceipt && (
                <p className="text-xs text-muted-foreground">Rate established at first offload — not editable here.</p>
              )}
            </div>
          </div>

          {isSubsequentReceipt ? (
            <div className="rounded-lg border border-muted bg-muted/30 p-4 text-sm text-muted-foreground flex items-center gap-2">
              <Lock className="h-4 w-4 shrink-0" />
              Freight, other charges, commission, duty, and additional charges were recorded on the first receipt and
              are not re-posted here. The fixed landed cost/kg ({selectedContainer?.currencyCode}) already covers the
              full container.
            </div>
          ) : (
            <OffloadChargeFields
              fields={fields}
              setFreight={setFreight}
              setFreightAccountId={setFreightAccountId}
              setFreightCurrencyCode={setFreightCurrencyCode}
              setOtherCharges={setOtherCharges}
              setOtherChargesAccountId={setOtherChargesAccountId}
              setOtherChargesCurrencyCode={setOtherChargesCurrencyCode}
              setDutyAmount={setDutyAmount}
              setDutyPending={setDutyPending}
              handleAddAdditionalCharge={handleAddAdditionalCharge}
              handleRemoveAdditionalCharge={handleRemoveAdditionalCharge}
              handleUpdateAdditionalCharge={handleUpdateAdditionalCharge}
              ledgerAccounts={ledgerAccounts}
              factorySuppliers={factorySuppliers}
            />
          )}

          {/* Warning: commission FX rate couldn't be resolved — user can still submit;
              server will validate and return an error if the rate is truly missing. */}
          {fields.commissionFromContainer &&
            fields.containerCommissionCcy !== "USD" &&
            fields.containerCommissionCcy !== fields.currencyCode &&
            !fields.commissionFxRateLoading &&
            !(parseFloat(fields.commissionFxRate) > 0) && (
              <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                Could not fetch the {fields.containerCommissionCcy}/USD exchange rate automatically. The offload will be
                validated by the server — if it fails, check that an exchange rate is configured for{" "}
                {fields.containerCommissionCcy}.
              </div>
            )}

          {estimatedAvgCostKg !== null && estimatedAvgCostKg > 0 && (
            <div className="rounded-md border border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30 dark:border-emerald-800 px-4 py-3 flex items-center justify-between">
              <span className="text-sm font-medium text-emerald-800 dark:text-emerald-300">
                Estimated Avg Cost / kg
              </span>
              <span className="text-base font-bold font-mono text-emerald-700 dark:text-emerald-200">
                ${estimatedAvgCostKg.toFixed(4)} <span className="text-xs font-normal">USD</span>
              </span>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => wrapAdminAction(handleSubmit, "Offload Container")}
              disabled={
                offloadMutation.isPending ||
                !fields.selectedContainerId ||
                // Only block while the commission FX rate is actively fetching.
                // If the fetch completed but returned no rate, the server will
                // validate and return an actionable error — do not silently lock
                // the button with no user-visible explanation.
                (fields.commissionFromContainer &&
                  fields.containerCommissionCcy !== "USD" &&
                  fields.containerCommissionCcy !== fields.currencyCode &&
                  fields.commissionFxRateLoading)
              }
            >
              {offloadMutation.isPending ? "Offloading..." : "Confirm Offload"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
