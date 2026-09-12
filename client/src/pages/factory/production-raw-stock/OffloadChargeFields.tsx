/**
 * Charge-entry section of the OffloadDialog: freight, other charges, the
 * repeatable extra-charge rows, and the duty details.
 *
 * Extracted from OffloadDialog.tsx during the P1 god-file split. Purely
 * presentational over the form state returned by useOffloadFormState.
 */

import { Plus, X } from "lucide-react";
import { formatNumber } from "@/lib/formatNumber";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { AccountCombobox } from "./ProductionRawStockHelpers";
import type { OffloadFormFields, OffloadLedgerAccount, OffloadSupplierOption } from "./offloadDialogTypes";

const CURRENCY_OPTIONS = ["USD", "EUR", "AUD", "GBP", "LBP"] as const;

interface OffloadChargeFieldsProps {
  fields: OffloadFormFields;
  setFreight: (value: string) => void;
  setFreightAccountId: (value: string) => void;
  setFreightCurrencyCode: (value: string) => void;
  setOtherCharges: (value: string) => void;
  setOtherChargesAccountId: (value: string) => void;
  setOtherChargesCurrencyCode: (value: string) => void;
  setDutyAmount: (value: string) => void;
  setDutyPending: (value: boolean) => void;
  handleAddAdditionalCharge: () => void;
  handleRemoveAdditionalCharge: (id: string) => void;
  handleUpdateAdditionalCharge: (id: string, field: string, value: string) => void;
  ledgerAccounts: OffloadLedgerAccount[];
  factorySuppliers: OffloadSupplierOption[];
}

