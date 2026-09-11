import React from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Satellite, AlertTriangle, RefreshCw, History, Loader2, ExternalLink, Clock, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { EnrichedContainerRow, fmtSkipReason, getContainerPriority } from "./gitContainerTypes";

export interface TrackingStatus {
  scraperAvailable: boolean;
  seventeenTrackConfigured: boolean;
  seventeenTrackQuotaExhausted: boolean;
  seventeenTrackRemaining: number;
  seventeenTrackMonthlyLimit: number;
  parcelsAppConfigured: boolean;
  parcelsAppQuotaExhausted: boolean;
  parcelsAppRemaining: number;
  parcelsAppMonthlyLimit: number;
}

export interface TrackingEvent {
  status: string;
  eventDate: string;
  location?: string | null;
  description?: string | null;
}

export interface TrackProgressStep {
  label: string;
  status: string;
  detail: string | null;
  ts: number;
}

interface TrackingSettingsMutation {
  isPending: boolean;
  mutate: (data: Record<string, unknown>) => void;
}

interface TrackNowMutation {
  isPending: boolean;
  mutate: () => void;
}

interface ContainerDrawerTrackingProps {
  container: EnrichedContainerRow;
  trackEnabled: boolean;
  setTrackEnabled: (v: boolean) => void;
  trackAutoUpdate: boolean;
  setTrackAutoUpdate: (v: boolean) => void;
  trackCarrierHint: string;
  setTrackCarrierHint: (v: string) => void;
  trackingSettingsMutation: TrackingSettingsMutation;
  trackNowMutation: TrackNowMutation;
  trackNowResult: unknown; // Result from trackNowMutation.data (started or TrackNowResult)
  trackProgress: TrackProgressStep[];
  trackingStatus: TrackingStatus | undefined;
  showEvents: boolean;
  setShowEvents: (v: boolean) => void;
  events: TrackingEvent[] | undefined;
  eventsLoading: boolean;
  canEdit: boolean;
}

