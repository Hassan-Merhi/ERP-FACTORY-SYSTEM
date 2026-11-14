/** ParcelsApp shipment event normalization and ETA presentation helpers. */
import type { ParcelsAppEvent, ParcelsAppShipment } from "./parcelsAppClient";
import { logger } from "./logger";

/**
 * Normalises the raw states array from a ParcelsApp shipment into our event shape.
 */
export function normaliseEvents(shipment: ParcelsAppShipment): ParcelsAppEvent[] {
  if (!shipment.states?.length) return [];
  return shipment.states.map((s) => ({
    date: s.date ?? null,
    status: s.status ?? null,
    location: s.location ?? null,
    description: s.description ?? null,
  }));
}

function getShipmentAttribute(shipment: ParcelsAppShipment, key: string): string | undefined {
  const attributes = shipment.attributes;
  if (!attributes) return undefined;

  const normalizedKey = key.trim().toLowerCase();
  if (Array.isArray(attributes)) {
    for (const attribute of attributes) {
      if (!attribute || typeof attribute !== "object") continue;
      const label = typeof attribute.l === "string" ? attribute.l.trim() : "";
      if (!label || label.toLowerCase() !== normalizedKey) continue;
      return typeof attribute.val === "string" ? attribute.val : undefined;
    }
    return undefined;
  }

  const exactValue = attributes[key];
  if (typeof exactValue === "string") return exactValue;
  const matchingKey = Object.keys(attributes).find((attributeKey) => attributeKey.toLowerCase() === normalizedKey);
  if (!matchingKey) return undefined;
  const value = attributes[matchingKey];
  return typeof value === "string" ? value : undefined;
}

/**
 * Derives a simple last-known status string from the shipment attributes or latest state.
 */
export function deriveLastStatus(shipment: ParcelsAppShipment): string | null {
  const firstState = shipment.states?.[0];
  return getShipmentAttribute(shipment, "status") ?? firstState?.status ?? null;
}

/**
 * Derives a simple last-known location string from the shipment attributes or latest state.
 */
export function deriveLastLocation(shipment: ParcelsAppShipment): string | null {
  const firstState = shipment.states?.[0];
  return getShipmentAttribute(shipment, "location") ?? firstState?.location ?? null;
}

/**
 * Derives the latest event date from the first state.
 */
