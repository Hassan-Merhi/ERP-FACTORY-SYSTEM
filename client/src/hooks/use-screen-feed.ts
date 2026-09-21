import { useEffect, useRef } from "react";
import type {
  ScreenFeedClickEvent,
  ScreenFeedCursorEvent,
  ScreenFeedFailureStage,
} from "./screen-feed-capture-engine";

let captureEnginePromise: Promise<typeof import("./screen-feed-capture-engine")> | null = null;

function loadScreenFeedCaptureEngine() {
  captureEnginePromise ??= import("./screen-feed-capture-engine");
  return captureEnginePromise;
}
import { getRemoteSupportTabId } from "./use-remote-control-session";
import {
  ACTIVE_CAPTURE_MIN_GAP_MS,
  DIRTY_SETTLE_MS,
  IDLE_REFRESH_MS,
  MAX_DIRTY_LATENCY_MS,
  adaptiveCaptureGapMs,
  failedCaptureBackoffMs,
} from "./screen-feed-capture-policy";
import { normalizeScreenFeedPoint } from "./screen-feed-viewing-quality";
import {
  sendScreenFeedControlMessage,
  subscribeScreenFeedTransportStatus,
} from "@/lib/screen-feed-binary-transport";

const POLL_INTERVAL_MS = 15000;
const UNWATCHED_POLL_INTERVAL_MS = 5000;
// Pointer telemetry is now a tiny websocket message rather than an HTTP POST.
// 100 ms is responsive enough for the remote cursor without creating request
// middleware/session-store load.
const POINTER_INTERVAL_MS = 100;
const BACKGROUND_MUTATION_MIN_GAP_MS = 4000;
const INTERACTION_ACTIVE_WINDOW_MS = 2500;

const CAPTURE_MUTATION_ATTRIBUTE_FILTER = [
  "class",
  "style",
  "value",
  "checked",
  "selected",
  "aria-expanded",
  "aria-checked",
  "data-state",
  "hidden",
];

export type ClickEvent = ScreenFeedClickEvent;

function trimLabel(el: HTMLElement): string {
  const txt =
    el.getAttribute("aria-label") ||
    el.getAttribute("placeholder") ||
    el.getAttribute("title") ||
    el.textContent?.trim() ||
    el.tagName.toLowerCase();
  return txt.slice(0, 60);
}

function runWhenIdle(fn: () => void): void {
  if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(fn, { timeout: 500 });
  else setTimeout(fn, 0);
}

function cursorsDiffer(previous: ScreenFeedCursorEvent | null, next: ScreenFeedCursorEvent): boolean {
  if (!previous) return true;
  return (
    previous.visible !== next.visible ||
    Math.abs(previous.x - next.x) > 0.002 ||
    Math.abs(previous.y - next.y) > 0.002 ||
    next.ts - previous.ts > 1000
  );
}

function compactFailureReason(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim().slice(0, 180);
  return "Unexpected screen capture pipeline failure.";
}

function reportCaptureFailure(tabId: string, stage: ScreenFeedFailureStage, reason: string, durationMs?: number): void {
  sendScreenFeedControlMessage({
    type: "screen-feed:failure",
    tabId,
    failure: { stage, reason: reason.slice(0, 180), durationMs, occurredAt: new Date().toISOString() },
  });
}

function ignoredForCapture(node: Node | null): boolean {
  const element = node instanceof Element ? node : node?.parentElement;
  if (!element) return false;
  return !!element.closest(
    "[data-screenfeed-ignore='true'], .html2canvas-container, [data-screenfeed-capture-styles='true']"
  );
}

function mutationHasVisibleChange(records: MutationRecord[]): boolean {
  for (const record of records) {
    if (ignoredForCapture(record.target)) continue;
    if (record.type === "attributes" || record.type === "characterData") return true;
    if (record.type !== "childList") continue;
    const nodes = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)];
    if (nodes.length === 0 || nodes.some((node) => !ignoredForCapture(node))) return true;
  }
  return false;
}