export function OffloadChargeFields({
  fields,
  setFreight,
  setFreightAccountId,
  setFreightCurrencyCode,
  setOtherCharges,
  setOtherChargesAccountId,
  setOtherChargesCurrencyCode,
  setDutyAmount,
  setDutyPending,
  handleAddAdditionalCharge,
  handleRemoveAdditionalCharge,
  handleUpdateAdditionalCharge,
  ledgerAccounts,
  factorySuppliers,
}: OffloadChargeFieldsProps) {
  return (
    <>
      <Separator />
      <div className="grid grid-cols-2 gap-6">
        <div className="space-y-4">
          <h3 className="font-semibold text-sm">Freight & Other Charges</h3>
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <div className="space-y-2">
              <Label>Freight Cost</Label>
              <Input
                type="number"
                step="0.01"
                value={fields.freight}
                onChange={(e) => setFreight(e.target.value)}
                disabled={fields.freightFromContainer}
                placeholder="0.00"
              />
            </div>
            <div className="space-y-2">
              <Label>Currency</Label>
              <Select
                value={fields.freightCurrencyCode}
                onValueChange={setFreightCurrencyCode}
                disabled={fields.freightFromContainer}
              >
                <SelectTrigger className="w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CURRENCY_OPTIONS.map((code) => (
                    <SelectItem key={code} value={code}>
                      {code}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {fields.freightCurrencyCode !== "USD" && (
            <p className="text-xs text-muted-foreground -mt-2">
              {fields.freightFxRateLoading
                ? "Fetching current exchange rate…"
                : parseFloat(fields.freightFxRate) > 0
                  ? `1 ${fields.freightCurrencyCode} = ${formatNumber(parseFloat(fields.freightFxRate))} USD — freight will be posted to the ledger in USD.`
                  : "Exchange rate unavailable — enter it manually to convert this charge to USD."}
            </p>
          )}
          <div className="space-y-2">
            <Label>Freight Account</Label>
            <AccountCombobox
              value={fields.freightAccountId}
              onValueChange={setFreightAccountId}
              accounts={ledgerAccounts}
              suppliers={factorySuppliers}
            />
          </div>

          <Separator />

          <div className="grid grid-cols-[1fr_auto] gap-2">
            <div className="space-y-2">
              <Label>Other Charges</Label>
              <Input
                type="number"
                step="0.01"
                value={fields.otherCharges}
                onChange={(e) => setOtherCharges(e.target.value)}
                disabled={fields.otherChargesFromContainer}
                placeholder="0.00"
              />
            </div>
            <div className="space-y-2">
              <Label>Currency</Label>
              <Select
                value={fields.otherChargesCurrencyCode}
                onValueChange={setOtherChargesCurrencyCode}
                disabled={fields.otherChargesFromContainer}
              >
                <SelectTrigger className="w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CURRENCY_OPTIONS.map((code) => (
                    <SelectItem key={code} value={code}>
                      {code}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {fields.otherChargesCurrencyCode !== "USD" && (
            <p className="text-xs text-muted-foreground -mt-2">
              {fields.otherChargesFxRateLoading
                ? "Fetching current exchange rate…"
                : parseFloat(fields.otherChargesFxRate) > 0
                  ? `1 ${fields.otherChargesCurrencyCode} = ${formatNumber(parseFloat(fields.otherChargesFxRate))} USD — other charges will be posted to the ledger in USD.`
                  : "Exchange rate unavailable — enter it manually to convert this charge to USD."}
            </p>
          )}
          <div className="space-y-2">
            <Label>Other Charges Account</Label>
            <AccountCombobox
              value={fields.otherChargesAccountId}
              onValueChange={setOtherChargesAccountId}
              accounts={ledgerAccounts}
              suppliers={factorySuppliers}
              disabled={fields.otherChargesFromContainer}
            />
          </div>

          <Separator />

          {/* ── Extra Charges (multiple rows) ── */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm text-muted-foreground">Extra Charges</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1 text-xs"
                onClick={handleAddAdditionalCharge}
              >
                <Plus className="h-3 w-3" />
                Add
              </Button>
            </div>
            {fields.additionalCharges.length > 0 && (
              <div className="space-y-3">
                {fields.additionalCharges.map((charge) => (
                  <div key={charge.id} className="rounded-md border p-3 space-y-2 bg-muted/20">
                    <div className="grid grid-cols-[1fr_auto_auto] gap-2 items-center">
                      <Input
                        placeholder="Description"
                        value={charge.description}
                        onChange={(e) => handleUpdateAdditionalCharge(charge.id, "description", e.target.value)}
                      />
                      <Select
                        value={charge.currencyCode}
                        onValueChange={(v) => handleUpdateAdditionalCharge(charge.id, "currencyCode", v)}
                      >
                        <SelectTrigger className="w-24">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CURRENCY_OPTIONS.map((code) => (
                            <SelectItem key={code} value={code}>
                              {code}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-destructive"
                        onClick={() => handleRemoveAdditionalCharge(charge.id)}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                    <Input
                      type="number"
                      step="0.01"
                      placeholder="Amount"
                      value={charge.amount}
                      onChange={(e) => handleUpdateAdditionalCharge(charge.id, "amount", e.target.value)}
                    />
                    {charge.currencyCode !== "USD" && (
                      <p className="text-xs text-muted-foreground">
                        {charge.fxRateLoading
                          ? "Fetching exchange rate…"
                          : parseFloat(charge.fxRate) > 0
                            ? `1 ${charge.currencyCode} = ${formatNumber(parseFloat(charge.fxRate))} USD`
                            : "Exchange rate unavailable — will use container FX rate"}
                      </p>
                    )}
                    <AccountCombobox
                      value={charge.ledgerAccountId}
                      onValueChange={(v) => handleUpdateAdditionalCharge(charge.id, "ledgerAccountId", v)}
                      accounts={ledgerAccounts}
                      suppliers={factorySuppliers}
                      placeholder="Select account"
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <h3 className="font-semibold text-sm">Duty Details</h3>
          <div className="space-y-2">
            <Label>Duty Amount (USD)</Label>
            <Input
              type="number"
              step="0.01"
              value={fields.dutyAmount}
              onChange={(e) => setDutyAmount(e.target.value)}
            />
          </div>
          <div className="flex items-center space-x-2">
            <Switch checked={fields.dutyPending} onCheckedChange={setDutyPending} />
            <Label>Duty Payment Pending</Label>
          </div>
        </div>
      </div>
    </>
  );
}
