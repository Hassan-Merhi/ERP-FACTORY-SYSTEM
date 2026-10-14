import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db";
import { factoryContainerVesselTracking, factoryContainerAisPositionHistory } from "@shared/schema";

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

