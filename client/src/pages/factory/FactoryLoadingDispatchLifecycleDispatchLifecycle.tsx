// Extracted from ./FactoryLoadingDispatchLifecycle.tsx to keep that module under the source-size cap.
import {
  CheckCircle2,
  ClipboardCheck,
  FileClock,
  FileSearch,
  History,
  Loader2,
  LockKeyhole,
  UnlockKeyhole,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { queryClient } from "@/lib/queryClient";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { factoryStatusLabel } from "@shared/factoryStatusPresentation";
import { errorMessage, fmt, useFactoryLoadingDispatchLifecycleState } from "./useFactoryLoadingDispatchLifecycleState";

export function FactoryLoadingDispatchLifecycleDispatchLifecycle({
  canClose,
  capabilities,
  closures,
  companyId,
  dispatchId,
  formatDisplayDateTime,
  history,
  latest,
  navigate,
  orderId,
  previewUrl,
  setCloseConfirmed,
  setCloseOpen,
  setDiscrepancyReason,
  setFrozenClosureId,
  setReopenOpen,
  setReopenReason,
  setShowHistory,
  showHistory,
  status,
  compact = false,
}: Pick<
  ReturnType<typeof useFactoryLoadingDispatchLifecycleState>,
  | "canClose"
  | "capabilities"
  | "closures"
  | "companyId"
  | "dispatchId"
  | "formatDisplayDateTime"
  | "history"
  | "latest"
  | "navigate"
  | "orderId"
  | "previewUrl"
  | "setCloseConfirmed"
  | "setCloseOpen"
  | "setDiscrepancyReason"
  | "setFrozenClosureId"
  | "setReopenOpen"
  | "setReopenReason"
  | "setShowHistory"
  | "showHistory"
  | "status"
> & { compact?: boolean }) {
  return (
    <Card
      className={compact ? "border-0 bg-transparent shadow-none" : "border-blue-200 bg-white dark:border-blue-500/30 dark:bg-[hsl(var(--factory-hue)_53%_13%)]"}
      data-testid="dispatch-lifecycle"
    >
      <CardContent className={compact ? "space-y-2 p-0" : "space-y-3 p-4"}>
        {!compact && (
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex items-start gap-2">
            {status === "CLOSED" ? (
              <LockKeyhole className="mt-0.5 h-5 w-5 text-emerald-600" />
            ) : (
              <ClipboardCheck className="mt-0.5 h-5 w-5 text-blue-600" />
            )}
            <div>
              <h3 className="text-sm font-semibold">{status === "CLOSED" ? "Dispatch completed" : "Dispatch finalization"}</h3>
              {status !== "CLOSED" && (
                <p className="mt-1 text-xs text-muted-foreground">Scan bales, then End Dispatch.</p>
              )}
            </div>
          </div>
          {status !== "CLOSED" && <Badge variant="outline">{factoryStatusLabel("dispatch", status)}</Badge>}
        </div>

        )}

        {!compact && status === "CLOSED" && latest && (
          <div className="space-y-1 rounded-lg bg-emerald-50 p-3 text-xs text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200">
            <p className="flex items-center gap-1.5 font-semibold">
              <CheckCircle2 className="h-4 w-4" /> Completed by {latest.closedByUsername}
            </p>
            <p>
              {formatDisplayDateTime(latest.closedAt)} · Closure #{latest.revision}
            </p>
            <p>
              {fmt(latest.summary?.verifiedBales)} verified bales · {fmt(latest.summary?.verifiedWeightKg, 3)} kg
            </p>
            {latest.approvedWithDiscrepancies && (
              <p className="font-semibold">Discrepancy approval: {latest.discrepancyReason}</p>
            )}
          </div>
        )}

        <div className={compact ? "flex flex-col gap-2" : "flex flex-wrap items-center gap-2"}>
          {canClose && (
            <Button
              size="sm"
              className={compact ? "w-full justify-start" : undefined}
              variant={compact ? "outline" : "default"}
              onClick={() => {
                setCloseConfirmed(false);
                setDiscrepancyReason("");
                setCloseOpen(true);
                void queryClient.invalidateQueries({ queryKey: companyQueryKey(previewUrl, companyId) });
              }}
              data-testid="button-end-dispatch"
            >
              <LockKeyhole className="mr-1.5 h-4 w-4" /> End Dispatch
            </Button>
          )}
          {status === "CLOSED" && capabilities["dispatch.reopen"] && (
            <Button
              size="sm"
              variant="outline"
              className={compact ? "w-full justify-start" : undefined}
              onClick={() => {
                setReopenReason("");
                setReopenOpen(true);
              }}
              data-testid="button-reopen-dispatch"
            >
              <UnlockKeyhole className="mr-1.5 h-4 w-4" /> Reopen
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className={compact ? "w-full justify-start" : undefined}
            onClick={() => setShowHistory((v) => !v)}
            data-testid="button-dispatch-audit-history"
          >
            <History className="mr-1.5 h-4 w-4" /> {showHistory ? "Hide history" : compact ? "Trip history" : "Closure & audit history"}
          </Button>
        </div>
        {showHistory && (
          <div className="space-y-3 border-t pt-3 dark:border-slate-700">
            {history.isLoading && (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading history…
              </p>
            )}
            {history.isError && <p className="text-xs text-red-600">{errorMessage(history.error)}</p>}
            {!history.isLoading && closures.length === 0 && (
              <p className="text-xs text-muted-foreground">No closures yet. This trip is still open.</p>
            )}
            {closures.map((closure) => (
              <div key={String(closure.id)} className="space-y-2 rounded-lg border p-3 text-xs dark:border-slate-700">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold">
                    Closure #{closure.revision} · {closure.closedByUsername}
                  </span>
                  <Badge variant="outline">{closure.reopenedAt ? "Reopened" : "Finalized"}</Badge>
                </div>
                <p className="text-muted-foreground">
                  {formatDisplayDateTime(closure.closedAt)} · {fmt(closure.summary?.verifiedBales)} bales ·{" "}
                  {fmt(closure.summary?.verifiedWeightKg, 3)} kg
                </p>
                {closure.approvedWithDiscrepancies && (
                  <p className="text-amber-700 dark:text-amber-300">
                    Approved with discrepancies: {closure.discrepancyReason}
                  </p>
                )}
                {closure.reopenedAt && (
                  <p className="text-blue-700 dark:text-sky-300">
                    Reopened by {closure.reopenedByUsername} on {formatDisplayDateTime(closure.reopenedAt)} —{" "}
                    {closure.reopenReason}
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    onClick={() => setFrozenClosureId(String(closure.id))}
                    data-testid={"button-view-closure-" + closure.id}
                  >
                    <FileSearch className="mr-1 h-3.5 w-3.5" /> View saved comparison
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    onClick={() =>
                      navigate(
                        "/factory/sales/loading/dispatch/" +
                          orderId +
                          "/" +
                          dispatchId +
                          "/report?closureId=" +
                          closure.id
                      )
                    }
                    data-testid={"button-print-closure-" + closure.id}
                  >
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
                    <div
                      key={String(event.id)}
                      className="flex flex-wrap justify-between gap-2 rounded-lg bg-slate-50 p-2 text-xs dark:bg-[hsl(var(--factory-hue)_63%_11%)]"
                    >
                      <span className="font-medium">{event.eventType.replace(/_/g, " ")}</span>
                      <span className="text-muted-foreground">
                        {event.actorUsername} · {formatDisplayDateTime(event.createdAt)}
                      </span>
                    </div>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Showing recent activity. Closure revisions remain available permanently.
                </p>
              </div>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
