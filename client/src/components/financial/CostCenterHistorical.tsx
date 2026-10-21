/**
 * Phase 7 historical allocations: explicit preview + immutable stale-aware
 * confirmation, no source posting mutations, no automatic bulk backfill.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import Decimal from "decimal.js";
import { useCompany } from "@/contexts/CompanyContext";
import { useAppMode } from "@/contexts/AppModeContext";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertTriangle, ClipboardCheck, History, Plus, RefreshCw, Trash2 } from "lucide-react";
import { readCostCenterApi, writeCostCenterApi, type CostCenter } from "@/api/costCentersApi";

type Kind = "VOUCHER_ENTRY" | "FACTORY_DAYBOOK";
type Split = { costCenterId: string; percent: string };
type Source = {
  sourceId: number;
  voucherId: number | null;
  voucherNumber: string | null;
  sourceDate: string;
  accountName: string;
  sourceModule: string;
  currency: string;
  amountNative: string;
  amountUsd: string;
  allocations: Array<{ costCenterId: number; amountNative: string; amountUsd: string }>;
};
type Preview = {
  batchId: string;
  status: string;
  candidateCount: number;
  sourceHash: string;
  sourceNativeTotal: string;
  sourceUsdTotal: string;
  allocatedNativeTotal: string;
  allocatedUsdTotal: string;
  expiresInMinutes: number;
  rows: Source[];
  warning: string;
};
type Reconciliation = {
  kind: Kind;
  basis: string;
  sourceCount: number;
  postedUsd: string;
  allocatedUsd: string;
  unallocatedUsd: string;
  allocatedSources: number;
  overallocatedSources: number;
  nativeCurrencies: Array<{
    currency: string;
    sourceCount: number;
    sourceNative: string;
    allocatedNative: string;
    unallocatedNative: string;
    overallocatedSources: number;
  }>;
};
type Account = { id: number; code: string; name: string };
type Batch = {
  id: string;
  status: string;
  sourceKind: Kind;
  candidateCount: number;
  sourceUsdTotal: string;
  createdAt: string;
  expiresAt: string;
  appliedAt: string | null;
  createdBy: string;
  request: { fromDate: string; toDate: string; reason: string };
};
const amountPattern = /^(?:0|[1-9]\d{0,2})(?:\.\d{1,4})?$/;
function startDate() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-01";
}
function dateToday() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
const fmt = (n: string | number | undefined) =>
  Number(n || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const err = (e: unknown) => (e instanceof Error ? e.message : "Historical allocation operation failed");

export function CostCenterHistorical({ baseUrl, centers }: { baseUrl: string; centers: CostCenter[] }) {
  const { selectedCompany } = useCompany();
  const isFactory = useAppMode() === "factory";
  const { toast } = useToast();
  const companyId = selectedCompany?.id;
  const canWrite = ["Admin", "Owner", "Developer"].includes(selectedCompany?.role || "");
  const [kind, setKind] = useState<Kind>("VOUCHER_ENTRY");
  const [from, setFrom] = useState(startDate);
  const [to, setTo] = useState(dateToday);
  const [account, setAccount] = useState("all");
  const [limit, setLimit] = useState("50");
  const [splits, setSplits] = useState<Split[]>([{ costCenterId: "", percent: "100" }]);
  const [reason, setReason] = useState("Historical expense cost center assignment");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [applied, setApplied] = useState<{ sourceCount: number; allocatedUsdTotal: string } | null>(null);
  const [showBatchHistory, setShowBatchHistory] = useState(false);
  const validWindow = from.length === 10 && to.length === 10 && from <= to;
  const queryString = useMemo(() => {
    const q = new URLSearchParams({ sourceKind: kind, fromDate: from, toDate: to });
    if (kind === "VOUCHER_ENTRY" && account !== "all") q.set("ledgerAccountId", account);
    return q.toString();
  }, [kind, from, to, account]);
  const { data: accounts } = useQuery<{ accounts: Account[] }>({
    queryKey: [baseUrl, companyId, "automation", "accounts"],
    queryFn: () => readCostCenterApi(baseUrl + "/automation/accounts"),
    enabled: !!companyId,
  });
  const {
    data: reconciliation,
    isLoading: reconLoading,
    isError: reconError,
    error: reconErrorText,
    refetch: refreshRecon,
  } = useQuery<Reconciliation>({
    queryKey: [baseUrl, companyId, "historical", "reconciliation", queryString],
    queryFn: () => readCostCenterApi<Reconciliation>(baseUrl + "/historical/reconciliation?" + queryString),
    enabled: !!companyId && validWindow,
    staleTime: 30000,
  });
  const { data: history, refetch: refreshHistory } = useQuery<{ batches: Batch[] }>({
    queryKey: [baseUrl, companyId, "historical", "batches"],
    queryFn: () => readCostCenterApi<{ batches: Batch[] }>(baseUrl + "/historical/batches"),
    enabled: !!companyId && showBatchHistory,
  });
  const pctTotal = useMemo(() => {
    try {
      return splits.reduce((acc, s) => acc.plus(new Decimal(s.percent || 0)), new Decimal(0));
    } catch {
      return new Decimal(-1);
    }
  }, [splits]);
  const validSplits =
    splits.length > 0 &&
    splits.length <= 10 &&
    splits.every(
      (s) =>
        s.costCenterId &&
        amountPattern.test(s.percent) &&
        new Decimal(s.percent).gt(0) &&
        centers.some((c) => c.active && String(c.id) === s.costCenterId)
    ) &&
    new Set(splits.map((s) => s.costCenterId)).size === splits.length &&
    pctTotal.gt(0) &&
    pctTotal.lte(100);
  const valid =
    canWrite &&
    validWindow &&
    validSplits &&
    Number.isInteger(Number(limit)) &&
    Number(limit) > 0 &&
    Number(limit) <= 100 &&
    reason.trim().length >= 5 &&
    reason.trim().length <= 500;
  function invalidatePreview() {
    setPreview(null);
    setConfirmation("");
    setApplied(null);
  }
  function changeSplit(index: number, patch: Partial<Split>) {
    invalidatePreview();
    setSplits((old) => old.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }
  const previewWrite = useMutation({
    mutationFn: () =>
      writeCostCenterApi<Preview>("POST", baseUrl + "/historical/preview", {
        sourceKind: kind,
        fromDate: from,
        toDate: to,
        ledgerAccountId: kind === "VOUCHER_ENTRY" && account !== "all" ? Number(account) : null,
        limit: Number(limit),
        reason: reason.trim(),
        splits: splits.map((s) => ({
          costCenterId: Number(s.costCenterId),
          percent: new Decimal(s.percent).toFixed(4),
        })),
      }),
    onSuccess: (result) => {
      setPreview(result);
      setConfirmation("");
      setApplied(null);
      toast({
        title: "Dry-run preview saved",
        description: "No original vouchers or cost-center allocations were changed.",
      });
      void refreshHistory();
    },
    onError: (error) => toast({ title: "Preview unavailable", description: err(error), variant: "destructive" }),
  });
  const applyWrite = useMutation({
    mutationFn: () => {
      if (!preview) throw new Error("Create a new dry-run preview first");
      return writeCostCenterApi<{ sourceCount: number; allocatedUsdTotal: string }>(
        "POST",
        baseUrl + "/historical/" + preview.batchId + "/apply",
        { confirmation: "APPLY" }
      );
    },
    onSuccess: async (result) => {
      setApplied(result);
      setPreview(null);
      setConfirmation("");
      await queryClient.invalidateQueries({ queryKey: [baseUrl, companyId] });
      toast({
        title: "Historical allocation applied",
        description:
          "Analytical tags added. The original vouchers, inventory values and account balances are unchanged.",
      });
      void refreshRecon();
      void refreshHistory();
    },
    onError: (e) => {
      setConfirmation("");
      toast({ title: "Batch rejected — nothing applied", description: err(e), variant: "destructive" });
    },
  });
  const samePreview = !!preview && !previewWrite.isPending && !applyWrite.isPending;
  return (
    <Card data-testid="cost-center-historical">
      <CardHeader className="space-y-2">
        <CardTitle className="flex gap-2 items-center text-base">
          <History className="w-4 h-4" /> Historical Assignment & Reconciliation
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Prior expense transactions remain Unallocated until you manually approve a specific historical batch. Existing
          manual or automatic assignments are never overwritten. Preview does not touch accounting; Apply creates
          analytical cost-center tags only.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2">
          <div className="space-y-1">
            <Label>Historical Source</Label>
            <Select
              value={kind}
              onValueChange={(v) => {
                invalidatePreview();
                setKind(v as Kind);
                setAccount("all");
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="VOUCHER_ENTRY">Posted expense voucher lines</SelectItem>
                {isFactory && <SelectItem value="FACTORY_DAYBOOK">Standalone Factory expenses</SelectItem>}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="historical-cc-from">From</Label>
            <Input
              id="historical-cc-from"
              type="date"
              value={from}
              onChange={(e) => {
                invalidatePreview();
                setFrom(e.target.value);
              }}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="historical-cc-to">To</Label>
            <Input
              id="historical-cc-to"
              type="date"
              value={to}
              onChange={(e) => {
                invalidatePreview();
                setTo(e.target.value);
              }}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="historical-cc-limit">Maximum entries (1–100)</Label>
            <Input
              id="historical-cc-limit"
              type="number"
              min={1}
              max={100}
              step={1}
              value={limit}
              onChange={(e) => {
                invalidatePreview();
                setLimit(e.target.value);
              }}
            />
          </div>
          {kind === "VOUCHER_ENTRY" && (
            <div className="space-y-1 sm:col-span-2">
              <Label>Expense Ledger Account (optional)</Label>
              <Select
                value={account}
                onValueChange={(v) => {
                  invalidatePreview();
                  setAccount(v);
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="All expense accounts" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Eligible Expense Accounts</SelectItem>
                  {(accounts?.accounts || []).map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      {a.code} — {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        <div className="rounded-md border p-3 space-y-2">
          <div className="flex gap-2 items-center justify-between">
            <h3 className="text-sm font-semibold">Historical Expense Reconciliation</h3>
            <Button variant="ghost" size="sm" onClick={() => void refreshRecon()}>
              <RefreshCw className="h-3 w-3 mr-1" /> Refresh
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Control totals cover eligible posted expense debit sources only, not your complete general ledger or P&L.
            Existing allocations stay linked to their original historical USD values.
          </p>
          {reconLoading && <p className="text-sm text-muted-foreground">Reading source control totals…</p>}
          {reconError && (
            <p role="alert" className="text-sm text-destructive">
              {err(reconErrorText)}
            </p>
          )}
          {reconciliation && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
              <div>
                <p className="text-xs text-muted-foreground">Eligible sources</p>
                <p className="font-semibold">{reconciliation.sourceCount}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Source book value USD</p>
                <p className="font-mono font-semibold">{fmt(reconciliation.postedUsd)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Allocated USD</p>
                <p className="font-mono font-semibold">{fmt(reconciliation.allocatedUsd)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Unallocated USD</p>
                <p className="font-mono font-semibold">{fmt(reconciliation.unallocatedUsd)}</p>
              </div>
              {reconciliation.overallocatedSources > 0 && (
                <p role="alert" className="text-sm text-destructive col-span-full">
                  {reconciliation.overallocatedSources} source allocations exceed their USD book value; resolve before
                  approving a new batch.
                </p>
              )}
            </div>
          )}
          {reconciliation && reconciliation.nativeCurrencies.length > 0 && (
            <div className="overflow-x-auto border rounded-md">
              <p className="px-2 pt-2 text-xs font-semibold">Original-currency control totals (no FX revaluation)</p>
              <table className="text-xs w-full min-w-[480px]">
                <thead>
                  <tr className="text-left">
                    <th className="p-2">Currency</th>
                    <th className="p-2 text-right">Source</th>
                    <th className="p-2 text-right">Assigned</th>
                    <th className="p-2 text-right">Unallocated</th>
                  </tr>
                </thead>
                <tbody>
                  {reconciliation.nativeCurrencies.map((row) => (
                    <tr key={row.currency} className="border-t">
                      <td className="p-2">{row.currency}</td>
                      <td className="p-2 text-right font-mono">{fmt(row.sourceNative)}</td>
                      <td className="p-2 text-right font-mono">{fmt(row.allocatedNative)}</td>
                      <td className="p-2 text-right font-mono">
                        {fmt(row.unallocatedNative)}
                        {row.overallocatedSources > 0 && (
                          <span className="block text-destructive">Overallocated: {row.overallocatedSources}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        {canWrite && (
          <div className="rounded-md border p-3 space-y-3">
            <h3 className="text-sm font-semibold">Manual Bulk Allocation</h3>
            <p className="text-xs text-muted-foreground">
              Applies only to fully unallocated, active, unreversed eligible expense debit entries. Payments,
              intercompany records, migrated/protected vouchers, pending loadings and inventory asset movements are
              excluded.
            </p>
            {splits.map((split, index) => (
              <div key={index} className="flex flex-wrap gap-2 items-end">
                <div className="space-y-1 flex-1 min-w-[160px]">
                  <Label>Cost Center</Label>
                  <Select value={split.costCenterId} onValueChange={(v) => changeSplit(index, { costCenterId: v })}>
                    <SelectTrigger>
                      <SelectValue placeholder="Choose active center" />
                    </SelectTrigger>
                    <SelectContent>
                      {centers
                        .filter((c) => c.active)
                        .map((c) => (
                          <SelectItem key={c.id} value={String(c.id)}>
                            {c.code} — {c.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1 w-28">
                  <Label>Percent</Label>
                  <Input
                    inputMode="decimal"
                    value={split.percent}
                    onChange={(e) => changeSplit(index, { percent: e.target.value })}
                  />
                </div>
                <Button
                  title="Remove split"
                  size="icon"
                  variant="ghost"
                  onClick={() => {
                    invalidatePreview();
                    setSplits((s) => s.filter((_, i) => i !== index));
                  }}
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            ))}
            <div className="flex flex-wrap justify-between items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={splits.length >= 10}
                onClick={() => {
                  invalidatePreview();
                  setSplits((s) => [...s, { costCenterId: "", percent: "" }]);
                }}
              >
                <Plus className="h-3 w-3 mr-1" /> Add split
              </Button>
              <span className={"text-xs " + (pctTotal.gt(100) ? "text-destructive" : "text-muted-foreground")}>
                {pctTotal.toFixed(4)}% assigned; remaining balance stays Unallocated
              </span>
            </div>
            <div className="space-y-1">
              <Label htmlFor="historical-cc-reason">Required Audit Reason</Label>
              <Input
                id="historical-cc-reason"
                maxLength={500}
                value={reason}
                onChange={(e) => {
                  invalidatePreview();
                  setReason(e.target.value);
                }}
              />
            </div>
            <Button
              disabled={!valid || previewWrite.isPending || applyWrite.isPending}
              onClick={() => previewWrite.mutate()}
            >
              <ClipboardCheck className="h-4 w-4 mr-2" />
              {previewWrite.isPending ? "Preparing…" : "Preview Historical Allocation (Dry Run)"}
            </Button>
          </div>
        )}
        {preview && (
          <div className="rounded-md border p-3 space-y-3">
            <div className="flex flex-wrap justify-between gap-2 items-center">
              <h3 className="font-semibold text-sm">Dry Run — {preview.candidateCount} Sources</h3>
              <Badge variant="secondary">No allocations written</Badge>
            </div>
            <p className="text-sm">
              Historical source USD {fmt(preview.sourceUsdTotal)}; planned allocation USD{" "}
              {fmt(preview.allocatedUsdTotal)}. Native currencies are preserved individually by source.
            </p>
            <p className="text-xs text-muted-foreground">
              Preview expires after {preview.expiresInMinutes} minutes. Source changes invalidate it immediately. Apply
              is all-or-nothing.
            </p>
            <div className="max-h-64 overflow-auto rounded border">
              <table className="text-xs w-full min-w-[560px]">
                <thead className="bg-muted/40 sticky top-0">
                  <tr>
                    <th className="text-left p-2">Date / Source</th>
                    <th className="text-left p-2">Account</th>
                    <th className="text-right p-2">Original value</th>
                    <th className="text-right p-2">Book USD</th>
                    <th className="text-right p-2">Allocation USD</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row) => (
                    <tr key={row.sourceId} className="border-t">
                      <td className="p-2">
                        {row.sourceDate?.slice(0, 10)}
                        <p>{row.voucherNumber || "Daybook #" + row.sourceId}</p>
                      </td>
                      <td className="p-2">{row.accountName}</td>
                      <td className="p-2 text-right">
                        {row.currency} {fmt(row.amountNative)}
                      </td>
                      <td className="p-2 text-right">{fmt(row.amountUsd)}</td>
                      <td className="p-2 text-right">
                        {fmt(row.allocations.reduce((s, a) => s + Number(a.amountUsd), 0))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="rounded-md border border-destructive/30 p-3 space-y-2">
              <p className="text-sm flex gap-2 items-center font-semibold">
                <AlertTriangle className="h-4 w-4" />
                Confirm historical assignment
              </p>
              <p className="text-xs text-muted-foreground">
                This writes analytical allocation records for all {preview.candidateCount} sources. It cannot alter
                posted vouchers. To proceed, enter <strong>APPLY</strong>. Existing assignments are never overwritten.
              </p>
              <div className="flex flex-wrap gap-2">
                <Input
                  aria-label="Type APPLY to confirm"
                  placeholder="Type APPLY"
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                  className="max-w-44"
                />
                <Button disabled={!samePreview || confirmation !== "APPLY"} onClick={() => applyWrite.mutate()}>
                  {applyWrite.isPending ? "Applying…" : "Apply Approved Batch"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setPreview(null);
                    setConfirmation("");
                  }}
                >
                  Discard Preview
                </Button>
              </div>
            </div>
          </div>
        )}
        {applied && (
          <p role="status" className="text-sm font-medium">
            Applied {applied.sourceCount} historical source allocations, USD {fmt(applied.allocatedUsdTotal)}. No
            vouchers or accounting balances were changed.
          </p>
        )}
        <div className="space-y-2 border-t pt-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setShowBatchHistory((v) => !v);
              void refreshHistory();
            }}
          >
            {showBatchHistory ? "Hide" : "Show"} Recent Historical Batches
          </Button>
          {showBatchHistory && (
            <div className="space-y-1">
              {(history?.batches || []).map((row) => (
                <div key={row.id} className="border-b text-sm py-2 flex flex-wrap justify-between gap-2">
                  <div>
                    <span className="font-medium">
                      {row.sourceKind === "VOUCHER_ENTRY" ? "Vouchers" : "Factory Daybook"}
                    </span>
                    <p className="text-xs text-muted-foreground">
                      {row.request.fromDate} – {row.request.toDate}
                      {" · "}
                      {row.candidateCount} sources · USD {fmt(row.sourceUsdTotal)}
                    </p>
                    <p className="text-xs text-muted-foreground">{row.request.reason}</p>
                  </div>
                  <Badge variant="secondary">
                    {row.status === "PREVIEW" && new Date(row.expiresAt).getTime() < Date.now()
                      ? "EXPIRED"
                      : row.status}
                  </Badge>
                </div>
              ))}
              {history?.batches.length === 0 && (
                <p className="text-xs text-muted-foreground">No historical batches saved.</p>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
