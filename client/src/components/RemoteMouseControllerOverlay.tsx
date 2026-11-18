import { createPortal } from "react-dom";
import { Loader2, LockKeyhole, MousePointer2, ShieldCheck, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { translateRemoteSupportPhase4Text } from "@/i18n/remoteSupportPhase4Translations";
import { useRemoteMouseControllerOverlayStatePart1 } from "./useRemoteMouseControllerOverlayStatePart1";
import {
  useRemoteMouseControllerOverlayStatePart2,
  useRemoteMouseControllerOverlayStatePart3,
} from "./useRemoteMouseControllerOverlayStatePart2";

function useRemoteMouseControllerOverlayState() {
  const {
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
  } = useRemoteMouseControllerOverlayStatePart1();
  const { stopCombined } = useRemoteMouseControllerOverlayStatePart2({
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
  });
  useRemoteMouseControllerOverlayStatePart3({ controlEnabled, sessionId, setError, setLastResult, t });
  return {
    authorizeCombined,
    authorizeMouse,
    busy,
    combinedEnabled,
    confirmPasswordAndAuthorize,
    confirmPasswordAndAuthorizeCombined,
    controlEnabled,
    error,
    language,
    lastResult,
    password,
    passwordOpen,
    portalHost,
    session,
    setPassword,
    stopCombined,
    stopMouse,
    t,
    target,
  };
}

export function RemoteMouseControllerOverlay() {
  const {
    authorizeCombined,
    authorizeMouse,
    busy,
    combinedEnabled,
    confirmPasswordAndAuthorize,
    confirmPasswordAndAuthorizeCombined,
    controlEnabled,
    error,
    language,
    lastResult,
    password,
    passwordOpen,
    portalHost,
    session,
    setPassword,
    stopCombined,
    stopMouse,
    t,
    target,
  } = useRemoteMouseControllerOverlayState();

  if (!target || !session || !portalHost) return null;

  const statusLabel = lastResult
    ? t(lastResult.status === "executed" ? "Executed" : lastResult.status === "blocked" ? "Blocked" : "Ignored")
    : null;

  if (portalHost.dataset.remoteControlPanelMode === "unified") {
    return createPortal(
      <section
        className="space-y-2 text-sm"
        data-screenfeed-ignore="true"
        data-testid="remote-mouse-controller-overlay"
        data-remote-control-panel-section="mouse"
      >
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 text-xs text-slate-300">
            {combinedEnabled ? t("Mouse and keyboard active") : t("Read-only until explicitly enabled")}
          </p>
          <button
            type="button"
            role="switch"
            aria-checked={combinedEnabled}
            aria-label={t("Mouse & keyboard control")}
            disabled={busy}
            data-testid="button-toggle-remote-control"
            onClick={() => void (combinedEnabled ? stopCombined() : authorizeCombined())}
            className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-300 disabled:cursor-wait disabled:opacity-50 ${combinedEnabled ? "border-blue-400 bg-blue-600" : "border-slate-600 bg-slate-700"}`}
          >
            <span
              className={`h-5 w-5 rounded-full bg-white shadow transition-transform ${combinedEnabled ? "translate-x-6" : "translate-x-1"}`}
            />
          </button>
        </div>
        <p className="text-[11px] leading-relaxed text-slate-400">
          {t("ERP tab only")} · {t("Only safe search, filter and explicitly approved fields can be edited.")}
        </p>
        {passwordOpen && !combinedEnabled && (
          <form
            className="space-y-2 border-t border-slate-700 pt-3"
            onSubmit={(event) => {
              event.preventDefault();
              void confirmPasswordAndAuthorizeCombined();
            }}
          >
            <p className="text-xs text-slate-200">
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
                className="h-9 border-slate-600 bg-slate-900 text-white"
                data-testid="input-remote-mouse-password"
              />
              <Button type="submit" size="sm" className="h-9" disabled={!password || busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : t("Confirm")}
              </Button>
            </div>
          </form>
        )}
        {statusLabel ? <p className="text-[11px] text-slate-400">{statusLabel}</p> : null}
        {error ? (
          <p className="text-xs text-red-300" role="alert">
            {error}
          </p>
        ) : null}
      </section>,
      portalHost
    );
  }

  return createPortal(
    <section
      className="w-full rounded-xl border bg-background/95 p-3 shadow-xs"
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
