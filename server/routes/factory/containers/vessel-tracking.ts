import type { Express, Request, Response } from "express";
import { requireAuth } from "../../../auth";
import { db } from "../../../db";
import { factoryContainers } from "@shared/schema";
import { and, eq, isNull } from "drizzle-orm";
import { getVesselTracking, listVesselPositionHistory } from "../../../services/ais/aisRepository";
import { getAisHealth } from "../../../services/ais/aisHealth";
import { estimateAisEta } from "../../../services/ais/aisEtaEstimator";
import { resolveAisDestinationCoordinates } from "../../../services/ais/aisDestinationResolver";

function companyIdFor(req: Request): number | null { return req.session.factoryCompanyId || req.session.currentCompanyId || null; }
async function visibleContainer(containerId: number, companyId: number) {
  const [row] = await db.select({
    id: factoryContainers.id, containerNumber: factoryContainers.containerNumber, arrivalDate: factoryContainers.arrivalDate,
    destination: factoryContainers.destination,
    trackingLastStatus: factoryContainers.trackingLastStatus, trackingLastEventDate: factoryContainers.trackingLastEventDate,
    trackingLastDescription: factoryContainers.trackingLastDescription, trackingProvider: factoryContainers.trackingProvider,
    trackingDetectedCarrier: factoryContainers.trackingDetectedCarrier,
  }).from(factoryContainers).where(and(eq(factoryContainers.id, containerId), eq(factoryContainers.companyId, companyId), isNull(factoryContainers.deletedAt))).limit(1);
  return row ?? null;
}
function validId(raw: string) { const id = Number(raw); return Number.isInteger(id) && id > 0 ? id : null; }

function calculatedEta(container: Awaited<ReturnType<typeof visibleContainer>>, vessel: Awaited<ReturnType<typeof getVesselTracking>>) {
  if (!container || !vessel) return null;
  const destination = resolveAisDestinationCoordinates(container.destination || vessel.aisDestination);
  const estimate = estimateAisEta({
    latitude: vessel.latitude, longitude: vessel.longitude, speedKnots: vessel.speedKnots,
    lastPositionAt: vessel.lastPositionAt,
    destinationLatitude: destination?.latitude, destinationLongitude: destination?.longitude,
  });
  return { ...estimate, destination: destination?.label ?? null };
}

/** Carrier tracking remains authoritative; AIS is deliberately returned separately. */
export function registerFactoryContainerVesselTrackingRoutes(app: Express) {
  app.get("/api/factory/containers/:id/vessel-tracking", requireAuth, async (req: Request, res: Response) => {
    const companyId = companyIdFor(req); if (!companyId) return res.status(400).json({ message: "No company selected" });
    const containerId = validId(req.params.id); if (!containerId) return res.status(400).json({ message: "Invalid container id" });
    const container = await visibleContainer(containerId, companyId); if (!container) return res.status(404).json({ message: "Container not found" });
    const vessel = await getVesselTracking(containerId, companyId);
    const aisEstimate = calculatedEta(container, vessel);
    return res.json({
      container: { id: container.id, containerNumber: container.containerNumber, status: container.trackingLastStatus, lastEventDate: container.trackingLastEventDate, lastDescription: container.trackingLastDescription, eta: container.arrivalDate, etaSource: container.trackingProvider || "stored", carrier: container.trackingDetectedCarrier },
      vessel: vessel ? { name: vessel.vesselName, imo: vessel.imo, mmsi: vessel.mmsi, voyage: vessel.voyageNumber, carrier: vessel.carrier, mappingSource: vessel.mappingSource, mappingConfidence: vessel.mappingConfidence } : null,
      ais: vessel ? { latitude: vessel.latitude, longitude: vessel.longitude, speedKnots: vessel.speedKnots, course: vessel.course, heading: vessel.heading, navigationStatus: vessel.navigationStatus, destination: vessel.aisDestination, aisEta: vessel.aisEta, lastPositionAt: vessel.lastPositionAt, lastUpdateAt: vessel.lastAisUpdateAt, calculatedEta: aisEstimate } : null,
    });
  });
  app.get("/api/factory/containers/:id/ais-position", requireAuth, async (req: Request, res: Response) => {
    const companyId = companyIdFor(req); if (!companyId) return res.status(400).json({ message: "No company selected" });
    const containerId = validId(req.params.id); if (!containerId) return res.status(400).json({ message: "Invalid container id" });
    const container = await visibleContainer(containerId, companyId); if (!container) return res.status(404).json({ message: "Container not found" });
    const vessel = await getVesselTracking(containerId, companyId); if (!vessel?.mmsi) return res.status(404).json({ message: "No vessel mapped to this container" });
    return res.json({ mmsi: vessel.mmsi, vesselName: vessel.vesselName, latitude: vessel.latitude, longitude: vessel.longitude, speedKnots: vessel.speedKnots, course: vessel.course, heading: vessel.heading, navigationStatus: vessel.navigationStatus, lastPositionAt: vessel.lastPositionAt, lastUpdateAt: vessel.lastAisUpdateAt, calculatedEta: calculatedEta(container, vessel) });
  });
  app.get("/api/factory/containers/:id/vessel-history", requireAuth, async (req: Request, res: Response) => {
    const companyId = companyIdFor(req); if (!companyId) return res.status(400).json({ message: "No company selected" });
    const containerId = validId(req.params.id); if (!containerId) return res.status(400).json({ message: "Invalid container id" });
    if (!(await visibleContainer(containerId, companyId))) return res.status(404).json({ message: "Container not found" });
    const points = await listVesselPositionHistory(containerId, companyId, Number(req.query.limit) || 500);
    return res.json({ containerId, points });
  });
  app.get("/api/factory/ais/health", requireAuth, (_req: Request, res: Response) => res.json(getAisHealth()));
}
