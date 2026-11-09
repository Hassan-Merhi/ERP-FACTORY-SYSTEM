/**
 * Phase 6: End Dispatch, discrepancy gate, read-only closure snapshots and
 * supervisor-only reopening. This never posts to loading/stock/accounting.
 */
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  AlertTriangle, CheckCircle2, ClipboardCheck, FileClock,
  FileSearch, History, LockKeyhole, Loader2, RotateCcw, ShieldCheck,
  UnlockKeyhole,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { factoryActionCapabilities } from "@shared/factoryActionCapabilities";
import { factoryStatusLabel } from "@shared/factoryStatusPresentation";
import { useCompany } from "@/contexts/CompanyContext";
import type { FactoryMyAccess } from "@shared/apiTypes";

interface ClosingSummary {
  expectedBales: number | null;
  verifiedBales: number;
  missingBales: number | null;
  unexpectedBales: number;
  crossTripMisplacedBales: number;
  duplicateBales: number;
  verifiedWeightKg: number;
  expectedWeightKg: number | null;
  weightDifferenceKg: number | null;
}
interface ClosingIssue { code: string; label: string; count?: number }
interface ClosePreview {
  dispatchId: number;
  dispatchNumber: number;
  status: string;
  fingerprint: string;
  issues: ClosingIssue[];
  needsApproval: boolean;
  canCloseClean: boolean;
  hasAnyScans: boolean;
  summary: ClosingSummary;
}
interface Closure {
  id: number | string;
  revision: number;
  summary: ClosingSummary;
  issues: ClosingIssue[];
  approvedWithDiscrepancies: boolean;
  discrepancyReason: string | null;
  closedByUsername: string;
  closedAt: string;
  reopenedAt: string | null;
  reopenedByUsername: string | null;
  reopenReason: string | null;
}
interface AuditEvent {
  id: number | string;
  eventType: string;
  actorUsername: string;
  details: Record<string, unknown>;
  createdAt: string;
}
interface Lifecycle {
  trip: { id: number | string; status: string; dispatchNumber: number; closedAt: string | null; reopenedAt: string | null };
  closures: Closure[];
  events: AuditEvent[];
  eventsLimitedTo: number;
}
interface FrozenSnapshot extends Closure {
  comparison: {
    articles: Array<{ articleCode: string; expectedQty: number | null; scannedQty: number; missingQty: number | null; extraQty: number }>;
    missingBales: Array<{ baleReference: string; articleCode: string; reason: string }>;
    unexpectedBales: Array<{ baleReference: string; articleCode: string; reason: string }>;
    crossTripBales: Array<{ baleReference: string; articleCode: string; reason: string }>;
  };
}
interface Props {
  orderId: number;
  dispatchId: number;
  companyId: number | null | undefined;
  status: string;
  role: string;
  onChanged: () => void;
}
function fmt(n: number | null | undefined, precision = 0) {
  return n === null || n === undefined ? "—"
    : Number(n).toLocaleString(undefined, { maximumFractionDigits: precision });
}
function errorMessage(error: unknown) { return error instanceof Error ? error.message : "Unexpected server error"; }
async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "include", cache: "no-store" });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.message || "Could not load dispatch review");
  }
  return res.json() as Promise<T>;
}

