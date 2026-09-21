import { randomUUID } from "crypto";
import type { Notification, PoolClient } from "pg";
import {
  REALTIME_INVALIDATION_TOPICS,
  type RealtimeInvalidationTopic,
} from "../../../shared/realtimeInvalidation";
import { pool } from "../../db";
import { logger } from "../../lib/logger";

const INVALIDATION_CHANNEL = "erp_read_microcache_invalidate";
const RECONNECT_DELAY_MS = 5_000;
const TOPIC_SET = new Set<string>(REALTIME_INVALIDATION_TOPICS);

export interface ReadMicrocacheInvalidation {
  companyIds?: number[];
  topics?: RealtimeInvalidationTopic[];
  locationIds?: number[];
}

interface ReadMicrocacheNotification {
  version: 1;
  sourceInstanceId: string;
  invalidation?: ReadMicrocacheInvalidation;
}

export interface ReadMicrocacheCoordinator {
  isReady: () => boolean;
  publishInvalidation: (invalidation: ReadMicrocacheInvalidation) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeIds(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = new Set<number>();
  for (const candidate of value) {
    const id = positiveInteger(candidate);
    if (id !== null) ids.add(id);
  }
  return ids.size > 0 ? [...ids] : undefined;
}

function normalizeTopics(value: unknown): RealtimeInvalidationTopic[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const topics = new Set<RealtimeInvalidationTopic>();
  for (const candidate of value) {
    if (typeof candidate === "string" && TOPIC_SET.has(candidate)) {
      topics.add(candidate as RealtimeInvalidationTopic);
    }
  }
  return topics.size > 0 ? [...topics] : undefined;
}

function parseScopedNotification(payload: string | undefined): ReadMicrocacheNotification | null {
  if (!payload?.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.sourceInstanceId !== "string") return null;

    const rawInvalidation = isRecord(parsed.invalidation) ? parsed.invalidation : undefined;
    const companyIds = normalizeIds(rawInvalidation?.companyIds);
    const topics = normalizeTopics(rawInvalidation?.topics);
    const locationIds = normalizeIds(rawInvalidation?.locationIds);
    const invalidation =
      rawInvalidation === undefined
        ? undefined
        : {
            ...(companyIds ? { companyIds } : {}),
            ...(topics ? { topics } : {}),
            ...(locationIds ? { locationIds } : {}),
          };

    return {
      version: 1,
      sourceInstanceId: parsed.sourceInstanceId,
      ...(invalidation ? { invalidation } : {}),
    };
  } catch {
    return null;
  }
}

export function startReadMicrocacheCoordinator(
  onExternalInvalidation: (invalidation?: ReadMicrocacheInvalidation) => void
): ReadMicrocacheCoordinator {
  const instanceId = process.env.RENDER_INSTANCE_ID || `${process.pid}-${randomUUID()}`;
  let ready = false;
  let activeClient: PoolClient | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;

  const scheduleReconnect = () => {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, RECONNECT_DELAY_MS);
    reconnectTimer.unref();
  };

  const detachClient = (client: PoolClient) => {
    client.removeAllListeners("notification");
    client.removeAllListeners("error");
    client.removeAllListeners("end");
    client.release(true);
  };

  const handleDisconnect = (client: PoolClient, error?: unknown) => {
    if (activeClient !== client) return;
    activeClient = null;
    ready = false;
    onExternalInvalidation();
    detachClient(client);
    logger.warn("Read microcache invalidation listener disconnected", {
      module: "read-microcache",
      action: "coordinator-disconnect",
      error,
    });
    scheduleReconnect();
  };

  const connect = async () => {
    let client: PoolClient | null = null;
    try {
      const connectedClient = await pool.connect();
      client = connectedClient;
      activeClient = connectedClient;

      connectedClient.on("notification", (notification: Notification) => {
        if (notification.channel !== INVALIDATION_CHANNEL) return;

        const scoped = parseScopedNotification(notification.payload);
        if (scoped) {
          if (scoped.sourceInstanceId === instanceId) return;
          onExternalInvalidation(scoped.invalidation);
          return;
        }

        // Backward-compatible rollout behavior: older instances publish their
        // bare instance id. Treat any non-self legacy payload as a blanket
        // invalidation rather than risking stale data.
        if (notification.payload === instanceId) return;
        onExternalInvalidation();
      });
      connectedClient.on("error", (error) => handleDisconnect(connectedClient, error));
      connectedClient.on("end", () => handleDisconnect(connectedClient));

      await connectedClient.query(`LISTEN ${INVALIDATION_CHANNEL}`);
      ready = true;
      logger.info("Read microcache invalidation listener ready", {
        module: "read-microcache",
        action: "coordinator-ready",
      });
    } catch (error) {
      ready = false;
      if (client) {
        if (activeClient === client) activeClient = null;
        detachClient(client);
      }
      logger.warn("Read microcache invalidation listener failed to start", {
        module: "read-microcache",
        action: "coordinator-connect-failed",
        error,
      });
      scheduleReconnect();
    }
  };

  void connect();

  return {
    isReady: () => ready,
    publishInvalidation: async (invalidation) => {
      const payload: ReadMicrocacheNotification = {
        version: 1,
        sourceInstanceId: instanceId,
        invalidation,
      };
      try {
        await pool.query("SELECT pg_notify($1, $2)", [INVALIDATION_CHANNEL, JSON.stringify(payload)]);
      } catch (error) {
        logger.warn("Read microcache invalidation publish failed", {
          module: "read-microcache",
          action: "coordinator-publish-failed",
          error,
        });
      }
    },
  };
}
