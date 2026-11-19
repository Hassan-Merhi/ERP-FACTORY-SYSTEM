import "./lib/observabilityBootstrap";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import type { Express, RequestHandler } from "express";
import { runWithTraceContext } from "./lib/traceContext";
import { logger } from "./lib/logger";
import {
  normalizeBroadcastCompanyIds,
  normalizeBroadcastUserId,
  shouldDeliverBroadcastToCompanies,
  shouldDeliverBroadcastToUser,
} from "./lib/broadcastScope";
import { cleanupScreenFeedWebSocket, type ScreenFeedSocketContext } from "./services/screenFeedWebSocketTransport";
import { cleanupRemoteControlWebSocket } from "./services/remoteControlWebSocketTransport";
import {
  cleanSessionText,
  rawDataBuffer,
  parseJsonMessage,
  handleAuthenticatedSocketMessage,
  type SessionResolution,
  type SessionResolver,
  type SessionUpgradeRequest,
  type BroadcastOptions,
} from "./wsServerHelpers";
export type { BroadcastOptions } from "./wsServerHelpers";

let wss: WebSocketServer | null = null;
let resolveSession: SessionResolver | null = null;

const socketCompanies = new WeakMap<WebSocket, readonly number[] | null>();
const socketUsers = new WeakMap<WebSocket, string | null>();
const socketRealtimeClientIds = new WeakMap<WebSocket, string | null>();
const socketRemoteContexts = new WeakMap<WebSocket, ScreenFeedSocketContext>();

function positiveCompanyId(value: unknown): number | null {
  const companyId = Number(value);
  return Number.isInteger(companyId) && companyId > 0 ? companyId : null;
}

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
            const companyIds = normalizeBroadcastCompanyIds([session?.currentCompanyId, session?.factoryCompanyId]);
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

export function registerWebSocketHttpFallback(app: Express): void {
  app.get("/ws", (_req, res) => {
    res.setHeader("Upgrade", "websocket");
    res.status(426).end();
  });
}

export function setupWS(server: Server, sessionMiddleware?: RequestHandler): void {
  wss = new WebSocketServer({ server, path: "/ws" });
  resolveSession = sessionMiddleware ? sessionCompanyResolver(sessionMiddleware) : null;

  wss.on("connection", (ws, request) => {
    const connectionId = `websocket-${randomUUID()}`;
    socketCompanies.set(ws, null);
    socketUsers.set(ws, null);
    socketRealtimeClientIds.set(ws, null);

    if (resolveSession) {
      void resolveSession(request)
        .then((result) => {
          if (result.status === "resolved") {
            socketCompanies.set(ws, result.companyIds);
            socketUsers.set(ws, result.userId);
            if (result.userId) {
              socketRemoteContexts.set(ws, {
                userId: result.userId,
                username: result.username,
                role: result.role,
                companyId: result.companyId,
              });
            }
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
              if (!isBinary) {
                const message = parseJsonMessage(rawDataBuffer(data));
                if (message?.type === "realtime:identify") {
                  socketRealtimeClientIds.set(ws, cleanSessionText(message.clientId, 128) || null);
                  return;
                }
              }
              const context = socketRemoteContexts.get(ws);
              if (!context) return;
              void handleAuthenticatedSocketMessage(ws, context, data, isBinary).catch((error) => {
                logger.warn("[WS] Remote-support message failed.", { error });
              });
            }
          );
        });

        const pingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.ping();
        }, 30_000);

        ws.on("close", () => {
          clearInterval(pingInterval);
          cleanupRemoteControlWebSocket(ws);
          cleanupScreenFeedWebSocket(ws);
          socketRemoteContexts.delete(ws);
          socketCompanies.delete(ws);
          socketUsers.delete(ws);
          socketRealtimeClientIds.delete(ws);
        });
      }
    );
  });
}

function shouldDeliver(client: WebSocket, options: BroadcastOptions): boolean {
  if (!shouldDeliverBroadcastToCompanies(socketCompanies.get(client), options.companyId)) return false;
  if (!shouldDeliverBroadcastToUser(socketUsers.get(client), options.userIds)) return false;
  if (options.excludeRealtimeClientId && socketRealtimeClientIds.get(client) === options.excludeRealtimeClientId) {
    return false;
  }
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
