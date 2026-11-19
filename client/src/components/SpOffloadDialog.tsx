import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Plus, Trash2, Loader2 } from "lucide-react";
import { formatUsd } from "@/lib/moneyDisplay";
import type { SpOffloadContainer } from "./spOffloadDialogTypes";
import { useSpOffloadDialogModel, deriveSpOffloadDialogView } from "./SpOffloadDialogModel";
import { SpOffloadDialogPostingPreview } from "./SpOffloadDialogPostingPreview";

export function fmt2(v: string | number | null | undefined) {
  const n = parseFloat(String(v ?? "0"));
  return isNaN(n) ? "$0.00" : formatUsd(n, 2);
}

const CHARGE_TYPES = [
  { value: "prepaid_used", label: "Prepaid Used" },
  { value: "paid_now", label: "Paid Now (Cash/Bank)" },
  { value: "unpaid_payable", label: "Unpaid Payable (Accrual)" },
  { value: "invoice_freight", label: "Invoice Freight (Cost Clearing)" },
  { value: "other", label: "Other (Any Account)" },
  { value: "parent_agent", label: "Agent via HADI L'SHI" },
];

export interface SpOffloadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  container: SpOffloadContainer | null;
  onSuccess?: () => void;
}

export function SpOffloadDialog({ open, onOpenChange, container, onSuccess }: SpOffloadDialogProps) {
  const sp = useSpOffloadDialogModel({ open, onOpenChange, container, onSuccess });

  if (!container) return null;
  const costs = deriveSpOffloadDialogView({ container, sp });

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!sp.offloadMutation.isPending) {
          onOpenChange(v);
        }
      }}
    >
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Offload Container</DialogTitle>
          <DialogDescription>
            {container.supplierName}
            {container.containerNumber ? ` · ${container.containerNumber}` : ""}
            {" · "}
            {container.invoiceNumber}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* Offload Location */}
          <div>
            <Label htmlFor="sp-offload-location">Offload Location</Label>
            <Select value={sp.selectedLocationId} onValueChange={sp.setSelectedLocationId}>
              <SelectTrigger id="sp-offload-location" className="mt-1" data-testid="select-sp-offload-location">
                <SelectValue placeholder="Select a location…" />
              </SelectTrigger>
              <SelectContent>
                {sp.locationsList.map((l) => (
                  <SelectItem key={l.id} value={String(l.id)}>
                    {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Offload Date */}
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <Label htmlFor="sp-offload-date">Offload Date</Label>
              <Input
                id="sp-offload-date"
                type="date"
                value={sp.offloadDate}
                onChange={(e) => sp.setOffloadDate(e.target.value)}
                className="mt-1"
                data-testid="input-sp-offload-date"
              />
            </div>
            <div className="text-sm text-muted-foreground pt-5">
              {(container.lines || []).length} line{(container.lines || []).length !== 1 ? "s" : ""} ·{" "}
              {costs.totalQty.toLocaleString("en-US", { maximumFractionDigits: 2 })} units
            </div>
          </div>

          <Separator />

          {/* Landed Charges */}
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <p className="text-sm font-medium">Landed Charges</p>
                <p className="text-xs text-muted-foreground">Added to base cost to compute final unit cost</p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={costs.addCharge}
                data-testid="button-sp-add-charge"
              >
                <Plus className="h-3.5 w-3.5 mr-1" />
                Add Charge
              </Button>
            </div>

            {costs.invoiceCharges.length > 0 && (
              <div
                className="rounded-md border border-border bg-muted/30 p-3 space-y-1"
                data-testid="sp-invoice-charges"
              >
                <p className="text-xs font-medium text-muted-foreground">
                  {sp.freshStartOtw
                    ? "Already included in Goods OTW — allocated into stock cost once on offload"
                    : "From the container invoice — added automatically (Cr Cost Clearing)"}
                </p>
                {costs.invoiceCharges.map((c) => (
                  <div key={c.kind} className="flex items-center justify-between text-xs">
                    <span>{c.description}</span>
                    <span className="tabular-nums font-medium">{fmt2(c.amountUsd)}</span>
                  </div>
                ))}
              </div>
            )}

            {sp.chargeLines.length === 0 && costs.invoiceCharges.length === 0 && (
              <p className="text-sm text-muted-foreground py-2">
                No charges — all stock cost will equal the discounted base cost.
              </p>
            )}

            {sp.chargeLines.map((charge, idx) => (
              <div
                key={idx}
                className="grid grid-cols-12 gap-2 items-start p-3 border border-border rounded-md bg-muted/20"
              >
                {/* Charge type */}
                <div className="col-span-4">
                  <Label className="text-xs">Type</Label>
                  <Select value={charge.chargeType} onValueChange={(v) => costs.updateCharge(idx, "chargeType", v)}>
                    <SelectTrigger className="h-8 text-xs mt-1" data-testid={`select-sp-charge-type-${idx}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CHARGE_TYPES.filter((t) => !sp.freshStartOtw || t.value === "paid_now").map((t) => (
                        <SelectItem key={t.value} value={t.value}>
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Description */}
                <div className="col-span-3">
                  <Label className="text-xs">Description</Label>
                  <Input
                    value={charge.description}
                    onChange={(e) => costs.updateCharge(idx, "description", e.target.value)}
                    placeholder="e.g., Port fees"
                    className="h-8 text-xs mt-1"
                    data-testid={`input-sp-charge-desc-${idx}`}
                  />
                </div>

                {/* Amount */}
                <div className="col-span-2">
                  <Label className="text-xs">Amount (USD)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    value={charge.amountUsd}
                    onChange={(e) => costs.updateCharge(idx, "amountUsd", e.target.value)}
                    placeholder="0.00"
                    className="h-8 text-xs mt-1"
                    data-testid={`input-sp-charge-amount-${idx}`}
                  />
                </div>

                {/* Credit account picker — varies by type */}
                <div className="col-span-2">
                  <Label className="text-xs">{charge.chargeType === "parent_agent" ? "Agent" : "Credit Account"}</Label>
                  <div className="mt-1">
                    {charge.chargeType === "prepaid_used" ? (
                      <Select
                        value={charge.prepaidChargeId}
                        onValueChange={(v) => costs.updateCharge(idx, "prepaidChargeId", v)}
                      >
                        <SelectTrigger className="h-8 text-xs" data-testid={`select-sp-charge-prepaid-${idx}`}>
                          <SelectValue placeholder="Select prepaid" />
                        </SelectTrigger>
                        <SelectContent>
                          {(container.prepaid || []).map((p) => (
                            <SelectItem key={p.id} value={String(p.id)}>
                              {p.chargeType} — {fmt2(p.amountPaidUsd)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : charge.chargeType === "paid_now" ? (
                      <Select
                        value={charge.creditBankAccountId}
                        onValueChange={(v) => costs.updateCharge(idx, "creditBankAccountId", v)}
                      >
                        <SelectTrigger className="h-8 text-xs" data-testid={`select-sp-charge-bank-${idx}`}>
                          <SelectValue placeholder="Select bank" />
                        </SelectTrigger>
                        <SelectContent>
                          {(sp.statusData?.bankAccounts || []).map((b) => (
                            <SelectItem key={b.id} value={String(b.id)}>
                              {b.bankName}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : charge.chargeType === "unpaid_payable" || charge.chargeType === "other" ? (
                      <Select
                        value={charge.creditLedgerAccountId}
                        onValueChange={(v) => costs.updateCharge(idx, "creditLedgerAccountId", v)}
                      >
                        <SelectTrigger className="h-8 text-xs" data-testid={`select-sp-charge-ledger-${idx}`}>
                          <SelectValue placeholder="Select account" />
                        </SelectTrigger>
                        <SelectContent>
                          {sp.ledgerAccounts.map((a) => (
                            <SelectItem key={a.id} value={String(a.id)}>
                              {a.code} — {a.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : charge.chargeType === "parent_agent" ? (
                      <Select
                        value={charge.parentAgentAccountId}
                        onValueChange={(v) => costs.updateCharge(idx, "parentAgentAccountId", v)}
                      >
                        <SelectTrigger className="h-8 text-xs" data-testid={`select-sp-charge-agent-${idx}`}>
                          <SelectValue placeholder="Select agent" />
                        </SelectTrigger>
                        <SelectContent>
                          {sp.parentAgents.map((a) => (
                            <SelectItem key={a.ledger_account_id} value={String(a.ledger_account_id)}>
                              {a.account_name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <div className="h-8 flex items-center px-1">
                        <Badge variant="secondary" className="text-xs">
                          Auto → Cost Clearing
                        </Badge>
                      </div>
                    )}
                  </div>
                </div>

                {/* Remove */}
                <div className="col-span-1 flex items-end justify-end pb-0.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => costs.removeCharge(idx)}
                    data-testid={`button-sp-remove-charge-${idx}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>

          {/* Cost Summary */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 rounded-md border border-border bg-muted/20 p-3">
            <div>
              <p className="text-xs text-muted-foreground">Base Cost</p>
              <p className="font-semibold text-sm">{fmt2(costs.totalBaseCost)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Landed Charges</p>
              <p className="font-semibold text-sm">{fmt2(costs.totalLandedCost)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Final Stock Cost</p>
              <p className="font-semibold text-sm">{fmt2(costs.totalFinalCost)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">OTW Reversal</p>
              <p className="font-semibold text-sm">{fmt2(costs.invoiceTotal)}</p>
            </div>
          </div>

          <Separator />

          <SpOffloadDialogPostingPreview sp={sp} costs={costs} container={container} />

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={sp.offloadMutation.isPending}
            >
              Cancel
            </Button>
            {sp.recordChanges.allowed && (
              <Button
                type="button"
                onClick={() => sp.offloadMutation.mutate()}
                disabled={sp.offloadMutation.isPending}
                data-testid="button-sp-confirm-offload"
              >
                {sp.offloadMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Confirm Offload
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
