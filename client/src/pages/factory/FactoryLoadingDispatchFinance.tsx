/**
 * Phase 3 — charge drafting and a read-only financial preview for a closed truck.
 * Phase 4 will add the separate financial-post/reversal workflow.
 */
import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { DollarSign, FileWarning, Loader2, Pencil, Plus, RefreshCw, Trash2, Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { confirmAction } from "@/components/ConfirmHost";

type Kind = "BILLABLE" | "INTERNAL" | "DISCOUNT";
type ErpType = "" | "freight" | "surcharge" | "fumigation" | "documentCharges";
interface Account {
  id: number;
  code: string;
  name: string;
  accountType: string;
}
interface Charge {
  id: number;
  name: string;
  kind: Kind;
  amount: string;
  currency: string;
  ledgerAccountId: number;
  offsetLedgerAccountId: number | null;
  erpChargeType: ErpType | null;
  notes: string | null;
  revision: number;
  lockedAt?: string | null;
}
interface SignedSource {
  sourceFingerprint: string;
  baleCount: number;
  totalWeightKg: string;
  goodsSubtotal: string;
  closureRevision: number;
  bales: Array<{ baleId: number; articleCode: string; lineTotal: string }>;
}
interface Preview {
  status: string;
  currency: string;
  revision: number;
  source: SignedSource | null;
  sourceError: { code: string; message: string } | null;
  totals: {
    goodsSubtotal: string;
    billableChargesTotal: string;
    discountTotal: string;
    internalExpenseTotal: string;
    customerTotal: string;
    chargeCount: number;
  } | null;
  charges: Charge[];
  chargeFingerprint: string;
  accounts: Account[];
  canEdit: boolean;
  postingEnabled: boolean;
  postingNotice: string;
}
interface Props {
  orderId: number;
  dispatchId: number;
  companyId: number | null | undefined;
  status: string;
  role: string;
}

interface ChargeForm {
  name: string;
  kind: Kind;
  amount: string;
  ledgerAccountId: string;
  offsetLedgerAccountId: string;
  erpChargeType: ErpType;
  notes: string;
}
const emptyForm = (): ChargeForm => ({
  name: "",
  kind: "BILLABLE",
  amount: "",
  ledgerAccountId: "",
  offsetLedgerAccountId: "",
  erpChargeType: "",
  notes: "",
});
const money = (value: string | undefined) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed)
    ? parsed.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "—";
};
const roleCanManage = (role: string) => ["admin", "owner", "developer"].includes(role.trim().toLowerCase());
const acceptsOffset = (type: string) => /liability|payable|accrual|clearing/i.test(type);
async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    credentials: "include",
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || "Unable to load trip charges");
  return body as T;
}
function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unable to save financial charge";
}

