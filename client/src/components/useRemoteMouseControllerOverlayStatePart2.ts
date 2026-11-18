// Extracted from ./RemoteMouseControllerOverlay.tsx to keep that module under the source-size cap.
import { useCallback, useEffect } from "react";
import { remoteControllerRequestJson } from "@/components/RemoteControllerSessionContext";
import {
  applyRemoteControlRateLimit,
  clearRemoteControlRateLimit,
  decideRemoteControlCommand,
  isRemoteControlRateLimitError,
  remoteControlSendDelayMs,
} from "@/hooks/remote-control-command-flow";
import {
  normalizeRemoteMousePoint,
  normalizeRemoteWheelDelta,
  parseFrameViewportFromDataset,
  type RemoteMouseFrameSize,
} from "@/hooks/remote-mouse-control-policy";
import {
  RemoteControlRealtimeError,
  requestRemoteControlRealtime,
  subscribeRemoteControlRealtime,
  subscribeRemoteControlRealtimeReady,
} from "@/lib/remote-control-session-transport";
import {
  POINTER_COALESCE_MS,
  SCROLL_COALESCE_MS,
  useRemoteMouseControllerOverlayStatePart1,
  type CommandResultView,
  type MouseCommandPayload,
} from "./useRemoteMouseControllerOverlayStatePart1";

