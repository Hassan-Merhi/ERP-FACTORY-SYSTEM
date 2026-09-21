import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Plus, Trash2, FileText, TrendingDown, TrendingUp, Loader2, Building2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { apiRequest } from "@/lib/queryClient";

function fmt2(v: string | number | null | undefined) {
  const n = parseFloat(String(v ?? "0"));
  return isNaN(n) ? "$0.00" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const CHARGE_TYPES = [
  { value: "prepaid_used", label: "Prepaid Used" },
  { value: "paid_now", label: "Paid Now (Cash/Bank)" },
  { value: "unpaid_payable", label: "Unpaid Payable (Accrual)" },
  { value: "invoice_freight", label: "Invoice Freight (Cost Clearing)" },
  { value: "other", label: "Other (Any Account)" },
  { value: "parent_agent", label: "Agent via HADI L'SHI" },
];

interface ChargeLine {
  chargeType: string;
  description: string;
  amountUsd: string;
  prepaidChargeId: string;
  creditBankAccountId: string;
  creditLedgerAccountId: string;
  parentAgentAccountId: string;
}

interface SpContainerLine {
  qty?: string | number | null;
  unitRateUsd?: string | number | null;
}

interface SpPrepaidCharge {
  id: string | number;
  chargeType: string;
  amountPaidUsd: string | number;
}

interface SpOffloadContainer {
  id: number;
  supplierName?: string | null;
  containerNumber?: string | null;
  invoiceNumber?: string | null;
  discountPct?: string | number | null;
  invoiceTotalUsd?: string | number | null;
  lines?: SpContainerLine[];
  prepaid?: SpPrepaidCharge[];
}

interface SpSetupAccount {
  id: string | number;
  subType: string;
  name?: string | null;
}

interface SpBankAccount {
  id: string | number;
  bankName: string;
}

interface SpSetupStatus {
  spAccounts?: SpSetupAccount[];
  bankAccounts?: SpBankAccount[];
}

interface SpLedgerAccount {
  id: string | number;
  code?: string | null;
  name: string;
}

interface SpLocationOption {
  id: string | number;
  name: string;
}

interface ParentAgentOption {
  ledger_account_id: string | number;
  account_name: string;
}

interface SpOffloadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  container: SpOffloadContainer | null;
  onSuccess?: () => void;
}

