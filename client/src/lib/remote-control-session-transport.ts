export interface RemoteControlRealtimeMessage {
  type: string;
  [key: string]: unknown;
}

export class RemoteControlRealtimeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
    readonly retryAfterMs: number | null = null
  ) {
    super(message);
    this.name = "RemoteControlRealtimeError";
  }
}

type Listener = (message: RemoteControlRealtimeMessage) => void;

interface CommandTiming {
  commandId: string;
  targetUserId: string;
  targetTabId: string;
  commandType: string;
  sentAt: number;
}

const listeners = new Set<Listener>();
const readyListeners = new Set<(ready: boolean) => void>();
const pending = new Map<
  string,
  {
    resolve: (message: RemoteControlRealtimeMessage) => void;
    reject: (error: Error) => void;
    timeoutId: number;
  }
>();
const commandTimings = new Map<string, CommandTiming>();
const MAX_COMMAND_TIMINGS = 512;

let socket: WebSocket | null = null;
let authenticatedReady = false;
let reconnectTimer: number | null = null;
let reconnectAttempts = 0;
let refs = 0;

function targetUrl(): string {
  const configured = (import.meta.env?.VITE_WS_URL as string) || "";
  if (configured) return configured;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

function newRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `rc-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function timestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function shouldRun(): boolean {
  return refs > 0 || listeners.size > 0 || pending.size > 0;
}

function setReady(value: boolean): void {
  if (authenticatedReady === value) return;
  authenticatedReady = value;
  for (const listener of readyListeners) listener(value);
}

function sendTelemetry(payload: Record<string, unknown>): void {
  if (!socket || socket.readyState !== WebSocket.OPEN || !authenticatedReady) return;
  try {
    socket.send(JSON.stringify({ type: "remote-support:telemetry", ...payload }));
  } catch {
    // Telemetry is best-effort and must never affect command execution.
  }
}

function trimCommandTimings(): void {
  while (commandTimings.size > MAX_COMMAND_TIMINGS) {
    const first = commandTimings.keys().next();
    if (first.done) break;
    commandTimings.delete(first.value);
  }
}

function observePublishedCommand(message: RemoteControlRealtimeMessage): void {
  if (message.ok === false) return;
  const command = objectRecord(message.command);
  if (!command) return;
  const commandId = typeof command.id === "string" ? command.id.trim().slice(0, 128) : "";
  const targetUserId = typeof command.targetUserId === "string" ? command.targetUserId.trim().slice(0, 128) : "";
  const targetTabId = typeof command.targetTabId === "string" ? command.targetTabId.trim().slice(0, 160) : "";
  const commandType = typeof command.type === "string" ? command.type.slice(0, 80) : "unknown";
  const sentAt = timestamp(command.createdAt);
  if (!commandId || !targetUserId || !targetTabId || sentAt == null) return;

  const timing: CommandTiming = { commandId, targetUserId, targetTabId, commandType, sentAt };
  commandTimings.set(commandId, timing);
  trimCommandTimings();
  sendTelemetry({
    event: "command-sent",
    commandId,
    targetUserId,
    targetTabId,
    commandType,
    sentAt,
  });
}

function observeCommandResult(message: RemoteControlRealtimeMessage): void {
  if (message.type !== "remote-control:mouse-result" && message.type !== "remote-control:keyboard-result") return;
  const result = objectRecord(message.result);
  if (!result) return;
  const commandId = typeof result.commandId === "string" ? result.commandId.trim().slice(0, 128) : "";
  const timing = commandTimings.get(commandId);
  if (!timing) return;
  const executedAt = timestamp(result.completedAt);
  const status = typeof result.status === "string" ? result.status.slice(0, 40) : "unknown";
  if (executedAt == null) return;

  sendTelemetry({
    event: "command-result",
    commandId: timing.commandId,
    targetUserId: timing.targetUserId,
    targetTabId: timing.targetTabId,
    commandType: timing.commandType,
    sentAt: timing.sentAt,
    executedAt,
    status,
  });
  commandTimings.delete(commandId);
}

function failPending(message: string): void {
  for (const [id, request] of pending) {
    window.clearTimeout(request.timeoutId);
    request.reject(new RemoteControlRealtimeError(0, "TRANSPORT_DISCONNECTED", message));
    pending.delete(id);
  }
  commandTimings.clear();
}

function scheduleReconnect(): void {
  if (!shouldRun() || reconnectTimer !== null) return;
  const delay = Math.min(10_000, 500 * 2 ** Math.min(reconnectAttempts, 5)) + Math.floor(Math.random() * 250);
  reconnectAttempts += 1;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function handleMessage(message: RemoteControlRealtimeMessage): void {
  if (message.type === "realtime:ready") {
    reconnectAttempts = 0;
    setReady(true);
    return;
  }

  if (message.type === "remote-control:response" && typeof message.requestId === "string") {
    observePublishedCommand(message);
    const request = pending.get(message.requestId);
    if (request) {
      pending.delete(message.requestId);
      window.clearTimeout(request.timeoutId);
      if (message.ok === false) {
        request.reject(
          new RemoteControlRealtimeError(
            typeof message.status === "number" ? message.status : 500,
            typeof message.code === "string" ? message.code : null,
            typeof message.message === "string" ? message.message : "Remote control request failed.",
            typeof message.retryAfterMs === "number" ? message.retryAfterMs : null
          )
        );
      } else request.resolve(message);
    }
  }

  observeCommandResult(message);
  for (const listener of listeners) listener(message);
}

function connect(): void {
  if (socket || !shouldRun()) return;
  const next = new WebSocket(targetUrl());
  socket = next;
  setReady(false);

  next.onmessage = (event) => {
    if (socket !== next || typeof event.data !== "string") return;
    try {
      const parsed = JSON.parse(event.data) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        typeof (parsed as { type?: unknown }).type === "string"
      ) {
        handleMessage(parsed as RemoteControlRealtimeMessage);
      }
    } catch {
      // Binary screen-feed traffic is carried by a separate client instance.
    }
  };
  next.onerror = () => next.close();
  next.onclose = () => {
    if (socket !== next) return;
    socket = null;
    setReady(false);
    failPending("Remote-control realtime connection closed.");
    scheduleReconnect();
  };
}

function retain(): () => void {
  refs += 1;
  connect();
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    refs = Math.max(0, refs - 1);
    if (!shouldRun()) {
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
      const current = socket;
      socket = null;
      setReady(false);
      commandTimings.clear();
      current?.close(1000, "Remote control idle");
    }
  };
}

export function subscribeRemoteControlRealtime(listener: Listener): () => void {
  listeners.add(listener);
  const release = retain();
  return () => {
    listeners.delete(listener);
    release();
  };
}

export function subscribeRemoteControlRealtimeReady(listener: (ready: boolean) => void): () => void {
  readyListeners.add(listener);
  const release = retain();
  listener(authenticatedReady);
  return () => {
    readyListeners.delete(listener);
    release();
  };
}

export function isRemoteControlRealtimeReady(): boolean {
  return !!socket && socket.readyState === WebSocket.OPEN && authenticatedReady;
}

export function requestRemoteControlRealtime<T extends RemoteControlRealtimeMessage = RemoteControlRealtimeMessage>(
  message: RemoteControlRealtimeMessage,
  timeoutMs = 5000
): Promise<T> {
  if (!isRemoteControlRealtimeReady() || !socket) {
    return Promise.reject(
      new RemoteControlRealtimeError(0, "TRANSPORT_NOT_READY", "Remote-control realtime transport is not ready.")
    );
  }
  const id = newRequestId();
  return new Promise<T>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      pending.delete(id);
      reject(new RemoteControlRealtimeError(0, "TRANSPORT_TIMEOUT", "Remote-control request timed out."));
    }, timeoutMs);
    pending.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
      timeoutId,
    });
    try {
      socket?.send(JSON.stringify({ ...message, requestId: id }));
    } catch (error) {
      window.clearTimeout(timeoutId);
      pending.delete(id);
      reject(error instanceof Error ? error : new Error("Remote-control send failed."));
    }
  });
}