export function useRemoteMouseControllerOverlayStatePart2({
  activeSessionIdRef,
  busy,
  commandTailRef,
  controlEnabled,
  keyboardActive,
  pointerLatestRef,
  pointerQueueActiveRef,
  pointerQueueSessionRef,
  pointerTimerRef,
  portalHost,
  rateGateRef,
  refreshSession,
  schedulePointerDrainRef,
  screenImage,
  scrollPendingRef,
  scrollTimerRef,
  sessionId,
  sessionTargetUserId,
  setBusy,
  setError,
  setLastResult,
  setPasswordOpen,
  setScreenImage,
  t,
}: Pick<
  Awaited<ReturnType<typeof useRemoteMouseControllerOverlayStatePart1>>,
  | "activeSessionIdRef"
  | "busy"
  | "commandTailRef"
  | "controlEnabled"
  | "keyboardActive"
  | "pointerLatestRef"
  | "pointerQueueActiveRef"
  | "pointerQueueSessionRef"
  | "pointerTimerRef"
  | "portalHost"
  | "rateGateRef"
  | "refreshSession"
  | "schedulePointerDrainRef"
  | "screenImage"
  | "scrollPendingRef"
  | "scrollTimerRef"
  | "sessionId"
  | "sessionTargetUserId"
  | "setBusy"
  | "setError"
  | "setLastResult"
  | "setPasswordOpen"
  | "setScreenImage"
  | "t"
>) {
  const stopCombined = useCallback(async () => {
    if (!sessionId || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (keyboardActive) {
        await remoteControllerRequestJson(
          `/api/screen-feed/control/sessions/${encodeURIComponent(sessionId)}/keyboard-authorization/revoke`,
          { method: "POST", body: JSON.stringify({}) }
        );
      }
      if (controlEnabled) {
        await remoteControllerRequestJson(
          `/api/screen-feed/control/sessions/${encodeURIComponent(sessionId)}/mouse-authorization/revoke`,
          { method: "POST", body: JSON.stringify({}) }
        );
      }
      setLastResult(null);
      await refreshSession();
    } catch (requestError) {
      await refreshSession().catch(() => undefined);
      setError(requestError instanceof Error ? t(requestError.message) : t("Mouse command failed."));
    } finally {
      setBusy(false);
    }
  }, [busy, controlEnabled, keyboardActive, refreshSession, sessionId, t, setBusy, setError, setLastResult]);

  const sendCommandNow = useCallback(
    async (payload: MouseCommandPayload, expectedSessionId: string) => {
      if (activeSessionIdRef.current !== expectedSessionId) return;
      const decision = decideRemoteControlCommand({ kind: payload.type, gate: rateGateRef.current, now: Date.now() });
      if (decision === "supersede") return;
      if (decision === "defer") {
        const delay = remoteControlSendDelayMs(rateGateRef.current, Date.now());
        await new Promise((resolve) => window.setTimeout(resolve, delay));
        if (activeSessionIdRef.current !== expectedSessionId) return;
      }

      try {
        await requestRemoteControlRealtime({
          type: "remote-control:mouse-command",
          sessionId: expectedSessionId,
          command: payload,
        });
        rateGateRef.current = clearRemoteControlRateLimit(rateGateRef.current);
      } catch (requestError) {
        if (activeSessionIdRef.current !== expectedSessionId) return;
        if (requestError instanceof RemoteControlRealtimeError) {
          if (isRemoteControlRateLimitError(requestError)) {
            rateGateRef.current = applyRemoteControlRateLimit(
              rateGateRef.current,
              Date.now(),
              requestError.retryAfterMs
            );
            return;
          }
          if (requestError.code === "TRANSPORT_NOT_READY" || requestError.code === "TRANSPORT_DISCONNECTED") {
            rateGateRef.current = applyRemoteControlRateLimit(rateGateRef.current, Date.now(), 300);
            return;
          }
          if (requestError.status === 428 || requestError.code === "MOUSE_AUTHORIZATION_REQUIRED") {
            setPasswordOpen(true);
            void refreshSession().catch(() => undefined);
          }
        }
        setError(requestError instanceof Error ? t(requestError.message) : t("Mouse command failed."));
      }
    },
    [refreshSession, t, activeSessionIdRef, rateGateRef, setError, setPasswordOpen]
  );

  const enqueueOrderedCommand = useCallback(
    (payload: MouseCommandPayload) => {
      if (!sessionId || !controlEnabled) return;
      const expectedSessionId = sessionId;
      const frameViewport = screenImage ? parseFrameViewportFromDataset(screenImage.dataset) : undefined;
      const command: MouseCommandPayload = frameViewport ? { ...payload, frameViewport } : payload;
      commandTailRef.current = commandTailRef.current
        .catch(() => undefined)
        .then(() => sendCommandNow(command, expectedSessionId));
    },
    [controlEnabled, screenImage, sendCommandNow, sessionId, commandTailRef]
  );

  const schedulePointerDrain = useCallback(() => {
    if (!sessionId || !controlEnabled || pointerQueueActiveRef.current || !pointerLatestRef.current) return;
    const expectedSessionId = sessionId;
    pointerQueueActiveRef.current = true;
    pointerQueueSessionRef.current = expectedSessionId;
    const nextTail = commandTailRef.current
      .catch(() => undefined)
      .then(async () => {
        if (activeSessionIdRef.current !== expectedSessionId) return;
        const point = pointerLatestRef.current;
        pointerLatestRef.current = null;
        if (point) await sendCommandNow({ type: "pointer-move", ...point }, expectedSessionId);
      });
    commandTailRef.current = nextTail;
    void nextTail.finally(() => {
      if (pointerQueueSessionRef.current !== expectedSessionId) return;
      pointerQueueActiveRef.current = false;
      pointerQueueSessionRef.current = null;
      if (pointerLatestRef.current && activeSessionIdRef.current === expectedSessionId)
        schedulePointerDrainRef.current();
    });
  }, [
    controlEnabled,
    sendCommandNow,
    sessionId,
    activeSessionIdRef,
    commandTailRef,
    pointerLatestRef,
    pointerQueueActiveRef,
    pointerQueueSessionRef,
    schedulePointerDrainRef,
  ]);

  useEffect(() => {
    schedulePointerDrainRef.current = schedulePointerDrain;
  }, [schedulePointerDrain, schedulePointerDrainRef]);

  const flushPointer = useCallback(() => {
    pointerTimerRef.current = null;
    schedulePointerDrain();
  }, [schedulePointerDrain, pointerTimerRef]);

  const flushScroll = useCallback(() => {
    scrollTimerRef.current = null;
    const pending = scrollPendingRef.current;
    scrollPendingRef.current = null;
    if (pending && (pending.deltaX !== 0 || pending.deltaY !== 0))
      enqueueOrderedCommand({ type: "scroll", ...pending });
  }, [enqueueOrderedCommand, scrollPendingRef, scrollTimerRef]);

  useEffect(() => {
    if (!sessionTargetUserId || !portalHost) {
      setScreenImage(null);
      return;
    }
    const dialog = portalHost.closest<HTMLElement>("[data-testid='dialog-watch-user']");
    if (!dialog || dialog.dataset.watchedUserId !== sessionTargetUserId) {
      setScreenImage(null);
      return;
    }
    const syncImage = () => {
      const next = dialog.querySelector<HTMLImageElement>("[data-testid='img-screen-feed']");
      setScreenImage((current) => (current === next ? current : next));
    };
    syncImage();
    const observer = new MutationObserver(syncImage);
    observer.observe(dialog, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      setScreenImage(null);
    };
  }, [portalHost, sessionTargetUserId, setScreenImage]);

  useEffect(() => {
    if (!controlEnabled) return;
    const image = screenImage;
    if (!image) return;
    image.style.cursor = "crosshair";
    image.style.touchAction = "none";

    const pointFromEvent = (clientX: number, clientY: number) => {
      const frameSize: RemoteMouseFrameSize | null =
        image.naturalWidth > 0 && image.naturalHeight > 0
          ? { width: image.naturalWidth, height: image.naturalHeight }
          : (() => {
              const frame = parseFrameViewportFromDataset(image.dataset);
              return frame ? { width: frame.width, height: frame.height } : null;
            })();
      return normalizeRemoteMousePoint(clientX, clientY, image.getBoundingClientRect(), frameSize);
    };

    const onPointerMove = (event: PointerEvent) => {
      const point = pointFromEvent(event.clientX, event.clientY);
      if (!point) return;
      pointerLatestRef.current = point;
      if (pointerTimerRef.current === null)
        pointerTimerRef.current = window.setTimeout(flushPointer, POINTER_COALESCE_MS);
    };
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const point = pointFromEvent(event.clientX, event.clientY);
      if (!point) return;
      event.preventDefault();
      event.stopPropagation();
      pointerLatestRef.current = null;
      if (pointerTimerRef.current !== null) window.clearTimeout(pointerTimerRef.current);
      pointerTimerRef.current = null;
      enqueueOrderedCommand({ type: "click", ...point });
    };
    const onWheel = (event: WheelEvent) => {
      const point = pointFromEvent(event.clientX, event.clientY);
      if (!point) return;
      event.preventDefault();
      event.stopPropagation();
      const frame = parseFrameViewportFromDataset(image.dataset);
      const delta = normalizeRemoteWheelDelta(event.deltaX, event.deltaY, event.deltaMode, frame?.width, frame?.height);
      const previous = scrollPendingRef.current;
      scrollPendingRef.current = {
        ...point,
        deltaX: Math.max(-1200, Math.min(1200, (previous?.deltaX ?? 0) + delta.deltaX)),
        deltaY: Math.max(-1200, Math.min(1200, (previous?.deltaY ?? 0) + delta.deltaY)),
      };
      if (scrollTimerRef.current === null) scrollTimerRef.current = window.setTimeout(flushScroll, SCROLL_COALESCE_MS);
    };

    image.addEventListener("pointermove", onPointerMove);
    image.addEventListener("click", onClick, true);
    image.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => {
      image.style.cursor = "";
      image.style.touchAction = "";
      image.removeEventListener("pointermove", onPointerMove);
      image.removeEventListener("click", onClick, true);
      image.removeEventListener("wheel", onWheel, true);
      pointerLatestRef.current = null;
      scrollPendingRef.current = null;
      if (pointerTimerRef.current !== null) window.clearTimeout(pointerTimerRef.current);
      if (scrollTimerRef.current !== null) window.clearTimeout(scrollTimerRef.current);
      pointerTimerRef.current = null;
      scrollTimerRef.current = null;
    };
  }, [
    controlEnabled,
    enqueueOrderedCommand,
    flushPointer,
    flushScroll,
    screenImage,
    pointerLatestRef,
    pointerTimerRef,
    scrollPendingRef,
    scrollTimerRef,
  ]);
  return { stopCombined };
}

