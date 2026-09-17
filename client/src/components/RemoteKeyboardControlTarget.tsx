import { useEffect, useRef } from "react";
import type { RemoteControlSessionView } from "@/hooks/use-remote-control-session";
import {
  applyRemoteKeyboardCommand,
  clearRemoteEditableFocus,
  noteTrustedLocalRemoteControlInteraction,
  type RemoteKeyboardCommandView,
  type RemoteKeyboardExecutionResult,
} from "@/hooks/remote-keyboard-control-policy";
import {
  requestRemoteControlRealtime,
  subscribeRemoteControlRealtime,
  subscribeRemoteControlRealtimeReady,
} from "@/lib/remote-control-session-transport";

const MAX_COMMAND_AGE_MS = 8000;
const MAX_SEEN_COMMANDS = 256;

function parseCommand(value: unknown): RemoteKeyboardCommandView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const command = value as Partial<RemoteKeyboardCommandView>;
  if (
    !command.id ||
    !command.sessionId ||
    (command.type !== "insert-text" && command.type !== "key") ||
    typeof command.sequence !== "number" ||
    typeof command.shiftKey !== "boolean"
  ) return null;
  return command as RemoteKeyboardCommandView;
}

async function reportResult(
  sessionId: string,
  tabId: string,
  commandId: string,
  result: RemoteKeyboardExecutionResult
): Promise<void> {
  try {
    await requestRemoteControlRealtime({
      type: "remote-control:keyboard-result",
      sessionId,
      tabId,
      commandId,
      status: result.status,
      reason: result.reason,
    });
  } catch {
    // The support session heartbeat/reconnect will reconcile transport state.
  }
}

export function RemoteKeyboardControlTarget({
  session,
  tabId,
}: {
  session: RemoteControlSessionView | null;
  tabId: string;
}) {
  const seenCommandIdsRef = useRef(new Set<string>());
  const lastSequenceRef = useRef(0);
  const sessionId = session?.id ?? null;
  const targetTabId = session?.targetTabId ?? null;
  const keyboardEnabled = !!session?.capabilities.keyboard;

  useEffect(() => {
    seenCommandIdsRef.current.clear();
    lastSequenceRef.current = 0;
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !keyboardEnabled || targetTabId !== tabId) {
      clearRemoteEditableFocus();
      return;
    }

    const onTrustedLocalInteraction = (event: Event) => {
      if (event.isTrusted) noteTrustedLocalRemoteControlInteraction();
    };
    document.addEventListener("pointerdown", onTrustedLocalInteraction, true);
    document.addEventListener("keydown", onTrustedLocalInteraction, true);
    document.addEventListener("beforeinput", onTrustedLocalInteraction, true);
    document.addEventListener("input", onTrustedLocalInteraction, true);

    let closed = false;
    const bind = () => {
      if (closed) return;
      void requestRemoteControlRealtime({
        type: "remote-control:bind-keyboard-target",
        sessionId,
        tabId,
      }).catch(() => undefined);
    };

    const handleCommand = (value: unknown) => {
      if (closed) return;
      const command = parseCommand(value);
      if (!command || command.sessionId !== sessionId) return;

      if (seenCommandIdsRef.current.has(command.id) || command.sequence <= lastSequenceRef.current) {
        void reportResult(sessionId, tabId, command.id, { status: "ignored", reason: "duplicate-command" });
        return;
      }

      seenCommandIdsRef.current.add(command.id);
      lastSequenceRef.current = Math.max(lastSequenceRef.current, command.sequence);
      if (seenCommandIdsRef.current.size > MAX_SEEN_COMMANDS) {
        const first = seenCommandIdsRef.current.values().next().value;
        if (first) seenCommandIdsRef.current.delete(first);
      }

      const createdAt = command.createdAt ? new Date(command.createdAt).getTime() : Date.now();
      const result =
        !Number.isFinite(createdAt) || Date.now() - createdAt > MAX_COMMAND_AGE_MS
          ? { status: "ignored" as const, reason: "stale-command" }
          : applyRemoteKeyboardCommand(command);
      void reportResult(sessionId, tabId, command.id, result);
    };

    const unsubscribeMessages = subscribeRemoteControlRealtime((message) => {
      if (message.type === "remote-control:keyboard-command") handleCommand(message.command);
    });
    const unsubscribeReady = subscribeRemoteControlRealtimeReady((ready) => {
      if (ready) bind();
    });
    bind();

    return () => {
      closed = true;
      void requestRemoteControlRealtime({ type: "remote-control:unbind-keyboard-target", sessionId }).catch(() => undefined);
      unsubscribeMessages();
      unsubscribeReady();
      document.removeEventListener("pointerdown", onTrustedLocalInteraction, true);
      document.removeEventListener("keydown", onTrustedLocalInteraction, true);
      document.removeEventListener("beforeinput", onTrustedLocalInteraction, true);
      document.removeEventListener("input", onTrustedLocalInteraction, true);
      clearRemoteEditableFocus();
    };
  }, [keyboardEnabled, sessionId, tabId, targetTabId]);

  return null;
}
