import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { db } from "../../db";
import { factoryContainers, factoryContainerVesselTracking, factoryContainerAisPositionHistory } from "@shared/schema";
import type { AisUpdate } from "./aisTypes";

const HISTORY_SAMPLE_MINUTES = Math.max(5, Number(process.env.AISSTREAM_HISTORY_SAMPLE_MINUTES || 15));

export async function getVesselTracking(containerId: number, companyId: number) {
  const [row] = await db.select().from(factoryContainerVesselTracking)
    .where(and(eq(factoryContainerVesselTracking.containerId, containerId), eq(factoryContainerVesselTracking.companyId, companyId))).limit(1);
  return row ?? null;
}

export async function listVesselPositionHistory(containerId: number, companyId: number, limit = 500) {
  return db.select({
    latitude: factoryContainerAisPositionHistory.latitude,
    longitude: factoryContainerAisPositionHistory.longitude,
    speedKnots: factoryContainerAisPositionHistory.speedKnots,
    course: factoryContainerAisPositionHistory.course,
    heading: factoryContainerAisPositionHistory.heading,
    navigationStatus: factoryContainerAisPositionHistory.navigationStatus,
    observedAt: factoryContainerAisPositionHistory.observedAt,
  }).from(factoryContainerAisPositionHistory)
    .where(and(eq(factoryContainerAisPositionHistory.containerId, containerId), eq(factoryContainerAisPositionHistory.companyId, companyId)))
    .orderBy(asc(factoryContainerAisPositionHistory.observedAt)).limit(Math.min(Math.max(limit, 1), 2000));
}

/** Return only MMSIs attached to containers that are still eligible for live tracking. */
export async function listActiveTrackedMmsis(): Promise<string[]> {
  const rows = await db.select({ mmsi: factoryContainerVesselTracking.mmsi }).from(factoryContainerVesselTracking)
    .innerJoin(factoryContainers, eq(factoryContainers.id, factoryContainerVesselTracking.containerId))
    .where(and(isNull(factoryContainers.deletedAt), eq(factoryContainers.trackingEnabled, true), eq(factoryContainers.trackingAutoUpdate, true), ne(factoryContainers.status, "OFFLOADED")));
  return [...new Set(rows.map((row) => row.mmsi).filter((mmsi): mmsi is string => Boolean(mmsi)))].sort();
}

async function samplePosition(update: Extract<AisUpdate, { kind: "position" }>) {
  // Sample per mapped container at a bounded cadence. The history is the vessel's actual observed trail,
  // never an invented route between ports.
  const mappings = await db.select({
    containerId: factoryContainerVesselTracking.containerId,
    companyId: factoryContainerVesselTracking.companyId,
  }).from(factoryContainerVesselTracking).where(eq(factoryContainerVesselTracking.mmsi, update.mmsi));

  for (const mapping of mappings) {
    await db.insert(factoryContainerAisPositionHistory).values({
      companyId: mapping.companyId,
      containerId: mapping.containerId,
      mmsi: update.mmsi,
      vesselName: update.vesselName,
      latitude: String(update.latitude), longitude: String(update.longitude),
      speedKnots: update.speedKnots === null ? null : String(update.speedKnots),
      course: update.course === null ? null : String(update.course),
      heading: update.heading === null ? null : Math.trunc(update.heading),
      navigationStatus: update.navigationStatus,
      observedAt: update.observedAt,
    }).onConflictDoNothing().then(async () => {
      // Keep at most one sample in each configured time bucket by deleting the just-added point if an older
      // point already exists in the same bucket. This avoids high-frequency AIS storage growth.
      await db.execute(sql`
        DELETE FROM factory_container_ais_position_history h
        WHERE h.container_id = ${mapping.containerId}
          AND h.mmsi = ${update.mmsi}
          AND h.observed_at = ${update.observedAt}
          AND EXISTS (
            SELECT 1 FROM factory_container_ais_position_history older
            WHERE older.container_id = h.container_id AND older.mmsi = h.mmsi
              AND older.observed_at < h.observed_at
              AND older.observed_at >= h.observed_at - (${HISTORY_SAMPLE_MINUTES} * interval '1 minute')
          )
      `);
    });
  }
}

/** Persist an AIS update only for an already-linked MMSI. Wave 2 owns creation of the mapping. */
export async function applyAisUpdate(update: AisUpdate): Promise<number> {
  const now = new Date();
  const patch = update.kind === "position" ? {
    vesselName: update.vesselName ?? undefined, latitude: String(update.latitude), longitude: String(update.longitude),
    speedKnots: update.speedKnots === null ? null : String(update.speedKnots), course: update.course === null ? null : String(update.course),
    heading: update.heading === null ? null : Math.trunc(update.heading), navigationStatus: update.navigationStatus,
    lastPositionAt: update.observedAt, lastAisUpdateAt: now, updatedAt: now,
  } : {
    vesselName: update.vesselName ?? undefined, imo: update.imo, aisDestination: update.destination,
    aisEta: update.eta, lastAisUpdateAt: now, updatedAt: now,
  };
  const rows = await db.update(factoryContainerVesselTracking).set(patch)
    .where(eq(factoryContainerVesselTracking.mmsi, update.mmsi)).returning({ id: factoryContainerVesselTracking.id });
  if (rows.length && update.kind === "position") await samplePosition(update);
  return rows.length;
}
