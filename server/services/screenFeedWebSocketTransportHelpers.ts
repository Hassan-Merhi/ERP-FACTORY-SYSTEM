// Extracted from ./screenFeedWebSocketTransport.ts
import type { WebSocket } from "ws";
import { isRemoteSupportEnabled } from "./remoteSupportRuntime";

export interface ScreenFeedSocketContext {
  userId: string;
  username: string;
  role: string;
  companyId: number | null;
}

export type SocketWithState = WebSocket;

export const producers = new Map<string, Set<SocketWithState>>();

export const viewers = new Map<string, Set<SocketWithState>>();

export const latestFrames = new Map<string, { packet: Buffer; capturedAt: number }>();

const OPEN = 1;

export function clean(value: unknown, max = 160): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function safeSendJson(socket: SocketWithState, payload: unknown): void {
  if (socket.readyState !== OPEN) return;
  try {
    socket.send(JSON.stringify(payload));
  } catch {
    // Connection cleanup removes dead sockets.
  }
}

export function safeSendBinary(socket: SocketWithState, packet: Buffer): void {
  if (socket.readyState !== OPEN) return;
  try {
    socket.send(packet, { binary: true });
  } catch {
    // Connection cleanup removes dead sockets.
  }
}

export function notifyProducerStatus(key: string): void {
  const watched = (viewers.get(key)?.size ?? 0) > 0;
  for (const producer of producers.get(key) ?? []) {
    safeSendJson(producer, {
      type: "screen-feed:status",
      watched,
      fast: watched && isRemoteSupportEnabled("fastScreenFeed"),
    });
  }
}
