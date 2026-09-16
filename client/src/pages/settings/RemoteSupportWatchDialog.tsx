import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Clock, History, Maximize2, Monitor, RefreshCw, Wifi, WifiOff, X, ZoomIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { translateRemoteSupportPhase5Text } from "@/i18n/remoteSupportPhase5Translations";
import { apiRequest } from "@/lib/queryClient";
import { getPageLabel } from "./WatchUserDialog";

interface RemoteSupportRuntime {
  flags?: {
    screenFeedEnabled?: boolean;
    fastScreenFeed?: boolean;
  };
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
  dataUrl: string;
  capturedAt: string;
  receivedAt?: string;
  username?: string;
  capture?: ScreenCaptureInfo | null;
  captureFailure?: CaptureFailure | null;
  viewport?: ScreenFrameViewport | null;
}

interface ScreenFeedPayload {
  dataUrl?: string;
  capturedAt?: string;
  receivedAt?: string;
  username?: string;
  capture?: ScreenCaptureInfo | null;
  captureFailure?: CaptureFailure | null;
  viewport?: ScreenFrameViewport | null;
}

interface FastPollState {
  etag: string | null;
  frame: ScreenFrame | null;
  failure: CaptureFailure | null;
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

const FALLBACK_POLL_MS = 3000;
const MAX_LIVE_STREAM_ERRORS = 2;

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

function captureFailureFromFrame(frame: ScreenFrame | null): CaptureFailure | null {
  if (!frame) return null;
  if (frame.captureFailure?.reason) return frame.captureFailure;
  if (!frame.capture?.failureReason) return null;
  return {
    stage: frame.capture.source === "fallback" ? "capture" : "encode",
    reason: frame.capture.failureReason,
    occurredAt: frame.capturedAt,
    durationMs: frame.capture.durationMs ?? null,
  };
}

async function fetchConditionalFrame(
  userId: string,
  state: FastPollState,
  signal: AbortSignal
): Promise<FastPollState> {
  const response = await fetch(`/api/screen-feed/${encodeURIComponent(userId)}`, {
    method: "GET",
    credentials: "include",
    cache: "no-store",
    signal,
    headers: state.etag ? { "If-None-Match": state.etag } : undefined,
  });

  if (response.status === 304) return state;
  if (!response.ok) throw new Error("Screen feed request failed.");

  const payload = (await response.json()) as ScreenFeedPayload | null;
  // A 200 response without a frame is a real state transition (for example,
  // the source frame expired), not an unchanged response. Only a 304 keeps the
  // prior image in memory; otherwise an old frame could remain visible forever.
  const nextFrame = payload?.dataUrl && payload.capturedAt ? (payload as ScreenFrame) : null;
  const failure = payload?.captureFailure ?? (nextFrame ? captureFailureFromFrame(nextFrame) : null);
  return {
    etag: response.headers.get("ETag"),
    frame: nextFrame,
    failure,
  };
}

function ScreenFeedDialog({
  userId,
  username,
  onClose,
  liveTransportEnabled,
}: {
  userId: string;
  username: string;
  onClose: () => void;
  liveTransportEnabled: boolean;
}) {
  const { language } = useApplicationLanguage();
  const [frame, setFrame] = useState<ScreenFrame | null>(null);
  const [captureFailure, setCaptureFailure] = useState<CaptureFailure | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [displayMode, setDisplayMode] = useState<DisplayMode>("fit");
  const stateRef = useRef<FastPollState>({ etag: null, frame: null, failure: null });
  const connectedRef = useRef(false);
  const pollAbortRef = useRef<AbortController | null>(null);
  const viewerSurfaceRef = useRef<HTMLDivElement>(null);
  const t = useCallback((value: string) => translateRemoteSupportPhase5Text(value, language), [language]);

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

  const presence = presenceRaw && typeof presenceRaw === "object" && !Array.isArray(presenceRaw) ? presenceRaw : null;
  const activity = useMemo(() => (Array.isArray(activityRaw) ? (activityRaw as ActivityEvent[]) : []), [activityRaw]);
  const groupedActivity = useMemo(() => groupConsecutiveActivity(activity), [activity]);

  const setConnectionState = useCallback((value: boolean) => {
    connectedRef.current = value;
    setConnected(value);
  }, []);

  const pollOnce = useCallback(async () => {
    pollAbortRef.current?.abort();
    const controller = new AbortController();
    pollAbortRef.current = controller;
    setRefreshing(true);
    try {
      const next = await fetchConditionalFrame(userId, stateRef.current, controller.signal);
      stateRef.current = next;
      setFrame(next.frame);
      setCaptureFailure(next.failure);
      setError(null);
    } catch (pollError) {
      if (controller.signal.aborted) return;
      setError(pollError instanceof Error ? t(pollError.message) : t("Polling recovery failed."));
    } finally {
      if (pollAbortRef.current === controller) {
        pollAbortRef.current = null;
        setRefreshing(false);
      }
    }
  }, [t, userId]);

  useEffect(() => {
    stateRef.current = { etag: null, frame: null, failure: null };
    setFrame(null);
    setCaptureFailure(null);
    setConnectionState(false);
    setError(null);

    let closed = false;
    let eventSource: EventSource | null = null;
    let liveStreamErrors = 0;
    let liveStreamAbandoned = false;

    if (liveTransportEnabled) {
      eventSource = new EventSource(`/api/screen-feed/live/${encodeURIComponent(userId)}`, {
        withCredentials: true,
      });

      eventSource.addEventListener("ready", () => {
        if (closed || liveStreamAbandoned) return;
        liveStreamErrors = 0;
        setConnectionState(true);
        setError(null);
      });
      eventSource.addEventListener("frame", (event) => {
        if (closed || liveStreamAbandoned) return;
        try {
          const nextFrame = JSON.parse((event as MessageEvent<string>).data) as ScreenFrame;
          if (!nextFrame?.dataUrl) return;
          liveStreamErrors = 0;
          const nextFailure = captureFailureFromFrame(nextFrame);
          stateRef.current = { etag: null, frame: nextFrame, failure: nextFailure };
          setFrame(nextFrame);
          setCaptureFailure(nextFailure);
          setConnectionState(true);
          setError(null);
        } catch {
          setError(t("A live frame arrived in an invalid format."));
        }
      });
      eventSource.addEventListener("capture-failure", (event) => {
        if (closed || liveStreamAbandoned) return;
        try {
          const failure = JSON.parse((event as MessageEvent<string>).data) as CaptureFailure;
          if (!failure?.reason) return;
          stateRef.current = { ...stateRef.current, failure };
          setCaptureFailure(failure);
        } catch {
          // Polling recovery can still retrieve the sanitized diagnostic.
        }
      });
      eventSource.onerror = () => {
        if (closed || liveStreamAbandoned) return;
        liveStreamErrors += 1;
        setConnectionState(false);
        setError(t("Live connection interrupted. Polling recovery is active."));
        if (liveStreamErrors >= MAX_LIVE_STREAM_ERRORS) {
          liveStreamAbandoned = true;
          eventSource?.close();
          eventSource = null;
        }
        void pollOnce();
      };
    }

    // Prime the viewer from the conditional endpoint. Once SSE is connected,
    // the interval below goes idle and polling becomes recovery-only.
    void pollOnce();
    const intervalId = window.setInterval(() => {
      if (!liveTransportEnabled || !connectedRef.current) void pollOnce();
    }, FALLBACK_POLL_MS);

    return () => {
      closed = true;
      liveStreamAbandoned = true;
      window.clearInterval(intervalId);
      eventSource?.close();
      pollAbortRef.current?.abort();
      pollAbortRef.current = null;
      connectedRef.current = false;
      stateRef.current = { etag: null, frame: null, failure: null };
    };
  }, [liveTransportEnabled, pollOnce, setConnectionState, t, userId]);

  const fmtTime = (value: string | null | undefined) => {
    if (!value) return "—";
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
        data-screenfeed-ignore="true"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            <div className="font-semibold truncate" data-watch-username={username}>
              {t("Watching")} {username}
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {liveTransportEnabled && connected ? (
                <Wifi className="h-3.5 w-3.5" />
              ) : (
                <WifiOff className="h-3.5 w-3.5" />
              )}
              <span>{liveTransportEnabled && connected ? t("Fast live feed") : t("Polling mode")}</span>
              {frame?.capturedAt ? <span>· {new Date(frame.capturedAt).toLocaleTimeString()}</span> : null}
              {presence?.lastSeen ? (
                <span>
                  · {t("last seen")} {fmtTime(presence.lastSeen)}
                </span>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void pollOnce()} disabled={refreshing}>
              <RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
              {t("Refresh")}
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
            {frame?.dataUrl ? (
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
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
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
              displayMode === "fit"
                ? "items-center justify-center overflow-hidden"
                : "items-start justify-start overflow-auto"
            }`}
            data-testid="screen-feed-viewport"
          >
            {frame?.dataUrl ? (
              <img
                src={frame.dataUrl}
                alt={`${t("Live screen for")} ${username}`}
                className={
                  displayMode === "fit" ? "max-h-full max-w-full object-contain" : "max-h-none max-w-none object-none"
                }
                draggable={false}
                data-testid="img-screen-feed"
                data-frame-viewport-width={frame.viewport?.width ?? ""}
                data-frame-viewport-height={frame.viewport?.height ?? ""}
                data-frame-viewport-scroll-x={frame.viewport?.scrollX ?? ""}
                data-frame-viewport-scroll-y={frame.viewport?.scrollY ?? ""}
                data-frame-viewport-visual-scale={frame.viewport?.visualScale ?? ""}
                data-frame-captured-at={frame.capturedAt}
              />
            ) : (
              <div className="m-auto flex max-w-xl flex-col items-center gap-2 px-6 text-center text-sm text-white/70">
                <Clock className="h-9 w-9 opacity-40" />
                <span>
                  {captureFailure
                    ? `${t("Screen capture failed")}: ${captureFailure.reason}`
                    : t("Waiting for the first screen frame…")}
                </span>
              </div>
            )}
          </div>

          <aside className="hidden w-72 shrink-0 flex-col border-l lg:flex">
            <div className="border-b px-3 py-2">
              <p className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <History className="h-3.5 w-3.5" /> {t("Page history")}
              </p>
            </div>
            {presence?.currentRoute ? (
              <div className="border-b bg-muted/40 px-3 py-2">
                <p className="mb-0.5 text-xs text-muted-foreground">{t("Currently on")}</p>
                <p className="truncate text-sm font-semibold">{getPageLabel(presence.currentRoute)}</p>
                <p className="truncate font-mono text-xs text-muted-foreground">{presence.currentRoute}</p>
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
                      {event.count > 1 ? (
                        <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px]">×{event.count}</span>
                      ) : null}
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
          <p className="text-sm text-muted-foreground">
            {t("Enable screen feed in Remote Support settings before opening a viewer.")}
          </p>
          <Button onClick={onClose}>{t("Close")}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function RemoteSupportWatchDialog(props: { userId: string; username: string; onClose: () => void }) {
  const {
    data: runtime,
    isLoading,
    isError,
  } = useQuery<RemoteSupportRuntime>({
    // Every authorized watcher can read this; the Developer-only admin runtime
    // snapshot (queryKey: ["/api/screen-feed/admin/runtime"]) answers 403 for
    // Admin/Owner/Manager, which silently pinned them to polling mode.
    queryKey: ["/api/screen-feed/capabilities"],
    queryFn: () => apiRequest("GET", "/api/screen-feed/capabilities").then((response) => response.json()),
    staleTime: 15000,
    retry: 1,
  });

  if (isLoading) return <RuntimeLoadingDialog onClose={props.onClose} />;

  if (!isError && runtime?.flags?.screenFeedEnabled === false) {
    return <RuntimeDisabledDialog onClose={props.onClose} />;
  }

  return (
    <ScreenFeedDialog
      {...props}
      liveTransportEnabled={
        !isError && runtime?.flags?.screenFeedEnabled === true && runtime?.flags?.fastScreenFeed === true
      }
    />
  );
}
