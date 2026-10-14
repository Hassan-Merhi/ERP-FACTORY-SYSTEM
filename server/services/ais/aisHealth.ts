import type { AisHealthSnapshot } from "./aisTypes";

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
  subscribedVessels: 0,
  subscriptionUpdatedAt: null,
};

export function getAisHealth(): AisHealthSnapshot {
  return { ...health };
}
