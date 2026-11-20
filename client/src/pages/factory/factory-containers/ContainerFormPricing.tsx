import { UnifiedAccountPicker } from "@/components/accounts/UnifiedAccountPicker";
// Extracted from ./ContainerFormBody.tsx
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatNumber } from "@/lib/formatNumber";
import type { ContainerFormBodyProps } from "./ContainerFormBody";

export function ContainerFormPricing({
  formData,
  setFormData,
  fxRate,
  currency,
  setCurrency,
  fxRateSource,
  fxEffectiveDate,
  setFxRateSource,
  setFxRate,
  fxIsSuggestion,
  ledgerAccounts,
}: {
  formData: ContainerFormBodyProps["formData"];
  setFormData: ContainerFormBodyProps["setFormData"];
  fxRate: ContainerFormBodyProps["fxRate"];
  currency: ContainerFormBodyProps["currency"];
  setCurrency: ContainerFormBodyProps["setCurrency"];
  fxRateSource: ContainerFormBodyProps["fxRateSource"];
  fxEffectiveDate: ContainerFormBodyProps["fxEffectiveDate"];
  setFxRateSource: ContainerFormBodyProps["setFxRateSource"];
  setFxRate: ContainerFormBodyProps["setFxRate"];
  fxIsSuggestion: ContainerFormBodyProps["fxIsSuggestion"];
  ledgerAccounts: ContainerFormBodyProps["ledgerAccounts"];
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-sm font-semibold">Money &amp; Commission</p>
        <Separator className="flex-1" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <Label>Total Kg</Label>
          <Input
            type="text"
            inputMode="decimal"
            value={formData.totalKg}
            onChange={(e) => setFormData((f) => ({ ...f, totalKg: e.target.value }))}
            placeholder="0.000"
            data-testid="input-container-total-kg"
          />
        </div>
        <div>
          <Label>Rate per Kg</Label>
          <Input
            type="text"
            inputMode="decimal"
            value={formData.ratePerKg}
            onChange={(e) => setFormData((f) => ({ ...f, ratePerKg: e.target.value }))}
            placeholder="0.0000000"
            data-testid="input-container-rate"
          />
        </div>
      </div>
      {(() => {
        const rate = parseFloat(formData.ratePerKg || "0");
        const kg = parseFloat(formData.totalKg || "0");
        if (!rate || !kg || isNaN(rate) || isNaN(kg)) return null;
        const total = rate * kg;
        const fx = parseFloat(fxRate || "0");
        const totalUsd = currency !== "USD" && fx > 0 ? total * fx : null;
        const SYMBOLS: Record<string, string> = { USD: "$", EUR: "€", AUD: "A$", GBP: "£", LBP: "LL" };
        const sym = SYMBOLS[currency] ?? currency + " ";
        return (
          <div
            className="rounded-md bg-muted/50 border px-3 py-2 text-sm space-y-0.5"
            data-testid="text-edit-container-value-preview"
          >
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Estimated total value</span>
              <span className="font-semibold font-mono tabular-nums">
                {sym}
                {total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                {currency !== "USD" && (
                  <span className="text-xs text-muted-foreground font-normal ml-1"> {currency}</span>
                )}
                <span className="text-xs text-muted-foreground font-normal ml-1.5">
                  ({rate.toLocaleString("en-US", { maximumFractionDigits: 7 })} ×{" "}
                  {kg.toLocaleString("en-US", { maximumFractionDigits: 2 })} kg)
                </span>
              </span>
            </div>
            {totalUsd !== null && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground text-xs">≈ in USD</span>
                <span className="font-mono tabular-nums text-xs text-muted-foreground">
                  ${totalUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD
                  <span className="ml-1.5 opacity-70">
                    ({sym}
                    {total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} × {fx} FX)
                  </span>
                </span>
              </div>
            )}
          </div>
        );
      })()}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <Label>Currency</Label>
          <Select value={currency} onValueChange={setCurrency}>
            <SelectTrigger data-testid="select-container-currency">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["USD", "EUR", "AUD", "LBP", "GBP"].map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <div className="flex items-center justify-between mb-1">
            <Label>
              FX Rate{" "}
              {currency !== "USD"
                ? fxRateSource === "auto"
                  ? `(Auto${fxEffectiveDate ? ` — ${fxEffectiveDate}` : ""})`
                  : "(Manual)"
                : ""}
            </Label>
            {currency !== "USD" && (
              <button
                type="button"
                className="text-xs text-muted-foreground underline"
                onClick={() => setFxRateSource(fxRateSource === "auto" ? "manual" : "auto")}
                data-testid="button-toggle-fx-source"
              >
                {fxRateSource === "auto" ? "Switch to Manual" : "Switch to Auto"}
              </button>
            )}
          </div>
          <Input
            type="number"
            value={fxRate}
            onChange={(e) => setFxRate(e.target.value)}
            disabled={currency === "USD" || fxRateSource === "auto"}
            readOnly={currency !== "USD" && fxRateSource === "auto"}
            placeholder="1"
            data-testid="input-container-fx-rate"
          />
        </div>
      </div>
      {currency !== "USD" && fxRateSource === "auto" && fxIsSuggestion && (
        <p className="text-xs text-amber-600 dark:text-amber-400" data-testid="container-auto-fx-suggestion">
          This is a suggested dated FX quote, not yet a recorded rate. Create/Update will confirm and audit the rate
          before saving. Admin or Owner permission is required.
        </p>
      )}
      {currency !== "USD" && fxRate && parseFloat(fxRate) > 0 && (
        <div className="text-sm text-muted-foreground">
          1 {currency} = {formatNumber(parseFloat(fxRate))} USD &nbsp;&nbsp;·&nbsp;&nbsp; 1 USD ={" "}
          {formatNumber(1 / parseFloat(fxRate))} {currency}
          {formData.ratePerKg && (
            <span>
              {" "}
              &nbsp;&nbsp;·&nbsp;&nbsp; Rate/Kg ≈ {formatNumber(
                parseFloat(formData.ratePerKg) * parseFloat(fxRate)
              )}{" "}
              USD
            </span>
          )}
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <Label>Commission Amount</Label>
          <Input
            type="number"
            value={formData.commissionAmount}
            onChange={(e) => setFormData((f) => ({ ...f, commissionAmount: e.target.value }))}
            placeholder="0.00"
            data-testid="input-container-commission"
          />
        </div>
        <div>
          <Label>Commission Currency</Label>
          <Select
            value={formData.commissionCurrencyCode}
            onValueChange={(val) => setFormData((f) => ({ ...f, commissionCurrencyCode: val }))}
          >
            <SelectTrigger data-testid="select-commission-currency">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["USD", "EUR", "AUD", "GBP", "LBP"].map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div>
        <Label>
          ERP Commission Account <span className="text-muted-foreground text-xs font-normal">(optional)</span>
        </Label>
        <UnifiedAccountPicker
 options={ledgerAccounts.map((account) => ({ value: String(account.id), name: account.name }))}
 value={formData.commissionAccountId || ""}
 onChange={(val) => setFormData((f) => ({ ...f, commissionAccountId: val }))}
 placeholder={"None (leave empty)"}
 testId={"select-commission-account"}
 allowClear
 />
        <p className="text-xs text-muted-foreground mt-1">
          Commission flows into the broker's balance automatically via the "Broker / Commission To" field above.
        </p>
      </div>
    </div>
  );
}
