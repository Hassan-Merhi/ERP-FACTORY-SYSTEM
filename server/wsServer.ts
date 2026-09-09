import "./lib/observabilityBootstrap";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server } from "http";
import type { RequestHandler } from "express";
import { runWithTraceContext } from "./lib/traceContext";
import { logger } from "./lib/logger";
import {
  normalizeBroadcastCompanyIds,
  shouldDeliverBroadcastToCompanies,
} from "./lib/broadcastScope";

let wss: WebSocketServer | null = null;
let resolveSession: SessionResolver | null = null;

type SessionResolution =
  | { status: "resolved"; companyIds: number[] }
  | { status: "missing" }
  | { status: "unresolved" };

/** Runs the app's session middleware over a bare upgrade request. */
type SessionResolver = (request: IncomingMessage) => Promise<SessionResolution>;
type SessionUpgradeRequest = IncomingMessage & {
  session?: { currentCompanyId?: unknown; factoryCompanyId?: unknown };
};

/**
 * Every client used to receive every broadcast, so a sale in one company woke
 * clients in every other company. Sockets now carry both authenticated ERP and
 * Factory company contexts, and a write only reaches a matching tenant context.
 */
const socketCompanies = new WeakMap<WebSocket, readonly number[] | null>();

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
        // The upgrade request carries the session cookie, and express-session
        // reads it from the same store the HTTP routes use.
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
            if (companyIds.length > 0) {
              finish({ status: "resolved", companyIds });
              return;
            }
            finish({ status: "missing" });
          }
        );
      } catch (error) {
        logger.warn("[WS] Could not resolve the session for a socket.", { error });
        finish({ status: "unresolved" });
      }

      // A hung session store must not leave a live socket permanently unable to
      // receive tenant-scoped invalidations. Mark it unresolved so setupWS can
      // close it and let the client reconnect with a fresh lookup.
      setTimeout(() => finish({ status: "unresolved" }), 5_000).unref?.();
    });
}

export function setupWS(server: Server, sessionMiddleware?: RequestHandler): void {
  wss = new WebSocketServer({ server, path: "/ws" });
  resolveSession = sessionMiddleware ? sessionCompanyResolver(sessionMiddleware) : null;

  wss.on("connection", (ws, request) => {
    const connectionId = `websocket-${randomUUID()}`;

    // Tenant-scoped broadcasts fail closed until company context resolves. If
    // the session store itself errors or times out, close the socket so the
    // client reconnects instead of remaining permanently stale with null scope.
    socketCompanies.set(ws, null);
    if (resolveSession) {
      void resolveSession(request)
        .then((result) => {
          if (result.status === "resolved") {
            socketCompanies.set(ws, result.companyIds);
            return;
          }
          if (result.status === "unresolved" && ws.readyState !== WebSocket.CLOSED) {
            logger.warn("[WS] Closing socket after unresolved session company; client should reconnect.");
            ws.close(1013, "Session company unavailable");
          }
        })
        .catch((error) => {
          logger.warn("[WS] Closing socket after unexpected session-resolution failure.", { error });
          if (ws.readyState !== WebSocket.CLOSED) ws.close(1013, "Session company unavailable");
        });
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

        ws.on("message", () => {
          runWithTraceContext(
            {
              requestId: `websocket-message-${randomUUID()}`,
              routeTemplate: "/ws:message",
              buildVersion: process.env.BUILD_VERSION || process.env.RENDER_GIT_COMMIT?.substring(0, 8) || "dev",
              source: "websocket",
            },
            () => undefined
          );
        });

        const pingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.ping();
          }
        }, 30_000);

        ws.on("close", () => {
          clearInterval(pingInterval);
          socketCompanies.delete(ws);
        });
      }
    );
  });
}

export interface BroadcastOptions {
  /**
   * The company the change belongs to. Sockets in other ERP/Factory company
   * contexts are skipped; unresolved sockets fail closed. Omit companyId to
   * reach every client for intentionally server-wide messages.
   */
  companyId?: number | null;
}

function shouldDeliver(client: WebSocket, companyId: number | null | undefined): boolean {
  return shouldDeliverBroadcastToCompanies(socketCompanies.get(client), companyId);
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
        if (!shouldDeliver(client, options.companyId)) {
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

// ── Broadcast volume ────────────────────────────────────────────────────────
// Every write broadcasts, and every broadcast makes receiving clients refresh
// the dependent active queries. Counting delivered vs skipped messages shows
// whether tenant scoping is keeping unrelated clients asleep.
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
    messagesSkippedByCompanyScope: skippedCount,
    windowMinutes: Math.round(elapsed / 60_000),
  });

  broadcastCount = 0;
  deliveredCount = 0;
  skippedCount = 0;
  lastReportAt = Date.now();
}