export default function FactoryLoadingDispatchFinance({ orderId, dispatchId, companyId, status, role }: Props) {
  const { toast } = useToast();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<ChargeForm>(emptyForm());
  const base = "/api/factory/customer-orders/" + orderId + "/loading-dispatches/" + dispatchId;
  const url = base + "/financial-preview";
  const enabled = Boolean(companyId) && status === "CLOSED" && roleCanManage(role);
  const preview = useQuery<Preview>({
    queryKey: companyQueryKey(url, companyId),
    queryFn: () => readJson<Preview>(url),
    enabled,
    staleTime: 5000,
    refetchInterval: formOpen ? false : 15000,
  });
  const data = preview.data;
  const canEdit = enabled && Boolean(data?.canEdit) && data?.status !== "POSTED" && data?.status !== "CONSOLIDATED";
  // The API already scopes these to active, visible accounts in the selected
  // Factory company. Let the operator select any ledger account type instead
  // of silently restricting customer charges to income accounts.
  const mainAccounts = data?.accounts ?? [];
  const offsetAccounts = (data?.accounts ?? []).filter((a) => acceptsOffset(a.accountType));
  const validForm =
    form.name.trim().length > 0 &&
    form.name.trim().length <= 160 &&
    /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/.test(form.amount.trim()) &&
    Number(form.amount) > 0 &&
    Number(form.ledgerAccountId) > 0 &&
    (form.kind !== "INTERNAL" || Number(form.offsetLedgerAccountId) > 0);

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: companyQueryKey(url, companyId) });
  }
  function beginCreate() {
    setEditingId(null);
    setForm(emptyForm());
    setFormOpen(true);
  }
  function beginEdit(c: Charge) {
    setEditingId(c.id);
    setForm({
      name: c.name,
      kind: c.kind,
      amount: c.amount,
      ledgerAccountId: String(c.ledgerAccountId),
      offsetLedgerAccountId: c.offsetLedgerAccountId ? String(c.offsetLedgerAccountId) : "",
      erpChargeType: (c.erpChargeType ?? "") as ErpType,
      notes: c.notes ?? "",
    });
    setFormOpen(true);
  }
  const save = useMutation({
    mutationFn: async (payload: ChargeForm) => {
      if (!data?.source || !data.canEdit) throw new Error("Refresh the signed financial preview before saving");
      const path = editingId === null ? base + "/financial-charges" : base + "/financial-charges/" + editingId;
      const response = await apiRequest(editingId === null ? "POST" : "PATCH", path, {
        expectedChargeFingerprint: data.chargeFingerprint,
        expectedSourceFingerprint: data.source.sourceFingerprint,
        charge: {
          name: payload.name.trim(),
          kind: payload.kind,
          amount: payload.amount,
          ledgerAccountId: Number(payload.ledgerAccountId),
          offsetLedgerAccountId: payload.kind === "INTERNAL" ? Number(payload.offsetLedgerAccountId) : null,
          erpChargeType:
            payload.kind === "INTERNAL" || payload.kind === "DISCOUNT" ? null : payload.erpChargeType || null,
          notes: payload.notes.trim() || null,
        },
      });
      return response.json();
    },
    onSuccess: () => {
      setFormOpen(false);
      setEditingId(null);
      setForm(emptyForm());
      invalidate();
      toast({ title: "Trip charge saved", description: "Draft only — no voucher or balance posted." });
    },
    onError: (error) => {
      invalidate();
      toast({ title: "Could not save charge", description: errorMessage(error), variant: "destructive" });
    },
  });
  const remove = useMutation({
    mutationFn: async (chargeId: number) => {
      if (!data?.source || !data.canEdit) throw new Error("Refresh financial preview before deleting");
      const response = await apiRequest("DELETE", base + "/financial-charges/" + chargeId, {
        expectedChargeFingerprint: data.chargeFingerprint,
        expectedSourceFingerprint: data.source.sourceFingerprint,
      });
      return response.json();
    },
    onSuccess: () => {
      invalidate();
      toast({ title: "Draft charge removed" });
    },
    onError: (error) => {
      invalidate();
      toast({ title: "Could not delete charge", description: errorMessage(error), variant: "destructive" });
    },
  });
  const busy = save.isPending || remove.isPending;

  return (
    <Card
      className="border-slate-200 bg-white dark:border-slate-700 dark:bg-card"
      data-testid="dispatch-trip-financial-preview"
    >
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex items-start gap-2">
            <Wallet className="mt-0.5 h-5 w-5 text-emerald-600" />
            <div>
              <h3 className="text-sm font-bold">Trip financial preview & charges</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Review actual loaded articles and add account-linked trip charges. No accounting is posted yet.
              </p>
            </div>
          </div>
          <Badge variant="outline">{data?.status ?? "Not posted"}</Badge>
        </div>

        {status !== "CLOSED" && (
          <p className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">
            End Dispatch to review its signed bale amounts and add financial charges.
          </p>
        )}
        {status === "CLOSED" && !roleCanManage(role) && (
          <p className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">
            Financial charge management requires Admin, Owner or Developer access.
          </p>
        )}
        {enabled && preview.isPending && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading signed trip totals…
          </p>
        )}
        {enabled && preview.isError && (
          <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
            <p className="flex items-start gap-2">
              <FileWarning className="h-4 w-4 shrink-0" />
              {errorMessage(preview.error)}
            </p>
            <Button type="button" variant="outline" size="sm" onClick={() => void preview.refetch()}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Retry
            </Button>
          </div>
        )}
        {enabled && data && (
          <>
            {data.sourceError && (
              <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                {data.sourceError.message}. Financial changes are blocked until the signed trip is reconciled.
              </p>
            )}
            {data.source && data.totals && (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-lg bg-muted/60 p-3">
                    <p className="text-[11px] text-muted-foreground">Verified bales</p>
                    <p className="font-mono font-semibold">{data.source.baleCount}</p>
                    <p className="text-[11px] text-muted-foreground">{data.source.totalWeightKg} kg</p>
                  </div>
                  <div className="rounded-lg bg-muted/60 p-3">
                    <p className="text-[11px] text-muted-foreground">Trip goods</p>
                    <p className="font-mono font-semibold">$ {money(data.totals.goodsSubtotal)}</p>
                    <p className="text-[11px] text-muted-foreground">Closure #{data.source.closureRevision}</p>
                  </div>
                </div>
                <div className="space-y-1 rounded-lg border p-3 text-xs">
                  <div className="flex justify-between gap-2">
                    <span>Billable charges</span>
                    <span className="font-mono">+ $ {money(data.totals.billableChargesTotal)}</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span>Discounts</span>
                    <span className="font-mono">− $ {money(data.totals.discountTotal)}</span>
                  </div>
                  <div className="flex justify-between gap-2 text-muted-foreground">
                    <span>Internal expenses (not billed)</span>
                    <span className="font-mono">$ {money(data.totals.internalExpenseTotal)}</span>
                  </div>
                  <div className="mt-2 flex justify-between gap-2 border-t pt-2 font-semibold">
                    <span>Estimated customer charge</span>
                    <span className="font-mono">$ {money(data.totals.customerTotal)}</span>
                  </div>
                </div>
              </>
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold">Trip charges ({data.charges.length})</span>
                {canEdit && !formOpen && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={beginCreate}
                    data-testid="dispatch-add-financial-charge"
                  >
                    <Plus className="mr-1 h-3.5 w-3.5" /> Add charge
                  </Button>
                )}
              </div>
              {data.charges.length === 0 && (
                <p className="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
                  No trip-specific charges saved.
                </p>
              )}
              {data.charges.map((c) => {
                const account = data.accounts.find((a) => a.id === c.ledgerAccountId);
                return (
                  <div
                    key={c.id}
                    className="rounded-lg border p-3 text-xs"
                    data-testid={"dispatch-financial-charge-" + c.id}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-semibold">{c.name}</p>
                        <p className="text-muted-foreground">
                          {c.kind} · {account?.name ?? "Ledger #" + c.ledgerAccountId}
                        </p>
                        {c.erpChargeType && <p className="text-muted-foreground">PO mapping: {c.erpChargeType}</p>}
                        {c.kind === "INTERNAL" && (
                          <p className="text-muted-foreground">Offset account #{c.offsetLedgerAccountId}</p>
                        )}
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="font-mono font-semibold">$ {money(c.amount)}</p>
                        {canEdit && !formOpen && !c.lockedAt && (
                          <div className="mt-1 flex gap-1">
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label={"Edit " + c.name}
                              disabled={busy}
                              onClick={() => beginEdit(c)}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label={"Remove " + c.name}
                              disabled={busy}
                              onClick={async () => {
                                const confirmed = await confirmAction({
                                  title: "Remove this draft charge?",
                                  confirmText: "Remove",
                                  tone: "destructive",
                                });
                                if (confirmed) remove.mutate(c.id);
                              }}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                    {c.notes && <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{c.notes}</p>}
                  </div>
                );
              })}
            </div>

            {canEdit && formOpen && (
              <form
                onSubmit={(event: FormEvent<HTMLFormElement>) => {
                  event.preventDefault();
                  if (validForm && !busy) save.mutate(form);
                }}
                className="space-y-3 rounded-lg border border-blue-200 bg-blue-50/30 p-3 dark:border-blue-900 dark:bg-blue-950/20"
                data-testid="dispatch-trip-charge-form"
              >
                <p className="text-sm font-semibold">{editingId ? "Edit draft charge" : "New trip charge"}</p>
                <div className="space-y-1">
                  <Label htmlFor="dispatch-charge-kind">Type</Label>
                  <select
                    id="dispatch-charge-kind"
                    className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                    value={form.kind}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        kind: e.target.value as Kind,
                        ledgerAccountId: "",
                        offsetLedgerAccountId: "",
                        erpChargeType: "",
                      })
                    }
                  >
                    <option value="BILLABLE">Customer-billable charge</option>
                    <option value="INTERNAL">Internal expense (not billed)</option>
                    <option value="DISCOUNT">Customer discount</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="dispatch-charge-name">Name</Label>
                  <Input
                    id="dispatch-charge-name"
                    maxLength={160}
                    required
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="Transport, freight, handling…"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="dispatch-charge-amount">Amount (USD)</Label>
                  <Input
                    id="dispatch-charge-amount"
                    required
                    inputMode="decimal"
                    placeholder="0.00"
                    value={form.amount}
                    onChange={(e) => setForm({ ...form, amount: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="dispatch-charge-account">Ledger account</Label>
                  <select
                    id="dispatch-charge-account"
                    required
                    className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                    value={form.ledgerAccountId}
                    onChange={(e) => setForm({ ...form, ledgerAccountId: e.target.value })}
                  >
                    <option value="">Select account</option>
                    {mainAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} — {a.name} ({a.accountType})
                      </option>
                    ))}
                  </select>
                  <p className="text-[11px] text-muted-foreground">
                    All active ledger account types are available. Billable charges credit this account, discounts debit
                    it, and internal expenses debit it. Confirm the intended accounting treatment before posting.
                  </p>
                </div>
                {form.kind === "INTERNAL" && (
                  <div className="space-y-1">
                    <Label htmlFor="dispatch-charge-offset">Payable / offset account</Label>
                    <select
                      id="dispatch-charge-offset"
                      required
                      className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                      value={form.offsetLedgerAccountId}
                      onChange={(e) => setForm({ ...form, offsetLedgerAccountId: e.target.value })}
                    >
                      <option value="">Select offset</option>
                      {offsetAccounts
                        .filter((a) => String(a.id) !== form.ledgerAccountId)
                        .map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.code} — {a.name}
                          </option>
                        ))}
                    </select>
                    <p className="text-[11px] text-muted-foreground">
                      Recording this expense does not imply a cash payment.
                    </p>
                  </div>
                )}
                {form.kind === "BILLABLE" && (
                  <div className="space-y-1">
                    <Label htmlFor="dispatch-charge-erp-type">ERP PO charge mapping (optional)</Label>
                    <select
                      id="dispatch-charge-erp-type"
                      className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                      value={form.erpChargeType}
                      onChange={(e) => setForm({ ...form, erpChargeType: e.target.value as ErpType })}
                    >
                      <option value="">Not mapped to ERP PO</option>
                      <option value="freight">Freight</option>
                      <option value="surcharge">Surcharge</option>
                      <option value="fumigation">Fumigation</option>
                      <option value="documentCharges">Document charges</option>
                    </select>
                    <p className="text-[11px] text-muted-foreground">
                      Unmapped charges will require explicit review before PO export in Phase 5.
                    </p>
                  </div>
                )}
                {form.kind === "DISCOUNT" && (
                  <p className="text-[11px] text-muted-foreground">
                    Discounts are tracked separately and will map to the ERP PO Discount column.
                  </p>
                )}
                <div className="space-y-1">
                  <Label htmlFor="dispatch-charge-notes">Notes (optional)</Label>
                  <Textarea
                    id="dispatch-charge-notes"
                    rows={2}
                    maxLength={1000}
                    value={form.notes}
                    onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setFormOpen(false);
                      setEditingId(null);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" size="sm" disabled={!validForm || busy}>
                    {save.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                    Save draft charge
                  </Button>
                </div>
              </form>
            )}
            <p className="flex items-start gap-2 border-t pt-3 text-[11px] text-muted-foreground">
              <DollarSign className="h-3.5 w-3.5 shrink-0" />
              {data.postingNotice} These figures are provisional until posted. ERP import remains a separate PO Excel
              upload.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
