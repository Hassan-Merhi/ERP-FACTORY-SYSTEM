import { releaseDebtEnglish } from "@/i18n/finalCloseoutTranslations";
import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, Clock3, History, Loader2, RefreshCw, RotateCcw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import type { InventoryLocation } from "./locationInventoryTypes";

interface DeliveryEntry {
  id: number;
  source: "manual" | "scheduled" | "retry";
  retryOfId: number | null;
  status: "running" | "sent" | "failed" | "skipped_empty";
  includeCost: boolean;
  includeZeroStock: boolean;
  includeNegativeStock: boolean;
  stockGroupId: number | null;
  stockGroupName: string | null;
  categoryId: number | null;
  categoryName: string | null;
  initiatedByUserId: string | null;
  initiatedByUsername: string | null;
  scheduledFor: string | null;
  destinationGroupName: string | null;
  reportGeneratedAt: string | null;
  itemCount: number | null;
  pageCount: number | null;
  fileName: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  canRetry: boolean;
}

interface DeliveryHistoryResponse {
  locationId: number;
  deliveries: DeliveryEntry[];
  summary: {
    latestStatus: DeliveryEntry["status"] | null;
    latestError: string | null;
    latestAt: string | null;
    lastSentAt: string | null;
    lastSentSource: DeliveryEntry["source"] | null;
    lastSentIncludeCost: boolean | null;
  };
}

interface Props {
  location: InventoryLocation;
  companyId?: number;
  canSendWithCost: boolean;
}

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function sourceLabel(source: DeliveryEntry["source"]): string {
  if (source === "scheduled") return "Automatic";
  if (source === "retry") return "Retry";
  return "Manual";
}

function statusPresentation(status: DeliveryEntry["status"]) {
  if (status === "sent")
    return { label: releaseDebtEnglish("Sent"), Icon: CheckCircle2, className: "text-green-600 dark:text-green-400" };
  if (status === "failed") return { label: "Failed", Icon: XCircle, className: "text-destructive" };
  if (status === "skipped_empty")
    return {
      label: releaseDebtEnglish("No matching stock"),
      Icon: XCircle,
      className: "text-amber-600 dark:text-amber-400",
    };
  return { label: releaseDebtEnglish("Sending"), Icon: Clock3, className: "text-blue-600 dark:text-blue-400" };
}

function newIdempotencyToken(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function LocationWhatsappDeliveryHistoryDialog({ location, companyId, canSendWithCost }: Props) {
  const [open, setOpen] = useState(false);
  const [retryingId, setRetryingId] = useState<number | null>(null);
  const retryLockRef = useRef(false);
  const { toast } = useToast();

  const historyQuery = useQuery<DeliveryHistoryResponse>({
    queryKey: ["/api/locations", location.id, "whatsapp-deliveries", companyId],
    queryFn: async () => {
      const response = await fetch(`/api/locations/${location.id}/whatsapp-deliveries?limit=50`, {
        credentials: "include",
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.message || `Failed to load delivery history: ${response.status}`);
      }
      return response.json();
    },
    enabled: open && !!companyId,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const retryMutation = useMutation({
    mutationFn: async (delivery: DeliveryEntry) => {
      setRetryingId(delivery.id);
      const idempotencyKey = newIdempotencyToken();
      const response = await apiRequest(
        "POST",
        `/api/locations/${location.id}/whatsapp-deliveries/${delivery.id}/retry`,
        { idempotencyKey }
      );
      return response.json();
    },
    onSuccess: (result) => {
      toast({
        title: result.duplicate ? "Retry already processed" : "Stock report resent",
        description: `${result.itemCount ?? 0} items sent to ${result.destinationGroupName || "the linked WhatsApp group"}.`,
      });
    },
    onError: (error: Error) => {
      toast({ title: releaseDebtEnglish("Retry failed"), description: error.message, variant: "destructive" });
    },
    onSettled: async () => {
      retryLockRef.current = false;
      setRetryingId(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/locations", location.id, "whatsapp-deliveries"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/locations", location.id, "whatsapp-schedule"] }),
      ]);
    },
  });

  const handleRetry = (delivery: DeliveryEntry) => {
    if (retryLockRef.current || retryMutation.isPending) return;
    if (delivery.includeCost && !canSendWithCost) {
      toast({
        title: releaseDebtEnglish("Cost report restricted"),
        description: releaseDebtEnglish("Cost-price and total-value permission is required to retry this report."),
        variant: "destructive",
      });
      return;
    }
    retryLockRef.current = true;
    retryMutation.mutate(delivery);
  };

  const summary = historyQuery.data?.summary;
  const deliveries = historyQuery.data?.deliveries ?? [];

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

                            {delivery.canRetry && (
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
