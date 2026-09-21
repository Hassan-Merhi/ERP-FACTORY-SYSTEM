import type { Express, Request, Response } from "express";
import { requireAuth } from "../../../auth";
import { db } from "../../../db";
import { factoryContainers } from "@shared/schema";
import { and, eq, isNull } from "drizzle-orm";
import { getVesselTracking } from "../../../services/ais/aisRepository";
import { getAisHealth } from "../../../services/ais/aisHealth";

function companyIdFor(req: Request): number | null {
  return req.session.factoryCompanyId || req.session.currentCompanyId || null;
}
async function visibleContainer(containerId: number, companyId: number) {
  const [row] = await db.select({
    id: factoryContainers.id, containerNumber: factoryContainers.containerNumber,
    arrivalDate: factoryContainers.arrivalDate, trackingLastStatus: factoryContainers.trackingLastStatus,
    trackingLastEventDate: factoryContainers.trackingLastEventDate,
    trackingLastDescription: factoryContainers.trackingLastDescription,
    trackingProvider: factoryContainers.trackingProvider,
    trackingDetectedCarrier: factoryContainers.trackingDetectedCarrier,
  }).from(factoryContainers).where(and(eq(factoryContainers.id, containerId), eq(factoryContainers.companyId, companyId), isNull(factoryContainers.deletedAt))).limit(1);
  return row ?? null;
}
/** Carrier tracking remains authoritative; AIS is deliberately returned separately. */
export function registerFactoryContainerVesselTrackingRoutes(app: Express) {
  app.get("/api/factory/containers/:id/vessel-tracking", requireAuth, async (req: Request, res: Response) => {
    const companyId = companyIdFor(req);
    if (!companyId) return res.status(400).json({ message: "No company selected" });
    const containerId = Number(req.params.id);
    if (!Number.isInteger(containerId) || containerId <= 0) return res.status(400).json({ message: "Invalid container id" });
    const container = await visibleContainer(containerId, companyId);
    if (!container) return res.status(404).json({ message: "Container not found" });
    const vessel = await getVesselTracking(containerId, companyId);
    return res.json({
      container: { id: container.id, containerNumber: container.containerNumber, status: container.trackingLastStatus, lastEventDate: container.trackingLastEventDate, lastDescription: container.trackingLastDescription, eta: container.arrivalDate, etaSource: container.trackingProvider || "stored", carrier: container.trackingDetectedCarrier },
      vessel: vessel ? { name: vessel.vesselName, imo: vessel.imo, mmsi: vessel.mmsi, voyage: vessel.voyageNumber, carrier: vessel.carrier, mappingSource: vessel.mappingSource, mappingConfidence: vessel.mappingConfidence } : null,
      ais: vessel ? { latitude: vessel.latitude, longitude: vessel.longitude, speedKnots: vessel.speedKnots, course: vessel.course, heading: vessel.heading, navigationStatus: vessel.navigationStatus, destination: vessel.aisDestination, aisEta: vessel.aisEta, lastPositionAt: vessel.lastPositionAt, lastUpdateAt: vessel.lastAisUpdateAt } : null,
    });
  });
  app.get("/api/factory/containers/:id/ais-position", requireAuth, async (req: Request, res: Response) => {
    const companyId = companyIdFor(req);
    if (!companyId) return res.status(400).json({ message: "No company selected" });
    const containerId = Number(req.params.id);
    if (!Number.isInteger(containerId) || containerId <= 0) return res.status(400).json({ message: "Invalid container id" });
    if (!(await visibleContainer(containerId, companyId))) return res.status(404).json({ message: "Container not found" });
    const vessel = await getVesselTracking(containerId, companyId);
    if (!vessel?.mmsi) return res.status(404).json({ message: "No vessel mapped to this container" });
    return res.json({ mmsi: vessel.mmsi, vesselName: vessel.vesselName, latitude: vessel.latitude, longitude: vessel.longitude, speedKnots: vessel.speedKnots, course: vessel.course, heading: vessel.heading, navigationStatus: vessel.navigationStatus, lastPositionAt: vessel.lastPositionAt, lastUpdateAt: vessel.lastAisUpdateAt });
  });
  app.get("/api/factory/ais/health", requireAuth, (_req: Request, res: Response) => res.json(getAisHealth()));
}
