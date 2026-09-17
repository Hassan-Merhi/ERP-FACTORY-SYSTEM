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

function shouldRun(): boolean {
  return refs > 0 || listeners.size > 0 || pending.size > 0;
}

function setReady(value: boolean): void {
  if (authenticatedReady === value) return;
  authenticatedReady = value;
  for (const listener of readyListeners) listener(value);
}

function failPending(message: string): void {
  for (const [id, request] of pending) {
    window.clearTimeout(request.timeoutId);
    request.reject(new RemoteControlRealtimeError(0, "TRANSPORT_DISCONNECTED", message));
    pending.delete(id);
  }
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
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof (parsed as { type?: unknown }).type === "string") {
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
