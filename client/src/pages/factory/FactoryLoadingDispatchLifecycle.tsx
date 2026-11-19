import { FileClock, Loader2, RotateCcw, UnlockKeyhole } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { LoadingState } from "@/components/ui/page-state";
import { FactoryLoadingDispatchLifecycleDialog } from "./FactoryLoadingDispatchLifecycleDialog";

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

      <FactoryLoadingDispatchLifecycleDialog
        canConfirmEnd={canConfirmEnd}
        closeConfirmed={closeConfirmed}
        closeOpen={closeOpen}
        discrepancyReason={discrepancyReason}
        dispatchId={dispatchId}
        endMutation={endMutation}
        hasApproval={hasApproval}
        issues={issues}
        navigate={navigate}
        orderId={orderId}
        preview={preview}
        s={s}
        setCloseConfirmed={setCloseConfirmed}
        setCloseOpen={setCloseOpen}
        setDiscrepancyReason={setDiscrepancyReason}
        supervisory={supervisory}
      />

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
          {frozen.isPending && <LoadingState title="Loading saved comparison…" />}
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
