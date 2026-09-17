import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, ShieldCheck } from "lucide-react";
import {
  RemoteControllerRequestError,
  remoteControllerRequestJson,
  useRemoteControllerSession,
  type RemoteControllerSessionView,
} from "@/components/RemoteControllerSessionContext";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { translateRemoteSupportPhase5Text } from "@/i18n/remoteSupportPhase5Translations";

interface SessionPayload {
  session?: RemoteControllerSessionView | null;
  code?: string;
  message?: string;
}

type WatchdogState = "idle" | "waiting" | "starting" | "ready" | "error";

const RECONCILE_INTERVAL_MS = 2500;
const HEARTBEAT_INTERVAL_MS = 5000;
const CONFLICT_RETRY_BASE_MS = 15000;
const CONFLICT_RETRY_MAX_MS = 60000;

export function RemoteControlSessionWatchdog() {
  const { language } = useApplicationLanguage();
  const { target, session, adoptSession, refreshSession } = useRemoteControllerSession();
  const [state, setState] = useState<WatchdogState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const runningRef = useRef(false);
  const lastHeartbeatRef = useRef(0);
  const nextStartAttemptAtRef = useRef(0);
  const conflictCountRef = useRef(0);
  const t = useCallback((value: string) => translateRemoteSupportPhase5Text(value, language), [language]);

  useEffect(() => {
    lastHeartbeatRef.current = 0;
    nextStartAttemptAtRef.current = 0;
    conflictCountRef.current = 0;
    setState(target ? "waiting" : "idle");
    setMessage(null);
  }, [target]);

  useEffect(() => {
    if (!target) return;
    let cancelled = false;

    const reconcile = async () => {
      if (cancelled || runningRef.current || document.visibilityState !== "visible") return;
      runningRef.current = true;
      try {
        const boundToSelectedTab =
          session?.id &&
          session.status === "active" &&
          session.targetUserId === target.userId &&
          session.targetTabId === target.tabId;
        if (boundToSelectedTab && session) {
          conflictCountRef.current = 0;
          nextStartAttemptAtRef.current = 0;
          setState("ready");
          setMessage(null);

          if (Date.now() - lastHeartbeatRef.current >= HEARTBEAT_INTERVAL_MS) {
            lastHeartbeatRef.current = Date.now();
            try {
              const heartbeat = await remoteControllerRequestJson<SessionPayload>(
                `/api/screen-feed/control/sessions/${encodeURIComponent(session.id)}/heartbeat`,
                { method: "POST", body: JSON.stringify({}) }
              );
              if (!cancelled && heartbeat.session) adoptSession(heartbeat.session);
            } catch (error) {
              if (cancelled) return;
              adoptSession(null);
              setState("waiting");
              setMessage(error instanceof Error ? t(error.message) : t("Reconnecting the support session."));
              void refreshSession().catch(() => undefined);
            }
          }
          return;
        }

        if (Date.now() < nextStartAttemptAtRef.current) {
          setState("waiting");
          return;
        }

        setState("starting");
        try {
          const started = await remoteControllerRequestJson<SessionPayload>("/api/screen-feed/control/sessions", {
            method: "POST",
            body: JSON.stringify({
              targetUserId: target.userId,
              targetUsername: target.username,
              tabId: target.tabId,
              durationMinutes: 15,
            }),
          });
          if (cancelled) return;
          if (
            started.session?.id &&
            started.session.targetUserId === target.userId &&
            started.session.targetTabId === target.tabId
          ) {
            conflictCountRef.current = 0;
            nextStartAttemptAtRef.current = 0;
            lastHeartbeatRef.current = Date.now();
            adoptSession(started.session);
            setState("ready");
            setMessage(null);
            return;
          }
          throw new Error(t("Remote control session did not bind to the selected ERP tab."));
        } catch (error) {
          if (cancelled) return;
          const code = error instanceof RemoteControllerRequestError ? (error.code ?? "") : "";
          const status = error instanceof RemoteControllerRequestError ? error.status : 0;
          if (status === 409 && ["TARGET_TAB_UNAVAILABLE", "TARGET_ALREADY_CONTROLLED", "SESSION_INACTIVE"].includes(code)) {
            conflictCountRef.current += 1;
            const retryDelay = Math.min(
              CONFLICT_RETRY_MAX_MS,
              CONFLICT_RETRY_BASE_MS * 2 ** Math.min(conflictCountRef.current - 1, 2)
            );
            nextStartAttemptAtRef.current = Date.now() + retryDelay;
            setState("waiting");
            setMessage(
              code === "TARGET_ALREADY_CONTROLLED"
                ? t("Another controller already owns this support session.")
                : t("Waiting for the selected employee ERP tab to register for control.")
            );
            void refreshSession().catch(() => undefined);
            return;
          }
          nextStartAttemptAtRef.current = Date.now() + CONFLICT_RETRY_BASE_MS;
          setState("error");
          setMessage(error instanceof Error ? t(error.message) : t("Unable to prepare remote control."));
        }
      } finally {
        runningRef.current = false;
      }
    };

    void reconcile();
    const intervalId = window.setInterval(() => void reconcile(), RECONCILE_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void reconcile();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      runningRef.current = false;
    };
  }, [adoptSession, refreshSession, session, t, target]);

  if (!target || state === "idle" || state === "ready") return null;

  const failed = state === "error";
  return (
    <div
      className="fixed left-3 top-14 z-[2147483645] flex max-w-[min(92vw,420px)] items-start gap-2 rounded-lg border bg-background/95 px-3 py-2 shadow-xl backdrop-blur"
      data-screenfeed-ignore="true"
      data-testid="remote-control-session-watchdog"
      role={failed ? "alert" : "status"}
    >
      {failed ? (
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      ) : state === "starting" ? (
        <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" />
      ) : (
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
      )}
      <div className="min-w-0">
        <p className="text-xs font-semibold">
          {failed
            ? t("Remote control unavailable")
            : state === "starting"
              ? t("Preparing remote control")
              : t("Control reconnecting")}
        </p>
        <p className="text-[11px] text-muted-foreground">
          {message || `${t("Preparing the selected ERP tab for")} ${target.username}.`}
        </p>
      </div>
    </div>
  );
}
