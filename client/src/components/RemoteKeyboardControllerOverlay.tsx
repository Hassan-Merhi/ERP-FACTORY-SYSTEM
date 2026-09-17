import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Keyboard, Loader2, LockKeyhole, MousePointer2, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  RemoteControllerRequestError,
  remoteControllerRequestJson,
  useRemoteControllerSession,
} from "@/components/RemoteControllerSessionContext";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import type { RemoteKeyboardKey } from "@/hooks/remote-keyboard-control-policy";
import { translateRemoteSupportPhase5Text } from "@/i18n/remoteSupportPhase5Translations";
import { translateRemoteSupportPhase6Text } from "@/i18n/remoteSupportPhase6Translations";

function getKeyboardErrorForReason(reason: string | null, t: (v: string) => string): string | null {
  if (!reason) return null;
  const map: Record<string, string> = {
    "local-user-active": t("Employee is actively typing — remote typing paused. Try again in a moment."),
    "no-safe-editable-focus": t("No safe field focused — click a safe search, filter or approved field in the watched screen first."),
    "text-not-supported": t("This field doesn't accept typed text — select a text field."),
    "field-length-limit": t("Field is at its length limit — delete some text first."),
    "invalid-text": t("Text contains blocked control characters."),
    "invalid-key": t("That key isn't allowed remotely."),
    "form-submit-blocked": t("Form submission is blocked remotely."),
    "select-key-blocked": t("This select only supports ArrowUp/Down, Home, End."),
    "checkbox-key-blocked": t("Checkbox not approved — only explicitly approved checkboxes can be toggled remotely."),
    "selection-not-supported": t("This field doesn't support text selection."),
    "vertical-key-not-supported": t("Vertical arrow not supported in this field."),
    "number-step-blocked": t("Number stepping blocked — only approved number fields support ArrowUp/Down."),
    "nothing-to-delete": t("Nothing to delete at the current cursor position."),
    "delete-failed": t("Delete failed."),
    "no-adjacent-field": t("No adjacent safe field to Tab to."),
    "stale-command": t("Command expired before execution."),
    "duplicate-command": t("Duplicate command ignored."),
  };
  return map[reason] ?? t("That field is protected and cannot be edited remotely.");
}

interface KeyboardResultView {
  commandId: string;
  sessionId: string;
  status: "executed" | "blocked" | "ignored";
  reason: string | null;
  completedAt: string;
}

type KeyboardPayload =
  | { type: "insert-text"; text: string }
  | { type: "key"; key: RemoteKeyboardKey; shiftKey: boolean };

const ALLOWED_SPECIAL_KEYS = new Map<string, RemoteKeyboardKey>([
  ["Backspace", "Backspace"],
  ["Delete", "Delete"],
  ["Tab", "Tab"],
  ["Escape", "Escape"],
  ["Enter", "Enter"],
  ["ArrowUp", "ArrowUp"],
  ["ArrowDown", "ArrowDown"],
  ["ArrowLeft", "ArrowLeft"],
  ["ArrowRight", "ArrowRight"],
  ["Home", "Home"],
  ["End", "End"],
  [" ", "Space"],
]);

const TEXT_BATCH_DELAY_MS = 45;
const MAX_TEXT_BATCH_CODE_POINTS = 32;

function authorizationIsFresh(expiresAt: string | null | undefined): boolean {
  if (!expiresAt) return false;
  const value = new Date(expiresAt).getTime();
  return Number.isFinite(value) && value > Date.now();
}

