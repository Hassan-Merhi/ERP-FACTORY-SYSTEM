import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ArrowLeft, Plus, Trash2, Info, Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { PageHeader } from "@/components/PageHeader";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { useLocation } from "wouter";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";
import { factoryApiRequest } from "@/lib/factoryApi";
import { formatNumber } from "@/lib/formatNumber";
import type { FactorySupplier } from "@shared/schema";
import type { AuthMe, FactoryMyAccess, ApiListRow } from "@shared/apiTypes";

type OtherChargeLine = { amount: string; currencyCode: string; ledgerAccountId: string };

export default function FactoryContainerCreate() {
  const [, navigate] = useLocation();
  useEscapeToParent("/factory/containers");
  const { toast } = useToast();

  const [formData, setFormData] = useState({
    containerNumber: "",
    supplierId: "",
    notes: "",
    commissionAmount: "",
    commissionCurrencyCode: "USD",
    commissionSupplierId: "",
    commissionNotes: "",
    freight: "",
    freightAccountId: "",
    freightCurrencyCode: "USD",
  });

  const [currency, setCurrency] = useState("USD");
  const [totalKg, setTotalKg] = useState("");
  const [ratePerKg, setRatePerKg] = useState("");
  const [otherChargeLines, setOtherChargeLines] = useState<OtherChargeLine[]>([]);
  const [fxRate, setFxRate] = useState("1");
  const [fxRateLoading, setFxRateLoading] = useState(false);
  // Commission-specific FX — kept independent so a EUR commission on an AUD container
  // uses EUR/USD (1.18), not the container's AUD/USD rate (0.67).
  const [commissionFxRate, setCommissionFxRate] = useState("1");
  const [commissionFxRateLoading, setCommissionFxRateLoading] = useState(false);
  const [commissionFxRateDate, setCommissionFxRateDate] = useState<string | null>(null);

  // Auto-fetch the live USD exchange rate whenever a non-USD currency is selected.
  // Without this, fxRateToUsd was previously hardcoded to "1" for every currency,
  // which meant EUR (or any other) amounts were treated as if they were already USD —
  // e.g. a €11,035 container plus a $1,000 USD commission would be added as
  // 11,035 + 1,000 = 12,035 instead of converting the EUR portion to USD first.
  useEffect(() => {
    if (currency === "USD") {
      setFxRate("1");
      return;
    }
    setFxRateLoading(true);
    factoryApiRequest("GET", `/api/factory/fx-rates/latest/${currency}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.rate) setFxRate(String(data.rate));
      })
      .catch(() => {})
      .finally(() => setFxRateLoading(false));
  }, [currency]);

  const updateOtherChargeLine = (idx: number, field: keyof OtherChargeLine, value: string) => {
    setOtherChargeLines((prev) => prev.map((l, i) => (i === idx ? { ...l, [field]: value } : l)));
  };
  const removeOtherChargeLine = (idx: number) => {
    setOtherChargeLines((prev) => prev.filter((_, i) => i !== idx));
  };

  useEffect(() => {
    setFormData((f) => ({ ...f, commissionCurrencyCode: currency, freightCurrencyCode: currency }));
  }, [currency]);

  // Auto-fetch commission FX whenever the commission currency changes.
  // Must stay independent from the container FX so that, e.g., a EUR commission
  // on an AUD container gets 1 EUR = 1.18 USD, not 1 AUD = 0.67 USD.
  useEffect(() => {
    const commCcy = (formData.commissionCurrencyCode || currency).toUpperCase();
    const containerCcy = currency.toUpperCase();
    if (commCcy === "USD") {
      setCommissionFxRate("1");
      setCommissionFxRateDate(null);
      return;
    }
    if (commCcy === containerCcy) {
      // Same currency as container — reuse the container's already-fetched FX rate
      setCommissionFxRate(fxRate);
      setCommissionFxRateDate(null);
      return;
    }
    // Different non-USD currency: fetch independently
    setCommissionFxRateLoading(true);
    factoryApiRequest("GET", `/api/factory/fx-rates/latest/${commCcy}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.rate) {
          setCommissionFxRate(String(data.rate));
          setCommissionFxRateDate(data.date ?? null);
        } else {
          setCommissionFxRate("");
        }
      })
      .catch(() => setCommissionFxRate(""))
      .finally(() => setCommissionFxRateLoading(false));
  }, [formData.commissionCurrencyCode, currency, fxRate]);

  const { data: suppliers } = useQuery<FactorySupplier[]>({
    queryKey: ["/api/factory/suppliers"],
  });

  const { data: ledgerAccounts = [] } = useQuery<ApiListRow[]>({
    queryKey: ["/api/ledger-accounts?includeHidden=true"],
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const activeSuppliers = suppliers?.filter((s) => s.isActive) ?? [];

  const selectedSupplier = formData.supplierId
    ? (activeSuppliers.find((s) => s.id === parseInt(formData.supplierId)) ?? null)
    : null;

  // Auto-derive broker from supplier's parentId (true broker balance model)
  const linkedBroker = selectedSupplier?.parentId
    ? (activeSuppliers.find((s) => s.id === selectedSupplier.parentId) ?? null)
    : null;

  // When supplier changes: if it has a linked broker, auto-set commissionSupplierId
  useEffect(() => {
    if (selectedSupplier?.parentId) {
      setFormData((f) => ({ ...f, commissionSupplierId: String(selectedSupplier.parentId) }));
    }
    // If supplier has no parent, clear any previously auto-set broker only if it was auto-derived
    // (we leave manually-chosen broker intact when supplier has no parent)
  }, [selectedSupplier?.id, selectedSupplier?.parentId]);

  // Show all active suppliers in the dropdown
  const filteredSupplierList = activeSuppliers;

  const createMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        containerNumber: formData.containerNumber,
        supplierId: formData.supplierId ? parseInt(formData.supplierId) : null,
        notes: formData.notes || null,
        status: "PENDING",
        currencyCode: currency,
        fxRateToUsd: currency === "USD" ? "1" : fxRate,
        fxRateSource: "auto",
        totalKg: totalKg || null,
        ratePerKg: ratePerKg || null,
        commissionAmount: formData.commissionAmount || "0",
        commissionCurrencyCode: formData.commissionCurrencyCode || currency,
        commissionSupplierId: formData.commissionSupplierId ? parseInt(formData.commissionSupplierId) : null,
        commissionNotes: formData.commissionNotes || null,
        freight: formData.freight || "0",
        freightCurrencyCode: formData.freightCurrencyCode || currency,
        freightAccountId: formData.freightAccountId ? parseInt(formData.freightAccountId) : null,
        otherCharges: "0",
        otherChargesAccountId: null,
      };
      const res = await factoryApiRequest("POST", "/api/factory/containers", payload);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to create container");
      }
      const container = await res.json();
      const validLines = otherChargeLines.filter((l) => parseFloat(l.amount || "0") > 0);
      if (validLines.length > 0) {
        await factoryApiRequest("POST", `/api/factory/containers/${container.id}/other-charges/sync`, {
          charges: validLines.map((l) => ({
            description: "Other Charge",
            amount: l.amount,
            currencyCode: l.currencyCode || currency,
            ledgerAccountId: l.ledgerAccountId ? parseInt(l.ledgerAccountId) : null,
          })),
        });
      }
      return container;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/containers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });
      const hasCommission = parseFloat(formData.commissionAmount || "0") > 0;
      toast({
        title: "Container created",
        description: hasCommission
          ? "Container created and commission account set up automatically."
          : "Container created successfully.",
      });
      navigate("/factory/containers");
    },
    onError: (err: Error) => {
      if (err?._handledGlobally) return;
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const commissionCcy = (formData.commissionCurrencyCode || currency).toUpperCase();
  const commissionAmt2 = parseFloat(formData.commissionAmount || "0");
  const commissionFxUnresolved =
    commissionAmt2 > 0 &&
    commissionCcy !== "USD" &&
    commissionCcy !== currency.toUpperCase() &&
    (commissionFxRateLoading || !(parseFloat(commissionFxRate) > 0));

  const canSubmit =
    !!formData.containerNumber &&
    !createMutation.isPending &&
    !(currency !== "USD" && (fxRateLoading || !(parseFloat(fxRate) > 0))) &&
    !commissionFxUnresolved;

  return (
    <div className="max-w-2xl mx-auto p-4 sm:p-6 space-y-6">
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
              <Building2 className="h-4 w-4 text-muted-foreground flex-shrink-0" />
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
          <div className="grid grid-cols-2 gap-3">
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

          <div className="grid grid-cols-2 gap-3">
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

          <div className="grid grid-cols-2 gap-3">
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

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Freight &amp; Other Charges</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
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
            <Select
              value={formData.freightAccountId || "__none__"}
              onValueChange={(val) => setFormData({ ...formData, freightAccountId: val === "__none__" ? "" : val })}
            >
              <SelectTrigger data-testid="select-freight-account">
                <SelectValue placeholder="Auto (Freight)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Auto (Freight)</SelectItem>
                {ledgerAccounts.map((acc) => (
                  <SelectItem key={acc.id} value={String(acc.id)}>
                    {acc.name}
                    {acc.code ? ` (${acc.code})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
              <div className="grid grid-cols-[1fr_auto_2fr_auto] gap-x-2 gap-y-1 items-center">
                <div className="text-xs text-muted-foreground font-medium">Amount</div>
                <div className="text-xs text-muted-foreground font-medium">CCY</div>
                <div className="text-xs text-muted-foreground font-medium">Account</div>
                <div />
                {otherChargeLines.map((line, idx) => (
                  <>
                    <Input
                      key={`amt-${idx}`}
                      type="number"
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
                      <SelectTrigger className="w-20" data-testid={`select-other-charge-currency-${idx}`}>
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
                    <Select
                      key={`acc-${idx}`}
                      value={line.ledgerAccountId || "__none__"}
                      onValueChange={(val) =>
                        updateOtherChargeLine(idx, "ledgerAccountId", val === "__none__" ? "" : val)
                      }
                    >
                      <SelectTrigger data-testid={`select-other-charge-account-${idx}`}>
                        <SelectValue placeholder="No account" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">No account</SelectItem>
                        {ledgerAccounts.map((acc) => (
                          <SelectItem key={acc.id} value={String(acc.id)}>
                            {acc.name}
                            {acc.code ? ` (${acc.code})` : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      key={`del-${idx}`}
                      type="button"
                      size="icon"
                      variant="ghost"
                      onClick={() => removeOtherChargeLine(idx)}
                      data-testid={`button-remove-other-charge-${idx}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

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

      <div className="flex justify-end gap-3 pb-6">
        <Button variant="outline" onClick={() => navigate("/factory/containers")} data-testid="button-cancel">
          Cancel
        </Button>
        <Button onClick={() => createMutation.mutate()} disabled={!canSubmit} data-testid="button-create-container">
          {createMutation.isPending ? "Creating..." : "Create Container"}
        </Button>
      </div>
    </div>
  );
}
