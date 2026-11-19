// Extracted from ./FactoryLoadingDispatchLifecycle.tsx
import { AlertTriangle, CheckCircle2, FileSearch, LockKeyhole, Loader2 } from "lucide-react";
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
import { errorMessage, fmt, useFactoryLoadingDispatchLifecycleState } from "./useFactoryLoadingDispatchLifecycleState";

export function FactoryLoadingDispatchLifecycleDialog({
  canConfirmEnd,
  closeConfirmed,
  closeOpen,
  discrepancyReason,
  dispatchId,
  endMutation,
  hasApproval,
  issues,
  navigate,
  orderId,
  preview,
  s,
  setCloseConfirmed,
  setCloseOpen,
  setDiscrepancyReason,
  supervisory,
}: Pick<
  ReturnType<typeof useFactoryLoadingDispatchLifecycleState>,
  | "canConfirmEnd"
  | "closeConfirmed"
  | "closeOpen"
  | "discrepancyReason"
  | "dispatchId"
  | "endMutation"
  | "hasApproval"
  | "issues"
  | "navigate"
  | "orderId"
  | "preview"
  | "s"
  | "setCloseConfirmed"
  | "setCloseOpen"
  | "setDiscrepancyReason"
  | "supervisory"
>) {
  return (
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
            Review the current physical truck verification. Ending will lock this trip, not the parent loading or other
            trucks.
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
                <CheckCircle2 className="h-4 w-4" /> No scan anomalies found. This trip can be ended without an expected
                truck plan.
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
  );
}
