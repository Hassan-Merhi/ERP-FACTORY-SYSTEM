import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { factoryContainers, factoryContainerTrackingChecks } from "../../../shared/schema";
import { and, eq, gte } from "drizzle-orm";
import { setSchedulerMeta } from "./persistence";
import { activeStatusFilter, anyProviderConfigured, isInactiveStatus, isValidContainerNumber } from "./progress-quota";
import { trackOneContainer } from "./track-one";

const MAX_CONCURRENT_TRACK_JOBS = 5;
const DEFAULT_FACTORY_TRACKING_MAX_PER_RUN = 30;
let _activeTrackJobs = 0;

function factoryTrackingMaxPerRun(): number {
  const configured = Number(process.env.FACTORY_TRACKING_MAX_PER_RUN);
  if (!Number.isFinite(configured)) return DEFAULT_FACTORY_TRACKING_MAX_PER_RUN;
  return Math.max(1, Math.min(100, Math.trunc(configured)));
}

/** True when the server already has the maximum number of tracking jobs running. */
export function isFactoryTrackingAtCapacity(): boolean {
  return _activeTrackJobs >= MAX_CONCURRENT_TRACK_JOBS;
}

/** Number of factory tracking jobs currently in flight. */
export function factoryTrackingInFlightCount(): number {
  return _activeTrackJobs;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface FactoryTrackNowResult {
  success: boolean;
  containerNumber: string;
  provider: string | null;
  lastStatus: string | null;
  lastLocation: string | null;
  lastDescription: string | null;
  lastCheckedAt: Date;
  oldEta: string | null;
  newEta: string | null;
  etaChanged: boolean;
  attempts: Array<{ provider: string; status: string; error: string | null }>;
  error: string | null;
}

export async function trackOneFactoryContainerById(containerId: number): Promise<FactoryTrackNowResult> {
  if (_activeTrackJobs >= MAX_CONCURRENT_TRACK_JOBS) {
    throw Object.assign(new Error("Server is busy — too many tracking jobs in flight. Try again shortly."), {
      code: "TRACKING_BUSY",
    });
  }

  const [row] = await db
    .select({
      id: factoryContainers.id,
      containerNumber: factoryContainers.containerNumber,
      status: factoryContainers.status,
      arrivalDate: factoryContainers.arrivalDate,
      destination: factoryContainers.destination,
      trackingCarrierHint: factoryContainers.trackingCarrierHint,
    })
    .from(factoryContainers)
    .where(eq(factoryContainers.id, containerId))
    .limit(1);

  if (!row) throw new Error("Container not found");

  if (isInactiveStatus(row.status)) {
    throw new Error("Tracking is disabled for offloaded/closed/completed containers.");
  }

  _activeTrackJobs++;
  try {
    const oldEta = row.arrivalDate ?? null;
    const trackStartedAt = new Date();
    const destinationCountry = row.destination || "Congo";
    const manualCarrierHint = row.trackingCarrierHint ?? null;
    logger.info(
      `[FactoryTracking] trackOneFactoryContainerById: container=${row.containerNumber} dest="${destinationCountry}" manualHint=${manualCarrierHint ?? "none"}`
    );

    const result = await trackOneContainer(row.id, row.containerNumber, destinationCountry, manualCarrierHint);
    await setSchedulerMeta(row.id, null, new Date(Date.now() + 24 * 60 * 60 * 1000));

    const [postRow] = await db
      .select({ arrivalDate: factoryContainers.arrivalDate, trackingProvider: factoryContainers.trackingProvider })
      .from(factoryContainers)
      .where(eq(factoryContainers.id, containerId))
      .limit(1);

    const newEta = postRow?.arrivalDate ?? null;
    const finalProvider = postRow?.trackingProvider ?? null;

    const attemptRows = await db
      .select({
        provider: factoryContainerTrackingChecks.provider,
        status: factoryContainerTrackingChecks.status,
        error: factoryContainerTrackingChecks.errorMessage,
      })
      .from(factoryContainerTrackingChecks)
      .where(
        and(
          eq(factoryContainerTrackingChecks.containerId, containerId),
          gte(factoryContainerTrackingChecks.checkedAt, trackStartedAt)
        )
      )
      .orderBy(factoryContainerTrackingChecks.checkedAt);

    return {
      success: result.success,
      containerNumber: row.containerNumber,
      provider: finalProvider,
      lastStatus: result.lastStatus,
      lastLocation: result.lastLocation,
      lastDescription: result.lastDescription,
      lastCheckedAt: result.lastCheckedAt,
      oldEta,
      newEta,
      etaChanged: newEta !== oldEta,
      attempts: attemptRows,
      error: result.error,
    };
  } finally {
    _activeTrackJobs--;
  }
}

export async function trackDueFactoryContainers(): Promise<void> {
  logger.info("[FactoryTracking] Starting auto-tracking run...");

  if (!anyProviderConfigured()) {
    logger.info("[FactoryTracking] No tracking providers configured — skipping.");
    return;
  }

  let rows: Array<{
    id: number;
    containerNumber: string;
    status: string;
    trackingAutoUpdate: boolean;
    trackingLastCheckedAt: Date | null;
    trackingNextCheckAt: Date | null;
    destination: string | null;
    trackingCarrierHint: string | null;
  }>;

  try {
    rows = await db
      .select({
        id: factoryContainers.id,
        containerNumber: factoryContainers.containerNumber,
        status: factoryContainers.status,
        trackingAutoUpdate: factoryContainers.trackingAutoUpdate,
        trackingLastCheckedAt: factoryContainers.trackingLastCheckedAt,
        trackingNextCheckAt: factoryContainers.trackingNextCheckAt,
        destination: factoryContainers.destination,
        trackingCarrierHint: factoryContainers.trackingCarrierHint,
      })
      .from(factoryContainers)
      .where(and(eq(factoryContainers.trackingEnabled, true), activeStatusFilter));
  } catch (err: unknown) {
    logger.error("[FactoryTracking] Failed to fetch containers", { error: getErrorMessage(err) });
    return;
  }

  if (rows.length === 0) {
    logger.info("[FactoryTracking] No active tracking-enabled factory containers.");
    return;
  }

  const now = Date.now();
  const MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;

  const eligible = rows.filter((r) => {
    if (!r.trackingAutoUpdate) return false;
    if (!isValidContainerNumber(r.containerNumber)) return false;
    if (r.trackingNextCheckAt && r.trackingNextCheckAt.getTime() > now) return false;
    if (r.trackingLastCheckedAt && now - r.trackingLastCheckedAt.getTime() < MIN_INTERVAL_MS) return false;
    return true;
  });

  // Bound each six-hour run so a large backlog does not turn into a long burst
  // of carrier requests. Oldest/never-checked rows go first, so deferred rows
  // naturally rotate into the next run without being marked as checked.
  eligible.sort((a, b) => {
    const aChecked = a.trackingLastCheckedAt?.getTime() ?? 0;
    const bChecked = b.trackingLastCheckedAt?.getTime() ?? 0;
    if (aChecked !== bChecked) return aChecked - bChecked;
    return a.id - b.id;
  });

  const maxPerRun = factoryTrackingMaxPerRun();
  const toTrack = eligible.slice(0, maxPerRun);
  const deferred = eligible.length - toTrack.length;

  logger.info(
    `[FactoryTracking] ${eligible.length} of ${rows.length} factory containers eligible; ` +
      `tracking ${toTrack.length} this run, deferring ${deferred}.`
  );

  for (const row of toTrack) {
    try {
      const destCountry = row.destination || "Congo";
      const carrierHint = row.trackingCarrierHint ?? null;
      await trackOneContainer(row.id, row.containerNumber, destCountry, carrierHint);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } catch (err: unknown) {
      logger.error(`[FactoryTracking] Error tracking ${row.containerNumber}`, {
        containerId: row.id,
        error: getErrorMessage(err),
      });
    }
  }

  logger.info("[FactoryTracking] Auto-tracking run complete.", {
    eligible: eligible.length,
    tracked: toTrack.length,
    deferred,
    maxPerRun,
  });
}

export async function updateFactoryContainerTrackingSettings(
  containerId: number,
  settings: { trackingEnabled?: boolean; trackingAutoUpdate?: boolean; trackingCarrierHint?: string | null }
): Promise<void> {
  const updatePayload: Record<string, unknown> = {};
  if (settings.trackingEnabled !== undefined) updatePayload.trackingEnabled = settings.trackingEnabled;
  if (settings.trackingAutoUpdate !== undefined) updatePayload.trackingAutoUpdate = settings.trackingAutoUpdate;
  if ("trackingCarrierHint" in settings) updatePayload.trackingCarrierHint = settings.trackingCarrierHint;
  if (Object.keys(updatePayload).length === 0) return;
  await db.update(factoryContainers).set(updatePayload).where(eq(factoryContainers.id, containerId));
}
