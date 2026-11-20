import { UnifiedAccountPicker } from "@/components/accounts/UnifiedAccountPicker";
// Extracted from ./FactoryContainerCreate.tsx to keep that module under the source-size cap.
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useFactoryContainerCreateState } from "./useFactoryContainerCreateState";

export function FactoryContainerCreateCardSection({
  currency,
  formData,
  ledgerAccounts,
  otherChargeLines,
  removeOtherChargeLine,
  setFormData,
  setOtherChargeLines,
  updateOtherChargeLine,
}: Pick<
  ReturnType<typeof useFactoryContainerCreateState>,
  | "currency"
  | "formData"
  | "ledgerAccounts"
  | "otherChargeLines"
  | "removeOtherChargeLine"
  | "setFormData"
  | "setOtherChargeLines"
  | "updateOtherChargeLine"
>) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Freight &amp; Other Charges</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2">
          <div>
            <Label>
              Freight Amount <span className="text-muted-foreground text-xs font-normal">(optional)</span>
            </Label>
            <Input
              type="number"
              value={formData.freight}
              onChange={(e) => setFormData({ ...formData, freight: e.target.value })}
              placeholder="0.00"
              data-testid="input-container-freight"
            />
          </div>
          <div>
            <Label>Freight Currency</Label>
            <Select
              value={formData.freightCurrencyCode}
              onValueChange={(val) => setFormData({ ...formData, freightCurrencyCode: val })}
            >
              <SelectTrigger data-testid="select-freight-currency">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="USD">USD</SelectItem>
                <SelectItem value="EUR">EUR</SelectItem>
                <SelectItem value="AUD">AUD</SelectItem>
                <SelectItem value="GBP">GBP</SelectItem>
                <SelectItem value="LBP">LBP</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div>
          <Label>
            Freight Account <span className="text-muted-foreground text-xs font-normal">(optional)</span>
          </Label>
          <UnifiedAccountPicker
 options={ledgerAccounts.map((account) => ({ value: String(account.id), name: String(account.name ?? "") }))}
 value={formData.freightAccountId || ""}
 onChange={(val) => setFormData({ ...formData, freightAccountId: val })}
 placeholder={"Auto (Freight)"}
 testId={"select-freight-account"}
 allowClear
 />
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Label>
              Other Charges <span className="text-muted-foreground text-xs font-normal">(optional)</span>
            </Label>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              onClick={() =>
                setOtherChargeLines((prev) => [...prev, { amount: "", currencyCode: currency, ledgerAccountId: "" }])
              }
              data-testid="button-add-other-charge"
            >
              <Plus className="h-3 w-3 mr-1" />
              Add Line
            </Button>
          </div>
          {otherChargeLines.length === 0 && (
            <p className="text-xs text-muted-foreground py-1">No other charges. Click "Add Line" to add one.</p>
          )}
          {otherChargeLines.length > 0 && (
            // Phones give each charge line its own bordered row (amount, currency, remove; then the
            // account underneath); sm+ keeps the four-column grid via `sm:contents`.
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_2fr_auto] sm:items-center sm:gap-x-2 sm:gap-y-1">
              <div className="hidden text-xs font-medium text-muted-foreground sm:block">Amount</div>
              <div className="hidden text-xs font-medium text-muted-foreground sm:block">CCY</div>
              <div className="hidden text-xs font-medium text-muted-foreground sm:block">Account</div>
              <div className="hidden sm:block" />
              {otherChargeLines.map((line, idx) => (
                <div
                  key={`line-${idx}`}
                  className="grid grid-cols-[minmax(0,1fr)_5.5rem_auto] items-center gap-2 rounded-md border p-2 sm:contents"
                  data-testid={`other-charge-line-${idx}`}
                >
                  <Input
                    key={`amt-${idx}`}
                    type="number"
                    inputMode="decimal"
                    aria-label="Other charge amount"
                    value={line.amount}
                    onChange={(e) => updateOtherChargeLine(idx, "amount", e.target.value)}
                    placeholder="0.00"
                    data-testid={`input-other-charge-amount-${idx}`}
                  />
                  <Select
                    key={`ccy-${idx}`}
                    value={line.currencyCode || currency}
                    onValueChange={(val) => updateOtherChargeLine(idx, "currencyCode", val)}
                  >
                    <SelectTrigger
                      className="w-full sm:w-20"
                      aria-label="Other charge currency"
                      data-testid={`select-other-charge-currency-${idx}`}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="USD">USD</SelectItem>
                      <SelectItem value="EUR">EUR</SelectItem>
                      <SelectItem value="AUD">AUD</SelectItem>
                      <SelectItem value="LBP">LBP</SelectItem>
                      <SelectItem value="GBP">GBP</SelectItem>
                    </SelectContent>
                  </Select>
                  <UnifiedAccountPicker
 key={`acc-${idx}`}
 options={ledgerAccounts.map((account) => ({ value: String(account.id), name: String(account.name ?? "") }))}
 value={line.ledgerAccountId || ""}
 onChange={(val) => updateOtherChargeLine(idx, "ledgerAccountId", val)}
 placeholder={"No account"}
 testId={`select-other-charge-account-${idx}`}
 className={"order-last col-span-3 sm:order-0 sm:col-span-1"}
 allowClear
 />
                  <Button
                    key={`del-${idx}`}
                    type="button"
                    size="icon"
                    variant="ghost"
                    onClick={() => removeOtherChargeLine(idx)}
                    aria-label="Remove other charge"
                    data-testid={`button-remove-other-charge-${idx}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