export function useScreenFeed() {
  const busyRef = useRef(false);
  const watchedRef = useRef(false);
  const fastModeRef = useRef(false);
  const captureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const captureDueAtRef = useRef(0);
  const pointerTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pointerRef = useRef<ScreenFeedCursorEvent | null>(null);
  const lastSentPointerRef = useRef<ScreenFeedCursorEvent | null>(null);
  const lastSignatureRef = useRef<string | null>(null);
  const lastUploadedClickTsRef = useRef(0);
  const lastCaptureAtRef = useRef(0);
  const lastInteractionAtRef = useRef(0);
  const dirtyRef = useRef(false);
  const dirtySinceRef = useRef(0);
  const pendingMinGapRef = useRef(ACTIVE_CAPTURE_MIN_GAP_MS);
  const lastCaptureDurationRef = useRef(0);
  const consecutiveFailuresRef = useRef(0);

  useEffect(() => {
    busyRef.current = false;
    const tabId = getRemoteSupportTabId();
    let disposed = false;
    let lastObservedHref = window.location.href;
    let mutationObserver: MutationObserver | null = null;
    const clickBuffer: ClickEvent[] = [];
    const trackedScrollElements = new Set<HTMLElement>();

    const clearCaptureTimer = () => {
      if (captureTimerRef.current) clearTimeout(captureTimerRef.current);
      captureTimerRef.current = null;
      captureDueAtRef.current = 0;
    };

    function scheduleAt(dueAt: number) {
      if (!watchedRef.current || document.visibilityState !== "visible" || disposed || busyRef.current) return;
      if (captureTimerRef.current && captureDueAtRef.current > 0 && captureDueAtRef.current <= dueAt) return;
      clearCaptureTimer();
      captureDueAtRef.current = dueAt;
      captureTimerRef.current = setTimeout(() => {
        captureTimerRef.current = null;
        captureDueAtRef.current = 0;
        runCaptureCycle();
      }, Math.max(0, dueAt - Date.now()));
    }

    function effectiveMinGapMs() {
      return adaptiveCaptureGapMs(pendingMinGapRef.current, lastCaptureDurationRef.current);
    }

    function scheduleIdleRefresh() {
      if (!watchedRef.current || document.visibilityState !== "visible" || disposed || busyRef.current) return;
      scheduleAt((lastCaptureAtRef.current || Date.now()) + IDLE_REFRESH_MS);
    }

    function markDirty(options?: { urgent?: boolean; minGapMs?: number }) {
      const now = Date.now();
      let urgent = options?.urgent ?? false;
      if (window.location.href !== lastObservedHref) {
        lastObservedHref = window.location.href;
        lastSignatureRef.current = null;
        urgent = true;
      }
      const requestedMinGap = options?.minGapMs ?? ACTIVE_CAPTURE_MIN_GAP_MS;
      if (!dirtyRef.current) {
        dirtySinceRef.current = now;
        pendingMinGapRef.current = requestedMinGap;
      } else {
        pendingMinGapRef.current = Math.min(pendingMinGapRef.current, requestedMinGap);
      }
      dirtyRef.current = true;
      if (!watchedRef.current || document.visibilityState !== "visible" || busyRef.current || disposed) return;
      const settleAt = urgent ? now : now + DIRTY_SETTLE_MS;
      const minGapAt = lastCaptureAtRef.current + effectiveMinGapMs();
      const maxLatencyAt = (dirtySinceRef.current || now) + MAX_DIRTY_LATENCY_MS;
      scheduleAt(Math.max(minGapAt, Math.min(settleAt, maxLatencyAt)));
    }

    function completeCaptureCycle(result: {
      uploaded: boolean;
      unchanged: boolean;
      failed: boolean;
      cancelled: boolean;
      signature: string | null;
      latestClickTs: number;
      durationMs: number;
    }) {
      lastCaptureAtRef.current = Date.now();
      lastCaptureDurationRef.current = Math.max(0, result.durationMs);
      if (result.cancelled) {
        if (watchedRef.current && document.visibilityState === "visible") {
          if (!dirtyRef.current) {
            dirtySinceRef.current = Date.now();
            pendingMinGapRef.current = ACTIVE_CAPTURE_MIN_GAP_MS;
          }
          dirtyRef.current = true;
        }
        return;
      }
      if (result.uploaded) {
        lastSignatureRef.current = result.signature;
        lastUploadedClickTsRef.current = result.latestClickTs;
      } else if (result.unchanged && result.signature) {
        lastSignatureRef.current = result.signature;
      }
      if (!result.failed) consecutiveFailuresRef.current = 0;
      if (result.failed) {
        consecutiveFailuresRef.current += 1;
        if (!dirtyRef.current) {
          dirtySinceRef.current = Date.now();
          pendingMinGapRef.current = ACTIVE_CAPTURE_MIN_GAP_MS;
        }
        dirtyRef.current = true;
      }
    }

    function finishSchedulingAfterCapture(failed: boolean) {
      if (!watchedRef.current || document.visibilityState !== "visible" || disposed) return;
      if (failed) {
        scheduleAt(
          Math.max(
            lastCaptureAtRef.current + effectiveMinGapMs(),
            Date.now() + failedCaptureBackoffMs(consecutiveFailuresRef.current)
          )
        );
      } else if (dirtyRef.current) markDirty({ minGapMs: pendingMinGapRef.current });
      else scheduleIdleRefresh();
    }

    function runCaptureCycle() {
      if (!watchedRef.current || busyRef.current || disposed || document.visibilityState !== "visible") return;
      const now = Date.now();
      if (!dirtyRef.current && lastCaptureAtRef.current && now - lastCaptureAtRef.current < IDLE_REFRESH_MS) {
        scheduleIdleRefresh();
        return;
      }
      const minGapAt = lastCaptureAtRef.current + effectiveMinGapMs();
      if (dirtyRef.current && lastCaptureAtRef.current && now < minGapAt) {
        scheduleAt(minGapAt);
        return;
      }

      busyRef.current = true;
      let failed = false;
      runWhenIdle(() => {
        if (!watchedRef.current || document.visibilityState !== "visible" || disposed) {
          busyRef.current = false;
          if (watchedRef.current) markDirty({ urgent: true });
          return;
        }
        dirtyRef.current = false;
        dirtySinceRef.current = 0;
        pendingMinGapRef.current = ACTIVE_CAPTURE_MIN_GAP_MS;
        const expectedPath = window.location.href;
        loadScreenFeedCaptureEngine()
          .then(({ captureAndUploadScreenFrame }) =>
            captureAndUploadScreenFrame({
          fast: fastModeRef.current,
          lastSignature: lastSignatureRef.current,
          lastUploadedClickTs: lastUploadedClickTsRef.current,
          cursor: pointerRef.current,
          expectedPath,
          clicks: clickBuffer,
          scrollElements: trackedScrollElements,
          shouldContinue: () => !disposed && watchedRef.current && document.visibilityState === "visible",
            })
          )
          .then((result) => {
            failed = result.failed;
            completeCaptureCycle(result);
            if (result.failed && watchedRef.current && document.visibilityState === "visible" && !disposed) {
              reportCaptureFailure(
                tabId,
                result.failureStage ?? "pipeline",
                result.failureReason ?? "Screen frame could not be produced or uploaded.",
                result.durationMs
              );
            }
          })
          .catch((error) => {
            failed = true;
            lastCaptureAtRef.current = Date.now();
            consecutiveFailuresRef.current += 1;
            if (!dirtyRef.current) {
              dirtySinceRef.current = Date.now();
              pendingMinGapRef.current = ACTIVE_CAPTURE_MIN_GAP_MS;
            }
            dirtyRef.current = true;
            if (watchedRef.current && document.visibilityState === "visible" && !disposed) {
              reportCaptureFailure(tabId, "pipeline", compactFailureReason(error));
            }
          })
          .finally(() => {
            busyRef.current = false;
            finishSchedulingAfterCapture(failed);
          });
      });
    }

    const onPointerMove = (event: PointerEvent) => {
      if (!watchedRef.current) return;
      const point = normalizeScreenFeedPoint(event.clientX, event.clientY, window.innerWidth, window.innerHeight);
      pointerRef.current = { ...point, visible: true, ts: Date.now() };
    };
    const onPointerLeave = () => {
      if (!watchedRef.current) return;
      const previous = pointerRef.current ?? { x: 0, y: 0, visible: false, ts: Date.now() };
      pointerRef.current = { ...previous, visible: false, ts: Date.now() };
    };
    const noteInteraction = () => {
      lastInteractionAtRef.current = Date.now();
    };
    const onClick = (event: MouseEvent) => {
      if (!watchedRef.current) return;
      const target =
        event.target instanceof HTMLElement
          ? event.target
          : event.target instanceof Element
            ? event.target.parentElement
            : null;
      if (!target || target.closest("[data-screenfeed-ignore='true']")) return;
      noteInteraction();
      const point = normalizeScreenFeedPoint(event.clientX, event.clientY, window.innerWidth, window.innerHeight);
      clickBuffer.push({ ...point, label: trimLabel(target), ts: Date.now() });
      if (clickBuffer.length > 50) clickBuffer.shift();
      markDirty();
    };
    const onInput = (event: Event) => {
      if (!watchedRef.current || ignoredForCapture(event.target as Node | null)) return;
      noteInteraction();
      markDirty();
    };
    const onScroll = (event: Event) => {
      if (!watchedRef.current || ignoredForCapture(event.target as Node | null)) return;
      noteInteraction();
      if (event.target instanceof HTMLElement) trackedScrollElements.add(event.target);
      markDirty();
    };
    const onResize = () => {
      if (!watchedRef.current) return;
      noteInteraction();
      lastSignatureRef.current = null;
      markDirty();
    };
    const onNavigation = () => {
      if (!watchedRef.current) return;
      noteInteraction();
      lastObservedHref = window.location.href;
      lastSignatureRef.current = null;
      markDirty({ urgent: true });
    };

    const sendPointerUpdate = () => {
      const cursor = pointerRef.current;
      if (
        !watchedRef.current ||
        document.visibilityState !== "visible" ||
        !cursor ||
        !cursorsDiffer(lastSentPointerRef.current, cursor)
      ) return;
      if (sendScreenFeedControlMessage({ type: "screen-feed:cursor", tabId, cursor })) {
        lastSentPointerRef.current = cursor;
      }
    };
    const startPointerLoop = () => {
      if (pointerTimerRef.current || document.visibilityState !== "visible") return;
      sendPointerUpdate();
      pointerTimerRef.current = setInterval(sendPointerUpdate, POINTER_INTERVAL_MS);
    };
    const stopPointerLoop = () => {
      if (pointerTimerRef.current) clearInterval(pointerTimerRef.current);
      pointerTimerRef.current = null;
      lastSentPointerRef.current = null;
    };
    const stopMutationObserver = () => {
      mutationObserver?.disconnect();
      mutationObserver = null;
    };
    const startMutationObserver = () => {
      if (mutationObserver || !watchedRef.current || document.visibilityState !== "visible") return;
      mutationObserver = new MutationObserver((records) => {
        if (!watchedRef.current || !mutationHasVisibleChange(records)) return;
        const recentlyInteractive = Date.now() - lastInteractionAtRef.current <= INTERACTION_ACTIVE_WINDOW_MS;
        markDirty({ minGapMs: recentlyInteractive ? ACTIVE_CAPTURE_MIN_GAP_MS : BACKGROUND_MUTATION_MIN_GAP_MS });
      });
      mutationObserver.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: CAPTURE_MUTATION_ATTRIBUTE_FILTER,
      });
    };

    const stopCapturing = () => {
      clearCaptureTimer();
      stopPointerLoop();
      stopMutationObserver();
      lastSignatureRef.current = null;
      lastUploadedClickTsRef.current = 0;
      lastCaptureAtRef.current = 0;
      lastInteractionAtRef.current = 0;
      lastCaptureDurationRef.current = 0;
      consecutiveFailuresRef.current = 0;
      dirtyRef.current = false;
      dirtySinceRef.current = 0;
      pendingMinGapRef.current = ACTIVE_CAPTURE_MIN_GAP_MS;
      clickBuffer.length = 0;
      trackedScrollElements.clear();
      pointerRef.current = null;
    };

    const applyWatchStatus = (watched: boolean, fast: boolean) => {
      const wasWatched = watchedRef.current;
      const modeChanged = fastModeRef.current !== fast;
      fastModeRef.current = fast;
      if (watched) {
        watchedRef.current = true;
        startMutationObserver();
        startPointerLoop();
        if (!wasWatched || modeChanged) {
          lastSignatureRef.current = null;
          markDirty({ urgent: true });
        }
      } else if (wasWatched) {
        watchedRef.current = false;
        stopCapturing();
      }
    };

    const pollWatcherStatus = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const response = await fetch(`/api/screen-feed/being-watched?tabId=${encodeURIComponent(tabId)}`, { credentials: "include" });
        if (!response.ok) return applyWatchStatus(false, false);
        const data = await response.json();
        applyWatchStatus(Boolean(data?.watched), Boolean(data?.fast));
      } catch {
        applyWatchStatus(false, false);
      }
    };

    let pollId: ReturnType<typeof setInterval> | null = null;
    let pollIntervalMs = 0;
    const stopFallbackPolling = () => {
      if (pollId) clearInterval(pollId);
      pollId = null;
      pollIntervalMs = 0;
    };
    const startFallbackPolling = () => {
      const desiredInterval = watchedRef.current ? POLL_INTERVAL_MS : UNWATCHED_POLL_INTERVAL_MS;
      if (pollId && pollIntervalMs === desiredInterval) return;
      const firstRun = !pollId;
      if (pollId) clearInterval(pollId);
      pollIntervalMs = desiredInterval;
      if (firstRun) void pollWatcherStatus();
      pollId = setInterval(() => {
        void pollWatcherStatus();
        startFallbackPolling();
      }, desiredInterval);
    };

    const bindProducer = () => {
      if (!sendScreenFeedControlMessage({ type: "screen-feed:producer-bind", tabId })) startFallbackPolling();
    };
    const unsubscribeTransport = subscribeScreenFeedTransportStatus((message) => {
      if (message.type === "screen-feed-transport-ready") {
        stopFallbackPolling();
        bindProducer();
        return;
      }
      if (message.type === "screen-feed:producer-bound") {
        stopFallbackPolling();
        return;
      }
      if (message.type === "screen-feed:status") {
        applyWatchStatus(Boolean(message.watched), Boolean(message.fast));
        return;
      }
      if (message.type === "screen-feed-transport-disconnected") startFallbackPolling();
    });
    // Recovery only. In the normal path the socket readiness event immediately
    // stops this before the first interval fires.
    startFallbackPolling();

    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        clearCaptureTimer();
        stopPointerLoop();
        stopMutationObserver();
        return;
      }
      bindProducer();
      if (watchedRef.current) {
        startMutationObserver();
        startPointerLoop();
        lastSignatureRef.current = null;
        markDirty({ urgent: true });
        sendPointerUpdate();
      }
      if (pollId) void pollWatcherStatus();
    };

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onPointerLeave, { passive: true });
    window.addEventListener("click", onClick, { capture: true });
    document.addEventListener("input", onInput, { capture: true });
    document.addEventListener("change", onInput, { capture: true });
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onResize, { passive: true });
    window.addEventListener("popstate", onNavigation);
    window.addEventListener("hashchange", onNavigation);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      disposed = true;
      unsubscribeTransport();
      stopMutationObserver();
      stopFallbackPolling();
      watchedRef.current = false;
      stopCapturing();
      window.removeEventListener("pointermove", onPointerMove);
      document.documentElement.removeEventListener("pointerleave", onPointerLeave);
      window.removeEventListener("click", onClick, true);
      document.removeEventListener("input", onInput, true);
      document.removeEventListener("change", onInput, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("popstate", onNavigation);
      window.removeEventListener("hashchange", onNavigation);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);
}
