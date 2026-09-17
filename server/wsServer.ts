import "./lib/observabilityBootstrap";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { IncomingMessage, Server } from "http";
import type { RequestHandler } from "express";
import { runWithTraceContext } from "./lib/traceContext";
import { logger } from "./lib/logger";
import {
  normalizeBroadcastCompanyIds,
  normalizeBroadcastUserId,
  shouldDeliverBroadcastToCompanies,
  shouldDeliverBroadcastToUser,
} from "./lib/broadcastScope";
import {
  cleanupScreenFeedWebSocket,
  handleScreenFeedWebSocketMessage,
  type ScreenFeedSocketContext,
} from "./services/screenFeedWebSocketTransport";

let wss: WebSocketServer | null = null;
let resolveSession: SessionResolver | null = null;

type SessionResolution =
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

/** Runs the app's session middleware over a bare upgrade request. */
type SessionResolver = (request: IncomingMessage) => Promise<SessionResolution>;
type SessionUpgradeRequest = IncomingMessage & {
  session?: {
    userId?: unknown;
    username?: unknown;
    currentRole?: unknown;
    role?: unknown;
    currentCompanyId?: unknown;
    factoryCompanyId?: unknown;
  };
};

const socketCompanies = new WeakMap<WebSocket, readonly number[] | null>();
const socketUsers = new WeakMap<WebSocket, string | null>();
const socketScreenFeedContexts = new WeakMap<WebSocket, ScreenFeedSocketContext>();

function cleanSessionText(value: unknown, max = 160): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function positiveCompanyId(value: unknown): number | null {
  const companyId = Number(value);
  return Number.isInteger(companyId) && companyId > 0 ? companyId : null;
}

/**
 * express-session decorates the response to write its cookie. An upgrade has no
 * response to write to, so it gets a stand-in that accepts those calls and does
 * nothing — the session is only being read here.
 */
function upgradeResponseStub() {
  const noop = () => undefined;
  return {
    setHeader: noop,
    getHeader: () => undefined,
    removeHeader: noop,
    writeHead: noop,
    write: () => true,
    end: noop,
    on: noop,
    once: noop,
    emit: () => false,
    headersSent: false,
    finished: false,
  };
}

function sessionCompanyResolver(sessionMiddleware: RequestHandler): SessionResolver {
  return (request) =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (result: SessionResolution) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      try {
        sessionMiddleware(
          request as unknown as Parameters<RequestHandler>[0],
          upgradeResponseStub() as unknown as Parameters<RequestHandler>[1],
          (error?: unknown) => {
            if (error) {
              logger.warn("[WS] Session-store lookup failed for a socket.", { error });
              finish({ status: "unresolved" });
              return;
            }

            const session = (request as SessionUpgradeRequest).session;
            const companyIds = normalizeBroadcastCompanyIds([
              session?.currentCompanyId,
              session?.factoryCompanyId,
            ]);
            const userId = normalizeBroadcastUserId(session?.userId);
            if (companyIds.length > 0 || userId) {
              finish({
                status: "resolved",
                companyIds,
                userId,
                username: cleanSessionText(session?.username) || userId || "",
                role: cleanSessionText(session?.currentRole) || cleanSessionText(session?.role),
                companyId: positiveCompanyId(session?.currentCompanyId) ?? positiveCompanyId(session?.factoryCompanyId),
              });
              return;
            }
            finish({ status: "missing" });
          }
        );
      } catch (error) {
        logger.warn("[WS] Could not resolve the session for a socket.", { error });
        finish({ status: "unresolved" });
      }

      setTimeout(() => finish({ status: "unresolved" }), 5_000).unref?.();
    });
}

function sendRealtimeReady(ws: WebSocket): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "realtime:ready" }));
}

function rawDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

