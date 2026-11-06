import { visibleTabInterval } from "@/lib/queryPolicies";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Clock3, History, Layers3, Maximize2, Monitor, RefreshCw, Wifi, WifiOff, X, Zap, ZoomIn } from "lucide-react";
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
  const source =
    record.source === "dom" || record.source === "retry" || record.source === "fallback" ? record.source : undefined;
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

function ScreenFeedDialog({ userId, username, onClose, fastMode }: { userId: string; username: string; onClose: () => void; fastMode?: boolean }) {
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
    queryFn: () =>
      apiRequest("GET", `/api/screen-feed/control/tabs/${encodeURIComponent(userId)}`).then((response) =>
        response.json()
      ),
    refetchInterval: visibleTabInterval(4_000),
  });
  const tabs = useMemo(
    () =>
      Array.isArray(tabsPayload?.tabs) ? tabsPayload.tabs.slice().sort((a, b) => b.lastSeenAt - a.lastSeenAt) : [],
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
    refetchInterval: visibleTabInterval(30_000),
  });
  const { data: activityRaw } = useQuery({
    queryKey: ["/api/user-presence", userId, "activity"],
    queryFn: () => apiRequest("GET", `/api/user-presence/${userId}/activity`).then((response) => response.json()),
    refetchInterval: visibleTabInterval(30_000),
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

  const tabListRef = useRef<HTMLDivElement>(null);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="dark fixed! inset-0! left-0! top-0! flex h-screen! w-screen! max-w-none! translate-x-0! translate-y-0! flex-col gap-0! overflow-hidden rounded-none! border-0! bg-[#07111f] p-0! text-slate-100 [&>button.absolute]:hidden"
        data-testid="dialog-watch-user"
        data-watched-user-id={userId}
        data-watched-tab-id={selectedTabId}
        data-screenfeed-ignore="true"
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-800/80 bg-[#0a1628] px-4 py-3 lg:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-600/20 text-blue-300">
              <Monitor className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <h2 className="truncate text-base font-bold tracking-tight lg:text-lg" data-watch-username={username}>
                  {t("Watching")} {username}
                </h2>
                <span
                  className={`hidden shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold sm:inline-flex ${frame ? "bg-emerald-500/15 text-emerald-300" : "bg-slate-700/70 text-slate-300"}`}
                  data-testid="screen-feed-connection-badge"
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${frame ? "bg-emerald-400" : "bg-amber-400"}`} />
                  {frame ? t("Live") : connected ? t("Connected") : t("Connecting…")}
                </span>
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-400">
                {connected ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
                <span>{connected ? t("Binary live feed") : t("Connecting…")}</span>
                {presence?.lastSeen ? <span>· {t("last seen")} {fmtTime(presence.lastSeen)}</span> : null}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {fastMode !== false ? (
              <span className="hidden items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/70 px-3 py-2 text-xs font-semibold text-emerald-300 md:inline-flex">
                <Zap className="h-4 w-4" /> {t("Fast mode")}
              </span>
            ) : null}
            {frame?.viewport ? (
              <span className="hidden items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/70 px-3 py-2 text-xs text-slate-300 xl:inline-flex">
                <Monitor className="h-4 w-4 text-blue-300" />
                {frame.viewport.width} × {frame.viewport.height}
              </span>
            ) : null}
            <Button variant="ghost" size="icon" className="shrink-0 text-slate-300 hover:bg-slate-800 hover:text-white" aria-label={t("Close viewer")} onClick={onClose}>
              <X className="h-5 w-5" />
            </Button>
          </div>
        </header>

        <nav className="flex min-w-0 shrink-0 items-center gap-2 border-b border-slate-800/80 bg-[#081525] px-3 py-2.5 lg:px-5" aria-label={t("ERP tab")}>
          <div className="hidden shrink-0 items-center gap-2 pr-2 text-sm font-semibold text-slate-200 sm:flex">
            <Layers3 className="h-4 w-4 text-blue-400" />
            {t("ERP tab")}
          </div>
          <button type="button" className="hidden h-9 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white sm:flex" onClick={() => tabListRef.current?.scrollBy({ left: -320, behavior: "smooth" })} aria-label={t("Previous tabs")}>
            <ChevronLeft className="h-5 w-5" />
          </button>
          <div ref={tabListRef} className="hidden min-w-0 flex-1 gap-2 overflow-x-auto scroll-smooth [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:flex" data-testid="screen-feed-tab-strip">
            {tabs.length === 0 ? <span className="px-3 py-2 text-xs text-slate-400">{t("No active tabs")}</span> : null}
            {tabs.map((tab, index) => (
              <button
                key={tab.tabId}
                type="button"
                onClick={() => setSelectedTabId(tab.tabId)}
                aria-pressed={selectedTabId === tab.tabId}
                data-testid="button-select-remote-tab"
                className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border px-3 text-xs font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-300 ${selectedTabId === tab.tabId ? "border-blue-400 bg-blue-600/90 text-white shadow-[0_0_0_1px_rgba(96,165,250,0.4)]" : "border-slate-700 bg-slate-900/70 text-slate-300 hover:border-slate-500 hover:bg-slate-800"}`}
                title={getPageLabel(tab.route)}
              >
                <Monitor className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="max-w-44 truncate">{getPageLabel(tab.route)}</span>
                {tabs.filter((candidate) => candidate.route === tab.route).length > 1 ? (
                  <span className="rounded bg-black/20 px-1.5 py-0.5 text-[10px]">#{index + 1}</span>
                ) : null}
              </button>
            ))}
          </div>
          <label className="flex min-w-0 flex-1 items-center sm:hidden">
            <span className="sr-only">{t("ERP tab")}</span>
            <select
              value={selectedTabId}
              onChange={(event) => setSelectedTabId(event.target.value)}
              className="h-9 w-full min-w-0 rounded-lg border border-blue-600/50 bg-slate-900 px-2 text-sm text-white"
              data-testid="select-remote-support-tab"
            >
              {tabs.length === 0 ? <option value="">{t("No active tabs")}</option> : null}
              {tabs.map((tab, index) => (
                <option value={tab.tabId} key={tab.tabId}>{getPageLabel(tab.route)} #{index + 1}</option>
              ))}
            </select>
          </label>
          <button type="button" className="hidden h-9 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white sm:flex" onClick={() => tabListRef.current?.scrollBy({ left: 320, behavior: "smooth" })} aria-label={t("Next tabs")}>
            <ChevronRight className="h-5 w-5" />
          </button>
        </nav>

        {error || captureFailure ? (
          <div className="shrink-0 space-y-1 border-b border-amber-500/30 bg-amber-950/40 px-4 py-2 text-xs text-amber-100" role="alert">
            {error ? <p className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 shrink-0" />{error}</p> : null}
            {captureFailure ? (
              <p className="flex items-center gap-2" data-testid="screen-feed-capture-failure">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                {t("Screen capture issue")}: {captureFailure.reason}
                {captureFailure.stage ? ` · ${captureFailure.stage}` : ""}
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-3 lg:flex-row lg:gap-4 lg:p-4">
          <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-700/80 bg-[#091523] shadow-[0_8px_32px_rgba(0,0,0,0.24)]">
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-3 py-2 lg:px-4">
              <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                <span className={`h-2 w-2 rounded-full ${frame ? "bg-emerald-400" : "bg-amber-400"}`} />
                <span>{t("Live screen")}</span>
                <span className="hidden text-xs font-medium text-emerald-300 sm:inline">
                  {frame ? t("Streaming") : connected ? t("Preparing frame…") : t("Connecting…")}
                </span>
                {frame?.capturedAt ? (
                  <span className="hidden items-center gap-1 text-[11px] font-normal text-slate-400 md:inline-flex">
                    <Clock3 className="h-3 w-3" /> {fmtTime(frame.capturedAt)}
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800 hover:text-white"
                  onClick={() => { void refetchTabs(); bindViewer(); }}
                  title={t("Refresh")}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  <span className="ml-1.5 hidden sm:inline">{t("Refresh")}</span>
                </Button>
                <Button size="sm" variant={displayMode === "fit" ? "default" : "outline"} className="h-8 px-2.5" onClick={() => setDisplayMode("fit")} data-testid="button-feed-fit">
                  <Monitor className="mr-1.5 h-3.5 w-3.5" />{t("Fit")}
                </Button>
                <Button size="sm" variant={displayMode === "actual" ? "default" : "outline"} className="h-8 px-2.5" onClick={() => setDisplayMode("actual")} data-testid="button-feed-actual">
                  <ZoomIn className="mr-1.5 h-3.5 w-3.5" />100%
                </Button>
                <Button size="sm" variant="outline" className="h-8 border-slate-700 bg-slate-900 px-2.5 text-slate-100" onClick={openNativeFullscreen} data-testid="button-fullscreen-feed" disabled={!frame?.imageUrl} aria-label={t("Full Screen")}>
                  <Maximize2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            <div
              ref={viewerSurfaceRef}
              className={`relative flex min-h-[38vh] min-w-0 flex-1 bg-black ${displayMode === "fit" ? "items-center justify-center overflow-hidden" : "items-start justify-start overflow-auto"}`}
              data-testid="screen-feed-viewport"
            >
              {frame?.imageUrl ? (
                <img
                  src={frame.imageUrl}
                  alt={`${t("Live screen for")} ${username}`}
                  className={displayMode === "fit" ? "h-full w-full object-contain" : "max-h-none max-w-none object-none"}
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
                <div className="flex max-w-sm flex-col items-center gap-3 px-6 text-center">
                  <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-slate-700 bg-slate-900 text-slate-400">
                    <Monitor className="h-8 w-8" />
                  </div>
                  <p className="text-sm font-semibold text-slate-200">
                    {selectedTabId ? t("Preparing live screen…") : t("Waiting for an active ERP tab…")}
                  </p>
                  <p className="text-xs text-slate-500">
                    {selectedTabId ? t("Waiting for the first binary frame from this ERP tab…") : t("No active tabs")}
                  </p>
                  <RefreshCw className="h-4 w-4 animate-spin text-blue-400" aria-hidden="true" />
                </div>
              )}
            </div>
          </section>

          <aside className="flex max-h-[30vh] min-h-0 w-full shrink-0 flex-col gap-3 overflow-y-auto lg:max-h-none lg:w-[330px] lg:overflow-hidden xl:w-[352px]" data-testid="screen-feed-activity-panel">
            <div className="shrink-0 rounded-xl border border-slate-700/80 bg-[#112139] p-3 shadow-lg">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-blue-400" aria-hidden="true" />
                <h3 className="text-sm font-semibold">{t("Mouse & keyboard control")}</h3>
              </div>
              <div data-screen-feed-control-slot className="mt-2" data-screenfeed-ignore="true" />
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-700/80 bg-[#0d1b30]">
              <div className="flex shrink-0 items-center justify-between gap-2 border-b border-slate-700/60 px-4 py-3">
                <h3 className="flex items-center gap-2 text-sm font-semibold"><History className="h-4 w-4 text-blue-300" />{t("Recent activity")}</h3>
                <span className="rounded-full bg-blue-500/15 px-2 py-0.5 text-[10px] font-semibold text-blue-300">{t("Live")}</span>
              </div>
              {selectedTab ? (
                <div className="shrink-0 border-b border-slate-700/60 bg-blue-700/15 px-4 py-2.5">
                  <p className="text-[11px] text-slate-400">{t("Selected tab")}</p>
                  <p className="truncate text-sm font-semibold text-blue-100">{getPageLabel(selectedTab.route)}</p>
                </div>
              ) : null}
              <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-2 text-sm" data-testid="screen-feed-activity-list">
                {groupedActivity.length === 0 ? (
                  <p className="px-2 py-3 text-xs text-slate-400">{t("No history yet.")}</p>
                ) : groupedActivity.map((event, index) => (
                  <div
                    key={`${event.id}-${event.route}`}
                    className={`relative flex items-center gap-2.5 rounded-lg px-2 py-2 ${index === 0 ? "bg-blue-700/30 text-white" : "text-slate-300"}`}
                  >
                    <span className={`h-2 w-2 shrink-0 rounded-full ${index === 0 ? "bg-blue-400 ring-4 ring-blue-500/15" : "bg-slate-600"}`} />
                    <span className="min-w-0 flex-1 truncate font-medium">{getPageLabel(event.route)}</span>
                    {event.count > 1 ? <span className="shrink-0 rounded bg-slate-700/80 px-1.5 py-0.5 text-[10px]">×{event.count}</span> : null}
                    <time className="shrink-0 text-[11px] text-slate-400" dateTime={event.occurredAt}>{fmtTime(event.occurredAt)}</time>
                  </div>
                ))}
              </div>
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
        className="fixed! inset-0! left-0! top-0! h-screen! w-screen! max-w-none! translate-x-0! translate-y-0! rounded-none! p-0 overflow-hidden flex items-center justify-center bg-background"
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
        className="fixed! inset-0! left-0! top-0! h-screen! w-screen! max-w-none! translate-x-0! translate-y-0! rounded-none! p-0 overflow-hidden flex items-center justify-center bg-background"
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
    queryKey: ["/api/screen-feed/capabilities"],
    queryFn: () => apiRequest("GET", "/api/screen-feed/capabilities").then((response) => response.json()),
    staleTime: 15000,
    retry: 1,
  });

  if (isLoading) return <RuntimeLoadingDialog onClose={props.onClose} />;
  if (!isError && runtime?.flags?.screenFeedEnabled === false) return <RuntimeDisabledDialog onClose={props.onClose} />;
  return <ScreenFeedDialog {...props} fastMode={runtime?.flags?.fastScreenFeed} />;
}
