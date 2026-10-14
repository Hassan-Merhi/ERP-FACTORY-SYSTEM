import { db } from "../../db";
import { logger } from "../../lib/logger";
import { factoryContainers, factoryContainerTrackingChecks } from "../../../shared/schema";
import { and, eq, gte } from "drizzle-orm";
import { setSchedulerMeta } from "./persistence";
import { isInactiveStatus } from "./progress-quota";
import { trackOneContainer } from "./track-one";

const MAX_CONCURRENT_TRACK_JOBS = 5;
let _activeTrackJobs = 0;

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