export function setupWS(server: Server, sessionMiddleware?: RequestHandler): void {
  wss = new WebSocketServer({ server, path: "/ws" });
  resolveSession = sessionMiddleware ? sessionCompanyResolver(sessionMiddleware) : null;

  wss.on("connection", (ws, request) => {
    const connectionId = `websocket-${randomUUID()}`;
    socketCompanies.set(ws, null);
    socketUsers.set(ws, null);

    if (resolveSession) {
      void resolveSession(request)
        .then((result) => {
          if (result.status === "resolved") {
            socketCompanies.set(ws, result.companyIds);
            socketUsers.set(ws, result.userId);
            if (result.userId) {
              socketScreenFeedContexts.set(ws, {
                userId: result.userId,
                username: result.username,
                role: result.role,
                companyId: result.companyId,
              });
            }
            // Read the session once at connection setup. Screen-feed binary
            // traffic then reuses this authenticated scope rather than running
            // express-session and user_company_roles middleware per frame.
            sendRealtimeReady(ws);
            return;
          }
          if (result.status === "unresolved" && ws.readyState !== WebSocket.CLOSED) {
            logger.warn("[WS] Closing socket after unresolved session context; client should reconnect.");
            ws.close(1013, "Session context unavailable");
          }
        })
        .catch((error) => {
          logger.warn("[WS] Closing socket after unexpected session-resolution failure.", { error });
          if (ws.readyState !== WebSocket.CLOSED) ws.close(1013, "Session context unavailable");
        });
    } else {
      sendRealtimeReady(ws);
    }

    runWithTraceContext(
      {
        requestId: connectionId,
        routeTemplate: "/ws",
        buildVersion: process.env.BUILD_VERSION || process.env.RENDER_GIT_COMMIT?.substring(0, 8) || "dev",
        source: "websocket",
      },
      () => {
        ws.on("error", () => {});

        ws.on("message", (data, isBinary) => {
          runWithTraceContext(
            {
              requestId: `websocket-message-${randomUUID()}`,
              routeTemplate: "/ws:message",
              buildVersion: process.env.BUILD_VERSION || process.env.RENDER_GIT_COMMIT?.substring(0, 8) || "dev",
              source: "websocket",
            },
            () => {
              const context = socketScreenFeedContexts.get(ws);
              if (!context) return;
              void handleScreenFeedWebSocketMessage(ws, context, rawDataBuffer(data), isBinary).catch((error) => {
                logger.warn("[WS] Screen-feed message failed.", { error });
              });
            }
          );
        });

        const pingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.ping();
        }, 30_000);

        ws.on("close", () => {
          clearInterval(pingInterval);
          cleanupScreenFeedWebSocket(ws);
          socketScreenFeedContexts.delete(ws);
          socketCompanies.delete(ws);
          socketUsers.delete(ws);
        });
      }
    );
  });
}

export interface BroadcastOptions {
  companyId?: number | null;
  userIds?: readonly string[];
}

function shouldDeliver(client: WebSocket, options: BroadcastOptions): boolean {
  if (!shouldDeliverBroadcastToCompanies(socketCompanies.get(client), options.companyId)) return false;
  if (!shouldDeliverBroadcastToUser(socketUsers.get(client), options.userIds)) return false;
  return true;
}

export function broadcast(message: object, options: BroadcastOptions = {}): void {
  if (!wss) return;
  const data = JSON.stringify(message);
  runWithTraceContext(
    {
      requestId: `websocket-broadcast-${randomUUID()}`,
      routeTemplate: "/ws:broadcast",
      buildVersion: process.env.BUILD_VERSION || process.env.RENDER_GIT_COMMIT?.substring(0, 8) || "dev",
      source: "websocket",
    },
    () => {
      let delivered = 0;
      let skipped = 0;
      wss?.clients.forEach((client) => {
        if (client.readyState !== WebSocket.OPEN) return;
        if (!shouldDeliver(client, options)) {
          skipped += 1;
          return;
        }
        client.send(data);
        delivered += 1;
      });
      recordBroadcast(delivered, skipped);
    }
  );
}

const BROADCAST_REPORT_INTERVAL_MS = 5 * 60_000;
let broadcastCount = 0;
let deliveredCount = 0;
let skippedCount = 0;
let lastReportAt = Date.now();

function recordBroadcast(delivered: number, skipped: number): void {
  broadcastCount += 1;
  deliveredCount += delivered;
  skippedCount += skipped;

  const elapsed = Date.now() - lastReportAt;
  if (elapsed < BROADCAST_REPORT_INTERVAL_MS) return;

  logger.info("[WS] Broadcast volume", {
    broadcasts: broadcastCount,
    messagesDelivered: deliveredCount,
    messagesSkippedByScope: skippedCount,
    windowMinutes: Math.round(elapsed / 60_000),
  });

  broadcastCount = 0;
  deliveredCount = 0;
  skippedCount = 0;
  lastReportAt = Date.now();
}
