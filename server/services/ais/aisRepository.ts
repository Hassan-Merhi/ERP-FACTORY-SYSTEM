import { and, eq, isNull, ne } from "drizzle-orm";
import { db } from "../../db";
import { factoryContainers, factoryContainerVesselTracking } from "@shared/schema";
import type { AisUpdate } from "./aisTypes";

export async function getVesselTracking(containerId: number, companyId: number) {
  const [row] = await db
    .select()
    .from(factoryContainerVesselTracking)
    .where(and(eq(factoryContainerVesselTracking.containerId, containerId), eq(factoryContainerVesselTracking.companyId, companyId)))
    .limit(1);
  return row ?? null;
}

/**
 * Return only MMSIs attached to containers that are still eligible for live tracking.
 * An empty result is intentional: callers must not open a world-wide AIS subscription.
 */
export async function listActiveTrackedMmsis(): Promise<string[]> {
  const rows = await db
    .select({ mmsi: factoryContainerVesselTracking.mmsi })
    .from(factoryContainerVesselTracking)
    .innerJoin(factoryContainers, eq(factoryContainers.id, factoryContainerVesselTracking.containerId))
    .where(and(
      isNull(factoryContainers.deletedAt),
      eq(factoryContainers.trackingEnabled, true),
      eq(factoryContainers.trackingAutoUpdate, true),
      ne(factoryContainers.status, "OFFLOADED")
    ));

  return [...new Set(rows.map((row) => row.mmsi).filter((mmsi): mmsi is string => Boolean(mmsi)))].sort();
}

/** Persist an AIS update only for an already-linked MMSI. Wave 2 owns creation of the mapping. */
export async function applyAisUpdate(update: AisUpdate): Promise<number> {
  const now = new Date();
  const patch = update.kind === "position"
    ? {
        vesselName: update.vesselName ?? undefined,
        latitude: String(update.latitude),
        longitude: String(update.longitude),
        speedKnots: update.speedKnots === null ? null : String(update.speedKnots),
        course: update.course === null ? null : String(update.course),
        heading: update.heading === null ? null : Math.trunc(update.heading),
        navigationStatus: update.navigationStatus,
        lastPositionAt: update.observedAt,
        lastAisUpdateAt: now,
        updatedAt: now,
      }
    : {
        vesselName: update.vesselName ?? undefined,
        imo: update.imo,
        aisDestination: update.destination,
        aisEta: update.eta,
        lastAisUpdateAt: now,
        updatedAt: now,
      };

  const rows = await db
    .update(factoryContainerVesselTracking)
    .set(patch)
    .where(eq(factoryContainerVesselTracking.mmsi, update.mmsi))
    .returning({ id: factoryContainerVesselTracking.id });
  return rows.length;
}