export function SpOffloadDialog({ open, onOpenChange, container, onSuccess }: SpOffloadDialogProps) {
  const { toast } = useToast();
  const [offloadDate, setOffloadDate] = useState(new Date().toISOString().slice(0, 10));
  const [chargeLines, setChargeLines] = useState<ChargeLine[]>([]);
  const [selectedLocationId, setSelectedLocationId] = useState("");

  const { data: statusData } = useQuery<SpSetupStatus>({
    queryKey: ["/api/sp/setup/status"],
    enabled: open,
  });

  const { data: ledgerAccounts = [] } = useQuery<SpLedgerAccount[]>({
    queryKey: ["/api/ledger-accounts?profile=picker"],
    enabled: open,
  });

  const { data: locationsList = [] } = useQuery<SpLocationOption[]>({
    queryKey: ["/api/locations"],
    enabled: open,
  });

  const { data: parentAgents = [] } = useQuery<ParentAgentOption[]>({
    queryKey: ["/api/sp/parent-agents"],
    enabled: open,
  });

  // Declared above the `!container` guard below so the hook count stays constant.
  // `container` is a prop, so it can go from set to null (or back) while this
  // dialog is mounted; with the mutation declared after the guard that changed
  // how many hooks ran between renders, which React fails on. Nothing here reads
  // `container` during render — `mutationFn` only runs on mutate(), which is
  // unreachable while the guard is returning null.
  const offloadMutation = useMutation({
    mutationFn: () => {
      if (!container) return Promise.reject(new Error("No container selected"));
      if (!selectedLocationId) {
        toast({ title: "Select a location", variant: "destructive" });
        return Promise.reject(new Error("Select a location"));
      }
      return apiRequest("POST", "/api/sp/offload", {
        containerId: container.id,
        offloadDate,
        locationId: selectedLocationId,
        chargeLines: chargeLines.filter((c) => parseFloat(c.amountUsd || "0") > 0),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sp/containers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/sp/stock"] });
      toast({ title: "Offload recorded", description: "Goods OTW reversed and stock created." });
      onOpenChange(false);
      setChargeLines([]);
      setSelectedLocationId("");
      onSuccess?.();
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  if (!container) return null;

  const discountFactor = 1 - parseFloat(String(container.discountPct ?? "0")) / 100;
  const totalQty = (container.lines || []).reduce((s, l) => s + parseFloat(String(l.qty ?? "0")), 0);
  const totalBaseCost = (container.lines || []).reduce(
    (s, l) => s + parseFloat(String(l.qty ?? "0")) * parseFloat(String(l.unitRateUsd ?? "0")) * discountFactor,
    0
  );
  const totalLandedCost = chargeLines.reduce((s, c) => s + parseFloat(c.amountUsd || "0"), 0);
  const totalFinalCost = totalBaseCost + totalLandedCost;
  const invoiceTotal = parseFloat(String(container.invoiceTotalUsd ?? "0"));

  const otwAcct = (statusData?.spAccounts || []).find((a) => a.subType === "sp_goods_otw");
  const otwClrAcct = (statusData?.spAccounts || []).find((a) => a.subType === "sp_otw_clearing");
  const stockAcct = (statusData?.spAccounts || []).find((a) => a.subType === "sp_stock");
  const costClrAcct = (statusData?.spAccounts || []).find((a) => a.subType === "sp_cost_clearing");
  const prepaidAcct = (statusData?.spAccounts || []).find((a) => a.subType === "sp_prepaid");
  const prepaidExpAcct = (statusData?.spAccounts || []).find((a) => a.subType === "sp_prepaid_expenses");
  const hadiIcAcct = (statusData?.spAccounts || []).find((a) => a.subType === "sp_hadi_intercompany");

  const activeCharges = chargeLines.filter((c) => parseFloat(c.amountUsd || "0") > 0);
  const agentCharges = activeCharges.filter((c) => c.chargeType === "parent_agent");
  const totalAgentCharges = agentCharges.reduce((s, c) => s + parseFloat(c.amountUsd || "0"), 0);

  const addCharge = () =>
    setChargeLines((prev) => [
      ...prev,
      {
        chargeType: "paid_now",
        description: "",
        amountUsd: "",
        prepaidChargeId: "",
        creditBankAccountId: "",
        creditLedgerAccountId: "",
        parentAgentAccountId: "",
      },
    ]);

  const removeCharge = (idx: number) => setChargeLines((prev) => prev.filter((_, i) => i !== idx));

  const updateCharge = (idx: number, key: keyof ChargeLine, value: string) =>
    setChargeLines((prev) => prev.map((c, i) => (i === idx ? { ...c, [key]: value } : c)));

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!offloadMutation.isPending) {
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
            <Select value={selectedLocationId} onValueChange={setSelectedLocationId}>
              <SelectTrigger id="sp-offload-location" className="mt-1" data-testid="select-sp-offload-location">
                <SelectValue placeholder="Select a location…" />
              </SelectTrigger>
              <SelectContent>
                {locationsList.map((l) => (
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
                value={offloadDate}
                onChange={(e) => setOffloadDate(e.target.value)}
                className="mt-1"
                data-testid="input-sp-offload-date"
              />
            </div>
            <div className="text-sm text-muted-foreground pt-5">
              {(container.lines || []).length} line{(container.lines || []).length !== 1 ? "s" : ""} ·{" "}
              {totalQty.toLocaleString("en-US", { maximumFractionDigits: 2 })} units
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
              <Button type="button" variant="outline" size="sm" onClick={addCharge} data-testid="button-sp-add-charge">
                <Plus className="h-3.5 w-3.5 mr-1" />
                Add Charge
              </Button>
            </div>

            {chargeLines.length === 0 && (
              <p className="text-sm text-muted-foreground py-2">
                No charges — all stock cost will equal the discounted base cost.
              </p>
            )}

            {chargeLines.map((charge, idx) => (
              <div
                key={idx}
                className="grid grid-cols-12 gap-2 items-start p-3 border border-border rounded-md bg-muted/20"
              >
                {/* Charge type */}
                <div className="col-span-4">
                  <Label className="text-xs">Type</Label>
                  <Select value={charge.chargeType} onValueChange={(v) => updateCharge(idx, "chargeType", v)}>
                    <SelectTrigger className="h-8 text-xs mt-1" data-testid={`select-sp-charge-type-${idx}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CHARGE_TYPES.map((t) => (
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
                    onChange={(e) => updateCharge(idx, "description", e.target.value)}
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
                    onChange={(e) => updateCharge(idx, "amountUsd", e.target.value)}
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
                        onValueChange={(v) => updateCharge(idx, "prepaidChargeId", v)}
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
                        onValueChange={(v) => updateCharge(idx, "creditBankAccountId", v)}
                      >
                        <SelectTrigger className="h-8 text-xs" data-testid={`select-sp-charge-bank-${idx}`}>
                          <SelectValue placeholder="Select bank" />
                        </SelectTrigger>
                        <SelectContent>
                          {(statusData?.bankAccounts || []).map((b) => (
                            <SelectItem key={b.id} value={String(b.id)}>
                              {b.bankName}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : charge.chargeType === "unpaid_payable" || charge.chargeType === "other" ? (
                      <Select
                        value={charge.creditLedgerAccountId}
                        onValueChange={(v) => updateCharge(idx, "creditLedgerAccountId", v)}
                      >
                        <SelectTrigger className="h-8 text-xs" data-testid={`select-sp-charge-ledger-${idx}`}>
                          <SelectValue placeholder="Select account" />
                        </SelectTrigger>
                        <SelectContent>
                          {ledgerAccounts.map((a) => (
                            <SelectItem key={a.id} value={String(a.id)}>
                              {a.code} — {a.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : charge.chargeType === "parent_agent" ? (
                      <Select
                        value={charge.parentAgentAccountId}
                        onValueChange={(v) => updateCharge(idx, "parentAgentAccountId", v)}
                      >
                        <SelectTrigger className="h-8 text-xs" data-testid={`select-sp-charge-agent-${idx}`}>
                          <SelectValue placeholder="Select agent" />
                        </SelectTrigger>
                        <SelectContent>
                          {parentAgents.map((a) => (
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
                    onClick={() => removeCharge(idx)}
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
              <p className="font-semibold text-sm">{fmt2(totalBaseCost)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Landed Charges</p>
              <p className="font-semibold text-sm">{fmt2(totalLandedCost)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Final Stock Cost</p>
              <p className="font-semibold text-sm">{fmt2(totalFinalCost)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">OTW Reversal</p>
              <p className="font-semibold text-sm">{fmt2(invoiceTotal)}</p>
            </div>
          </div>

          <Separator />

          {/* Accounting Preview */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">Accounting Preview</p>
                <p className="text-xs text-muted-foreground">
                  {agentCharges.length > 0
                    ? "Three journal vouchers will be created: two in SP Test Co, one in HADI L'SHI"
                    : "Two journal vouchers will be created on confirm"}
                </p>
              </div>
            </div>

            {/* Voucher A: OTW Reversal */}
            <div className="space-y-1">
              <div className="flex items-center gap-1.5">
                <TrendingDown className="h-3.5 w-3.5 text-muted-foreground" />
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Voucher A — Goods OTW Reversal (SP Test Co)
                </p>
              </div>
              <div className="rounded-md border border-border bg-muted/20 p-3 space-y-1">
                <div className="grid grid-cols-3 text-xs text-muted-foreground font-medium pb-1 border-b border-border/40">
                  <span className="col-span-2">Account</span>
                  <span className="text-right">Dr / Cr</span>
                </div>
                <div className="grid grid-cols-3 text-xs py-0.5">
                  <span className="col-span-2 font-medium">
                    {otwClrAcct?.name ?? "Goods OTW Clearing"}{" "}
                    <Badge variant="secondary" className="text-xs ml-1">
                      Dr
                    </Badge>
                  </span>
                  <span className="text-right tabular-nums font-semibold">{fmt2(invoiceTotal)}</span>
                </div>
                <div className="grid grid-cols-3 text-xs py-0.5 text-muted-foreground">
                  <span className="col-span-2 pl-4">{otwAcct?.name ?? "Goods OTW"} (Cr)</span>
                  <span className="text-right tabular-nums">{fmt2(invoiceTotal)}</span>
                </div>
              </div>
            </div>

            {/* Voucher B: Stock Creation */}
            <div className="space-y-1">
              <div className="flex items-center gap-1.5">
                <TrendingUp className="h-3.5 w-3.5 text-muted-foreground" />
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Voucher B — Stock Creation (SP Test Co)
                </p>
              </div>
              <div className="rounded-md border border-border bg-muted/20 p-3 space-y-1">
                <div className="grid grid-cols-3 text-xs text-muted-foreground font-medium pb-1 border-b border-border/40">
                  <span className="col-span-2">Account</span>
                  <span className="text-right">Dr / Cr</span>
                </div>
                <div className="grid grid-cols-3 text-xs py-0.5">
                  <span className="col-span-2 font-medium">
                    {stockAcct?.name ?? "SP Stock on Floor"}{" "}
                    <Badge variant="secondary" className="text-xs ml-1">
                      Dr
                    </Badge>
                  </span>
                  <span className="text-right tabular-nums font-semibold">{fmt2(totalFinalCost)}</span>
                </div>
                <div className="grid grid-cols-3 text-xs py-0.5 text-muted-foreground">
                  <span className="col-span-2 pl-4">
                    {costClrAcct?.name ?? "SP Cost Clearing"} — base supplier cost (Cr)
                  </span>
                  <span className="text-right tabular-nums">{fmt2(totalBaseCost)}</span>
                </div>
                {activeCharges.map((c, idx) => {
                  const amt = parseFloat(c.amountUsd || "0");
                  let creditLabel: string;
                  if (c.chargeType === "prepaid_used") {
                    const p = (container.prepaid || []).find((x) => String(x.id) === c.prepaidChargeId);
                    creditLabel = prepaidAcct?.name ?? "SP Prepaid Charges";
                    if (p) creditLabel += ` — ${p.chargeType}`;
                  } else if (c.chargeType === "paid_now") {
                    const b = (statusData?.bankAccounts || []).find((x) => String(x.id) === c.creditBankAccountId);
                    creditLabel = b ? b.bankName : "Bank Account";
                  } else if (c.chargeType === "unpaid_payable" || c.chargeType === "other") {
                    const a = ledgerAccounts.find((x) => String(x.id) === c.creditLedgerAccountId);
                    creditLabel = a ? `${a.name}` : "Ledger Account";
                  } else if (c.chargeType === "parent_agent") {
                    creditLabel = prepaidExpAcct?.name ?? "Prepaid Expenses";
                    const agent = parentAgents.find((x) => String(x.ledger_account_id) === c.parentAgentAccountId);
                    if (agent) creditLabel += ` (via ${agent.account_name})`;
                  } else {
                    creditLabel = `${costClrAcct?.name ?? "Cost Clearing"} — freight`;
                  }
                  return (
                    <div key={idx} className="grid grid-cols-3 text-xs py-0.5 text-muted-foreground">
                      <span className="col-span-2 pl-4">
                        {creditLabel} (Cr){c.description ? ` — ${c.description}` : ""}
                      </span>
                      <span className="text-right tabular-nums">{fmt2(amt)}</span>
                    </div>
                  );
                })}
                {activeCharges.length === 0 && (
                  <div className="grid grid-cols-3 text-xs py-0.5 text-muted-foreground">
                    <span className="col-span-2 pl-4">No landed charges — Cr equals base cost only</span>
                    <span className="text-right tabular-nums">—</span>
                  </div>
                )}
              </div>
            </div>

            {/* Voucher C: HADI L'SHI Agent Journal — only if agent charges exist */}
            {agentCharges.length > 0 && (
              <div className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Voucher C — Agent Charges (HADI L'SHI)
                  </p>
                </div>
                <div className="rounded-md border border-border bg-muted/20 p-3 space-y-1">
                  <div className="grid grid-cols-3 text-xs text-muted-foreground font-medium pb-1 border-b border-border/40">
                    <span className="col-span-2">Account</span>
                    <span className="text-right">Dr / Cr</span>
                  </div>
                  {agentCharges.map((c, idx) => {
                    const agent = parentAgents.find((x) => String(x.ledger_account_id) === c.parentAgentAccountId);
                    return (
                      <div key={idx} className="grid grid-cols-3 text-xs py-0.5">
                        <span className="col-span-2 font-medium">
                          {agent?.account_name ?? "Agent Account"}{" "}
                          <Badge variant="secondary" className="text-xs ml-1">
                            Dr
                          </Badge>
                          {c.description ? <span className="text-muted-foreground ml-1">— {c.description}</span> : null}
                        </span>
                        <span className="text-right tabular-nums font-semibold">
                          {fmt2(parseFloat(c.amountUsd || "0"))}
                        </span>
                      </div>
                    );
                  })}
                  <div className="grid grid-cols-3 text-xs py-0.5 text-muted-foreground border-t border-border/40 pt-1 mt-1">
                    <span className="col-span-2 pl-4">
                      {hadiIcAcct?.name ?? "SP Test Co — Intercompany"} (Cr)
                      <Badge variant="outline" className="text-xs ml-1">
                        excluded from Net Position
                      </Badge>
                    </span>
                    <span className="text-right tabular-nums">{fmt2(totalAgentCharges)}</span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={offloadMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => offloadMutation.mutate()}
              disabled={offloadMutation.isPending}
              data-testid="button-sp-confirm-offload"
            >
              {offloadMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Confirm Offload
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
