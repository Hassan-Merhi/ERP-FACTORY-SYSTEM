// Extracted from ./FactoryContainerCreate.tsx
import { Info } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatNumber } from "@/lib/formatNumber";
import { useFactoryContainerCreateState } from "./useFactoryContainerCreateState";

export function FactoryContainerCreateCard({
  commissionAmt2,
  commissionCcy,
  commissionFxRate,
  commissionFxRateDate,
  commissionFxRateLoading,
  currency,
  formData,
  fxRate,
  fxRateLoading,
  linkedBroker,
  ratePerKg,
  setCurrency,
  setFormData,
  setRatePerKg,
  setTotalKg,
  totalKg,
}: Pick<
  ReturnType<typeof useFactoryContainerCreateState>,
  | "commissionAmt2"
  | "commissionCcy"
  | "commissionFxRate"
  | "commissionFxRateDate"
  | "commissionFxRateLoading"
  | "currency"
  | "formData"
  | "fxRate"
  | "fxRateLoading"
  | "linkedBroker"
  | "ratePerKg"
  | "setCurrency"
  | "setFormData"
  | "setRatePerKg"
  | "setTotalKg"
  | "totalKg"
>) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Money &amp; Commission</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2">
          <div>
            <Label>Total Kg</Label>
            <Input
              type="number"
              value={totalKg}
              onChange={(e) => setTotalKg(e.target.value)}
              placeholder="0.000"
              data-testid="input-container-total-kg"
            />
          </div>
          <div>
            <Label>Rate per Kg</Label>
            <Input
              type="number"
              value={ratePerKg}
              onChange={(e) => setRatePerKg(e.target.value)}
              placeholder="0.0000000"
              step="0.0000001"
              data-testid="input-container-rate"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2">
          <div>
            <Label>Currency</Label>
            <Select value={currency} onValueChange={(val) => setCurrency(val)}>
              <SelectTrigger data-testid="select-container-currency">
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
          </div>
        </div>

        {currency !== "USD" && (
          <div className="text-xs text-muted-foreground">
            {fxRateLoading
              ? "Fetching current exchange rate…"
              : parseFloat(fxRate) > 0
                ? `1 ${currency} = ${formatNumber(parseFloat(fxRate))} USD (auto rate, used to convert this container's costs and commission to a common currency)`
                : "Exchange rate unavailable — costs in this currency may not convert correctly."}
          </div>
        )}

        <Separator />

        <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2">
          <div>
            <Label>Commission Amount</Label>
            <Input
              type="number"
              value={formData.commissionAmount}
              onChange={(e) => setFormData({ ...formData, commissionAmount: e.target.value })}
              placeholder="0.00"
              data-testid="input-container-commission"
            />
          </div>
          <div>
            <Label>Commission Currency</Label>
            <Select
              value={formData.commissionCurrencyCode}
              onValueChange={(val) => setFormData({ ...formData, commissionCurrencyCode: val })}
            >
              <SelectTrigger data-testid="select-commission-currency">
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

        {commissionAmt2 > 0 && commissionCcy !== "USD" && (
          <div className="text-xs text-muted-foreground -mt-1">
            {commissionFxRateLoading
              ? `Fetching ${commissionCcy}/USD rate…`
              : parseFloat(commissionFxRate) > 0
                ? `1 ${commissionCcy} = ${parseFloat(commissionFxRate)
                    .toFixed(8)
                    .replace(
                      /\.?0+$/,
                      ""
                    )} USD${commissionCcy === currency.toUpperCase() ? " (using container rate)" : commissionFxRateDate ? ` · ${commissionFxRateDate}` : ""}`
                : `No ${commissionCcy}/USD rate available — container creation blocked until resolved.`}
          </div>
        )}

        <div>
          <Label>
            Commission Notes <span className="text-muted-foreground text-xs font-normal">(optional)</span>
          </Label>
          <Input
            value={formData.commissionNotes}
            onChange={(e) => setFormData({ ...formData, commissionNotes: e.target.value })}
            placeholder="e.g. Commission for container facilitation"
            data-testid="input-commission-notes"
          />
        </div>

        {linkedBroker && parseFloat(formData.commissionAmount || "0") > 0 && (
          <div className="rounded-md bg-muted/50 px-3 py-2 text-sm flex items-start gap-2 text-muted-foreground">
            <Info className="h-4 w-4 mt-0.5 shrink-0 text-blue-500" />
            <span>
              A commission account for <strong className="text-foreground">{linkedBroker.name}</strong> will be
              automatically created or reused in your accounts.
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