export function deriveLastEventDate(shipment: ParcelsAppShipment): Date | null {
  const raw = shipment.states?.[0]?.date;
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Derives the estimated delivery date from shipment attributes.
 * Checks multiple field names since ParcelsApp varies by carrier/version.
 * Returns an ISO date string (YYYY-MM-DD) or null if not available.
 */
export function deriveEstimatedDeliveryDate(shipment: ParcelsAppShipment): string | null {
  // Helper: parse and return YYYY-MM-DD if valid, else null.
  const tryDate = (raw: unknown): string | null => {
    if (!raw || typeof raw !== "string") return null;
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  };

  const todayStr = new Date().toISOString().slice(0, 10);

  // 1. Check top-level shipment fields that ParcelsApp returns directly.
  //    Try explicitly-named ETA fields first, then delivered_by as a future-only fallback.
  //    delivered_by is excluded here; it's checked at the end only when it's a future date.
  const topLevel = [
    shipment.estimatedArrival,
    shipment.estimatedDeliveryDate,
    shipment.estimatedDelivery,
    shipment.eta,
    (shipment as unknown as ParcelsAppShipment & { estimatedTimeOfArrival: unknown }).estimatedTimeOfArrival,
    (shipment as unknown as ParcelsAppShipment & { scheduledArrival: unknown }).scheduledArrival,
    (shipment as unknown as ParcelsAppShipment & { plannedArrival: unknown }).plannedArrival,
    (shipment as unknown as ParcelsAppShipment & { predictedETA: unknown }).predictedETA,
    (shipment as unknown as ParcelsAppShipment & { ETA: unknown }).ETA,
  ];
  for (const raw of topLevel) {
    const d = tryDate(raw);
    if (d) return d;
  }

  // 2. Normalise attributes to a plain key→value dict.
  //    ParcelsApp returns attributes as an array of {l, val} objects in the real
  //    API response; legacy / test callers may pass a plain dict.
  const rawAttrs = shipment.attributes;
  let attrsDict: Record<string, string> = {};
  if (Array.isArray(rawAttrs)) {
    for (const entry of rawAttrs) {
      if (typeof entry?.l === "string" && typeof entry.val === "string") {
        attrsDict[entry.l] = entry.val;
      }
    }
  } else if (rawAttrs && typeof rawAttrs === "object") {
    attrsDict = rawAttrs as Record<string, string>;
  }

  // Known ETA field names inside the attributes dict.
  const knownEtaKeys = [
    "estimatedDeliveryDate",
    "estimatedDelivery",
    "expectedDelivery",
    "estimatedArrival",
    "estimatedTimeOfArrival",
    "scheduledArrival",
    "plannedArrival",
    "plannedArrivalDate",
    "predictedETA",
    "eta",
    "ETA",
  ];
  for (const key of knownEtaKeys) {
    const d = tryDate(attrsDict[key]);
    if (d) return d;
  }

  // Catch-all: scan attribute keys for unambiguous ETA/estimated-arrival terms.
  // Explicitly excluded patterns: actual, ata, discharge, berth, gate, loaded,
  // departed, movement — those all describe past events, not future ETAs.
  const etaKeyPattern =
    /^(eta|estimatedArrival|estimatedDelivery|expectedDelivery|scheduledArrival|plannedArrival|predictedETA)/i;
  for (const [key, val] of Object.entries(attrsDict)) {
    if (!val || !etaKeyPattern.test(key)) continue;
    const d = tryDate(val);
    if (d) return d;
  }

  // Last resort: ParcelsApp sometimes puts the predicted arrival in `delivered_by`.
  // It can also be a past actual-delivery date, so only use it when the date is
  // strictly in the future (> today).  This is the ONLY circumstance where we
  // use delivered_by — never for containers that have already been delivered.
  const deliveredByRaw = shipment.delivered_by as string | undefined;
  if (deliveredByRaw) {
    const d = tryDate(deliveredByRaw);
    if (d && d > todayStr) {
      logger.info(`[ParcelsApp] deriveEDD: using delivered_by=${deliveredByRaw} as future ETA (${d})`);
      return d;
    }
  }

  // Last-resort: when the latest event's status text explicitly describes
  // an estimated arrival/ETA (e.g. "Estimated Time of Arrival, Vessel: …"),
  // that event's own date IS the ETA.  We only use future (or today) dates
  // to avoid mistaking past events for ETAs.
  const latestState = shipment.states?.[0];
  if (latestState?.date && latestState?.status) {
    const sLower = latestState.status.toLowerCase();
    const isEtaEvent =
      sLower.includes("estimated time of arrival") ||
      sLower.includes("estimated arrival") ||
      sLower === "eta" ||
      sLower.startsWith("eta ");
    if (isEtaEvent) {
      const d = tryDate(latestState.date);
      if (d && d >= todayStr) {
        logger.info(`[ParcelsApp] deriveEDD: using event status "${latestState.status}" date=${d} as ETA`);
        return d;
      }
    }
  }

  // Actual-arrival fallback: once a container has discharged/arrived at
  // destination there will be no future ETA field anywhere in the response.
  // Rather than falling back to a stale old DB date, find the most recent
  // discharge or arrival event and use its date as the actual arrival date.
  // states[] is ordered newest-first, so the first match is the latest event.
  const arrivalPattern = /discharg|import discharg|arrived|arrival at destination|port arrival|delivered/i;
  const states = shipment.states ?? [];
  for (const state of states) {
    if (!state.date) continue;
    const textToCheck = `${state.status ?? ""} ${state.description ?? ""}`;
    if (arrivalPattern.test(textToCheck)) {
      const d = tryDate(state.date);
      if (d) {
        logger.info(`[ParcelsApp] deriveEDD: actual arrival event "${state.status}" → arrivalDate=${d}`);
        return d;
      }
    }
  }

  // No ETA found — return null so the caller preserves whatever is in the DB.
  return null;
}