export function RemoteKeyboardControllerOverlay() {
  const { language } = useApplicationLanguage();
  const { target, session, portalHost, refreshSession } = useRemoteControllerSession();
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<KeyboardResultView | null>(null);
  const captureRef = useRef<HTMLInputElement>(null);
  const commandTailRef = useRef<Promise<void>>(Promise.resolve());
  const activeSessionIdRef = useRef<string | null>(null);
  const textBufferRef = useRef("");
  const textTimerRef = useRef<number | null>(null);
  const isComposingRef = useRef(false);
  const t = useCallback((value: string) => translateRemoteSupportPhase6Text(value, language), [language]);

  const sessionId = session?.id ?? null;
  const mouseActive = !!session?.capabilities.mouse && authorizationIsFresh(session.mouseAuthorization?.expiresAt);
  const keyboardActive =
    !!session?.capabilities.keyboard && authorizationIsFresh(session.keyboardAuthorization?.expiresAt);

  useEffect(() => {
    activeSessionIdRef.current = sessionId;
    setError(null);
    setLastResult(null);
    setPasswordOpen(false);
    setPassword("");
    textBufferRef.current = "";
    if (textTimerRef.current !== null) window.clearTimeout(textTimerRef.current);
    textTimerRef.current = null;
  }, [sessionId]);

  // Re-focus the capture input aggressively while keyboard control is active.
  // Operators reported "can't type" when the input lost focus to a click,
  // a window blur, or the browser's own focus management. This keeps the
  // hidden capture input focused, with a blur-refocus handler and a
  // window-focus listener so typing resumes without a manual click.
  useEffect(() => {
    if (!keyboardActive) return;
    const input = captureRef.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    const scheduleRefocus = () => {
      window.setTimeout(() => {
        if (document.activeElement !== input && keyboardActive && activeSessionIdRef.current === sessionId) {
          input.focus({ preventScroll: true });
        }
      }, 0);
    };
    const onBlur = () => scheduleRefocus();
    const onWindowFocus = () => scheduleRefocus();
    const onVisibility = () => {
      if (document.visibilityState === "visible") scheduleRefocus();
    };
    input.addEventListener("blur", onBlur);
    window.addEventListener("focus", onWindowFocus);
    document.addEventListener("visibilitychange", onVisibility);
    // Also refocus after any click in the overlay's document
    const onDocPointerDown = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (target && input.contains(target)) return;
      // Don't steal focus from the password confirmation flow
      if (target?.closest("[data-testid='input-remote-keyboard-password']")) return;
      scheduleRefocus();
    };
    document.addEventListener("pointerdown", onDocPointerDown, true);
    return () => {
      input.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onWindowFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("pointerdown", onDocPointerDown, true);
    };
  }, [keyboardActive, sessionId]);

  const requestKeyboardAuthorization = useCallback(async () => {
    if (!sessionId) return;
    await remoteControllerRequestJson(
      `/api/screen-feed/control/sessions/${encodeURIComponent(sessionId)}/keyboard-authorization`,
      { method: "POST", body: JSON.stringify({}) }
    );
    await refreshSession();
    setPasswordOpen(false);
    setPassword("");
    window.setTimeout(() => captureRef.current?.focus({ preventScroll: true }), 0);
  }, [refreshSession, sessionId]);

  const enableKeyboard = useCallback(async () => {
    if (!sessionId || !mouseActive || busy) return;
    setBusy(true);
    setError(null);
    try {
      await requestKeyboardAuthorization();
    } catch (requestError) {
      if (
        requestError instanceof RemoteControllerRequestError &&
        (requestError.status === 428 || requestError.code === "PASSWORD_CONFIRMATION_REQUIRED")
      ) {
        setPasswordOpen(true);
      } else {
        setError(requestError instanceof Error ? t(requestError.message) : t("Unable to enable keyboard control."));
      }
    } finally {
      setBusy(false);
    }
  }, [busy, mouseActive, requestKeyboardAuthorization, sessionId, t]);

  const confirmPasswordAndEnable = useCallback(async () => {
    if (!password || !sessionId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await remoteControllerRequestJson("/api/auth/confirm-password", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      await requestKeyboardAuthorization();
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? translateRemoteSupportPhase5Text(requestError.message, language)
          : translateRemoteSupportPhase5Text("Password confirmation failed.", language)
      );
    } finally {
      setBusy(false);
    }
  }, [busy, language, password, requestKeyboardAuthorization, sessionId]);

  const stopKeyboard = useCallback(async () => {
    if (!sessionId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await remoteControllerRequestJson(
        `/api/screen-feed/control/sessions/${encodeURIComponent(sessionId)}/keyboard-authorization/revoke`,
        { method: "POST", body: JSON.stringify({}) }
      );
      setLastResult(null);
      await refreshSession();
    } catch (requestError) {
      setError(requestError instanceof Error ? t(requestError.message) : t("Keyboard command failed."));
    } finally {
      setBusy(false);
    }
  }, [busy, refreshSession, sessionId, t]);

  const enqueueCommand = useCallback(
    (payload: KeyboardPayload) => {
      if (!sessionId || !keyboardActive) return;
      const run = async () => {
        if (activeSessionIdRef.current !== sessionId) return;
        try {
          await remoteControllerRequestJson(
            `/api/screen-feed/control/sessions/${encodeURIComponent(sessionId)}/keyboard-commands`,
            { method: "POST", body: JSON.stringify(payload) }
          );
        } catch (requestError) {
          if (activeSessionIdRef.current !== sessionId) return;
          if (
            requestError instanceof RemoteControllerRequestError &&
            (requestError.status === 428 || requestError.code === "KEYBOARD_AUTHORIZATION_REQUIRED")
          ) {
            setPasswordOpen(true);
            void refreshSession().catch(() => undefined);
          }
          setError(requestError instanceof Error ? t(requestError.message) : t("Keyboard command failed."));
        }
      };
      commandTailRef.current = commandTailRef.current.catch(() => undefined).then(run);
    },
    [keyboardActive, refreshSession, sessionId, t]
  );

  const flushTextBuffer = useCallback(() => {
    if (textTimerRef.current !== null) window.clearTimeout(textTimerRef.current);
    textTimerRef.current = null;
    const text = textBufferRef.current;
    textBufferRef.current = "";
    if (text) enqueueCommand({ type: "insert-text", text });
  }, [enqueueCommand]);

  const queueText = useCallback(
    (text: string) => {
      textBufferRef.current += text;
      if (Array.from(textBufferRef.current).length >= MAX_TEXT_BATCH_CODE_POINTS) {
        flushTextBuffer();
        return;
      }
      if (textTimerRef.current === null) {
        textTimerRef.current = window.setTimeout(flushTextBuffer, TEXT_BATCH_DELAY_MS);
      }
    },
    [flushTextBuffer]
  );

  useEffect(() => {
    if (!keyboardActive) {
      textBufferRef.current = "";
      if (textTimerRef.current !== null) window.clearTimeout(textTimerRef.current);
      textTimerRef.current = null;
      return;
    }
    return () => {
      textBufferRef.current = "";
      if (textTimerRef.current !== null) window.clearTimeout(textTimerRef.current);
      textTimerRef.current = null;
    };
  }, [keyboardActive]);

  useEffect(() => {
    if (!sessionId || !keyboardActive) return;
    const eventSource = new EventSource(
      `/api/screen-feed/control/sessions/${encodeURIComponent(sessionId)}/keyboard-results`,
      { withCredentials: true }
    );
    eventSource.addEventListener("result", (event) => {
      try {
        const result = JSON.parse((event as MessageEvent<string>).data) as KeyboardResultView;
        if (result?.sessionId !== sessionId) return;
        setLastResult(result);
        if (result.status === "blocked" || result.status === "ignored") {
          const msg = getKeyboardErrorForReason(result.reason, t);
          if (msg) setError(msg);
        } else if (result.status === "executed") {
          setError(null);
        }
      } catch {
        // A later result replaces malformed stream data.
      }
    });
    return () => eventSource.close();
  }, [keyboardActive, sessionId, t]);

  if (!target || !session || !portalHost) return null;

  const statusLabel = lastResult
    ? translateRemoteSupportPhase5Text(
        lastResult.status === "executed" ? "Executed" : lastResult.status === "blocked" ? "Blocked" : "Ignored",
        language
      )
    : null;

  return createPortal(
    <section
      className="w-full rounded-xl border bg-background/95 p-3 shadow-sm"
      data-screenfeed-ignore="true"
      data-testid="remote-keyboard-controller-overlay"
      data-remote-control-panel-section="keyboard"
    >
      <div className="flex items-start gap-2">
        <div className="rounded-md bg-primary/10 p-1.5 text-primary">
          {keyboardActive ? <Keyboard className="h-4 w-4" /> : <MousePointer2 className="h-4 w-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">
            {t("Keyboard control")} · {session.targetUsername}
          </p>
          <p className="text-xs text-muted-foreground">
            {mouseActive
              ? t("Only safe search, filter and explicitly approved fields can be edited.")
              : t("Mouse control required")}
          </p>
        </div>
        {keyboardActive ? (
          <Button
            size="sm"
            variant="outline"
            className="h-8 shrink-0 px-2"
            disabled={busy}
            onClick={() => void stopKeyboard()}
            data-testid="button-disable-remote-keyboard"
          >
            {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Square className="mr-1 h-3 w-3" />}
            {t("Stop keyboard")}
          </Button>
        ) : (
          <Button
            size="sm"
            className="h-8 shrink-0 px-2"
            disabled={!mouseActive || busy}
            onClick={() => void enableKeyboard()}
            data-testid="button-enable-remote-keyboard"
          >
            {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <LockKeyhole className="mr-1 h-3 w-3" />}
            {t("Enable keyboard")}
          </Button>
        )}
      </div>

      {passwordOpen && !keyboardActive && (
        <form
          className="mt-3 space-y-2 border-t pt-3"
          onSubmit={(event) => {
            event.preventDefault();
            void confirmPasswordAndEnable();
          }}
        >
          <p className="text-xs font-medium">
            {t("Confirm your password to enable keyboard control for up to 5 minutes.")}
          </p>
          <div className="flex gap-2">
            <Input
              autoFocus
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={translateRemoteSupportPhase5Text("Password", language)}
              className="h-9"
              data-testid="input-remote-keyboard-password"
            />
            <Button type="submit" size="sm" className="h-9" disabled={!password || busy}>
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                translateRemoteSupportPhase5Text("Confirm", language)
              )}
            </Button>
          </div>
        </form>
      )}

      {keyboardActive && (
        <div className="mt-3 space-y-2 border-t pt-3">
          <p className="text-xs font-medium">{t("Click a safe field in the watched screen, then type here.")}</p>
          <Input
            ref={captureRef}
            value=""
            inputMode="text"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder={t("Type remote text here")}
            className="h-9"
            data-testid="input-remote-keyboard-capture"
            onPaste={(event) => event.preventDefault()}
            onCopy={(event) => event.preventDefault()}
            onCut={(event) => event.preventDefault()}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={(event) => {
              isComposingRef.current = false;
              const data = event.data ?? event.currentTarget.value ?? "";
              // Clear the DOM value so the next composition starts empty
              event.currentTarget.value = "";
              if (data) {
                queueText(data);
              }
            }}
            onInput={(event) => {
              if (isComposingRef.current) return;
              const target = event.currentTarget as HTMLInputElement;
              const val = target.value;
              if (val) {
                target.value = "";
                // Handles mobile autocomplete, predictives, and any direct insertion
                // that bypassed keyDown (e.g., some IME fallbacks).
                queueText(val);
              }
            }}
            onBlur={() => {
              if (keyboardActive) {
                window.setTimeout(() => captureRef.current?.focus({ preventScroll: true }), 0);
              }
            }}
            onFocus={() => setError(null)}
            onKeyDown={(event) => {
              if (isComposingRef.current) return;
              if (event.ctrlKey || event.metaKey || event.altKey) {
                event.preventDefault();
                setError(t("Clipboard shortcuts and paste are blocked."));
                return;
              }
              const special = ALLOWED_SPECIAL_KEYS.get(event.key);
              if (special) {
                event.preventDefault();
                flushTextBuffer();
                enqueueCommand({ type: "key", key: special, shiftKey: event.shiftKey });
                return;
              }
              if (Array.from(event.key).length === 1) {
                event.preventDefault();
                queueText(event.key);
              } else if (event.key === "Unidentified") {
                // Some IME compositions surface as Unidentified — handled via composition/input
                event.preventDefault();
              }
            }}
          />
          <p className="text-[11px] text-muted-foreground">{t("Clipboard shortcuts and paste are blocked.")}</p>
        </div>
      )}

      <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>
          {keyboardActive ? t("Keyboard active") : mouseActive ? t("Enable keyboard") : t("Mouse control required")}
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