export function useRemoteMouseControllerOverlayStatePart3({
  controlEnabled,
  sessionId,
  setError,
  setLastResult,
  t,
}: Pick<
  Awaited<ReturnType<typeof useRemoteMouseControllerOverlayStatePart1>>,
  "controlEnabled" | "sessionId" | "setError" | "setLastResult" | "t"
>) {
  const getMouseErrorForReason = useCallback(
    (reason: string | null, status: string): string | null => {
      if (status === "executed") return null;
      if (reason === "protected-element") return t("That control is protected and cannot be activated remotely.");
      if (reason === "action-not-allowlisted")
        return t("This control isn't on the allowlist — it needs a data-remote-control-action from the registry.");
      if (reason === "frame-point-offscreen")
        return t("That part of the screen has scrolled out of view. Wait for a fresh frame and try again.");
      if (reason === "invalid-coordinates") return t("Click position is outside the screen image.");
      if (reason === "no-target") return t("No element at that position.");
      if (reason === "no-clickable-target") return t("No clickable control at that position.");
      if (reason === "click-failed") return t("Click failed to activate the control.");
      if (reason === "empty-scroll") return t("Empty scroll ignored.");
      if (reason === "command-timeout") return t("Command timed out — the employee tab didn't respond.");
      if (reason === "duplicate-command") return t("Duplicate command ignored.");
      if (reason) return t(`Action ${status}: ${reason}`);
      return t(
        status === "blocked" ? "That control is protected and cannot be activated remotely." : "Action ignored."
      );
    },
    [t]
  );

  useEffect(() => {
    if (!controlEnabled || !sessionId) return;
    let cancelled = false;
    const bind = () => {
      if (cancelled) return;
      void requestRemoteControlRealtime({ type: "remote-control:bind-mouse-controller", sessionId }).catch(
        (bindError) => {
          if (!cancelled && bindError instanceof RemoteControlRealtimeError && bindError.status > 0)
            setError(t(bindError.message));
        }
      );
    };
    const unsubscribeReady = subscribeRemoteControlRealtimeReady((ready) => {
      if (ready) bind();
    });
    const unsubscribeMessages = subscribeRemoteControlRealtime((message) => {
      if (message.type !== "remote-control:mouse-result") return;
      const result = message.result as CommandResultView | undefined;
      if (!result || result.sessionId !== sessionId) return;
      setLastResult(result);
      const text = getMouseErrorForReason(result.reason, result.status);
      if (text && result.status !== "executed") setError(text);
      else if (result.status === "executed") setError(null);
    });
    bind();
    return () => {
      cancelled = true;
      unsubscribeReady();
      unsubscribeMessages();
    };
  }, [controlEnabled, getMouseErrorForReason, sessionId, t, setError, setLastResult]);
  return {};
}
