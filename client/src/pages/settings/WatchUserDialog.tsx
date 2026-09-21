import { visibleTabInterval } from "@/lib/queryPolicies";
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  AlertTriangle,
  Clock,
  Eye,
  History,
  Maximize2,
  Monitor,
  MousePointer2,
  RefreshCw,
  Wifi,
  WifiOff,
  ZoomIn,
} from "lucide-react";
import {
  calculateContainedScreenFeedSize,
  classifyScreenFeedConnection,
  formatScreenFeedDelay,
  type ScreenFeedDisplaySize,
} from "./screen-feed-viewer-layout";

export function getPageLabel(route: string): string {
  if (!route || route === "/") return "Dashboard";
  const routeLabels: Record<string, string> = {
    "/": "Dashboard",
    "/dashboard": "Dashboard",
    "/locations": "Locations",
    "/locations/inventory": "Location Inventory",
    "/stock-items": "Stock Items",
    "/stock-groups": "Stock Groups",
    "/ledger-accounts": "Ledger Accounts",
    "/vouchers": "Vouchers",
    "/vouchers/payment": "Payment Vouchers",
    "/vouchers/receipt": "Receipt Vouchers",
    "/vouchers/journal": "Journal Vouchers",
    "/vouchers/sales": "Sales Vouchers",
    "/purchase-orders": "Purchase Orders",
    "/containers": "Containers",
    "/containers/otw": "Containers OTW",
    "/employees": "Employees",
    "/customers": "Customers",
    "/suppliers": "Suppliers",
    "/bank-accounts": "Bank Accounts",
    "/reports": "Reports",
    "/reports/profit-loss": "Profit & Loss",
    "/reports/balance-sheet": "Balance Sheet",
    "/settings": "Settings",
    "/pos": "Point of Sale",
    "/pos/sales": "POS Sales",
    "/pos-transfer-orders": "POS Transfer Orders",
    "/chatbot": "AI Chatbot",
    "/deleted-items": "Deleted Items",
  };
  if (routeLabels[route]) return routeLabels[route];
  return route
    .replace(/^\//, "")
    .replace(/-/g, " ")
    .replace(/\//g, " > ")
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

interface ScreenFeedCursor {
  x: number;
  y: number;
  ts: number;
  visible: boolean;
}

interface ScreenFeedViewport {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  documentWidth: number;
  documentHeight: number;
  devicePixelRatio: number;
  visualScale: number;
}

interface ScreenFeedCapture {
  width: number;
  height: number;
  source: "dom" | "retry" | "fallback";
  quality: number;
  encodedBytes: number;
  durationMs: number;
  failureReason?: string | null;
}

interface ScreenFrame {
  dataUrl: string;
  capturedAt: string;
  receivedAt?: string;
  clientCapturedAt?: string | null;
  username: string;
  clicks: Array<{ x: number; y: number; label: string; ts: number }>;
  cursor?: ScreenFeedCursor | null;
  viewport?: ScreenFeedViewport | null;
  capture?: ScreenFeedCapture | null;
}

interface ActivityEvent {
  id: string | number;
  route: string;
  occurredAt: string;
}

interface GroupedActivityEvent extends ActivityEvent {
  count: number;
  firstOccurredAt: string;
}

type DisplayMode = "fit" | "actual";
type RecoveryState = "live" | "delayed" | "recovering" | "fallback" | "waiting";

const qualityLabels = {
  excellent: "Excellent",
  good: "Good",
  delayed: "Delayed",
  stale: "Stale",
  waiting: "Waiting",
} as const;

function formatBytes(bytes: number | undefined): string {
  if (!bytes || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  return `${Math.round(bytes / 1024)} KB`;
}

function groupConsecutiveActivity(activity: ActivityEvent[]): GroupedActivityEvent[] {
  const grouped: GroupedActivityEvent[] = [];
  for (const event of activity) {
    const previous = grouped[grouped.length - 1];
    if (previous && previous.route === event.route) {
      previous.count += 1;
      previous.firstOccurredAt = event.occurredAt;
      continue;
    }
    grouped.push({ ...event, count: 1, firstOccurredAt: event.occurredAt });
  }
  return grouped;
}

export function WatchUserDialog({
  userId,
  username,
  onClose,
}: {
  userId: string;
  username: string;
  onClose: () => void;
}) {
  const [liveConnected, setLiveConnected] = useState(false);
  const [liveFrame, setLiveFrame] = useState<ScreenFrame | null>(null);
  const [liveCursor, setLiveCursor] = useState<ScreenFeedCursor | null>(null);
  const [frameReceivedAt, setFrameReceivedAt] = useState<number | null>(null);
  const [displayMode, setDisplayMode] = useState<DisplayMode>("fit");
  const [tick, setTick] = useState(Date.now());
  const [displaySize, setDisplaySize] = useState<ScreenFeedDisplaySize>({ width: 0, height: 0 });
  const [streamGeneration, setStreamGeneration] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);

  const viewerSurfaceRef = useRef<HTMLDivElement>(null);
  const frameViewportRef = useRef<HTMLDivElement>(null);
  const watchStartRef = useRef(Date.now());
  const lastFrameIdentityRef = useRef<string | null>(null);

  const { data: presenceRaw } = useQuery({
    queryKey: ["/api/user-presence", userId],
    queryFn: () => apiRequest("GET", `/api/user-presence/${userId}`).then((response) => response.json()),
    refetchInterval: visibleTabInterval(30_000),
  });
  const { data: activityRaw } = useQuery({
    queryKey: ["/api/user-presence", userId, "activity"],
    queryFn: () => apiRequest("GET", `/api/user-presence/${userId}/activity`).then((response) => response.json()),
    refetchInterval: visibleTabInterval(30_000),
  });
  const {
    data: screenFrameRaw,
    refetch: refetchFrame,
    isFetching: isFetchingFrame,
  } = useQuery({
    queryKey: ["/api/screen-feed", userId],
    queryFn: () => apiRequest("GET", `/api/screen-feed/${userId}`).then((response) => response.json()),
    refetchInterval: liveConnected ? false : visibleTabInterval(3_000),
  });

  useEffect(() => {
    const intervalId = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(intervalId);
  }, []);

  useEffect(() => {
    setLiveConnected(false);
    setLiveFrame(null);
    setLiveCursor(null);
    setFrameReceivedAt(null);
    setStreamError(null);

    let eventSource: EventSource | null = null;
    let closed = false;
    try {
      eventSource = new EventSource(`/api/screen-feed/live/${encodeURIComponent(userId)}`, {
        withCredentials: true,
      });
      eventSource.addEventListener("ready", () => {
        if (closed) return;
        setLiveConnected(true);
        setStreamError(null);
      });
      eventSource.addEventListener("frame", (event) => {
        try {
          const frame = JSON.parse((event as MessageEvent<string>).data) as ScreenFrame;
          if (!frame?.dataUrl || !frame?.capturedAt) return;
          const identity = `${frame.capturedAt}:${frame.capture?.encodedBytes ?? frame.dataUrl.length}`;
          lastFrameIdentityRef.current = identity;
          setLiveConnected(true);
          setStreamError(null);
          setLiveFrame(frame);
          setLiveCursor(frame.cursor ?? null);
          setFrameReceivedAt(Date.now());
          setRefreshing(false);
        } catch {
          setStreamError("A live frame arrived in an invalid format.");
        }
      });
      eventSource.addEventListener("cursor", (event) => {
        try {
          const cursor = JSON.parse((event as MessageEvent<string>).data) as ScreenFeedCursor;
          if (cursor && Number.isFinite(cursor.x) && Number.isFinite(cursor.y)) setLiveCursor(cursor);
        } catch {
          // A later cursor or frame replaces the malformed event.
        }
      });
      eventSource.onerror = () => {
        if (closed) return;
        setLiveConnected(false);
        setStreamError("The live stream disconnected. Polling recovery is active.");
      };
    } catch {
      setLiveConnected(false);
      setStreamError("The browser could not open the live stream. Polling recovery is active.");
    }

    return () => {
      closed = true;
      eventSource?.close();
    };
  }, [streamGeneration, userId]);

  const presence = presenceRaw && typeof presenceRaw === "object" && !Array.isArray(presenceRaw) ? presenceRaw : null;
  const activity = useMemo(() => (Array.isArray(activityRaw) ? (activityRaw as ActivityEvent[]) : []), [activityRaw]);
  const groupedActivity = useMemo(() => groupConsecutiveActivity(activity), [activity]);
  const fallbackFrame =
    screenFrameRaw && typeof screenFrameRaw === "object" && !Array.isArray(screenFrameRaw)
      ? (screenFrameRaw as ScreenFrame)
      : null;
  const screenFrame = liveFrame ?? fallbackFrame;
  const clicks = Array.isArray(screenFrame?.clicks) ? screenFrame.clicks : [];
  const cursor = liveCursor ?? screenFrame?.cursor ?? null;

  useEffect(() => {
    if (!liveFrame && fallbackFrame?.dataUrl) {
      const identity = `${fallbackFrame.capturedAt}:${fallbackFrame.capture?.encodedBytes ?? fallbackFrame.dataUrl.length}`;
      if (lastFrameIdentityRef.current !== identity) {
        lastFrameIdentityRef.current = identity;
        setFrameReceivedAt(Date.now());
      }
      setLiveCursor(fallbackFrame.cursor ?? null);
      setRefreshing(false);
    }
  }, [fallbackFrame, liveFrame]);

  const sourceWidth = screenFrame?.capture?.width ?? screenFrame?.viewport?.width ?? 1280;
  const sourceHeight = screenFrame?.capture?.height ?? screenFrame?.viewport?.height ?? 720;

  useEffect(() => {
    const element = frameViewportRef.current;
    if (!element) return;
    const updateSize = () => {
      if (displayMode === "actual") {
        setDisplaySize({ width: sourceWidth, height: sourceHeight });
        return;
      }
      setDisplaySize(calculateContainedScreenFeedSize(element.clientWidth, element.clientHeight, sourceWidth, sourceHeight));
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [displayMode, sourceHeight, sourceWidth]);

  const isOnline =
    !!presence?.userId &&
    !!presence?.lastSeen &&
    tick - new Date(presence.lastSeen).getTime() < 3 * 60 * 1000;
  const hasScreen = !!screenFrame?.dataUrl;
  const serverTimestamp = screenFrame?.receivedAt ?? screenFrame?.capturedAt;
  const frameAgeMs = serverTimestamp ? Math.max(0, tick - new Date(serverTimestamp).getTime()) : Number.POSITIVE_INFINITY;
  const transportDelayMs =
    serverTimestamp && frameReceivedAt !== null
      ? Math.max(0, frameReceivedAt - new Date(serverTimestamp).getTime())
      : Number.NaN;
  const quality = classifyScreenFeedConnection(hasScreen, liveConnected, frameAgeMs);
  const recentClicks = clicks.filter((click) => tick - click.ts < 4000);
  const cursorVisible = !!cursor?.visible && tick - cursor.ts < 3000;
  const isFallback = screenFrame?.capture?.source === "fallback";
  const recoveryState: RecoveryState = !hasScreen
    ? "waiting"
    : isFallback
      ? "fallback"
      : refreshing || (!liveConnected && frameAgeMs > 5000)
        ? "recovering"
        : frameAgeMs > 5000
          ? "delayed"
          : "live";

  const fmtTime = (value: string | Date | null | undefined) => {
    if (!value) return "—";
    const date = new Date(value as string);
    return Number.isNaN(date.getTime())
      ? "—"
      : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };
  const timeAgo = (value: string | Date | null | undefined) => {
    if (!value) return "unknown";
    const date = new Date(value as string);
    if (Number.isNaN(date.getTime())) return "unknown";
    const seconds = Math.floor((tick - date.getTime()) / 1000);
    if (seconds < 5) return "just now";
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    return `${Math.floor(seconds / 3600)}h ago`;
  };

  const openNativeFullscreen = () => {
    if (viewerSurfaceRef.current?.requestFullscreen) void viewerSurfaceRef.current.requestFullscreen();
  };

  const requestFreshFrame = useCallback(async () => {
    setRefreshing(true);
    setStreamError(null);
    setStreamGeneration((value) => value + 1);
    try {
      await refetchFrame();
    } finally {
      window.setTimeout(() => setRefreshing(false), 5000);
    }
  }, [refetchFrame]);

  useEffect(() => {
    if (!hasScreen || frameAgeMs < 15000 || refreshing) return;
    void requestFreshFrame();
    // The age threshold prevents repeated reconnect loops.
    
  }, [frameAgeMs, hasScreen, refreshing, requestFreshFrame]);

  const frameMetadata = useMemo(() => {
    const capture = screenFrame?.capture;
    const viewport = screenFrame?.viewport;
    return {
      resolution: capture ? `${capture.width}×${capture.height}` : `${sourceWidth}×${sourceHeight}`,
      viewport: viewport ? `${viewport.width}×${viewport.height}` : "—",
      scroll: viewport ? `${viewport.scrollX}, ${viewport.scrollY}` : "—",
      zoom: viewport ? `${Math.round(viewport.visualScale * 100)}%` : "—",
      dpr: viewport ? viewport.devicePixelRatio.toFixed(2) : "—",
      source: capture?.source ?? "legacy",
      size: formatBytes(capture?.encodedBytes),
      captureTime: capture ? formatScreenFeedDelay(capture.durationMs) : "—",
      failureReason: capture?.failureReason?.trim() || null,
    };
  }, [screenFrame?.capture, screenFrame?.viewport, sourceHeight, sourceWidth]);

  const stateLabel = {
    live: "Live",
    delayed: "Delayed",
    recovering: "Recovering",
    fallback: "Fallback",
    waiting: "Waiting",
  }[recoveryState];

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="!fixed !inset-0 !left-0 !top-0 !translate-x-0 !translate-y-0 !max-w-none !w-screen !h-screen !rounded-none p-0 overflow-hidden flex flex-col"
        data-testid="dialog-watch-user"
        data-watched-user-id={String(userId)}
        data-screenfeed-ignore="true"
      >
        <div className="flex items-center gap-3 px-4 py-2.5 border-b shrink-0 flex-wrap gap-y-1">
          <span className="flex items-center gap-1.5">
            <span className={`h-2.5 w-2.5 rounded-full ${recoveryState === "live" ? "bg-green-500" : recoveryState === "delayed" ? "bg-amber-500" : recoveryState === "fallback" ? "bg-red-500" : "bg-muted-foreground/50"}`} />
            <span className="text-xs font-semibold uppercase tracking-wide">{stateLabel}</span>
          </span>
          <span className="font-semibold text-sm">Watching: {username}</span>
          {presence && (
            <span className="text-sm text-muted-foreground">
              · {presence.companyName || "Company unavailable"} · {presence.role || "—"} · last seen {timeAgo(presence.lastSeen)}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs font-medium" data-testid="screen-feed-quality">
              {liveConnected ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
              {qualityLabels[quality]}
            </span>
            <Button size="sm" variant="outline" onClick={() => void requestFreshFrame()} disabled={refreshing || isFetchingFrame} data-testid="button-request-fresh-frame">
              <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${refreshing || isFetchingFrame ? "animate-spin" : ""}`} />
              Request fresh frame
            </Button>
            <Button size="sm" variant={displayMode === "fit" ? "default" : "outline"} onClick={() => setDisplayMode("fit")} data-testid="button-feed-fit">
              <Monitor className="h-3.5 w-3.5 mr-1.5" /> Fit
            </Button>
            <Button size="sm" variant={displayMode === "actual" ? "default" : "outline"} onClick={() => setDisplayMode("actual")} data-testid="button-feed-actual">
              <ZoomIn className="h-3.5 w-3.5 mr-1.5" /> 100%
            </Button>
            {hasScreen && (
              <Button size="sm" variant="outline" onClick={openNativeFullscreen} data-testid="button-fullscreen-feed">
                <Maximize2 className="h-3.5 w-3.5 mr-1.5" /> Full Screen
              </Button>
            )}
          </div>
        </div>

        {(streamError || frameMetadata.failureReason || isFallback) && (
          <div className={`px-4 py-2 border-b text-xs flex items-start gap-2 ${isFallback ? "bg-red-500/10 text-red-700 dark:text-red-300" : "bg-amber-500/10 text-amber-700 dark:text-amber-300"}`}>
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">{isFallback ? "Full page capture failed; a simplified fallback is shown." : "The viewer is recovering the live connection."}</p>
              <p className="opacity-90 break-words">{frameMetadata.failureReason || streamError || "Waiting for the next full frame."}</p>
            </div>
          </div>
        )}

        <div className="flex flex-1 min-h-0 overflow-hidden">
          <div ref={viewerSurfaceRef} className="flex-1 min-w-0 flex flex-col overflow-hidden bg-black">
            <div
              ref={frameViewportRef}
              className={`flex-1 min-h-0 ${displayMode === "fit" ? "overflow-hidden flex items-center justify-center" : "overflow-auto flex items-start justify-start"}`}
              data-testid="screen-feed-viewport"
            >
              {hasScreen ? (
                <div className="relative shrink-0" style={{ width: displaySize.width, height: displaySize.height }} data-testid="screen-feed-frame-wrapper">
                  <img
                    src={screenFrame.dataUrl}
                    alt="Live screen of user"
                    className="block w-full h-full object-contain select-none"
                    draggable={false}
                    data-testid="img-screen-feed"
                    data-frame-viewport-width={screenFrame.viewport?.width ?? ""}
                    data-frame-viewport-height={screenFrame.viewport?.height ?? ""}
                    data-frame-viewport-scroll-x={screenFrame.viewport?.scrollX ?? ""}
                    data-frame-viewport-scroll-y={screenFrame.viewport?.scrollY ?? ""}
                    data-frame-viewport-visual-scale={screenFrame.viewport?.visualScale ?? ""}
                    data-frame-captured-at={screenFrame.capturedAt}
                  />
                  {cursorVisible && cursor && (
                    <div className="absolute pointer-events-none drop-shadow-md" style={{ left: `${cursor.x * 100}%`, top: `${cursor.y * 100}%`, transform: "translate(-2px, -2px)" }} data-testid="screen-feed-cursor">
                      <MousePointer2 className="h-5 w-5 fill-white text-black" />
                    </div>
                  )}
                  {recentClicks.map((click, index) => {
                    const opacity = Math.max(0, 1 - (tick - click.ts) / 4000);
                    return (
                      <div key={`${click.ts}-${index}`} title={click.label} style={{ position: "absolute", left: `${click.x * 100}%`, top: `${click.y * 100}%`, transform: "translate(-50%, -50%)", opacity, pointerEvents: "none" }}>
                        <span className="relative flex h-5 w-5">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-orange-400 opacity-75" />
                          <span className="relative inline-flex rounded-full h-5 w-5 bg-orange-500 border-2 border-white" />
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2 text-muted-foreground m-auto">
                  <Clock className="h-10 w-10 opacity-30" />
                  <p className="text-sm">Waiting for first frame…</p>
                  <p className="text-xs">Live delivery starts as soon as the employee browser responds.</p>
                  {tick - watchStartRef.current > 10000 && <Button size="sm" variant="outline" onClick={() => void requestFreshFrame()}>Reconnect viewer</Button>}
                </div>
              )}
            </div>

            <div className="border-t px-3 py-1.5 shrink-0 bg-background/95 text-xs text-muted-foreground">
              <div className="flex items-center gap-x-4 gap-y-1 flex-wrap">
                <span className="font-medium text-foreground">{stateLabel}</span>
                <span>Frame age: {Number.isFinite(frameAgeMs) ? formatScreenFeedDelay(frameAgeMs) : "—"}</span>
                <span>Delivery: {formatScreenFeedDelay(transportDelayMs)}</span>
                <span>Capture: {frameMetadata.resolution}</span>
                <span>Viewport: {frameMetadata.viewport}</span>
                <span>Zoom: {frameMetadata.zoom}</span>
                <span>DPR: {frameMetadata.dpr}</span>
                <span>Scroll: {frameMetadata.scroll}</span>
                <span>Frame: {frameMetadata.size}</span>
                <span>Render: {frameMetadata.captureTime}</span>
                <span>Source: {frameMetadata.source}</span>
              </div>
            </div>

            {clicks.length > 0 && (
              <div className="border-t px-3 py-1.5 shrink-0 bg-background/80 backdrop-blur-sm">
                <div className="flex items-center gap-4 flex-wrap">
                  <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide flex items-center gap-1 shrink-0"><Eye className="h-3 w-3" /> Clicks</span>
                  {[...clicks].reverse().slice(0, 6).map((click, index) => (
                    <div key={`${click.ts}-${index}`} className="flex items-center gap-1 text-xs text-muted-foreground">
                      <span className="truncate max-w-[160px]">{click.label || "—"}</span>
                      <span className="text-muted-foreground/50 shrink-0">{new Date(click.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="w-72 shrink-0 border-l flex flex-col overflow-hidden">
            <div className="px-3 py-2 border-b shrink-0">
              <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide flex items-center gap-1"><History className="h-3.5 w-3.5" /> Page history</p>
            </div>
            {isOnline && presence?.currentRoute && (
              <div className="px-3 py-2 border-b shrink-0 bg-muted/40">
                <p className="text-xs text-muted-foreground mb-0.5">Currently on</p>
                <p className="text-sm font-semibold truncate">{getPageLabel(presence.currentRoute)}</p>
                <p className="text-xs text-muted-foreground font-mono truncate">{presence.currentRoute}</p>
              </div>
            )}
            <div className="flex-1 overflow-y-auto divide-y text-sm min-h-0">
              {groupedActivity.length === 0 ? (
                <p className="text-xs text-muted-foreground px-3 py-3">No history yet — pages appear here as the user navigates.</p>
              ) : (
                groupedActivity.map((event) => (
                  <div key={`${event.id}-${event.route}`} className="px-3 py-2 space-y-0.5">
                    <div className="flex items-center gap-2">
                      <p className="font-medium leading-tight truncate">{getPageLabel(event.route)}</p>
                      {event.count > 1 && <span className="text-[10px] rounded-full bg-muted px-1.5 py-0.5 shrink-0">×{event.count}</span>}
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs text-muted-foreground font-mono truncate">{event.route}</p>
                      <p className="text-xs text-muted-foreground shrink-0">{fmtTime(event.occurredAt)}</p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
