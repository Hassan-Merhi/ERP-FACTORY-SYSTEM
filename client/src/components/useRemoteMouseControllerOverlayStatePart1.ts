// Extracted from ./RemoteMouseControllerOverlay.tsx to keep that module under the source-size cap.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  RemoteControllerRequestError,
  remoteControllerRequestJson,
  useRemoteControllerSession,
} from "@/components/RemoteControllerSessionContext";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { createRemoteControlRateGate, type RemoteControlRateGate } from "@/hooks/remote-control-command-flow";
import type { RemoteMouseCommandType, RemoteMouseFrameViewport } from "@/hooks/remote-mouse-control-policy";
import { translateRemoteSupportPhase5Text } from "@/i18n/remoteSupportPhase5Translations";

export interface CommandResultView {
  commandId: string;
  sessionId: string;
  status: "executed" | "blocked" | "ignored";
  reason: string | null;
  completedAt: string;
}

export interface MouseCommandPayload {
  type: RemoteMouseCommandType;
  x: number;
  y: number;
  deltaX?: number;
  deltaY?: number;
  frameViewport?: RemoteMouseFrameViewport;
}

export const POINTER_COALESCE_MS = 125;

export const SCROLL_COALESCE_MS = 100;

function authorizationIsFresh(expiresAt: string | null | undefined): boolean {
  if (!expiresAt) return false;
  const value = new Date(expiresAt).getTime();
  return Number.isFinite(value) && value > Date.now();
}

export function useRemoteMouseControllerOverlayStatePart1() {
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
  const rateGateRef = useRef<RemoteControlRateGate>(createRemoteControlRateGate());
  const t = useCallback((value: string) => translateRemoteSupportPhase5Text(value, language), [language]);
  const [screenImage, setScreenImage] = useState<HTMLImageElement | null>(null);

  const sessionId = session?.id ?? null;
  const sessionTargetUserId = session?.targetUserId ?? null;
  const authorized = authorizationIsFresh(session?.mouseAuthorization?.expiresAt);
  const controlEnabled = !!sessionId && !!session?.capabilities.mouse && authorized;
  const keyboardActive =
    !!session?.capabilities.keyboard && authorizationIsFresh(session.keyboardAuthorization?.expiresAt);
  const combinedEnabled = controlEnabled && keyboardActive;

  useEffect(() => {
    activeSessionIdRef.current = sessionId;
    commandTailRef.current = Promise.resolve();
    rateGateRef.current = createRemoteControlRateGate();
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

  // A single explicit action enables both guarded capabilities. Each separate
  // permission, password, audit, tenant and exact-tab check stays on the server.
  const authorizeCombined = useCallback(async () => {
    if (!sessionId || busy) return;
    setBusy(true);
    setError(null);
    let mouseGrantedHere = false;
    try {
      if (!controlEnabled) {
        await remoteControllerRequestJson(
          `/api/screen-feed/control/sessions/${encodeURIComponent(sessionId)}/mouse-authorization`,
          { method: "POST", body: JSON.stringify({}) }
        );
        mouseGrantedHere = true;
      }
      if (!keyboardActive) {
        await remoteControllerRequestJson(
          `/api/screen-feed/control/sessions/${encodeURIComponent(sessionId)}/keyboard-authorization`,
          { method: "POST", body: JSON.stringify({}) }
        );
      }
      await refreshSession();
      setPasswordOpen(false);
      setPassword("");
    } catch (requestError) {
      // Do not leave a newly activated mouse session on when keyboard is blocked.
      if (mouseGrantedHere) {
        await remoteControllerRequestJson(
          `/api/screen-feed/control/sessions/${encodeURIComponent(sessionId)}/mouse-authorization/revoke`,
          { method: "POST", body: JSON.stringify({}) }
        ).catch(() => undefined);
      }
      await refreshSession().catch(() => undefined);
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
  }, [busy, controlEnabled, keyboardActive, refreshSession, sessionId, t]);

  const confirmPasswordAndAuthorizeCombined = useCallback(async () => {
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await remoteControllerRequestJson("/api/auth/confirm-password", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      // Authorization is deliberately a separate action after password confirmation.
      // Release busy first via the callback below rather than bypassing the server.
      setPasswordOpen(false);
      setPassword("");
      if (sessionId) {
        let grantedMouse = false;
        try {
          if (!controlEnabled) {
            await remoteControllerRequestJson(
              `/api/screen-feed/control/sessions/${encodeURIComponent(sessionId)}/mouse-authorization`,
              { method: "POST", body: JSON.stringify({}) }
            );
            grantedMouse = true;
          }
          if (!keyboardActive) {
            await remoteControllerRequestJson(
              `/api/screen-feed/control/sessions/${encodeURIComponent(sessionId)}/keyboard-authorization`,
              { method: "POST", body: JSON.stringify({}) }
            );
          }
          await refreshSession();
        } catch (error) {
          if (grantedMouse) {
            await remoteControllerRequestJson(
              `/api/screen-feed/control/sessions/${encodeURIComponent(sessionId)}/mouse-authorization/revoke`,
              { method: "POST", body: JSON.stringify({}) }
            ).catch(() => undefined);
          }
          await refreshSession().catch(() => undefined);
          throw error;
        }
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? t(requestError.message) : t("Password confirmation failed."));
    } finally {
      setBusy(false);
    }
  }, [busy, controlEnabled, keyboardActive, password, refreshSession, sessionId, t]);
  return {
    activeSessionIdRef,
    authorizeCombined,
    authorizeMouse,
    busy,
    combinedEnabled,
    commandTailRef,
    confirmPasswordAndAuthorize,
    confirmPasswordAndAuthorizeCombined,
    controlEnabled,
    error,
    keyboardActive,
    language,
    lastResult,
    password,
    passwordOpen,
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
    session,
    sessionId,
    sessionTargetUserId,
    setBusy,
    setError,
    setLastResult,
    setPassword,
    setPasswordOpen,
    setScreenImage,
    stopMouse,
    t,
    target,
  };
}
