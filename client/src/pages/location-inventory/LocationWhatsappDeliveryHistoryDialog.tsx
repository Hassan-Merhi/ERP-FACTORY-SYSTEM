import { releaseDebtEnglish } from "@/i18n/finalCloseoutTranslations";
import { History, Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  formatDateTime,
  sourceLabel,
  statusPresentation,
  type Props,
} from "./LocationWhatsappDeliveryHistoryDialogHelpers";
import { useLocationWhatsappDeliveryHistoryDialogState } from "./useLocationWhatsappDeliveryHistoryDialogState";

export function LocationWhatsappDeliveryHistoryDialog({ location, companyId, canSendWithCost }: Props) {
  const { setOpen, open, retryingId, recordChanges, historyQuery, retryMutation, handleRetry, summary, deliveries } =
    useLocationWhatsappDeliveryHistoryDialogState({ location, companyId, canSendWithCost });

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="gap-2"
        onClick={() => setOpen(true)}
        data-testid="button-location-stock-history"
      >
        <History className="h-4 w-4" /> History
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[calc(100vw-1.5rem)] sm:max-w-[760px] max-h-[90vh] overflow-hidden flex flex-col p-0">
          <DialogHeader className="px-5 pt-5 pb-3 border-b">
            <div className="flex items-start justify-between gap-3 pr-8">
              <div>
                <DialogTitle className="flex items-center gap-2">
                  <History className="h-5 w-5" />
                  <span>{releaseDebtEnglish("WhatsApp Stock Delivery History")}</span>
                </DialogTitle>
                <DialogDescription className="mt-1">
                  Manual, automatic, and retry attempts for <strong>{location.name}</strong>.
                </DialogDescription>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="gap-2 shrink-0"
                onClick={() => historyQuery.refetch()}
                disabled={historyQuery.isFetching}
                data-testid="button-refresh-location-stock-history"
              >
                {historyQuery.isFetching ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                <span className="hidden sm:inline">Refresh</span>
              </Button>
            </div>
          </DialogHeader>

          <div className="overflow-y-auto px-4 sm:px-5 py-4 space-y-4">
            {historyQuery.isLoading ? (
              <div className="py-12 flex items-center justify-center text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin mr-2" />
                <span>{releaseDebtEnglish("Loading delivery history…")}</span>
              </div>
            ) : historyQuery.isError ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
                <p className="font-medium">{releaseDebtEnglish("Could not load delivery history.")}</p>
                <p className="mt-1">
                  {historyQuery.error instanceof Error
                    ? historyQuery.error.message
                    : releaseDebtEnglish("Unknown error")}
                </p>
                <Button variant="outline" size="sm" className="mt-3" onClick={() => historyQuery.refetch()}>
                  {releaseDebtEnglish("Retry loading")}
                </Button>
              </div>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-md border p-3">
                    <p className="text-xs text-muted-foreground">{releaseDebtEnglish("Last successful send")}</p>
                    <p className="text-sm font-medium mt-1">{formatDateTime(summary?.lastSentAt ?? null)}</p>
                    {summary?.lastSentAt && (
                      <p className="text-xs text-muted-foreground mt-1">
                        {summary.lastSentSource ? sourceLabel(summary.lastSentSource) : ""}
                        {summary.lastSentIncludeCost == null
                          ? ""
                          : ` · ${summary.lastSentIncludeCost ? "WITH COST" : "WITHOUT COST"}`}
                      </p>
                    )}
                  </div>
                  <div className="rounded-md border p-3">
                    <p className="text-xs text-muted-foreground">{releaseDebtEnglish("Latest attempt")}</p>
                    <p className="text-sm font-medium mt-1">
                      {summary?.latestStatus
                        ? statusPresentation(summary.latestStatus).label
                        : releaseDebtEnglish("No attempts yet")}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">{formatDateTime(summary?.latestAt ?? null)}</p>
                  </div>
                </div>

                {deliveries.length === 0 ? (
                  <div className="rounded-md border border-dashed py-12 text-center text-sm text-muted-foreground">
                    {releaseDebtEnglish("No WhatsApp stock reports have been attempted for this location yet.")}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {deliveries.map((delivery) => {
                      const status = statusPresentation(delivery.status);
                      const StatusIcon = status.Icon;
                      const costRetryRestricted = delivery.includeCost && !canSendWithCost;
                      return (
                        <div
                          key={delivery.id}
                          className="rounded-lg border p-3 sm:p-4 space-y-3"
                          data-testid={`location-stock-delivery-${delivery.id}`}
                        >
                          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <span
                                  className={cn(
                                    "inline-flex items-center gap-1.5 text-sm font-semibold",
                                    status.className
                                  )}
                                >
                                  <StatusIcon
                                    className={cn("h-4 w-4", delivery.status === "running" && "animate-pulse")}
                                  />
                                  {status.label}
                                </span>
                                <span className="text-xs rounded-full bg-muted px-2 py-0.5">
                                  {sourceLabel(delivery.source)}
                                </span>
                                <span className="text-xs rounded-full bg-muted px-2 py-0.5 font-medium">
                                  {delivery.includeCost ? "WITH COST" : "WITHOUT COST"}
                                </span>
                                {delivery.retryOfId && (
                                  <span className="text-xs text-muted-foreground">Retry of #{delivery.retryOfId}</span>
                                )}
                              </div>
                              <p className="text-xs text-muted-foreground mt-1.5">
                                Attempt #{delivery.id} · {formatDateTime(delivery.startedAt)}
                              </p>
                            </div>

                            {recordChanges.allowed && delivery.canRetry && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="gap-2 shrink-0"
                                disabled={retryMutation.isPending || costRetryRestricted}
                                title={
                                  costRetryRestricted
                                    ? "Cost-price and total-value permission is required to retry this report"
                                    : "Retry using fresh live stock and the original report filters"
                                }
                                onClick={() => handleRetry(delivery)}
                                data-testid={`button-retry-location-stock-delivery-${delivery.id}`}
                              >
                                {retryingId === delivery.id ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <RotateCcw className="h-4 w-4" />
                                )}
                                Retry
                              </Button>
                            )}
                          </div>

                          <div className="grid gap-x-4 gap-y-2 text-xs sm:grid-cols-2 lg:grid-cols-3">
                            <div>
                              <span className="text-muted-foreground">{releaseDebtEnglish("Destination:")}</span>{" "}
                              {delivery.destinationGroupName || "Linked WhatsApp group"}
                            </div>
                            <div>
                              <span className="text-muted-foreground">{releaseDebtEnglish("User:")}</span>{" "}
                              {delivery.initiatedByUsername || delivery.initiatedByUserId || "System"}
                            </div>
                            <div>
                              <span className="text-muted-foreground">{releaseDebtEnglish("Generated:")}</span>{" "}
                              {formatDateTime(delivery.reportGeneratedAt)}
                            </div>
                            <div>
                              <span className="text-muted-foreground">{releaseDebtEnglish("Items:")}</span>{" "}
                              {delivery.itemCount ?? "—"}
                            </div>
                            <div>
                              <span className="text-muted-foreground">{releaseDebtEnglish("Pages:")}</span>{" "}
                              {delivery.pageCount ?? "—"}
                            </div>
                            <div>
                              <span className="text-muted-foreground">{releaseDebtEnglish("Completed:")}</span>{" "}
                              {formatDateTime(delivery.completedAt)}
                            </div>
                            {delivery.scheduledFor && (
                              <div>
                                <span className="text-muted-foreground">{releaseDebtEnglish("Scheduled day:")}</span>{" "}
                                {delivery.scheduledFor}
                              </div>
                            )}
                            {delivery.stockGroupName && (
                              <div>
                                <span className="text-muted-foreground">{releaseDebtEnglish("Stock group:")}</span>{" "}
                                {delivery.stockGroupName}
                              </div>
                            )}
                            {delivery.categoryName && (
                              <div>
                                <span className="text-muted-foreground">{releaseDebtEnglish("Category:")}</span>{" "}
                                {delivery.categoryName}
                              </div>
                            )}
                          </div>

                          {delivery.fileName && (
                            <p className="text-xs text-muted-foreground break-all">
                              <span className="font-medium text-foreground/80">
                                {releaseDebtEnglish("Report file:")}
                              </span>{" "}
                              {delivery.fileName}
                            </p>
                          )}

                          <p className="text-xs text-muted-foreground">
                            Filters: {delivery.includeZeroStock ? "include zero" : "exclude zero"} ·{" "}
                            {delivery.includeNegativeStock ? "include negative" : "exclude negative"}
                          </p>

                          {delivery.error && (
                            <div className="rounded-md bg-destructive/5 border border-destructive/20 px-3 py-2 text-xs text-destructive wrap-break-word">
                              {delivery.error}
                            </div>
                          )}
                          {costRetryRestricted && delivery.canRetry && (
                            <p className="text-xs text-muted-foreground">
                              This WITH COST attempt can only be retried by a user with cost-price and total-value
                              permission.
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
