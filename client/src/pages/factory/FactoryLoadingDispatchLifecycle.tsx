import {
  AlertTriangle,
  CheckCircle2,
  FileClock,
  FileSearch,
  LockKeyhole,
  Loader2,
  RotateCcw,
  UnlockKeyhole,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  errorMessage,
  fmt,
  useFactoryLoadingDispatchLifecycleState,
  type Props,
} from "./useFactoryLoadingDispatchLifecycleState";
import { FactoryLoadingDispatchLifecycleDispatchLifecycle } from "./FactoryLoadingDispatchLifecycleDispatchLifecycle";

export default function FactoryLoadingDispatchLifecycle(props: Props) {
  const {
    canClose,
    canConfirmEnd,
    capabilities,
    closeConfirmed,
    closeOpen,
    closures,
    companyId,
    discrepancyReason,
    dispatchId,
    endMutation,
    formatDisplayDateTime,
    frozen,
    frozenClosureId,
    hasApproval,
    history,
    issues,
    latest,
    navigate,
    orderId,
    preview,
    previewUrl,
    reopenMutation,
    reopenOpen,
    reopenReason,
    s,
    setCloseConfirmed,
    setCloseOpen,
    setDiscrepancyReason,
    setFrozenClosureId,
    setReopenOpen,
    setReopenReason,
    setShowHistory,
    showHistory,
    status,
    supervisory,
  } = useFactoryLoadingDispatchLifecycleState(props);

  return (
    <>
      <FactoryLoadingDispatchLifecycleDispatchLifecycle
        canClose={canClose}
        capabilities={capabilities}
        closures={closures}
        companyId={companyId}
        dispatchId={dispatchId}
        formatDisplayDateTime={formatDisplayDateTime}
        history={history}
        latest={latest}
        navigate={navigate}
        orderId={orderId}
        previewUrl={previewUrl}
        setCloseConfirmed={setCloseConfirmed}
        setCloseOpen={setCloseOpen}
        setDiscrepancyReason={setDiscrepancyReason}
        setFrozenClosureId={setFrozenClosureId}
        setReopenOpen={setReopenOpen}
        setReopenReason={setReopenReason}
        setShowHistory={setShowHistory}
        showHistory={showHistory}
        status={status}
      />

      <Dialog
        open={closeOpen}
        onOpenChange={(v) => {
          if (endMutation.isPending) return;
          setCloseOpen(v);
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <LockKeyhole className="h-5 w-5 text-blue-600" /> End Dispatch
            </DialogTitle>
            <DialogDescription>
              Review the current physical truck verification. Ending will lock this trip, not the parent loading or
              other trucks.
            </DialogDescription>
          </DialogHeader>
          {preview.isPending && (
            <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Checking expected bales, scans and discrepancies…
            </div>
          )}
          {preview.isError && (
            <div role="alert" className="rounded-lg border border-red-300 p-3 text-sm text-red-700">
              {errorMessage(preview.error)}
              <Button size="sm" variant="outline" className="ml-2" onClick={() => void preview.refetch()}>
                Retry
              </Button>
            </div>
          )}
          {preview.data && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {(
                  [
                    ["Scanned bales", fmt(s?.verifiedBales)],
                    ["Scanned KG", fmt(s?.verifiedWeightKg, 3)],
                    ["Unexpected", fmt(s?.unexpectedBales)],
                  ] as const
                ).map(([name, value]) => (
                  <div className="rounded-lg bg-slate-50 p-2.5 dark:bg-[hsl(var(--factory-hue)_58%_10%)]" key={name}>
                    <p className="text-[11px] text-muted-foreground">{name}</p>
                    <p className="mt-1 font-mono text-lg font-bold">{value}</p>
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                No expected allocation is needed per truck. Remaining bales will be identified in All Trips comparison.
              </p>
              {issues.length ? (
                <div className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950/20">
                  <p className="flex items-center gap-2 text-sm font-semibold text-amber-900 dark:text-amber-200">
                    <AlertTriangle className="h-4 w-4" /> {issues.length} discrepancy check(s) need approval
                  </p>
                  <ul className="list-inside list-disc space-y-1 text-xs text-amber-900 dark:text-amber-200">
                    {issues.map((issue) => (
                      <li key={issue.code}>
                        {issue.label}
                        {issue.count !== undefined ? " (" + fmt(issue.count) + ")" : ""}
                      </li>
                    ))}
                  </ul>
                  {supervisory ? (
                    <div className="space-y-2">
                      <p className="text-xs font-semibold">Supervisor reason for closing with discrepancies</p>
                      <Textarea
                        value={discrepancyReason}
                        maxLength={1000}
                        rows={3}
                        placeholder="Explain the unexpected scanned bale(s) and why this trip may be ended"
                        onChange={(e) => setDiscrepancyReason(e.target.value)}
                        data-testid="input-dispatch-closure-reason"
                      />
                      <p className="text-[11px] text-muted-foreground">
                        Required: 10–1,000 characters. The reason and approval will be saved in permanent history.
                      </p>
                    </div>
                  ) : (
                    <p className="text-xs font-semibold text-amber-900 dark:text-amber-200">
                      Only Admin, Owner or Developer can approve and end a trip with discrepancies.
                    </p>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950/20 dark:text-emerald-200">
                  <CheckCircle2 className="h-4 w-4" /> No scan anomalies found. This trip can be ended without an
                  expected truck plan.
                </div>
              )}
              {issues.length > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setCloseOpen(false);
                    navigate("/factory/sales/loading/dispatch/" + orderId + "/" + dispatchId + "/compare");
                  }}
                  data-testid="button-review-dispatch-close-differences"
                >
                  <FileSearch className="mr-1.5 h-4 w-4" /> Review barcode differences
                </Button>
              )}
              {!preview.data.hasAnyScans && (
                <p className="text-xs font-medium text-red-600">
                  You must physically verify at least one bale before ending this dispatch.
                </p>
              )}
              <label className="flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-xs dark:border-slate-700">
                <Checkbox
                  checked={closeConfirmed}
                  disabled={endMutation.isPending}
                  onCheckedChange={(v) => setCloseConfirmed(v === true)}
                  data-testid="checkbox-confirm-end-dispatch"
                />
                <span>
                  I confirm the truck's physical verification has been reviewed and understand this dispatch will become
                  read-only.
                </span>
              </label>
            </div>
          )}
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" disabled={endMutation.isPending} onClick={() => setCloseOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!canConfirmEnd || endMutation.isPending || preview.isFetching}
              onClick={() => void endMutation.mutate()}
              data-testid="button-confirm-end-dispatch"
            >
              {endMutation.isPending ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <LockKeyhole className="mr-1.5 h-4 w-4" />
              )}
              {hasApproval ? "Approve & End" : "End & Lock Dispatch"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={reopenOpen}
        onOpenChange={(v) => {
          if (!reopenMutation.isPending) setReopenOpen(v);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RotateCcw className="h-5 w-5" /> Reopen Dispatch
            </DialogTitle>
            <DialogDescription>
              Reopening restores scanning and plan editing, but keeps the previous signed closure and audit history. A
              new closure revision will be created when you finish again.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={reopenReason}
            maxLength={1000}
            rows={3}
            onChange={(e) => setReopenReason(e.target.value)}
            placeholder="Why is this completed trip being reopened?"
            data-testid="input-reopen-dispatch-reason"
          />
          <p className="text-xs text-muted-foreground">Supervisor reason required (10–1,000 characters).</p>
          <DialogFooter>
            <Button variant="outline" disabled={reopenMutation.isPending} onClick={() => setReopenOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={
                !supervisory ||
                reopenMutation.isPending ||
                reopenReason.trim().length < 10 ||
                reopenReason.trim().length > 1000
              }
              onClick={() => void reopenMutation.mutate()}
              data-testid="button-confirm-reopen-dispatch"
            >
              {reopenMutation.isPending ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <UnlockKeyhole className="mr-1.5 h-4 w-4" />
              )}
              Reopen Trip
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(frozenClosureId)}
        onOpenChange={(v) => {
          if (!v) setFrozenClosureId(null);
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileClock className="h-5 w-5" /> Saved closure comparison
            </DialogTitle>
            <DialogDescription>
              Historical snapshot as it was when the trip ended. Later stock/loading changes do not rewrite it.
            </DialogDescription>
          </DialogHeader>
          {frozen.isPending && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading saved comparison…
            </p>
          )}
          {frozen.isError && <p className="text-sm text-red-600">{errorMessage(frozen.error)}</p>}
          {frozenClosureId && frozen.data && (
            <div className="space-y-3">
              <p className="text-sm font-semibold">
                Closure #{frozen.data.revision} · {frozen.data.closedByUsername} ·{" "}
                {formatDisplayDateTime(frozen.data.closedAt)}
              </p>
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">Verified {fmt(frozen.data.summary?.verifiedBales)}</Badge>
                <Badge variant="secondary">Expected {fmt(frozen.data.summary?.expectedBales)}</Badge>
                <Badge variant="secondary">Missing {fmt(frozen.data.summary?.missingBales)}</Badge>
                <Badge variant="secondary">Scanned KG {fmt(frozen.data.summary?.verifiedWeightKg, 3)}</Badge>
              </div>
              {frozen.data.approvedWithDiscrepancies && (
                <p className="rounded-lg bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950/20 dark:text-amber-200">
                  Supervisor approval: {frozen.data.discrepancyReason}
                </p>
              )}
              <div className="max-h-[360px] overflow-auto rounded-lg border dark:border-slate-700">
                <table className="w-full min-w-[500px] text-left text-xs">
                  <thead className="bg-slate-100 dark:bg-slate-800">
                    <tr>
                      <th className="px-3 py-2">Article</th>
                      <th className="px-3 py-2 text-right">Expected</th>
                      <th className="px-3 py-2 text-right">Scanned</th>
                      <th className="px-3 py-2 text-right">Missing</th>
                      <th className="px-3 py-2 text-right">Extra</th>
                    </tr>
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
              {(
                [
                  ["Missing exact references", frozen.data.comparison.missingBales],
                  ["Unexpected references", frozen.data.comparison.unexpectedBales],
                  ["Cross-trip differences", frozen.data.comparison.crossTripBales],
                ] as const
              ).map(([title, rows]) =>
                rows.length ? (
                  <div className="space-y-1" key={title}>
                    <h4 className="text-xs font-semibold">
                      {title} ({rows.length})
                    </h4>
                    <p className="max-h-32 overflow-y-auto rounded-md bg-slate-50 p-2 font-mono text-xs dark:bg-slate-800">
                      {rows.map((row) => row.baleReference + " (" + row.articleCode + ")").join(" · ")}
                    </p>
                  </div>
                ) : null
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setFrozenClosureId(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
