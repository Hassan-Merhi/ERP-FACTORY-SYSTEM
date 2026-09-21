import type { AisConnectionState, AisHealthSnapshot } from "./aisTypes";

const health: AisHealthSnapshot = {
  state: process.env.AISSTREAM_API_KEY ? "stopped" : "disabled",
  configured: Boolean(process.env.AISSTREAM_API_KEY),
  connectedAt: null,
  lastMessageAt: null,
  lastErrorAt: null,
  lastError: null,
  messagesReceived: 0,
  messagesRejected: 0,
  reconnects: 0,
};

export function setAisState(state: AisConnectionState): void {
  health.state = state;
  if (state === "connected") health.connectedAt = new Date();
}

export function recordAisMessage(accepted: boolean): void {
  health.lastMessageAt = new Date();
  if (accepted) health.messagesReceived += 1;
  else health.messagesRejected += 1;
}

export function recordAisError(message: string): void {
  health.lastError = message;
  health.lastErrorAt = new Date();
}

export function recordAisReconnect(): void {
  health.reconnects += 1;
}

export function getAisHealth(): AisHealthSnapshot {
  return { ...health };
}
