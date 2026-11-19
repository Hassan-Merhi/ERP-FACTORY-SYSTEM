// Extracted from ./RemoteSupportWatchDialog.tsx to keep that module under the source-size cap.
import { visibleTabInterval } from "@/lib/queryPolicies";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { translateRemoteSupportPhase5Text } from "@/i18n/remoteSupportMouseTranslations";
import { apiRequest } from "@/lib/queryClient";
import {
  sendScreenFeedControlMessage,
  subscribeScreenFeedBinaryFrames,
  subscribeScreenFeedTransportStatus,
} from "@/lib/screen-feed-binary-transport";
import {
  byteRangeToArrayBuffer,
  captureFailureFromMetadata,
  groupConsecutiveActivity,
  objectRecord,
  readCapture,
  readViewport,
  type ActivityEvent,
  type CaptureFailure,
  type DisplayMode,
  type RemoteControlTabView,
  type ScreenFrame,
} from "./groupConsecutiveActivity";

export function useScreenFeedDialogState({
  userId,
  username,
  onClose,
  fastMode,
}: {
  userId: string;
  username: string;
  onClose: () => void;
  fastMode?: boolean;
}) {
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
  return {
    bindViewer,
    captureFailure,
    connected,
    displayMode,
    error,
    fastMode,
    fmtTime,
    frame,
    groupedActivity,
    onClose,
    openNativeFullscreen,
    presence,
    refetchTabs,
    selectedTab,
    selectedTabId,
    setDisplayMode,
    setSelectedTabId,
    t,
    tabListRef,
    tabs,
    userId,
    username,
    viewerSurfaceRef,
  };
}
