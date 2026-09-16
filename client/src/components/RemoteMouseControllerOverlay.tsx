import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, LockKeyhole, MousePointer2, ShieldCheck, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  RemoteControllerRequestError,
  remoteControllerRequestJson,
  useRemoteControllerSession,
} from "@/components/RemoteControllerSessionContext";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import {
  normalizeRemoteMousePoint,
  parseFrameViewportFromDataset,
  type RemoteMouseCommandType,
  type RemoteMouseFrameViewport,
} from "@/hooks/remote-mouse-control-policy";
import { translateRemoteSupportPhase4Text } from "@/i18n/remoteSupportPhase4Translations";
import { translateRemoteSupportPhase5Text } from "@/i18n/remoteSupportPhase5Translations";

interface CommandResultView {
  commandId: string;
  sessionId: string;
  status: "executed" | "blocked" | "ignored";
  reason: string | null;
  completedAt: string;
}

interface MouseCommandPayload {
  type: RemoteMouseCommandType;
  x: number;
  y: number;
  deltaX?: number;
  deltaY?: number;
  frameViewport?: RemoteMouseFrameViewport;
}

const POINTER_COALESCE_MS = 125;
const SCROLL_COALESCE_MS = 100;

function authorizationIsFresh(expiresAt: string | null | undefined): boolean {
  if (!expiresAt) return false;
  const value = new Date(expiresAt).getTime();
  return Number.isFinite(value) && value > Date.now();
}

