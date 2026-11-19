// Extracted from ./WatchUserDialog.tsx: state, queries and handlers for WatchUserDialog.
import { visibleTabInterval } from "@/lib/queryPolicies";
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  calculateContainedScreenFeedSize,
  classifyScreenFeedConnection,
  formatScreenFeedDelay,
  type ScreenFeedDisplaySize,
} from "./screen-feed-viewer-layout";
import type { ScreenFrame, ScreenFeedCursor, DisplayMode, ActivityEvent, RecoveryState } from "./WatchUserDialog";
import { groupConsecutiveActivity, formatBytes } from "./WatchUserDialog";

export function useWatchUserDialogModel({
  userId,
}: {
  userId: {
    userId: string;
    username: string;
    onClose: () => void;
  }["userId"];
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
      setDisplaySize(
        calculateContainedScreenFeedSize(element.clientWidth, element.clientHeight, sourceWidth, sourceHeight)
      );
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [displayMode, sourceHeight, sourceWidth]);

  const isOnline =
    !!presence?.userId && !!presence?.lastSeen && tick - new Date(presence.lastSeen).getTime() < 3 * 60 * 1000;
  const hasScreen = !!screenFrame?.dataUrl;
  const serverTimestamp = screenFrame?.receivedAt ?? screenFrame?.capturedAt;
  const frameAgeMs = serverTimestamp
    ? Math.max(0, tick - new Date(serverTimestamp).getTime())
    : Number.POSITIVE_INFINITY;
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

  return {
    liveConnected,
    displayMode,
    setDisplayMode,
    tick,
    displaySize,
    refreshing,
    streamError,
    viewerSurfaceRef,
    frameViewportRef,
    watchStartRef,
    isFetchingFrame,
    presence,
    groupedActivity,
    screenFrame,
    clicks,
    cursor,
    isOnline,
    hasScreen,
    frameAgeMs,
    transportDelayMs,
    quality,
    recentClicks,
    cursorVisible,
    isFallback,
    recoveryState,
    fmtTime,
    timeAgo,
    openNativeFullscreen,
    requestFreshFrame,
    frameMetadata,
    stateLabel,
  };
}

export type WatchUserDialogModel = ReturnType<typeof useWatchUserDialogModel>;
