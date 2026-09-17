import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, History, Maximize2, Monitor, RefreshCw, Wifi, WifiOff, X, ZoomIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { translateRemoteSupportPhase5Text } from "@/i18n/remoteSupportPhase5Translations";
import { apiRequest } from "@/lib/queryClient";
import {
  reportScreenFeedFrameRendered,
  sendScreenFeedControlMessage,
  subscribeScreenFeedBinaryFrames,
  subscribeScreenFeedTransportStatus,
} from "@/lib/screen-feed-binary-transport";
import { getPageLabel } from "./WatchUserDialog";

interface RemoteSupportRuntime {
  flags?: { screenFeedEnabled?: boolean; fastScreenFeed?: boolean };
}

interface RemoteControlTabView {
  userId: string;
  username: string;
  tabId: string;
  companyId: number;
  route: string;
  firstSeenAt: number;
  lastSeenAt: number;
}

interface CaptureFailure {
  stage: string;
  reason: string;
  occurredAt: string;
  durationMs?: number | null;
}

interface ScreenCaptureInfo {
  source?: "dom" | "retry" | "fallback";
  durationMs?: number;
  failureReason?: string;
}

interface ScreenFrameViewport {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  visualScale: number;
}

interface ScreenFrame {
  imageUrl: string;
  capturedAt: string;
  capture?: ScreenCaptureInfo | null;
  viewport?: ScreenFrameViewport | null;
}

interface ActivityEvent {
  id: string | number;
  route: string;
  occurredAt: string;
}

interface GroupedActivityEvent extends ActivityEvent {
  count: number;
}

type DisplayMode = "fit" | "actual";

function groupConsecutiveActivity(activity: ActivityEvent[]): GroupedActivityEvent[] {
  const grouped: GroupedActivityEvent[] = [];
  for (const event of activity) {
    const previous = grouped[grouped.length - 1];
    if (previous && previous.route === event.route) {
      previous.count += 1;
      continue;
    }
    grouped.push({ ...event, count: 1 });
  }
  return grouped;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readViewport(value: unknown): ScreenFrameViewport | null {
  const record = objectRecord(value);
  if (!record) return null;
  const width = Number(record.width);
  const height = Number(record.height);
  const scrollX = Number(record.scrollX);
  const scrollY = Number(record.scrollY);
  const visualScale = Number(record.visualScale);
  if (![width, height, scrollX, scrollY, visualScale].every(Number.isFinite)) return null;
  return { width, height, scrollX, scrollY, visualScale };
}

function readCapture(value: unknown): ScreenCaptureInfo | null {
  const record = objectRecord(value);
  if (!record) return null;
  const source = record.source === "dom" || record.source === "retry" || record.source === "fallback" ? record.source : undefined;
  return {
    source,
    durationMs: typeof record.durationMs === "number" ? record.durationMs : undefined,
    failureReason: typeof record.failureReason === "string" ? record.failureReason : undefined,
  };
}

function captureFailureFromMetadata(metadata: Record<string, unknown>, capturedAt: string): CaptureFailure | null {
  const capture = readCapture(metadata.capture);
  if (!capture?.failureReason) return null;
  return {
    stage: capture.source === "fallback" ? "capture" : "encode",
    reason: capture.failureReason,
    occurredAt: capturedAt,
    durationMs: capture.durationMs ?? null,
  };
}

function byteRangeToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const start = bytes.byteOffset;
  const end = start + bytes.byteLength;
  return bytes.buffer.slice(start, end) as ArrayBuffer;
}

