import { UnifiedAccountPicker } from "@/components/accounts/UnifiedAccountPicker";
// Extracted from ./ContainerFormBody.tsx
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatNumber } from "@/lib/formatNumber";
import type { OtherChargeLine, ContainerFormBodyProps } from "./ContainerFormBody";

export function ContainerFormCharges({
  updateOtherChargeLine,
  formData,
  setFormData,
  ledgerAccounts,
  activeSuppliers,
  setOtherChargeLines,
  currency,
  otherChargeLines,
}: {
  updateOtherChargeLine: (idx: number, field: keyof OtherChargeLine, value: string) => void;
  formData: ContainerFormBodyProps["formData"];
  setFormData: ContainerFormBodyProps["setFormData"];
  ledgerAccounts: ContainerFormBodyProps["ledgerAccounts"];
  activeSuppliers: ContainerFormBodyProps["activeSuppliers"];
  setOtherChargeLines: ContainerFormBodyProps["setOtherChargeLines"];
  currency: ContainerFormBodyProps["currency"];
  otherChargeLines: ContainerFormBodyProps["otherChargeLines"];
}) {
  return (
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
          <UnifiedAccountPicker
 options={ledgerAccounts.map((account) => ({ value: String(account.id), name: account.name }))}
 value={formData.freightAccountId || ""}
 onChange={(val) => setFormData((f) => ({ ...f, freightAccountId: val }))}
 placeholder={"None"}
 testId={"select-freight-account"}
 allowClear
 />
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
          {formData.freightPaidBy === "supplier" && (
            <div>
              <Label>Freight Supplier (required)</Label>
              <Select
                value={formData.freightSupplierId || "__none__"}
                onValueChange={(value) =>
                  setFormData((current) => ({
                    ...current,
                    freightSupplierId: value === "__none__" ? "" : value,
                  }))
                }
              >
                <SelectTrigger data-testid="select-container-freight-supplier">
                  <SelectValue placeholder="Select freight supplier..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Select freight supplier...</SelectItem>
                  {activeSuppliers.map((supplier) => (
                    <SelectItem key={supplier.id} value={String(supplier.id)}>
                      {supplier.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">
                Freight can be payable to a different supplier than the goods purchase.
              </p>
            </div>
          )}
          {formData.freightPaidBy === "own" && (
            <div>
              <Label>
                Credit Account{" "}
                <span className="text-xs text-muted-foreground font-normal">(account that paid the freight)</span>
              </Label>
              <UnifiedAccountPicker
 options={ledgerAccounts.map((account) => ({ value: String(account.id), name: account.name }))}
 value={formData.freightOwnAccountId || ""}
 onChange={(val) => setFormData((f) => ({ ...f, freightOwnAccountId: val }))}
 placeholder={"Select account..."}
 testId={"select-freight-own-account"}
 allowClear
 />
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
                <UnifiedAccountPicker
 key={`acc-${idx}`}
 options={ledgerAccounts.map((account) => ({ value: String(account.id), name: account.name }))}
 value={line.ledgerAccountId || ""}
 onChange={(val) => updateOtherChargeLine(idx, "ledgerAccountId", val)}
 placeholder={"No account"}
 testId={`select-other-charge-account-${idx}`}
 allowClear
 />
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
  );
}
