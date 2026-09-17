import { useEffect, useRef, useState } from "react";
import type { RemoteControlSessionView } from "@/hooks/use-remote-control-session";
import {
  applyRemoteMouseCommand,
  type RemoteMouseCommandView,
  type RemoteMouseExecutionResult,
} from "@/hooks/remote-mouse-control-policy";
import {
  requestRemoteControlRealtime,
  subscribeRemoteControlRealtime,
  subscribeRemoteControlRealtimeReady,
} from "@/lib/remote-control-session-transport";

interface RemotePointerState {
  x: number;
  y: number;
  visible: boolean;
  clickPulse: number;
}

const MAX_COMMAND_AGE_MS = 8000;
const MAX_SEEN_COMMANDS = 256;

function parseFrameViewport(value: unknown): RemoteMouseCommandView["frameViewport"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const viewport = value as Record<string, unknown>;
  if (
    typeof viewport.width !== "number" ||
    typeof viewport.height !== "number" ||
    typeof viewport.scrollX !== "number" ||
    typeof viewport.scrollY !== "number" ||
    typeof viewport.visualScale !== "number"
  ) return undefined;
  return {
    width: viewport.width,
    height: viewport.height,
    scrollX: viewport.scrollX,
    scrollY: viewport.scrollY,
    visualScale: viewport.visualScale,
  };
}

function parseCommand(value: unknown): RemoteMouseCommandView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const command = value as Partial<RemoteMouseCommandView>;
  if (
    !command.id ||
    !command.sessionId ||
    (command.type !== "pointer-move" && command.type !== "click" && command.type !== "scroll") ||
    typeof command.x !== "number" ||
    typeof command.y !== "number" ||
    typeof command.sequence !== "number"
  ) return null;
  return { ...command, frameViewport: parseFrameViewport(command.frameViewport) } as RemoteMouseCommandView;
}

async function reportCommandResult(
  sessionId: string,
  tabId: string,
  commandId: string,
  result: RemoteMouseExecutionResult
): Promise<void> {
  try {
    await requestRemoteControlRealtime({
      type: "remote-control:mouse-result",
      sessionId,
      tabId,
      commandId,
      status: result.status,
      reason: result.reason,
    });
  } catch {
    // Session heartbeat/reconnect will reconcile transport state.
  }
}

export function RemoteMouseControlTarget({
  session,
  tabId,
}: {
  session: RemoteControlSessionView | null;
  tabId: string;
}) {
  const [pointer, setPointer] = useState<RemotePointerState>({ x: 0.5, y: 0.5, visible: false, clickPulse: 0 });
  const seenCommandIdsRef = useRef(new Set<string>());
  const lastSequenceRef = useRef(0);

  const sessionId = session?.id ?? null;
  const targetTabId = session?.targetTabId ?? null;
  const mouseEnabled = !!session?.capabilities.mouse;
  const keyboardEnabled = !!session?.capabilities.keyboard;
  const keyboardEnabledRef = useRef(keyboardEnabled);

  useEffect(() => {
    keyboardEnabledRef.current = keyboardEnabled;
  }, [keyboardEnabled]);

  useEffect(() => {
    seenCommandIdsRef.current.clear();
    lastSequenceRef.current = 0;
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !mouseEnabled || targetTabId !== tabId) {
      setPointer((current) => ({ ...current, visible: false }));
      return;
    }

    let closed = false;
    const bind = () => {
      if (closed) return;
      void requestRemoteControlRealtime({
        type: "remote-control:bind-mouse-target",
        sessionId,
        tabId,
      }).catch(() => {
        if (!closed) setPointer((current) => ({ ...current, visible: false }));
      });
    };

    const handleCommand = (value: unknown) => {
      if (closed) return;
      const command = parseCommand(value);
      if (!command || command.sessionId !== sessionId) return;

      if (seenCommandIdsRef.current.has(command.id) || command.sequence <= lastSequenceRef.current) {
        void reportCommandResult(sessionId, tabId, command.id, {
          status: "ignored",
          reason: "duplicate-command",
          clientX: 0,
          clientY: 0,
        });
        return;
      }

      seenCommandIdsRef.current.add(command.id);
      lastSequenceRef.current = Math.max(lastSequenceRef.current, command.sequence);
      if (seenCommandIdsRef.current.size > MAX_SEEN_COMMANDS) {
        const first = seenCommandIdsRef.current.values().next().value;
        if (first) seenCommandIdsRef.current.delete(first);
      }

      const createdAt = command.createdAt ? new Date(command.createdAt).getTime() : Date.now();
      if (!Number.isFinite(createdAt) || Date.now() - createdAt > MAX_COMMAND_AGE_MS) {
        void reportCommandResult(sessionId, tabId, command.id, {
          status: "ignored",
          reason: "stale-command",
          clientX: 0,
          clientY: 0,
        });
        return;
      }

      const result = applyRemoteMouseCommand(command, document, window, {
        keyboardEnabled: keyboardEnabledRef.current,
      });
      setPointer((current) => ({
        x: result.clientX,
        y: result.clientY,
        visible: true,
        clickPulse: command.type === "click" ? current.clickPulse + 1 : current.clickPulse,
      }));
      void reportCommandResult(sessionId, tabId, command.id, result);
    };

    const unsubscribeMessages = subscribeRemoteControlRealtime((message) => {
      if (message.type === "remote-control:mouse-command") handleCommand(message.command);
    });
    const unsubscribeReady = subscribeRemoteControlRealtimeReady((ready) => {
      if (ready) bind();
      else if (!closed) setPointer((current) => ({ ...current, visible: false }));
    });
    bind();

    return () => {
      closed = true;
      unsubscribeMessages();
      unsubscribeReady();
      setPointer((current) => ({ ...current, visible: false }));
    };
  }, [mouseEnabled, sessionId, tabId, targetTabId]);

  if (!sessionId || !mouseEnabled || !pointer.visible) return null;

  return (
    <div
      className="pointer-events-none fixed z-[2147483646]"
      style={{ left: pointer.x, top: pointer.y, transform: "translate(-2px, -2px)" }}
      aria-hidden="true"
      data-screenfeed-ignore="true"
      data-testid="remote-support-mouse-pointer"
    >
      <div className="relative h-5 w-5">
        <svg viewBox="0 0 24 24" className="h-5 w-5 drop-shadow" fill="none" aria-hidden="true">
          <path
            d="M4 3.5v14.8l4.2-4.1 2.8 6.3 3-1.4-2.8-6.1h5.9L4 3.5Z"
            fill="white"
            stroke="black"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
        {pointer.clickPulse > 0 && (
          <span
            key={pointer.clickPulse}
            className="absolute -left-2 -top-2 h-7 w-7 animate-ping rounded-full border-2 border-primary/80"
          />
        )}
      </div>
    </div>
  );
}