export default function FactoryLoadingDispatchLifecycle({ orderId, dispatchId, companyId, status, role, onChanged }: Props) {
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const { data: access } = useQuery<FactoryMyAccess>({
    queryKey: companyQueryKey("/api/factory/my-access", companyId),
    enabled: Boolean(companyId) && selectedCompany?.id === companyId,
  });
  const { formatDisplayDateTime } = useDateFormat();
  const [, navigate] = useLocation();
  const base = "/api/factory/customer-orders/" + orderId + "/loading-dispatches/" + dispatchId;
  const previewUrl = base + "/close-preview";
  const lifecycleUrl = base + "/lifecycle";
  const capabilities = factoryActionCapabilities({
    role,
    hasFactoryAccess: Boolean(selectedCompany?.id === companyId && access?.companyId === companyId && access.hasFactoryAccess),
  });
  const supervisory = capabilities["dispatch.approve-discrepancy"];
  const canClose = capabilities["dispatch.close"] && status === "OPEN";
  const [closeOpen, setCloseOpen] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [closeConfirmed, setCloseConfirmed] = useState(false);
  const [discrepancyReason, setDiscrepancyReason] = useState("");
  const [reopenReason, setReopenReason] = useState("");
  const [frozenClosureId, setFrozenClosureId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const preview = useQuery<ClosePreview>({
    queryKey: companyQueryKey(previewUrl, companyId),
    queryFn: () => getJson<ClosePreview>(previewUrl),
    enabled: Boolean(companyId) && closeOpen && status === "OPEN",
    refetchInterval: closeOpen ? 10000 : false,
  });
  const history = useQuery<Lifecycle>({
    queryKey: companyQueryKey(lifecycleUrl, companyId),
    queryFn: () => getJson<Lifecycle>(lifecycleUrl),
    enabled: Boolean(companyId),
    refetchInterval: 15000,
  });
  const frozenUrl = frozenClosureId ? lifecycleUrl + "/closures/" + frozenClosureId : lifecycleUrl;
  const frozen = useQuery<FrozenSnapshot>({
    queryKey: companyQueryKey(frozenUrl, companyId),
    queryFn: () => getJson<FrozenSnapshot>(frozenUrl),
    enabled: Boolean(companyId) && Boolean(frozenClosureId),
  });

  const invalidate = () => {
    const listUrl = "/api/factory/customer-orders/" + orderId + "/loading-dispatches";
    for (const url of [
      listUrl, base, base + "/scans", base + "/allocations",
      previewUrl, lifecycleUrl, base + "/comparison", listUrl + "/comparison",
    ]) {
      void queryClient.invalidateQueries({ queryKey: companyQueryKey(url, companyId) });
    }
    onChanged();
  };

  const endMutation = useMutation({
    mutationFn: async () => {
      if (!preview.data) throw new Error("Review current verification before ending this trip");
      const response = await apiRequest("POST", base + "/close", {
        confirm: true,
        fingerprint: preview.data.fingerprint,
        ...(preview.data.needsApproval ? { discrepancyReason: discrepancyReason.trim() } : {}),
      });
      return response.json() as Promise<{ revision: number; status: string; approvedWithDiscrepancies: boolean }>;
    },
    onSuccess: (data) => {
      setCloseOpen(false);
      setCloseConfirmed(false);
      setDiscrepancyReason("");
      invalidate();
      toast({
        title: "Dispatch ended and locked",
        description: "Closure #" + data.revision + " saved. The verification scans and plan are now read-only.",
      });
    },
    onError: (error) => {
      setCloseConfirmed(false);
      void preview.refetch();
      toast({ title: "Dispatch not ended", description: errorMessage(error), variant: "destructive" });
    },
  });

  const reopenMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", base + "/reopen", { reason: reopenReason.trim() });
      return response.json() as Promise<{ status: string }>;
    },
    onSuccess: () => {
      setReopenOpen(false);
      setReopenReason("");
      invalidate();
      toast({ title: "Dispatch reopened", description: "The previous closure remains preserved in audit history." });
    },
    onError: (error) => {
      toast({ title: "Dispatch not reopened", description: errorMessage(error), variant: "destructive" });
    },
  });

  const s = preview.data?.summary;
  const issues = preview.data?.issues ?? [];
  const hasApproval = Boolean(preview.data?.needsApproval);
  const canConfirmEnd = Boolean(
    canClose && closeConfirmed && preview.data && preview.data.status === "OPEN" &&
    preview.data.hasAnyScans &&
    (!hasApproval || (supervisory && discrepancyReason.trim().length >= 10 && discrepancyReason.trim().length <= 1000)),
  );
  // Historical closure records may have incomplete snapshots. Never allow
  // missing review data to crash the active dispatch page.
  const closures = Array.isArray(history.data?.closures) ? history.data.closures : [];
  const latest = closures[0] ?? null;

  return (
    <>
      <Card className="border-blue-200 bg-white dark:border-blue-500/30 dark:bg-[#101c34]" data-testid="dispatch-lifecycle">
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="flex items-start gap-2">
              {status === "CLOSED" ? <LockKeyhole className="mt-0.5 h-5 w-5 text-emerald-600" />
                : <ClipboardCheck className="mt-0.5 h-5 w-5 text-blue-600" />}
              <div>
                <h3 className="text-sm font-bold">Dispatch finalization</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {status === "CLOSED"
                    ? "This truck record is locked. Scans, expected allocations and details can no longer be changed."
                    : "End the trip after physically verifying its bales. Discrepancies require a supervisor approval."}
                </p>
              </div>
            </div>
            <Badge variant="outline" className={status === "CLOSED" ? "border-emerald-500 text-emerald-600" : "border-blue-400 text-blue-600"}>
              {status === "CLOSED" ? "Completed" : factoryStatusLabel("dispatch", status)}
            </Badge>
          </div>

          {status === "CLOSED" && latest && (
            <div className="space-y-1 rounded-lg bg-emerald-50 p-3 text-xs text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200">
              <p className="flex items-center gap-1.5 font-semibold"><CheckCircle2 className="h-4 w-4" /> Completed by {latest.closedByUsername}</p>
              <p>{formatDisplayDateTime(latest.closedAt)} · Closure #{latest.revision}</p>
              <p>{fmt(latest.summary?.verifiedBales)} verified bales · {fmt(latest.summary?.verifiedWeightKg, 3)} kg</p>
              {latest.approvedWithDiscrepancies && <p className="font-semibold">Discrepancy approval: {latest.discrepancyReason}</p>}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {canClose && (
              <Button size="sm" onClick={() => {
                setCloseConfirmed(false); setDiscrepancyReason("");
                setCloseOpen(true);
                void queryClient.invalidateQueries({ queryKey: companyQueryKey(previewUrl, companyId) });
              }} data-testid="button-end-dispatch">
                <LockKeyhole className="mr-1.5 h-4 w-4" /> End Dispatch
              </Button>
            )}
            {status === "CLOSED" && capabilities["dispatch.reopen"] && (
              <Button size="sm" variant="outline" onClick={() => {
                setReopenReason(""); setReopenOpen(true);
              }} data-testid="button-reopen-dispatch">
                <UnlockKeyhole className="mr-1.5 h-4 w-4" /> Reopen Dispatch
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => setShowHistory((v) => !v)}
              data-testid="button-dispatch-audit-history">
              <History className="mr-1.5 h-4 w-4" /> {showHistory ? "Hide" : "Closure & audit history"}
            </Button>
          </div>
          {status === "CLOSED" && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck className="h-4 w-4" /> Reopening never erases or changes the signed closure snapshot.
            </p>
          )}
          {showHistory && (
            <div className="space-y-3 border-t pt-3 dark:border-slate-700">
              {history.isLoading && <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading history…</p>}
              {history.isError && <p className="text-xs text-red-600">{errorMessage(history.error)}</p>}
              {!history.isLoading && closures.length === 0 &&
                <p className="text-xs text-muted-foreground">No closures yet. This trip is still open.</p>}
              {closures.map((closure) => (
                <div key={String(closure.id)} className="space-y-2 rounded-lg border p-3 text-xs dark:border-slate-700">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold">Closure #{closure.revision} · {closure.closedByUsername}</span>
                    <Badge variant="outline">{closure.reopenedAt ? "Reopened" : "Finalized"}</Badge>
                  </div>
                  <p className="text-muted-foreground">{formatDisplayDateTime(closure.closedAt)} · {fmt(closure.summary?.verifiedBales)} bales · {fmt(closure.summary?.verifiedWeightKg, 3)} kg</p>
                  {closure.approvedWithDiscrepancies && (
                    <p className="text-amber-700 dark:text-amber-300">Approved with discrepancies: {closure.discrepancyReason}</p>
                  )}
                  {closure.reopenedAt && <p className="text-blue-700 dark:text-sky-300">
                    Reopened by {closure.reopenedByUsername} on {formatDisplayDateTime(closure.reopenedAt)} — {closure.reopenReason}
                  </p>}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setFrozenClosureId(String(closure.id))}
                      data-testid={"button-view-closure-" + closure.id}>
                      <FileSearch className="mr-1 h-3.5 w-3.5" /> View saved comparison
                    </Button>
                    <Button size="sm" variant="outline" className="h-7 px-2 text-xs"
                      onClick={() => navigate("/factory/sales/loading/dispatch/" + orderId + "/" + dispatchId +
                        "/report?closureId=" + closure.id)}
                      data-testid={"button-print-closure-" + closure.id}>
                      <FileClock className="mr-1 h-3.5 w-3.5" /> Print saved manifest
                    </Button>
                  </div>
                </div>
              ))}
              {(history.data?.events?.length ?? 0) > 0 ? (
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold">Recent dispatch activity</h4>
                  <div className="max-h-[250px] space-y-1.5 overflow-y-auto">
                    {history.data?.events?.slice(0, 40).map((event) => (
                      <div key={String(event.id)} className="flex flex-wrap justify-between gap-2 rounded-lg bg-slate-50 p-2 text-xs dark:bg-[#0a172c]">
                        <span className="font-medium">{event.eventType.replace(/_/g, " ")}</span>
                        <span className="text-muted-foreground">{event.actorUsername} · {formatDisplayDateTime(event.createdAt)}</span>
                      </div>
                    ))}
                  </div>
                  <p className="text-[11px] text-muted-foreground">Showing recent activity. Closure revisions remain available permanently.</p>
                </div>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={closeOpen} onOpenChange={(v) => {
        if (endMutation.isPending) return;
        setCloseOpen(v);
      }}>
        <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><LockKeyhole className="h-5 w-5 text-blue-600" /> End Dispatch</DialogTitle>
            <DialogDescription>
              Review the current physical truck verification. Ending will lock this trip, not the parent loading or other trucks.
            </DialogDescription>
          </DialogHeader>
          {preview.isPending && <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking expected bales, scans and discrepancies…
          </div>}
          {preview.isError && <div role="alert" className="rounded-lg border border-red-300 p-3 text-sm text-red-700">
            {errorMessage(preview.error)}
            <Button size="sm" variant="outline" className="ml-2" onClick={() => void preview.refetch()}>Retry</Button>
          </div>}
          {preview.data && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {([
                  ["Expected", fmt(s?.expectedBales)],
                  ["Verified", fmt(s?.verifiedBales)],
                  ["Missing", fmt(s?.missingBales)],
                  ["Unexpected", fmt(s?.unexpectedBales)],
                ] as const).map(([name, value]) => (
                  <div className="rounded-lg bg-slate-50 p-2.5 dark:bg-[#0b162a]" key={name}>
                    <p className="text-[11px] text-muted-foreground">{name}</p>
                    <p className="mt-1 font-mono text-lg font-bold">{value}</p>
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {fmt(s?.verifiedWeightKg, 3)} kg physically verified
                {s?.expectedWeightKg !== null && s?.expectedWeightKg !== undefined
                  ? " · " + fmt(s.expectedWeightKg, 3) + " kg expected" : " · expected KG not fully allocated"}
              </p>
              {issues.length ? (
                <div className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950/20">
                  <p className="flex items-center gap-2 text-sm font-semibold text-amber-900 dark:text-amber-200">
                    <AlertTriangle className="h-4 w-4" /> {issues.length} discrepancy check(s) need approval
                  </p>
                  <ul className="list-inside list-disc space-y-1 text-xs text-amber-900 dark:text-amber-200">
                    {issues.map((issue) => <li key={issue.code}>{issue.label}{issue.count !== undefined ? " (" + fmt(issue.count) + ")" : ""}</li>)}
                  </ul>
                  {supervisory ? (
                    <div className="space-y-2">
                      <p className="text-xs font-semibold">Supervisor reason for closing with discrepancies</p>
                      <Textarea value={discrepancyReason} maxLength={1000} rows={3}
                        placeholder="Explain the missing / unexpected bales and why this truck may be finalized"
                        onChange={(e) => setDiscrepancyReason(e.target.value)}
                        data-testid="input-dispatch-closure-reason" />
                      <p className="text-[11px] text-muted-foreground">Required: 10–1,000 characters. The reason and approval will be saved in permanent history.</p>
                    </div>
                  ) : <p className="text-xs font-semibold text-amber-900 dark:text-amber-200">
                    Only Admin, Owner or Developer can approve and end a trip with discrepancies.
                  </p>}
                </div>
              ) : (
                <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950/20 dark:text-emerald-200">
                  <CheckCircle2 className="h-4 w-4" /> All expected items match this truck's physical scans.
                </div>
              )}
              {issues.length > 0 && (
                <Button size="sm" variant="outline" onClick={() => {
                  setCloseOpen(false);
                  navigate("/factory/sales/loading/dispatch/" + orderId + "/" + dispatchId + "/compare");
                }} data-testid="button-review-dispatch-close-differences">
                  <FileSearch className="mr-1.5 h-4 w-4" /> Review barcode differences
                </Button>
              )}
              {!preview.data.hasAnyScans && <p className="text-xs font-medium text-red-600">
                You must physically verify at least one bale before ending this dispatch.
              </p>}
              <label className="flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-xs dark:border-slate-700">
                <Checkbox checked={closeConfirmed} disabled={endMutation.isPending}
                  onCheckedChange={(v) => setCloseConfirmed(v === true)} data-testid="checkbox-confirm-end-dispatch" />
                <span>I confirm the truck's physical verification has been reviewed and understand this dispatch will become read-only.</span>
              </label>
            </div>
          )}
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" disabled={endMutation.isPending} onClick={() => setCloseOpen(false)}>Cancel</Button>
            <Button disabled={!canConfirmEnd || endMutation.isPending || preview.isFetching}
              onClick={() => void endMutation.mutate()} data-testid="button-confirm-end-dispatch">
              {endMutation.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <LockKeyhole className="mr-1.5 h-4 w-4" />}
              {hasApproval ? "Approve & End" : "End & Lock Dispatch"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={reopenOpen} onOpenChange={(v) => { if (!reopenMutation.isPending) setReopenOpen(v); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><RotateCcw className="h-5 w-5" /> Reopen Dispatch</DialogTitle>
            <DialogDescription>
              Reopening restores scanning and plan editing, but keeps the previous signed closure and audit history.
              A new closure revision will be created when you finish again.
            </DialogDescription>
          </DialogHeader>
          <Textarea value={reopenReason} maxLength={1000} rows={3}
            onChange={(e) => setReopenReason(e.target.value)}
            placeholder="Why is this completed trip being reopened?"
            data-testid="input-reopen-dispatch-reason" />
          <p className="text-xs text-muted-foreground">Supervisor reason required (10–1,000 characters).</p>
          <DialogFooter>
            <Button variant="outline" disabled={reopenMutation.isPending} onClick={() => setReopenOpen(false)}>Cancel</Button>
            <Button disabled={!supervisory || reopenMutation.isPending ||
              reopenReason.trim().length < 10 || reopenReason.trim().length > 1000}
              onClick={() => void reopenMutation.mutate()} data-testid="button-confirm-reopen-dispatch">
              {reopenMutation.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <UnlockKeyhole className="mr-1.5 h-4 w-4" />}
              Reopen Trip
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(frozenClosureId)} onOpenChange={(v) => { if (!v) setFrozenClosureId(null); }}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><FileClock className="h-5 w-5" /> Saved closure comparison</DialogTitle>
            <DialogDescription>Historical snapshot as it was when the trip ended. Later stock/loading changes do not rewrite it.</DialogDescription>
          </DialogHeader>
          {frozen.isPending && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading saved comparison…</p>}
          {frozen.isError && <p className="text-sm text-red-600">{errorMessage(frozen.error)}</p>}
          {frozen.data && (
            <div className="space-y-3">
              <p className="text-sm font-semibold">Closure #{frozen.data.revision} · {frozen.data.closedByUsername} · {formatDisplayDateTime(frozen.data.closedAt)}</p>
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">Verified {fmt(frozen.data.summary.verifiedBales)}</Badge>
                <Badge variant="secondary">Expected {fmt(frozen.data.summary.expectedBales)}</Badge>
                <Badge variant="secondary">Missing {fmt(frozen.data.summary.missingBales)}</Badge>
                <Badge variant="secondary">Scanned KG {fmt(frozen.data.summary.verifiedWeightKg, 3)}</Badge>
              </div>
              {frozen.data.approvedWithDiscrepancies && <p className="rounded-lg bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950/20 dark:text-amber-200">
                Supervisor approval: {frozen.data.discrepancyReason}
              </p>}
              <div className="max-h-[360px] overflow-auto rounded-lg border dark:border-slate-700">
                <table className="w-full min-w-[500px] text-left text-xs">
                  <thead className="bg-slate-100 dark:bg-slate-800">
                    <tr><th className="px-3 py-2">Article</th><th className="px-3 py-2 text-right">Expected</th>
                      <th className="px-3 py-2 text-right">Scanned</th><th className="px-3 py-2 text-right">Missing</th>
                      <th className="px-3 py-2 text-right">Extra</th></tr>
                  </thead>
                  <tbody>
                    {frozen.data.comparison.articles.map((row) => (
                      <tr key={row.articleCode} className="border-t dark:border-slate-700">
                        <td className="px-3 py-2 font-mono">{row.articleCode}</td>
                        <td className="px-3 py-2 text-right">{fmt(row.expectedQty)}</td>
                        <td className="px-3 py-2 text-right">{fmt(row.scannedQty)}</td>
                        <td className="px-3 py-2 text-right">{fmt(row.missingQty)}</td>
                        <td className="px-3 py-2 text-right">{fmt(row.extraQty)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {([
                ["Missing exact references", frozen.data.comparison.missingBales],
                ["Unexpected references", frozen.data.comparison.unexpectedBales],
                ["Cross-trip differences", frozen.data.comparison.crossTripBales],
              ] as const).map(([title, rows]) => rows.length ? (
                <div className="space-y-1" key={title}>
                  <h4 className="text-xs font-semibold">{title} ({rows.length})</h4>
                  <p className="max-h-32 overflow-y-auto rounded-md bg-slate-50 p-2 font-mono text-xs dark:bg-slate-800">
                    {rows.map((row) => row.baleReference + " (" + row.articleCode + ")").join(" · ")}
                  </p>
                </div>
              ) : null)}
            </div>
          )}
          <DialogFooter><Button variant="outline" onClick={() => setFrozenClosureId(null)}>Close</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
