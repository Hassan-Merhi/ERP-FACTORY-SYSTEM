import { ArrowLeft, Info, Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FACTORY_MOBILE_ACTION_BAR_CLEARANCE, FactoryMobileActionBar } from "@/components/ui/factory-mobile";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { PageHeader } from "@/components/PageHeader";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatNumber } from "@/lib/formatNumber";
import { useFactoryContainerCreateState } from "./useFactoryContainerCreateState";
import { FactoryContainerCreateCardSection } from "./FactoryContainerCreateCardSection";

export default function FactoryContainerCreate() {
  const {
    canSubmit,
    commissionAmt2,
    commissionCcy,
    commissionFxRate,
    commissionFxRateDate,
    commissionFxRateLoading,
    createMutation,
    currency,
    filteredSupplierList,
    formData,
    fxRate,
    fxRateLoading,
    isCreateOnly,
    ledgerAccounts,
    linkedBroker,
    navigate,
    otherChargeLines,
    ratePerKg,
    removeOtherChargeLine,
    setCurrency,
    setFormData,
    setOtherChargeLines,
    setRatePerKg,
    setTotalKg,
    totalKg,
    updateOtherChargeLine,
  } = useFactoryContainerCreateState();

  return (
    <div className={`mx-auto max-w-2xl space-y-6 ${FACTORY_MOBILE_ACTION_BAR_CLEARANCE} sm:p-6`}>
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/factory/containers")} data-testid="button-back">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <PageHeader title="Add Factory Container" subtitle="Track a new incoming factory container" />
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Basic</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>
              Container Number <span className="text-destructive">*</span>
            </Label>
            <Input
              value={formData.containerNumber}
              onChange={(e) => setFormData({ ...formData, containerNumber: e.target.value })}
              placeholder="e.g., CNTR-2024-001"
              data-testid="input-container-number"
            />
          </div>
          <div>
            <Label>
              Notes <span className="text-muted-foreground text-xs font-normal">(optional)</span>
            </Label>
            <Input
              value={formData.notes}
              onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
              placeholder="Additional notes"
              data-testid="input-container-notes"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Supplier</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Purchase Supplier — always shown first */}
          <div>
            <Label>Purchase Supplier</Label>
            <Select
              value={formData.supplierId || "__none__"}
              onValueChange={(val) => setFormData({ ...formData, supplierId: val === "__none__" ? "" : val })}
            >
              <SelectTrigger data-testid="select-container-supplier">
                <SelectValue placeholder="Select supplier..." />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">None</SelectItem>
                {filteredSupplierList.map((s) => (
                  <SelectItem key={s.id} value={s.id.toString()}>
                    {s.name}
                    {s.parentId ? " (linked)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Only show broker row when the selected supplier is linked to one */}
          {linkedBroker && (
            <div className="rounded-md bg-muted/50 px-3 py-2 text-sm flex items-center gap-2">
              <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
              <span className="text-muted-foreground">
                Linked Broker: <span className="font-medium text-foreground">{linkedBroker.name}</span>
              </span>
            </div>
          )}
        </CardContent>
      </Card>

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

      <FactoryContainerCreateCardSection
        currency={currency}
        formData={formData}
        ledgerAccounts={ledgerAccounts}
        otherChargeLines={otherChargeLines}
        removeOtherChargeLine={removeOtherChargeLine}
        setFormData={setFormData}
        setOtherChargeLines={setOtherChargeLines}
        updateOtherChargeLine={updateOtherChargeLine}
      />

      {/* ── Grand Total Summary Bar ───────────────────────────────────────────── */}
      {(() => {
        const totals: Record<string, number> = {};
        const add = (cc: string, amt: string) => {
          const v = parseFloat(amt || "0");
          if (v > 0) totals[cc] = (totals[cc] || 0) + v;
        };
        // Container purchase value
        const kg = parseFloat(totalKg || "0");
        const rate = parseFloat(ratePerKg || "0");
        if (kg > 0 && rate > 0) totals[currency] = (totals[currency] || 0) + kg * rate;
        // Freight
        add(formData.freightCurrencyCode || currency, formData.freight);
        // Commission
        add(formData.commissionCurrencyCode || currency, formData.commissionAmount);
        // Other charges
        for (const l of otherChargeLines) add(l.currencyCode || currency, l.amount);

        const entries = Object.entries(totals).sort(([a], [b]) =>
          a === currency ? -1 : b === currency ? 1 : a.localeCompare(b)
        );
        if (entries.length === 0) return null;
        return (
          <div className="rounded-md border bg-muted/30 px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-2">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Container Total</span>
            {entries.map(([cc, amt]) => (
              <div key={cc} className="flex items-baseline gap-1">
                <span className="text-xs text-muted-foreground">{cc}</span>
                <span className="text-lg font-bold tabular-nums">{formatNumber(amt)}</span>
              </div>
            ))}
          </div>
        );
      })()}

      {/* Phones pin Cancel / Create above the home indicator; sm+ keeps the right-aligned row. */}
      <FactoryMobileActionBar className="sm:gap-3 sm:pb-6" data-testid="container-create-actions">
        <Button variant="outline" onClick={() => navigate("/factory/containers")} data-testid="button-cancel">
          Cancel
        </Button>
        <Button
          onClick={() => createMutation.mutate()}
          disabled={!canSubmit || isCreateOnly}
          title={isCreateOnly ? "Your role cannot create factory containers." : undefined}
          data-testid="button-create-container"
        >
          {createMutation.isPending ? "Creating..." : "Create Container"}
        </Button>
      </FactoryMobileActionBar>
    </div>
  );
}
