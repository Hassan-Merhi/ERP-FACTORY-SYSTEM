import { AlertTriangle, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatNumber } from "@/lib/formatNumber";
import type { FactorySupplier } from "@shared/schema";
import type { ApiListRow } from "@shared/apiTypes";

type FormData = {
  containerNumber: string;
  supplierId: string;
  origin: string;
  totalKg: string;
  ratePerKg: string;
  arrivalDate: string;
  notes: string;
  status: string;
  commissionAmount: string;
  commissionCurrencyCode: string;
  commissionAccountId: string;
  commissionSupplierId: string;
  commissionNotes: string;
  freight: string;
  freightCurrencyCode: string;
  freightAccountId: string;
  freightPaidBy: "supplier" | "own";
  freightOwnAccountId: string;
  otherCharges: string;
  otherChargesAccountId: string;
};

type OtherChargeLine = { amount: string; currencyCode: string; ledgerAccountId: string; narration: string };

interface ContainerFormBodyProps {
  formData: FormData;
  setFormData: React.Dispatch<React.SetStateAction<FormData>>;
  currency: string;
  setCurrency: (v: string) => void;
  fxRate: string;
  setFxRate: (v: string) => void;
  fxRateSource: "auto" | "manual";
  setFxRateSource: (v: "auto" | "manual") => void;
  fxEffectiveDate: string;
  otherChargeLines: OtherChargeLine[];
  setOtherChargeLines: React.Dispatch<React.SetStateAction<OtherChargeLine[]>>;
  activeSuppliers: FactorySupplier[];
  filteredSupplierList: FactorySupplier[];
  selectedSupplier: FactorySupplier | null;
  brokerMismatch: boolean | null | undefined;
  ledgerAccounts: ApiListRow[];
}

