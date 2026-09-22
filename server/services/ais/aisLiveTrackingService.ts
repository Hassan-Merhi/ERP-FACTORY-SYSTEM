import { logger } from "../../lib/logger";
import { applyAisUpdate, listActiveTrackedMmsis } from "./aisRepository";
import { setAisSubscriptionCount } from "./aisHealth";
import { AisStreamClient } from "./aisStreamClient";
import type { AisUpdate } from "./aisTypes";

const DEFAULT_REFRESH_MS = 60_000;
const MIN_REFRESH_MS = 15_000;

let refreshTimer: ReturnType<typeof setInterval> | null = null;
let refreshInFlight: Promise<void> | null = null;
let started = false;
let subscribedMmsis: string[] = [];

// Keep at most two fingerprints per currently subscribed vessel (position/static).
// Entries for vessels that leave the active subscription are pruned on refresh so
// a long-running process cannot accumulate identifiers forever.
const lastFingerprints = new Map<string, string>();

function fingerprint(update: AisUpdate): string {
  return JSON.stringify(update);
}

function pruneFingerprints(activeMmsis: string[]): void {
  const active = new Set(activeMmsis);
  for (const key of lastFingerprints.keys()) {
    const separator = key.indexOf(":");
    const mmsi = separator >= 0 ? key.slice(separator + 1) : "";
    if (!active.has(mmsi)) lastFingerprints.delete(key);
  }
}

async function persistUpdate(update: AisUpdate): Promise<void> {
  const key = `${update.kind}:${update.mmsi}`;
  const next = fingerprint(update);
  if (lastFingerprints.get(key) === next) return;
  const affected = await applyAisUpdate(update);
  if (affected > 0) lastFingerprints.set(key, next);
}

const client = new AisStreamClient({
  mmsis: [],
  onUpdate: persistUpdate,
});

async function refreshSubscriptions(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const next = await listActiveTrackedMmsis();
      if (next.join(",") === subscribedMmsis.join(",")) return;

      subscribedMmsis = next;
      pruneFingerprints(next);
      setAisSubscriptionCount(next.length);
      client.setMmsis(next);

      if (next.length === 0) {
        // Critical safety rule: never connect with an empty MMSI filter because that
        // could turn into an unintended world-wide AIS feed.
        client.stop();
        logger.info("[AISStream] no active mapped vessels; live stream paused");
        return;
      }

      client.start();
      logger.info(`[AISStream] live subscription refreshed; vessels=${next.length}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "subscription refresh failed";
      logger.warn("[AISStream] could not refresh active vessel subscriptions", { error: message });
    }
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

export function startAisLiveTracking(): void {
  if (started) return;
  started = true;

  if (!process.env.AISSTREAM_API_KEY) {
    setAisSubscriptionCount(0);
    logger.info("[AISStream] live tracking disabled: AISSTREAM_API_KEY is not configured");
    return;
  }

  void refreshSubscriptions();
  const configured = Number(process.env.AISSTREAM_SUBSCRIPTION_REFRESH_MS ?? DEFAULT_REFRESH_MS);
  const refreshMs = Number.isFinite(configured) ? Math.max(MIN_REFRESH_MS, configured) : DEFAULT_REFRESH_MS;
  refreshTimer = setInterval(() => void refreshSubscriptions(), refreshMs);
  refreshTimer.unref?.();
}

export function stopAisLiveTracking(): void {
  started = false;
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
  subscribedMmsis = [];
  setAisSubscriptionCount(0);
  lastFingerprints.clear();
  client.stop();
}

/** Triggered by mapping/container workflows when they want subscription changes immediately. */
export function refreshAisLiveTrackingSubscriptions(): Promise<void> {
  if (!started) return Promise.resolve();
  return refreshSubscriptions();
}