export function RemoteMouseControllerOverlay() {
  const { language } = useApplicationLanguage();
  const { target, session, portalHost, refreshSession } = useRemoteControllerSession();
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<CommandResultView | null>(null);
  const commandTailRef = useRef<Promise<void>>(Promise.resolve());
  const activeSessionIdRef = useRef<string | null>(null);
  const pointerLatestRef = useRef<{ x: number; y: number } | null>(null);
  const pointerTimerRef = useRef<number | null>(null);
  const pointerQueueActiveRef = useRef(false);
  const pointerQueueSessionRef = useRef<string | null>(null);
  const schedulePointerDrainRef = useRef<() => void>(() => undefined);
  const scrollPendingRef = useRef<{ x: number; y: number; deltaX: number; deltaY: number } | null>(null);
  const scrollTimerRef = useRef<number | null>(null);
  const t = useCallback((value: string) => translateRemoteSupportPhase5Text(value, language), [language]);
  const [screenImage, setScreenImage] = useState<HTMLImageElement | null>(null);

  const sessionId = session?.id ?? null;
  const sessionTargetUserId = session?.targetUserId ?? null;
  const authorized = authorizationIsFresh(session?.mouseAuthorization?.expiresAt);
  const controlEnabled = !!sessionId && !!session?.capabilities.mouse && authorized;

  useEffect(() => {
    activeSessionIdRef.current = sessionId;
    commandTailRef.current = Promise.resolve();
    pointerQueueActiveRef.current = false;
    pointerQueueSessionRef.current = null;
    setError(null);
    setLastResult(null);
    setPasswordOpen(false);
    setPassword("");
    pointerLatestRef.current = null;
    scrollPendingRef.current = null;
    if (pointerTimerRef.current !== null) window.clearTimeout(pointerTimerRef.current);
    if (scrollTimerRef.current !== null) window.clearTimeout(scrollTimerRef.current);
    pointerTimerRef.current = null;
    scrollTimerRef.current = null;
  }, [sessionId]);

  const requestMouseAuthorization = useCallback(async () => {
    if (!sessionId) return;
    await remoteControllerRequestJson(
      `/api/screen-feed/control/sessions/${encodeURIComponent(sessionId)}/mouse-authorization`,
      { method: "POST", body: JSON.stringify({}) }
    );
    await refreshSession();
    setPasswordOpen(false);
    setPassword("");
  }, [refreshSession, sessionId]);

  const authorizeMouse = useCallback(async () => {
    if (!sessionId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await requestMouseAuthorization();
    } catch (requestError) {
      if (
        requestError instanceof RemoteControllerRequestError &&
        (requestError.status === 428 || requestError.code === "PASSWORD_CONFIRMATION_REQUIRED")
      ) {
        setPasswordOpen(true);
      } else {
        setError(requestError instanceof Error ? t(requestError.message) : t("Unable to enable mouse control."));
      }
    } finally {
      setBusy(false);
    }
  }, [busy, requestMouseAuthorization, sessionId, t]);

  const confirmPasswordAndAuthorize = useCallback(async () => {
    if (!password || busy || !sessionId) return;
    setBusy(true);
    setError(null);
    try {
      await remoteControllerRequestJson("/api/auth/confirm-password", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      await requestMouseAuthorization();
    } catch (requestError) {
      setError(requestError instanceof Error ? t(requestError.message) : t("Password confirmation failed."));
    } finally {
      setBusy(false);
    }
  }, [busy, password, requestMouseAuthorization, sessionId, t]);

  const stopMouse = useCallback(async () => {
    if (!sessionId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await remoteControllerRequestJson(
        `/api/screen-feed/control/sessions/${encodeURIComponent(sessionId)}/mouse-authorization/revoke`,
        { method: "POST", body: JSON.stringify({}) }
      );
      setLastResult(null);
      await refreshSession();
    } catch (requestError) {
      setError(requestError instanceof Error ? t(requestError.message) : t("Mouse command failed."));
    } finally {
      setBusy(false);
    }
  }, [busy, refreshSession, sessionId, t]);

  const sendCommandNow = useCallback(
    async (payload: MouseCommandPayload, expectedSessionId: string) => {
      if (activeSessionIdRef.current !== expectedSessionId) return;
      try {
        await remoteControllerRequestJson(
          `/api/screen-feed/control/sessions/${encodeURIComponent(expectedSessionId)}/commands`,
          {
            method: "POST",
            body: JSON.stringify(payload),
          }
        );
      } catch (requestError) {
        if (activeSessionIdRef.current !== expectedSessionId) return;
        if (
          requestError instanceof RemoteControllerRequestError &&
          (requestError.status === 428 || requestError.code === "MOUSE_AUTHORIZATION_REQUIRED")
        ) {
          setPasswordOpen(true);
          void refreshSession().catch(() => undefined);
        }
        setError(requestError instanceof Error ? t(requestError.message) : t("Mouse command failed."));
      }
    },
    [refreshSession, t]
  );

  const enqueueOrderedCommand = useCallback(
    (payload: MouseCommandPayload) => {
      if (!sessionId || !controlEnabled) return;
      const expectedSessionId = sessionId;
      // Clicks and scrolls are aimed at the frame on screen right now, so the
      // target can ignore them when its viewport has since scrolled, resized,
      // or zoomed instead of activating the wrong control.
      const frameViewport = screenImage ? parseFrameViewportFromDataset(screenImage.dataset) : undefined;
      const command: MouseCommandPayload = frameViewport ? { ...payload, frameViewport } : payload;
      commandTailRef.current = commandTailRef.current
        .catch(() => undefined)
        .then(() => sendCommandNow(command, expectedSessionId));
    },
    [controlEnabled, screenImage, sendCommandNow, sessionId]
  );

  const schedulePointerDrain = useCallback(() => {
    if (!sessionId || !controlEnabled || pointerQueueActiveRef.current || !pointerLatestRef.current) {
      return;
    }

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
      if (pointerLatestRef.current && activeSessionIdRef.current === expectedSessionId) {
        schedulePointerDrainRef.current();
      }
    });
  }, [controlEnabled, sendCommandNow, sessionId]);

  useEffect(() => {
    schedulePointerDrainRef.current = schedulePointerDrain;
  }, [schedulePointerDrain]);

  const flushPointer = useCallback(() => {
    pointerTimerRef.current = null;
    schedulePointerDrain();
  }, [schedulePointerDrain]);

  const flushScroll = useCallback(() => {
    scrollTimerRef.current = null;
    const pending = scrollPendingRef.current;
    scrollPendingRef.current = null;
    if (pending && (pending.deltaX !== 0 || pending.deltaY !== 0)) {
      enqueueOrderedCommand({ type: "scroll", ...pending });
    }
  }, [enqueueOrderedCommand]);

  // The screen image only exists once a frame has arrived, which is usually
  // after control was enabled — and it is replaced whenever the viewer drops
  // back to the waiting placeholder. Tracking it keeps the input listeners
  // bound to whatever image is on screen right now instead of binding once.
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
  }, [portalHost, sessionTargetUserId]);

  useEffect(() => {
    if (!controlEnabled) return;
    const image = screenImage;
    if (!image) return;

    image.style.cursor = "crosshair";
    image.style.touchAction = "none";

    const pointFromEvent = (clientX: number, clientY: number) =>
      normalizeRemoteMousePoint(clientX, clientY, image.getBoundingClientRect());

    const onPointerMove = (event: PointerEvent) => {
      const point = pointFromEvent(event.clientX, event.clientY);
      if (!point) return;
      pointerLatestRef.current = point;
      if (pointerTimerRef.current === null) {
        pointerTimerRef.current = window.setTimeout(flushPointer, POINTER_COALESCE_MS);
      }
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
      const previous = scrollPendingRef.current;
      scrollPendingRef.current = {
        ...point,
        deltaX: Math.max(-1200, Math.min(1200, (previous?.deltaX ?? 0) + event.deltaX)),
        deltaY: Math.max(-1200, Math.min(1200, (previous?.deltaY ?? 0) + event.deltaY)),
      };
      if (scrollTimerRef.current === null) {
        scrollTimerRef.current = window.setTimeout(flushScroll, SCROLL_COALESCE_MS);
      }
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
  }, [controlEnabled, enqueueOrderedCommand, flushPointer, flushScroll, screenImage]);

  useEffect(() => {
    if (!controlEnabled || !sessionId) return;
    const eventSource = new EventSource(`/api/screen-feed/control/sessions/${encodeURIComponent(sessionId)}/results`, {
      withCredentials: true,
    });
    eventSource.addEventListener("result", (event) => {
      try {
        const result = JSON.parse((event as MessageEvent<string>).data) as CommandResultView;
        if (result?.sessionId === sessionId) {
          setLastResult(result);
          if (result.status === "blocked") {
            setError(t("That control is protected and cannot be activated remotely."));
          } else if (result.status === "ignored" && result.reason === "stale-frame-viewport") {
            setError(t("The screen changed since this frame was captured. Wait for a fresh frame and try again."));
          }
        }
      } catch {
        // A later result replaces malformed stream data.
      }
    });
    return () => eventSource.close();
  }, [controlEnabled, sessionId, t]);

  if (!target || !session || !portalHost) return null;

  const statusLabel = lastResult
    ? t(lastResult.status === "executed" ? "Executed" : lastResult.status === "blocked" ? "Blocked" : "Ignored")
    : null;

  return createPortal(
    <section
      className="w-full rounded-xl border bg-background/95 p-3 shadow-sm"
      data-screenfeed-ignore="true"
      data-testid="remote-mouse-controller-overlay"
      data-remote-control-panel-section="mouse"
    >
      <div className="flex items-start gap-2">
        <div className="rounded-md bg-primary/10 p-1.5 text-primary">
          {controlEnabled ? <MousePointer2 className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">
            {t("Mouse control")} · {session.targetUsername}
          </p>
          <p className="text-xs text-muted-foreground">
            {translateRemoteSupportPhase4Text("ERP tab only", language)} · {t("Safe viewing and navigation")} ·{" "}
            {t("Keyboard disabled")}
          </p>
        </div>
        {controlEnabled ? (
          <Button
            size="sm"
            variant="outline"
            className="h-8 shrink-0 px-2"
            onClick={() => void stopMouse()}
            disabled={busy}
            data-testid="button-disable-remote-mouse"
          >
            {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Square className="mr-1 h-3 w-3" />}
            {t("Stop mouse")}
          </Button>
        ) : (
          <Button
            size="sm"
            className="h-8 shrink-0 px-2"
            onClick={() => void authorizeMouse()}
            disabled={busy}
            data-testid="button-enable-remote-mouse"
          >
            {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <LockKeyhole className="mr-1 h-3 w-3" />}
            {t("Enable")}
          </Button>
        )}
      </div>

      {passwordOpen && !controlEnabled && (
        <form
          className="mt-3 space-y-2 border-t pt-3"
          onSubmit={(event) => {
            event.preventDefault();
            void confirmPasswordAndAuthorize();
          }}
        >
          <p className="text-xs font-medium">
            {t("Confirm your password to enable mouse control for up to 5 minutes.")}
          </p>
          <div className="flex gap-2">
            <Input
              autoFocus
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={t("Password")}
              className="h-9"
              data-testid="input-remote-mouse-password"
            />
            <Button type="submit" size="sm" className="h-9" disabled={!password || busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : t("Confirm")}
            </Button>
          </div>
        </form>
      )}

      <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>
          {controlEnabled
            ? t("Active: click and scroll on allowlisted controls")
            : t("Read-only until explicitly enabled")}
        </span>
        {statusLabel && <span className="shrink-0">{statusLabel}</span>}
      </div>
      {error && (
        <p className="mt-2 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </section>,
    portalHost
  );
}