function ScreenFeedDialog({ userId, username, onClose }: { userId: string; username: string; onClose: () => void }) {
  const { language } = useApplicationLanguage();
  const [frame, setFrame] = useState<ScreenFrame | null>(null);
  const [captureFailure, setCaptureFailure] = useState<CaptureFailure | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [displayMode, setDisplayMode] = useState<DisplayMode>("fit");
  const [selectedTabId, setSelectedTabId] = useState("");
  const objectUrlRef = useRef<string | null>(null);
  const viewerSurfaceRef = useRef<HTMLDivElement>(null);
  const t = useCallback((value: string) => translateRemoteSupportPhase5Text(value, language), [language]);

  const { data: tabsPayload, refetch: refetchTabs } = useQuery<{ tabs?: RemoteControlTabView[] }>({
    queryKey: ["/api/screen-feed/control/tabs", userId],
    queryFn: () => apiRequest("GET", `/api/screen-feed/control/tabs/${encodeURIComponent(userId)}`).then((response) => response.json()),
    refetchInterval: 4000,
  });
  const tabs = useMemo(
    () => (Array.isArray(tabsPayload?.tabs) ? tabsPayload.tabs.slice().sort((a, b) => b.lastSeenAt - a.lastSeenAt) : []),
    [tabsPayload]
  );

  useEffect(() => {
    if (selectedTabId && tabs.some((tab) => tab.tabId === selectedTabId)) return;
    setSelectedTabId(tabs[0]?.tabId ?? "");
  }, [selectedTabId, tabs]);

  const selectedTab = useMemo(() => tabs.find((tab) => tab.tabId === selectedTabId) ?? null, [selectedTabId, tabs]);

  const { data: presenceRaw } = useQuery({
    queryKey: ["/api/user-presence", userId],
    queryFn: () => apiRequest("GET", `/api/user-presence/${userId}`).then((response) => response.json()),
    refetchInterval: 30000,
  });
  const { data: activityRaw } = useQuery({
    queryKey: ["/api/user-presence", userId, "activity"],
    queryFn: () => apiRequest("GET", `/api/user-presence/${userId}/activity`).then((response) => response.json()),
    refetchInterval: 30000,
  });

  const presence = objectRecord(presenceRaw);
  const activity = useMemo(() => (Array.isArray(activityRaw) ? (activityRaw as ActivityEvent[]) : []), [activityRaw]);
  const groupedActivity = useMemo(() => groupConsecutiveActivity(activity), [activity]);

  const bindViewer = useCallback(() => {
    if (!selectedTabId) return false;
    return sendScreenFeedControlMessage({
      type: "screen-feed:viewer-bind",
      userId,
      tabId: selectedTabId,
    });
  }, [selectedTabId, userId]);

  useEffect(() => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = null;
    setFrame(null);
    setCaptureFailure(null);
    setConnected(false);
    setError(null);
    if (!selectedTabId) return;

    const unsubscribeFrames = subscribeScreenFeedBinaryFrames((incoming) => {
      if (incoming.header.tabId !== selectedTabId) return;
      const metadata = objectRecord(incoming.header.metadata) ?? {};
      const url = URL.createObjectURL(new Blob([byteRangeToArrayBuffer(incoming.jpeg)], { type: "image/jpeg" }));
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = url;
      const next: ScreenFrame = {
        imageUrl: url,
        capturedAt: incoming.header.capturedAt,
        capture: readCapture(metadata.capture),
        viewport: readViewport(metadata.viewport),
      };
      setFrame(next);
      setCaptureFailure(captureFailureFromMetadata(metadata, incoming.header.capturedAt));
      setConnected(true);
      setError(null);
    });

    const unsubscribeStatus = subscribeScreenFeedTransportStatus((message) => {
      if (message.type === "screen-feed-transport-ready") {
        bindViewer();
        return;
      }
      if (message.type === "screen-feed:viewer-bound" && message.userId === userId && message.tabId === selectedTabId) {
        setConnected(true);
        setError(null);
        return;
      }
      if (message.type === "screen-feed:failure" && message.tabId === selectedTabId) {
        const failureRecord = objectRecord(message.failure);
        if (failureRecord && typeof failureRecord.reason === "string") {
          setCaptureFailure({
            stage: typeof failureRecord.stage === "string" ? failureRecord.stage : "pipeline",
            reason: failureRecord.reason,
            occurredAt:
              typeof failureRecord.occurredAt === "string" ? failureRecord.occurredAt : new Date().toISOString(),
            durationMs: typeof failureRecord.durationMs === "number" ? failureRecord.durationMs : null,
          });
        }
        return;
      }
      if (message.type === "screen-feed:error") {
        setConnected(false);
        setError(typeof message.message === "string" ? t(message.message) : t("Live connection interrupted."));
        return;
      }
      if (message.type === "screen-feed-transport-disconnected") {
        setConnected(false);
        setError(t("Live connection interrupted. Reconnecting…"));
      }
    });

    bindViewer();

    return () => {
      unsubscribeFrames();
      unsubscribeStatus();
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    };
  }, [bindViewer, selectedTabId, t, userId]);

  const fmtTime = (value: unknown) => {
    if (typeof value !== "string" && typeof value !== "number") return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? "—"
      : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };

  const openNativeFullscreen = () => {
    if (viewerSurfaceRef.current?.requestFullscreen) void viewerSurfaceRef.current.requestFullscreen();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="!fixed !inset-0 !left-0 !top-0 !h-screen !w-screen !max-w-none !translate-x-0 !translate-y-0 !rounded-none p-0 overflow-hidden flex flex-col bg-background"
        data-testid="dialog-watch-user"
        data-watched-user-id={userId}
        data-watched-tab-id={selectedTabId}
        data-screenfeed-ignore="true"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            <div className="font-semibold truncate" data-watch-username={username}>
              {t("Watching")} {username}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {connected ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
              <span>{connected ? t("Binary live feed") : t("Connecting…")}</span>
              {frame?.capturedAt ? <span>· {fmtTime(frame.capturedAt)}</span> : null}
              {presence?.lastSeen ? <span>· {t("last seen")} {fmtTime(presence.lastSeen)}</span> : null}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{t("ERP tab")}</span>
              <select
                value={selectedTabId}
                onChange={(event) => setSelectedTabId(event.target.value)}
                className="h-8 max-w-[320px] rounded-md border bg-background px-2 text-sm text-foreground"
                data-testid="select-remote-support-tab"
              >
                {tabs.length === 0 ? <option value="">{t("No active tabs")}</option> : null}
                {tabs.map((tab, index) => (
                  <option key={tab.tabId} value={tab.tabId}>
                    {getPageLabel(tab.route)} · {tab.route} · #{index + 1}
                  </option>
                ))}
              </select>
            </label>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void refetchTabs();
                bindViewer();
              }}
            >
              <RefreshCw className="mr-2 h-4 w-4" /> {t("Refresh")}
            </Button>
            <Button
              size="sm"
              variant={displayMode === "fit" ? "default" : "outline"}
              onClick={() => setDisplayMode("fit")}
              data-testid="button-feed-fit"
            >
              <Monitor className="mr-1.5 h-3.5 w-3.5" /> {t("Fit")}
            </Button>
            <Button
              size="sm"
              variant={displayMode === "actual" ? "default" : "outline"}
              onClick={() => setDisplayMode("actual")}
              data-testid="button-feed-actual"
            >
              <ZoomIn className="mr-1.5 h-3.5 w-3.5" /> 100%
            </Button>
            {frame?.imageUrl ? (
              <Button size="sm" variant="outline" onClick={openNativeFullscreen} data-testid="button-fullscreen-feed">
                <Maximize2 className="mr-1.5 h-3.5 w-3.5" /> {t("Full Screen")}
              </Button>
            ) : null}
            <Button variant="ghost" size="icon" aria-label={t("Close viewer")} onClick={onClose}>
              <X className="h-5 w-5" />
            </Button>
          </div>
        </div>

        {error ? (
          <div className="flex items-center gap-2 border-b bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
            <AlertTriangle className="h-4 w-4 shrink-0" /> <span>{error}</span>
          </div>
        ) : null}

        {captureFailure ? (
          <div
            className="flex items-start gap-2 border-b bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-100"
            data-testid="screen-feed-capture-failure"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {t("Screen capture issue")}: {captureFailure.reason}
              {captureFailure.stage ? ` · ${captureFailure.stage}` : ""}
            </span>
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div
            ref={viewerSurfaceRef}
            className={`flex min-w-0 flex-1 bg-black ${
              displayMode === "fit" ? "items-center justify-center overflow-hidden" : "items-start justify-start overflow-auto"
            }`}
            data-testid="screen-feed-viewport"
          >
            {frame?.imageUrl ? (
              <img
                src={frame.imageUrl}
                alt={`${t("Live screen for")} ${username}`}
                className={displayMode === "fit" ? "max-h-full max-w-full object-contain" : "max-h-none max-w-none object-none"}
                draggable={false}
                onLoad={() => reportScreenFeedFrameRendered(frame.capturedAt, selectedTabId)}
                data-testid="img-screen-feed"
                data-frame-viewport-width={frame.viewport?.width ?? ""}
                data-frame-viewport-height={frame.viewport?.height ?? ""}
                data-frame-viewport-scroll-x={frame.viewport?.scrollX ?? ""}
                data-frame-viewport-scroll-y={frame.viewport?.scrollY ?? ""}
                data-frame-viewport-visual-scale={frame.viewport?.visualScale ?? ""}
                data-frame-captured-at={frame.capturedAt}
              />
            ) : (
              <div className="flex max-w-md flex-col items-center gap-3 px-6 text-center text-sm text-white/70">
                <Monitor className="h-10 w-10" />
                <p>
                  {selectedTabId
                    ? t("Waiting for the first binary frame from this ERP tab…")
                    : t("Waiting for an active ERP tab…")}
                </p>
              </div>
            )}
          </div>

          <aside className="hidden w-80 shrink-0 flex-col border-l bg-background lg:flex" data-testid="screen-feed-activity-panel">
            <div className="flex items-center gap-2 border-b px-3 py-2 font-medium">
              <History className="h-4 w-4" /> {t("Recent activity")}
            </div>
            {selectedTab ? (
              <div className="border-b bg-muted/40 px-3 py-2">
                <p className="mb-0.5 text-xs text-muted-foreground">{t("Selected tab")}</p>
                <p className="truncate text-sm font-semibold">{getPageLabel(selectedTab.route)}</p>
                <p className="truncate font-mono text-xs text-muted-foreground">{selectedTab.route}</p>
              </div>
            ) : null}
            <div className="min-h-0 flex-1 divide-y overflow-y-auto text-sm">
              {groupedActivity.length === 0 ? (
                <p className="px-3 py-3 text-xs text-muted-foreground">{t("No history yet.")}</p>
              ) : (
                groupedActivity.map((event) => (
                  <div key={`${event.id}-${event.route}`} className="space-y-0.5 px-3 py-2">
                    <div className="flex items-center gap-2">
                      <p className="truncate font-medium leading-tight">{getPageLabel(event.route)}</p>
                      {event.count > 1 ? <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px]">×{event.count}</span> : null}
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate font-mono text-xs text-muted-foreground">{event.route}</p>
                      <p className="shrink-0 text-xs text-muted-foreground">{fmtTime(event.occurredAt)}</p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RuntimeLoadingDialog({ onClose }: { onClose: () => void }) {
  const { language } = useApplicationLanguage();
  const t = useCallback((value: string) => translateRemoteSupportPhase5Text(value, language), [language]);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="!fixed !inset-0 !left-0 !top-0 !h-screen !w-screen !max-w-none !translate-x-0 !translate-y-0 !rounded-none p-0 overflow-hidden flex items-center justify-center bg-background"
        data-screenfeed-ignore="true"
      >
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <RefreshCw className="h-4 w-4 animate-spin" /> {t("Preparing remote viewer…")}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RuntimeDisabledDialog({ onClose }: { onClose: () => void }) {
  const { language } = useApplicationLanguage();
  const t = useCallback((value: string) => translateRemoteSupportPhase5Text(value, language), [language]);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="!fixed !inset-0 !left-0 !top-0 !h-screen !w-screen !max-w-none !translate-x-0 !translate-y-0 !rounded-none p-0 overflow-hidden flex items-center justify-center bg-background"
        data-screenfeed-ignore="true"
      >
        <div className="max-w-md space-y-3 p-6 text-center">
          <AlertTriangle className="mx-auto h-8 w-8 text-amber-500" />
          <p className="font-semibold">{t("Remote screen feed is disabled.")}</p>
          <p className="text-sm text-muted-foreground">{t("Enable screen feed in Remote Support settings before opening a viewer.")}</p>
          <Button onClick={onClose}>{t("Close")}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function RemoteSupportWatchDialog(props: { userId: string; username: string; onClose: () => void }) {
  const { data: runtime, isLoading, isError } = useQuery<RemoteSupportRuntime>({
    queryKey: ["/api/screen-feed/capabilities"],
    queryFn: () => apiRequest("GET", "/api/screen-feed/capabilities").then((response) => response.json()),
    staleTime: 15000,
    retry: 1,
  });

  if (isLoading) return <RuntimeLoadingDialog onClose={props.onClose} />;
  if (!isError && runtime?.flags?.screenFeedEnabled === false) return <RuntimeDisabledDialog onClose={props.onClose} />;
  return <ScreenFeedDialog {...props} />;
}
