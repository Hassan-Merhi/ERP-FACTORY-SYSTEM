import { ArrowLeft, Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FACTORY_MOBILE_ACTION_BAR_CLEARANCE, FactoryMobileActionBar } from "@/components/ui/factory-mobile";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/PageHeader";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatNumber } from "@/lib/formatNumber";
import { useFactoryContainerCreateState } from "./useFactoryContainerCreateState";
import { FactoryContainerCreateCardSection } from "./FactoryContainerCreateCardSection";
import { FactoryContainerCreateCard } from "./FactoryContainerCreateCard";

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

      <FactoryContainerCreateCard
        commissionAmt2={commissionAmt2}
        commissionCcy={commissionCcy}
        commissionFxRate={commissionFxRate}
        commissionFxRateDate={commissionFxRateDate}
        commissionFxRateLoading={commissionFxRateLoading}
        currency={currency}
        formData={formData}
        fxRate={fxRate}
        fxRateLoading={fxRateLoading}
        linkedBroker={linkedBroker}
        ratePerKg={ratePerKg}
        setCurrency={setCurrency}
        setFormData={setFormData}
        setRatePerKg={setRatePerKg}
        setTotalKg={setTotalKg}
        totalKg={totalKg}
      />

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
