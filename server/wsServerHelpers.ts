// Extracted from ./wsServer.ts
import { WebSocket, type RawData } from "ws";
import type { IncomingMessage } from "http";
import {
  handleScreenFeedWebSocketMessage,
  screenFeedSocketKey,
  type ScreenFeedSocketContext,
} from "./services/screenFeedWebSocketTransport";
import { handleRemoteControlWebSocketMessage } from "./services/remoteControlWebSocketTransport";
import { isRemoteControlControllerRole } from "./services/remoteControlSessionService";
import { recordRemoteSupportCommandTelemetry } from "./services/remoteSupportRuntime";

export type SessionResolution =
  | {
      status: "resolved";
      companyIds: number[];
      userId: string | null;
      username: string;
      role: string;
      companyId: number | null;
    }
  | { status: "missing" }
  | { status: "unresolved" };

export type SessionResolver = (request: IncomingMessage) => Promise<SessionResolution>;

export type SessionUpgradeRequest = IncomingMessage & {
  session?: {
    userId?: unknown;
    username?: unknown;
    currentRole?: unknown;
    role?: unknown;
    currentCompanyId?: unknown;
    factoryCompanyId?: unknown;
  };
};

export function cleanSessionText(value: unknown, max = 160): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function rawDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export function parseJsonMessage(buffer: Buffer): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(buffer.toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function handleRemoteSupportTelemetry(context: ScreenFeedSocketContext, message: Record<string, unknown>): boolean {
  if (message.type !== "remote-support:telemetry") return false;
  // Only authenticated controller-role sockets can contribute rollout metrics.
  if (!isRemoteControlControllerRole(context.role)) return true;

  const commandId = cleanSessionText(message.commandId, 128);
  const targetUserId = cleanSessionText(message.targetUserId, 128);
  const targetTabId = cleanSessionText(message.targetTabId, 160);
  if (!commandId || !targetUserId || !targetTabId) return true;
  const feedKey = screenFeedSocketKey(targetUserId, targetTabId);
  const commandType = cleanSessionText(message.commandType, 80) || "unknown";

  if (message.event === "command-sent") {
    recordRemoteSupportCommandTelemetry({
      event: "sent",
      commandId,
      feedKey,
      commandType,
      sentAt: finiteNumber(message.sentAt),
    });
    return true;
  }

  if (message.event === "command-result") {
    recordRemoteSupportCommandTelemetry({
      event: "result",
      commandId,
      feedKey,
      commandType,
      sentAt: finiteNumber(message.sentAt),
      executedAt: finiteNumber(message.executedAt),
      status: cleanSessionText(message.status, 40),
    });
  }
  return true;
}

export async function handleAuthenticatedSocketMessage(
  ws: WebSocket,
  context: ScreenFeedSocketContext,
  data: RawData,
  isBinary: boolean
): Promise<void> {
  const buffer = rawDataBuffer(data);
  if (!isBinary) {
    const message = parseJsonMessage(buffer);
    if (message) {
      if (handleRemoteSupportTelemetry(context, message)) return;
      if (typeof message.type === "string" && message.type.startsWith("remote-control:")) {
        if (await handleRemoteControlWebSocketMessage(ws, context, message)) return;
      }
    }
  }
  await handleScreenFeedWebSocketMessage(ws, context, buffer, isBinary);
}

export interface BroadcastOptions {
  companyId?: number | null;
  userIds?: readonly string[];
  /** Skip only the browser tab that already applied this write locally. */
  excludeRealtimeClientId?: string | null;
}
