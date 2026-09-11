import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useMutation, useQueryClient as useTQClient } from "@tanstack/react-query";
import { Loader2, RefreshCw, Settings2, AlertTriangle, Boxes, XCircle, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Radio } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { factoryApiRequest } from "@/lib/factoryApi";
import type { FactorySupplier } from "@shared/schema";
import type { ContainerWithSupplier } from "./otwHelpers";
import { ContainerStatusBadge } from "./ContainerBadges";
import { trackingStatusBadge, TrackNowProgressLog, EventTimelineSheet, TrackingSettingsSheet } from "./TrackingSheets";

interface TrackNowResult {
  success: boolean;
  containerNumber?: string | null;
  lastStatus?: string | null;
  error?: string | null;
}

const OTW_FILTER_LABELS: Record<string, string> = {
  all: "All",
  PENDING: "Pending",
  IN_TRANSIT: "In Transit",
  ARRIVED: "Arrived",
  PARTIALLY_RECEIVED: "Partially Offloaded",
};

interface OtwTrackingPanelProps {
  containers: ContainerWithSupplier[];
  suppliers?: FactorySupplier[];
  isLoading: boolean;
  trackingNowId: number | null;
  setTrackingNowId: (id: number | null) => void;
}

export function OtwTrackingPanel({ containers, isLoading, trackingNowId, setTrackingNowId }: OtwTrackingPanelProps) {
  const { toast } = useToast();
  const tqClient = useTQClient();
  const [timelineId, setTimelineId] = useState<number | null>(null);
  const [settingsContainer, setSettingsContainer] = useState<ContainerWithSupplier | null>(null);
  const [otwStatusFilter, setOtwStatusFilter] = useState<string>("PENDING");

  const filteredPanelContainers =
    otwStatusFilter === "all" ? containers : containers.filter((c) => c.status === otwStatusFilter);

  const today = new Date().toDateString();
  const _checkedToday = containers.filter((c) => {
    const fc = c;
    return fc.trackingLastCheckedAt && new Date(fc.trackingLastCheckedAt).toDateString() === today;
  }).length;
  const _withErrors = containers.filter((c) => !!(c as { trackingError: unknown }).trackingError).length;
  const timelineContainer = containers.find((c) => c.id === timelineId) ?? null;

  const trackNowMutation = useMutation({
    mutationFn: async (containerId: number) => {
      const res = await factoryApiRequest("POST", `/api/factory/container-tracking/${containerId}/track-now`, {});
      return (await res.json()) as TrackNowResult;
    },
    onMutate: (id) => {
      setTrackingNowId(id);
    },
    onSuccess: (data) => {
      setTrackingNowId(null);
      tqClient.invalidateQueries({ queryKey: ["/api/factory/containers"] });
      toast({
        title: data.success ? "Tracking updated" : "Tracking failed",
        description: data.success
          ? `${data.containerNumber}: ${data.lastStatus ?? "Status fetched"}`
          : `${data.containerNumber}: ${data.error ?? "Unknown error"}`,
        variant: data.success ? "default" : "destructive",
      });
    },
    onError: (err: ClientErrorLike) => {
      setTrackingNowId(null);
      toast({ title: "Tracking failed", description: err?.message ?? "Unknown error", variant: "destructive" });
    },
  });

  const totalWeightKg = containers.reduce((sum, c) => sum + (parseFloat((c as { totalKg: string }).totalKg) || 0), 0);

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-20 rounded-lg" />
        <Skeleton className="h-48 rounded-lg" />
      </div>
    );
  }

  if (containers.length === 0) {
    return (
      <div className="rounded-xl border overflow-hidden">
        <div className="py-16 text-center">
          <Radio className="h-12 w-12 mx-auto mb-3 text-muted-foreground opacity-40" />
          <p className="text-muted-foreground">No containers currently on the way.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-3">
          <Boxes className="h-4 w-4 text-muted-foreground" />
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wide font-semibold leading-none mb-0.5">
              Total Weight
            </p>
            <p className="text-xl font-bold tabular-nums leading-none">
              {totalWeightKg > 0 ? `${totalWeightKg.toLocaleString(undefined, { maximumFractionDigits: 0 })} kg` : "—"}
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-xl border overflow-hidden">
        <div className="flex flex-col gap-2 px-4 py-3 border-b bg-muted/20">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-sm font-semibold">OTW Container Tracking</span>
            <span className="text-xs text-muted-foreground">
              {filteredPanelContainers.length} of {containers.length} container{containers.length !== 1 ? "s" : ""}
            </span>
          </div>
          <div className="flex gap-1 flex-wrap">
            {Object.entries(OTW_FILTER_LABELS).map(([key, label]) => {
              const count = key === "all" ? containers.length : containers.filter((c) => c.status === key).length;
              if (count === 0 && key !== "all") return null;
              return (
                <Button
                  key={key}
                  variant={otwStatusFilter === key ? "default" : "outline"}
                  size="sm"
                  onClick={() => setOtwStatusFilter(key)}
                  data-testid={`button-otw-filter-${key}`}
                >
                  {label} {count > 0 && <span className="ml-1 text-xs opacity-70">({count})</span>}
                </Button>
              );
            })}
          </div>
        </div>
        <div className="overflow-auto max-h-[calc(100vh-280px)]">
          <Table wrapperClassName="overflow-visible border-0 rounded-none">
            <TableHeader className="sticky top-0 z-30 bg-background">
              <TableRow className="bg-muted border-b-2 border-border/60 hover:bg-muted">
                <TableHead className="pl-4 text-xs font-semibold text-muted-foreground uppercase tracking-wide py-2">
                  Container
                </TableHead>
                <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide py-2">
                  Supplier
                </TableHead>
                <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide py-2">
                  Status
                </TableHead>
                <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide py-2">
                  Tracking Status
                </TableHead>
                <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide py-2">
                  Location
                </TableHead>
                <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide py-2">
                  ETA
                </TableHead>
                <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide py-2">
                  Last Checked
                </TableHead>
                <TableHead className="pr-4 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide py-2">
                  Actions
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredPanelContainers.map((c) => {
                const fc = c;
                const lastChecked: Date | null = fc.trackingLastCheckedAt ? new Date(fc.trackingLastCheckedAt) : null;
                const isTracking = trackingNowId === c.id;
                const hasError = !!fc.trackingError;
                const isEnabled = fc.trackingEnabled !== false;
                const isValidNum = /^[A-Z]{4}\d{7}$/.test((c.containerNumber || "").trim().toUpperCase());

                return (
                  <TableRow
                    key={c.id}
                    data-testid={`row-tracking-container-${c.id}`}
                    className="cursor-pointer"
                    onClick={() => setTimelineId(c.id)}
                  >
                    <TableCell className="pl-4 font-mono text-sm font-medium">
                      <div className="flex flex-col gap-0.5">
                        <span>{c.containerNumber}</span>
                        {!isValidNum && (
                          <span className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
                            <AlertTriangle className="h-3 w-3" />
                            Invalid format
                          </span>
                        )}
                        {fc.trackingDetectedCarrier && (
                          <span className="text-xs text-muted-foreground">{fc.trackingDetectedCarrier}</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {fc.supplierName ?? <span className="text-muted-foreground/50">—</span>}
                    </TableCell>
                    <TableCell>
                      <ContainerStatusBadge status={c.status ?? "PENDING"} />
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      {isTracking ? (
                        <TrackNowProgressLog containerId={c.id} />
                      ) : hasError ? (
                        <div className="flex flex-col gap-0.5">
                          {trackingStatusBadge(fc.trackingLastStatus)}
                          <span className="text-xs text-destructive flex items-center gap-1">
                            <XCircle className="h-3 w-3" />
                            {fc.trackingError?.slice(0, 60)}
                            {(fc.trackingError?.length ?? 0) > 60 ? "…" : ""}
                          </span>
                        </div>
                      ) : (
                        trackingStatusBadge(fc.trackingLastStatus)
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground max-w-[180px] truncate">
                      {fc.trackingLastLocation ?? <span className="text-muted-foreground/40">—</span>}
                    </TableCell>
                    <TableCell className="text-sm">
                      {c.arrivalDate ? (
                        <span
                          className={`font-mono ${new Date(c.arrivalDate) < new Date() ? "text-amber-600 dark:text-amber-400" : ""}`}
                        >
                          {c.arrivalDate}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {lastChecked ? (
                        <div className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {lastChecked.toLocaleDateString()}{" "}
                          {lastChecked.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </div>
                      ) : (
                        <span className="text-muted-foreground/40">Never</span>
                      )}
                    </TableCell>
                    <TableCell className="pr-4" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => setSettingsContainer(c)}
                              data-testid={`button-tracking-settings-${c.id}`}
                            >
                              <Settings2 className="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Tracking Settings</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled={isTracking || !isEnabled || !isValidNum}
                              onClick={() => trackNowMutation.mutate(c.id)}
                              data-testid={`button-track-now-${c.id}`}
                            >
                              {isTracking ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <RefreshCw className="h-4 w-4" />
                              )}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {!isEnabled
                              ? "Tracking disabled"
                              : !isValidNum
                                ? "Invalid container number format"
                                : "Track Now"}
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </div>

      <EventTimelineSheet
        containerId={timelineId}
        containerNumber={timelineContainer?.containerNumber ?? ""}
        open={!!timelineId}
        onClose={() => setTimelineId(null)}
      />
      <TrackingSettingsSheet
        container={settingsContainer}
        open={!!settingsContainer}
        onClose={() => setSettingsContainer(null)}
      />
    </div>
  );
}