export function ContainerDrawerTracking({
  container,
  trackEnabled,
  setTrackEnabled,
  trackAutoUpdate,
  setTrackAutoUpdate,
  trackCarrierHint,
  setTrackCarrierHint,
  trackingSettingsMutation,
  trackNowMutation,
  trackNowResult: _trackNowResult,
  trackProgress,
  trackingStatus,
  showEvents,
  setShowEvents,
  events,
  eventsLoading,
  canEdit,
}: ContainerDrawerTrackingProps) {
  const isContainerInactive = ["offloaded", "closed", "completed"].includes(container.status.toLowerCase());
  const priority = getContainerPriority(container);

  const handleSaveTrackingSettings = () => {
    trackingSettingsMutation.mutate({
      trackingEnabled: trackEnabled,
      trackingAutoUpdate: trackAutoUpdate,
      trackingCarrierHint: trackCarrierHint || null,
    });
  };

  const Row = ({
    label,
    badge,
    badgeColor: _badgeColor,
    detail,
    detailNode,
    testId,
  }: {
    label: string;
    badge: string;
    badgeColor: string;
    detail?: string;
    detailNode?: React.ReactNode;
    testId?: string;
  }) => (
    <div className="space-y-0.5" data-testid={testId}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full shrink-0 \${badgeColor}`}>{badge}</span>
      </div>
      {(detail || detailNode) && (
        <p className="text-[11px] text-muted-foreground/70 text-right leading-snug">{detailNode ?? detail}</p>
      )}
    </div>
  );

  return (
    <div className="space-y-4 pt-2">
      <Separator />

      {/* ── Auto Tracking ── */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Satellite className="h-3.5 w-3.5 text-muted-foreground" />
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Auto Tracking</p>
        </div>

        {/* Inactive container warning */}
        {isContainerInactive && (
          <div
            className="flex items-start gap-1.5 rounded-md bg-muted/50 border px-2 py-1.5"
            data-testid="banner-tracking-inactive"
          >
            <AlertTriangle className="h-3 w-3 text-muted-foreground shrink-0 mt-px" />
            <p className="text-xs text-muted-foreground">
              Tracking is disabled — container is {container?.status?.toLowerCase()}.
            </p>
          </div>
        )}

        {/* Tracking provider chain */}
        {trackingStatus && (
          <div className="rounded-md border bg-muted/20 px-3 py-2 space-y-2.5" data-testid="panel-provider-chain">
            <p className="text-xs font-medium text-muted-foreground">Tracking providers (tried in order)</p>

            <div className="space-y-1.5">
              <Row
                testId="row-http-scraper"
                label="1. HTTP scraper (no browser)"
                badge="Ready"
                badgeColor="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                detail="Direct carrier APIs — fastest, no quota. Fast-fails for Maersk/CMA."
              />

              <Row
                testId="row-maersk-public"
                label="2. Maersk public HTTP (no browser)"
                badge="Ready"
                badgeColor="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                detail="Maersk containers only — free, no API key, no quota"
              />

              <Row
                testId="row-scraper"
                label="3. Puppeteer web scraper (no quota)"
                badge={trackingStatus.scraperAvailable ? "Ready" : "Unavailable"}
                badgeColor={
                  trackingStatus.scraperAvailable
                    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                    : "bg-muted text-muted-foreground"
                }
                detail={
                  trackingStatus.scraperAvailable
                    ? "Stealth Chrome — handles Maersk & CMA anti-bot protection"
                    : "Chrome not available in this environment"
                }
              />

              <Row
                testId="row-17track"
                label="4. 17track API"
                badge={
                  !trackingStatus.seventeenTrackConfigured
                    ? "Not configured"
                    : trackingStatus.seventeenTrackQuotaExhausted
                      ? "Quota exhausted"
                      : "Ready"
                }
                badgeColor={
                  !trackingStatus.seventeenTrackConfigured
                    ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                    : trackingStatus.seventeenTrackQuotaExhausted
                      ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
                      : "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                }
                detailNode={
                  trackingStatus.seventeenTrackConfigured && (
                    <span>
                      Quota: {trackingStatus.seventeenTrackRemaining} / {trackingStatus.seventeenTrackMonthlyLimit}{" "}
                      remaining
                    </span>
                  )
                }
              />

              <Row
                testId="row-parcelsapp"
                label="5. ParcelsApp API (last resort)"
                badge={
                  !trackingStatus.parcelsAppConfigured
                    ? "Not configured"
                    : trackingStatus.parcelsAppQuotaExhausted
                      ? "Quota exhausted"
                      : "Ready"
                }
                badgeColor={
                  !trackingStatus.parcelsAppConfigured
                    ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                    : trackingStatus.parcelsAppQuotaExhausted
                      ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
                      : "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                }
                detailNode={
                  trackingStatus.parcelsAppConfigured && (
                    <span>
                      Quota: {trackingStatus.parcelsAppRemaining} / {trackingStatus.parcelsAppMonthlyLimit} remaining
                    </span>
                  )
                }
              />
            </div>
          </div>
        )}

        {/* Priority & Scheduling */}
        <div className="rounded-md border bg-muted/20 px-3 py-2 space-y-1.5" data-testid="panel-priority">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground">Auto-update scheduler</p>
            <div
              className={cn(
                "text-[10px] font-bold px-1.5 py-0.5 rounded-sm uppercase",
                priority.tier === "high"
                  ? "bg-red-100 text-red-700"
                  : priority.tier === "medium"
                    ? "bg-amber-100 text-amber-700"
                    : "bg-slate-100 text-slate-700"
              )}
            >
              {priority.label} Priority
            </div>
          </div>
          <div className="space-y-1">
            <div className="flex justify-between text-[11px]">
              <span className="text-muted-foreground">Status:</span>
              <span className="font-medium">{priority.reason}</span>
            </div>
            <div className="flex justify-between text-[11px]">
              <span className="text-muted-foreground">Interval:</span>
              <span className="font-medium">Every {priority.intervalHours} hours</span>
            </div>
            <div className="flex justify-between text-[11px]">
              <span className="text-muted-foreground">Next Check:</span>
              <span className="font-medium">
                {container.trackingNextCheckAt ? new Date(container.trackingNextCheckAt).toLocaleString() : "—"}
              </span>
            </div>
            {container.trackingLastSkipReason && (
              <div className="flex justify-between text-[11px]">
                <span className="text-muted-foreground">Last Run:</span>
                <span className="font-medium text-amber-700 italic">
                  {fmtSkipReason(container.trackingLastSkipReason)}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Settings Form */}
        <div className="space-y-3 pt-1">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-xs">Enabled</Label>
              <p className="text-[10px] text-muted-foreground">Allow system to track this container</p>
            </div>
            <Switch
              checked={trackEnabled}
              onCheckedChange={setTrackEnabled}
              disabled={!canEdit || isContainerInactive}
              data-testid="switch-tracking-enabled"
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-xs">Auto-update</Label>
              <p className="text-[10px] text-muted-foreground">Automatically poll for status changes</p>
            </div>
            <Switch
              checked={trackAutoUpdate}
              onCheckedChange={setTrackAutoUpdate}
              disabled={!canEdit || !trackEnabled || isContainerInactive}
              data-testid="switch-tracking-auto"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Carrier Hint (Optional)</Label>
            <Input
              placeholder="e.g. MAEU, MSCU, CMDU"
              value={trackCarrierHint}
              onChange={(e) => setTrackCarrierHint(e.target.value.toUpperCase())}
              disabled={!canEdit || !trackEnabled || isContainerInactive}
              className="font-mono"
              data-testid="input-tracking-hint"
            />
          </div>

          <Button
            size="sm"
            variant="outline"
            className="w-full text-xs"
            onClick={handleSaveTrackingSettings}
            disabled={!canEdit || trackingSettingsMutation.isPending}
            data-testid="button-save-tracking"
          >
            {trackingSettingsMutation.isPending && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
            Save Tracking Settings
          </Button>
        </div>

        <Separator className="my-1" />

        {/* ── Track Now ── */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
              On-demand Tracking
            </p>
            {container.trackingLastCheckedAt && (
              <span className="text-[10px] text-muted-foreground">
                Checked {new Date(container.trackingLastCheckedAt).toLocaleString()}
              </span>
            )}
          </div>

          {trackNowMutation.isPending ? (
            <div
              className="space-y-3 rounded-md border bg-sky-50/30 dark:bg-sky-900/10 p-3"
              data-testid="panel-tracking-progress"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin text-sky-600" />
                  <span className="text-sm font-medium">Tracking in progress...</span>
                </div>
                <span className="text-[10px] text-sky-600 font-mono">STEP {trackProgress.length}</span>
              </div>

              <Progress value={Math.min(100, (trackProgress.length / 5) * 100)} className="h-1.5" />

              <div className="space-y-1.5 max-h-32 overflow-y-auto pr-1 custom-scrollbar">
                {trackProgress.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground animate-pulse italic">
                    Connecting to carrier systems...
                  </p>
                ) : (
                  trackProgress.map((step, i) => (
                    <div key={i} className="flex items-start gap-2 animate-in slide-in-from-bottom-1 duration-300">
                      <div className="mt-1 h-1.5 w-1.5 rounded-full bg-sky-500 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-[11px] font-medium leading-none">{step.label}</p>
                          <span className="text-[9px] text-muted-foreground font-mono">
                            {new Date(step.ts).toLocaleTimeString([], {
                              hour12: false,
                              minute: "2-digit",
                              second: "2-digit",
                            })}
                          </span>
                        </div>
                        {step.detail && (
                          <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-1">{step.detail}</p>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : (
            <Button
              variant="default"
              className="w-full bg-sky-600 hover:bg-sky-700 text-white"
              onClick={() => trackNowMutation.mutate()}
              disabled={!canEdit || !trackEnabled || isContainerInactive}
              data-testid="button-track-now"
            >
              <RefreshCw className={cn("mr-2 h-4 w-4", trackNowMutation.isPending && "animate-spin")} />
              Track Now
            </Button>
          )}

          {/* Result of last check */}
          {container.trackingLastStatus && !trackNowMutation.isPending && (
            <div className="rounded-md border p-2.5 space-y-2" data-testid="panel-last-tracking">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-muted-foreground">Last Status</span>
                <span className="text-[10px] text-muted-foreground uppercase font-mono">
                  {container.trackingProvider}
                </span>
              </div>
              <p className="text-sm font-semibold leading-snug">{container.trackingLastStatus}</p>
              {container.trackingLastLocation && (
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <span className="shrink-0">📍</span> {container.trackingLastLocation}
                </p>
              )}
              {container.trackingLastDescription && (
                <p className="text-xs text-muted-foreground italic leading-tight border-l-2 pl-2 py-0.5">
                  "{container.trackingLastDescription}"
                </p>
              )}
              {container.trackingError && (
                <div className="mt-1 flex items-start gap-1.5 text-[10px] text-red-600 bg-red-50 dark:bg-red-900/20 p-1.5 rounded border border-red-100 dark:border-red-900/40">
                  <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
                  <span>{container.trackingError}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Events History ── */}
        <div className="pt-2">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-between px-2 text-xs font-semibold text-muted-foreground"
            onClick={() => setShowEvents(!showEvents)}
            data-testid="button-toggle-events"
          >
            <div className="flex items-center gap-2">
              <History className="h-3.5 w-3.5" />
              <span>TRACKING EVENTS HISTORY</span>
            </div>
            <ChevronDown className={cn("h-4 w-4 transition-transform", showEvents && "rotate-180")} />
          </Button>

          {showEvents && (
            <div className="mt-3 space-y-4 animate-in fade-in duration-300">
              {eventsLoading ? (
                <div className="space-y-3">
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                </div>
              ) : !events || events.length === 0 ? (
                <div className="text-center py-6 border rounded-md border-dashed">
                  <Clock className="h-6 w-6 text-muted-foreground/30 mx-auto mb-2" />
                  <p className="text-xs text-muted-foreground">No tracking events found yet.</p>
                </div>
              ) : (
                <div className="relative space-y-0 pb-2">
                  <div className="absolute left-[11px] top-2 bottom-2 w-px bg-muted-foreground/20" />
                  {events.map((ev, i) => (
                    <div key={i} className="relative pl-7 pb-4 last:pb-0">
                      <div
                        className={cn(
                          "absolute left-0 top-1 h-[22px] w-[22px] rounded-full border bg-background flex items-center justify-center z-10",
                          i === 0 ? "border-sky-500 ring-2 ring-sky-500/20" : "border-muted-foreground/30"
                        )}
                      >
                        {i === 0 ? (
                          <RefreshCw className="h-2.5 w-2.5 text-sky-600" />
                        ) : (
                          <div className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
                        )}
                      </div>
                      <div className="space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <p
                            className={cn(
                              "text-xs font-bold leading-none",
                              i === 0 ? "text-sky-700 dark:text-sky-400" : ""
                            )}
                          >
                            {ev.status}
                          </p>
                          <p className="text-[10px] text-muted-foreground whitespace-nowrap">
                            {new Date(ev.eventDate).toLocaleDateString()}
                          </p>
                        </div>
                        {ev.location && (
                          <p className="text-[11px] text-muted-foreground font-medium flex items-center gap-1">
                            <span>📍</span> {ev.location}
                          </p>
                        )}
                        {ev.description && (
                          <p className="text-[11px] text-muted-foreground/80 leading-snug">{ev.description}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {container.trackingLink && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full text-[10px] h-auto py-0 text-sky-600 underline"
                  asChild
                >
                  <a href={container.trackingLink} target="_blank" rel="noopener noreferrer">
                    View on carrier website <ExternalLink className="ml-1 h-2.5 w-2.5" />
                  </a>
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