export function ContainerFormBody({
  formData,
  setFormData,
  currency,
  setCurrency,
  fxRate,
  setFxRate,
  fxRateSource,
  setFxRateSource,
  fxEffectiveDate,
  otherChargeLines,
  setOtherChargeLines,
  activeSuppliers,
  filteredSupplierList,
  selectedSupplier,
  brokerMismatch,
  ledgerAccounts,
}: ContainerFormBodyProps) {
  const updateOtherChargeLine = (idx: number, field: keyof OtherChargeLine, value: string) =>
    setOtherChargeLines((prev) => prev.map((l, i) => (i === idx ? { ...l, [field]: value } : l)));

  return (
    <div className="max-h-[62vh] overflow-y-auto space-y-6 pr-1">
      {/* ── Section 1: Basic ───────────────────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold">Basic</p>
          <Separator className="flex-1" />
        </div>
        <div>
          <Label>Container Number *</Label>
          <Input
            value={formData.containerNumber}
            onChange={(e) => setFormData((f) => ({ ...f, containerNumber: e.target.value }))}
            placeholder="e.g., CNTR-2024-001"
            data-testid="input-container-number"
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label>Arrival Date</Label>
            <Input
              type="date"
              value={formData.arrivalDate}
              onChange={(e) => setFormData((f) => ({ ...f, arrivalDate: e.target.value }))}
              data-testid="input-container-arrival"
            />
          </div>
          <div>
            <Label>Status</Label>
            <Select value={formData.status} onValueChange={(val) => setFormData((f) => ({ ...f, status: val }))}>
              <SelectTrigger data-testid="select-container-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="PENDING">Pending</SelectItem>
                <SelectItem value="IN_TRANSIT">In Transit</SelectItem>
                <SelectItem value="AVAILABLE">Available</SelectItem>
                <SelectItem value="OFFLOADED">Offloaded</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {/* ── Section 2: Supplier & Broker ───────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold">Supplier &amp; Broker</p>
          <Separator className="flex-1" />
        </div>
        <div>
          <Label>
            Broker / Commission To <span className="text-muted-foreground text-xs font-normal">(optional)</span>
          </Label>
          <Select
            value={formData.commissionSupplierId || "__none__"}
            onValueChange={(val) => {
              const newBroker = val === "__none__" ? "" : val;
              setFormData((f) => ({
                ...f,
                commissionSupplierId: newBroker,
                supplierId: (() => {
                  if (!newBroker || !f.supplierId) return f.supplierId;
                  const sup = activeSuppliers.find((s) => s.id === parseInt(f.supplierId));
                  if (sup?.parentId && sup.parentId !== parseInt(newBroker)) return "";
                  return f.supplierId;
                })(),
              }));
            }}
          >
            <SelectTrigger data-testid="select-container-broker">
              <SelectValue placeholder="Select broker..." />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">None</SelectItem>
              {activeSuppliers.map((s) => (
                <SelectItem key={s.id} value={s.id.toString()}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Purchase Supplier</Label>
          <Select
            value={formData.supplierId || "__none__"}
            onValueChange={(val) => setFormData((f) => ({ ...f, supplierId: val === "__none__" ? "" : val }))}
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
          {formData.commissionSupplierId && (
            <p className="text-xs text-muted-foreground mt-1">
              Showing suppliers linked to broker + standalone suppliers
            </p>
          )}
        </div>
        {selectedSupplier?.parentId && !brokerMismatch && formData.commissionSupplierId && (
          <div className="rounded-md bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
            Linked to Broker:{" "}
            <span className="font-medium text-foreground">
              {activeSuppliers.find((s) => s.id === selectedSupplier.parentId)?.name ?? `#${selectedSupplier.parentId}`}
            </span>
          </div>
        )}
        {brokerMismatch && (
          <div className="rounded-md border border-yellow-400/60 bg-yellow-50 dark:bg-yellow-950/30 px-3 py-2 text-sm text-yellow-800 dark:text-yellow-300 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>
              This supplier belongs to{" "}
              <strong>
                {activeSuppliers.find((s) => s.id === selectedSupplier?.parentId)?.name ??
                  `Broker #${selectedSupplier?.parentId}`}
              </strong>
              , not the selected broker.
            </span>
          </div>
        )}
      </div>

      {/* ── Section 3: Money & Commission ──────────────────────────────── */}
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
          <Select
            value={formData.commissionAccountId || "__none__"}
            onValueChange={(val) => setFormData((f) => ({ ...f, commissionAccountId: val === "__none__" ? "" : val }))}
          >
            <SelectTrigger data-testid="select-commission-account">
              <SelectValue placeholder="None (leave empty)" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">None</SelectItem>
              {ledgerAccounts.map((acc) => (
                <SelectItem key={acc.id} value={String(acc.id)}>
                  {acc.name}
                  {acc.code ? ` (${acc.code})` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground mt-1">
            Commission flows into the broker's balance automatically via the "Broker / Commission To" field above.
          </p>
        </div>
      </div>

      {/* ── Section 4: Freight & Other Charges ─────────────────────────── */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold">Freight &amp; Other Charges</p>
          <Separator className="flex-1" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-[1fr_0.85fr_1.25fr] gap-3 items-end">
          <div>
            <Label className="whitespace-nowrap">
              Freight Amount <span className="text-muted-foreground text-xs font-normal">(optional)</span>
            </Label>
            <Input
              type="number"
              value={formData.freight}
              onChange={(e) => setFormData((f) => ({ ...f, freight: e.target.value }))}
              placeholder="0.00"
              data-testid="input-container-freight"
            />
          </div>
          <div>
            <Label className="whitespace-nowrap">Freight Currency</Label>
            <Select
              value={formData.freightCurrencyCode}
              onValueChange={(val) => setFormData((f) => ({ ...f, freightCurrencyCode: val }))}
            >
              <SelectTrigger data-testid="select-freight-currency">
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
          <div>
            <Label className="whitespace-nowrap">
              Freight Expense Account <span className="text-muted-foreground text-xs font-normal">(optional)</span>
            </Label>
            <Select
              value={formData.freightAccountId || "__none__"}
              onValueChange={(val) => setFormData((f) => ({ ...f, freightAccountId: val === "__none__" ? "" : val }))}
            >
              <SelectTrigger data-testid="select-freight-account">
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">None</SelectItem>
                {ledgerAccounts.map((acc) => (
                  <SelectItem key={acc.id} value={String(acc.id)}>
                    {acc.name}
                    {acc.code ? ` (${acc.code})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {parseFloat(formData.freight || "0") > 0 && (
          <div className="space-y-2">
            <Label>Freight Paid By</Label>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant={formData.freightPaidBy === "supplier" ? "default" : "outline"}
                onClick={() => setFormData((f) => ({ ...f, freightPaidBy: "supplier", freightOwnAccountId: "" }))}
                data-testid="button-freight-by-supplier"
                className="flex-1"
              >
                By Supplier
              </Button>
              <Button
                type="button"
                size="sm"
                variant={formData.freightPaidBy === "own" ? "default" : "outline"}
                onClick={() => setFormData((f) => ({ ...f, freightPaidBy: "own" }))}
                data-testid="button-freight-by-own"
                className="flex-1"
              >
                Own Account
              </Button>
            </div>
            {formData.freightPaidBy === "own" && (
              <div>
                <Label>
                  Credit Account{" "}
                  <span className="text-xs text-muted-foreground font-normal">(account that paid the freight)</span>
                </Label>
                <Select
                  value={formData.freightOwnAccountId || "__none__"}
                  onValueChange={(val) =>
                    setFormData((f) => ({ ...f, freightOwnAccountId: val === "__none__" ? "" : val }))
                  }
                >
                  <SelectTrigger data-testid="select-freight-own-account">
                    <SelectValue placeholder="Select account..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Select account...</SelectItem>
                    {ledgerAccounts.map((acc) => (
                      <SelectItem key={acc.id} value={String(acc.id)}>
                        {acc.name}
                        {acc.code ? ` (${acc.code})` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {formData.freightPaidBy === "supplier" && (
              <p className="text-xs text-muted-foreground">Freight will be added to the supplier's payable balance.</p>
            )}
          </div>
        )}
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
                setOtherChargeLines((prev) => [
                  ...prev,
                  { amount: "", currencyCode: currency, ledgerAccountId: "", narration: "" },
                ])
              }
              data-testid="button-add-other-charge"
            >
              <Plus className="h-3 w-3 mr-1" /> Add Line
            </Button>
          </div>
          {otherChargeLines.length === 0 && (
            <p className="text-xs text-muted-foreground py-1">No other charges. Click "Add Line" to add one.</p>
          )}
          {otherChargeLines.length > 0 && (
            <div className="grid grid-cols-[1fr_auto_2fr_2fr_auto] gap-x-2 gap-y-1 items-center">
              <div className="text-xs text-muted-foreground font-medium">Amount</div>
              <div className="text-xs text-muted-foreground font-medium">CCY</div>
              <div className="text-xs text-muted-foreground font-medium">Account</div>
              <div className="text-xs text-muted-foreground font-medium">Narration</div>
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
                      {["USD", "EUR", "AUD", "LBP", "GBP"].map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
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
                  <Input
                    key={`nar-${idx}`}
                    value={line.narration}
                    onChange={(e) => updateOtherChargeLine(idx, "narration", e.target.value)}
                    placeholder="Narration (optional)"
                    data-testid={`input-other-charge-narration-${idx}`}
                  />
                  <Button
                    key={`del-${idx}`}
                    type="button"
                    size="icon"
                    variant="ghost"
                    onClick={() => setOtherChargeLines((prev) => prev.filter((_, i) => i !== idx))}
                    data-testid={`button-remove-other-charge-${idx}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </>
              ))}
            </div>
          )}
          {otherChargeLines.length > 0 && (
            <div className="text-xs text-muted-foreground text-right pt-1 space-y-0.5">
              {(() => {
                const totals: Record<string, number> = {};
                for (const l of otherChargeLines) {
                  const cc = l.currencyCode || currency;
                  const v = parseFloat(l.amount || "0");
                  if (v > 0) totals[cc] = (totals[cc] || 0) + v;
                }
                return Object.entries(totals).map(([cc, amt]) => (
                  <div key={cc}>
                    Additional {cc} {formatNumber(amt)}
                  </div>
                ));
              })()}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
