// Extracted from ./maerskPublicProvider.ts
import { asFirst, asRawEventLocationObject, asRecord, asArray, rawStr } from "./types";
import type { CarrierRawEvent, CarrierTrackResult, TrackingEvent } from "./types";
import { logger } from "../../lib/logger";

export const TIMEOUT_MS = 12_000;

export const _lastAttempt = new Map<string, number>();

function parseDate(raw: unknown): Date | null {
  if (!raw || typeof raw !== "string") return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Recursively search any JSON object for keys that explicitly mean ETA/estimated
 * arrival.  Used as a supplemental pass after the primary field-path extraction,
 * in case Maersk restructures their API response shape.
 * Returns the first valid YYYY-MM-DD string found, or null.
 */
const DEEP_ETA_KEY_RE =
  /^(eta|estimatedArrival|estimatedTimeOfArrival|plannedArrival|plannedArrivalDate|scheduledArrival|predictiveEstimatedArrival|latestEstimatedArrival|arrivalDate|vesselArrival|portArrival|destinationEstimatedArrival)$/i;

function deepScanForEta(obj: unknown, depth = 0): { path: string; value: string } | null {
  if (depth > 12 || !obj || typeof obj !== "object") return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const r = deepScanForEta(item, depth + 1);
      if (r) return r;
    }
    return null;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (DEEP_ETA_KEY_RE.test(k) && typeof v === "string" && v.trim()) {
      const d = new Date(v);
      if (!isNaN(d.getTime())) return { path: k, value: d.toISOString().slice(0, 10) };
    }
    if (v && typeof v === "object") {
      const r = deepScanForEta(v, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

export function parseResponse(containerNumber: string, data: unknown, base: CarrierTrackResult): CarrierTrackResult {
  if (!data || typeof data !== "object") {
    return { ...base, noData: true, error: "empty_response" };
  }

  const d = asRecord(data);

  // Maersk may wrap in various shapes
  const entry = asRecord(
    (Array.isArray(data) ? asFirst(data) : null) ?? asFirst(d.containers) ?? d.shipment ?? d.trackingData ?? d
  );

  if (!entry) return { ...base, noData: true, error: "no_entry" };

  const rawEvents: unknown[] =
    (entry.events as unknown[] | undefined) ??
    (asRecord(asFirst(entry.containers)).events as unknown[] | undefined) ??
    (entry.milestones as unknown[] | undefined) ??
    (d.events as unknown[] | undefined) ??
    [];

  const events: TrackingEvent[] = (Array.isArray(rawEvents) ? (rawEvents as CarrierRawEvent[]) : [])
    .map((e): TrackingEvent => {
      const locObj = asRawEventLocationObject(e.location);
      return {
        date: parseDate(e.eventDateTime ?? e.eventDate ?? e.timestamp ?? e.date ?? null),
        status: rawStr(e.transportEventTypeCode) ?? rawStr(e.activityName) ?? rawStr(e.eventCode) ?? rawStr(e.status),
        location:
          rawStr(locObj?.portName) ??
          rawStr(locObj?.locationName) ??
          rawStr(e.portName) ??
          rawStr(e.locationName) ??
          (typeof e.location === "string" ? e.location : null),
        description: rawStr(e.description) ?? rawStr(e.eventDescription) ?? rawStr(e.activityName),
      };
    })
    .filter((e) => e.date !== null || e.status !== null)
    .sort((a, b) => {
      if (!a.date) return 1;
      if (!b.date) return -1;
      return b.date.getTime() - a.date.getTime();
    });

  const latest = events[0] ?? null;

  // For portCalls, the destination is the last entry or the one flagged isDestination.
  // portCalls[0] is the ORIGIN — never use index 0 for ETA.
  const portCalls = asArray(entry.portCalls).map(asRecord);
  const destPortCall =
    portCalls.find((p) => p.isDestination === true || p.isDestination === "true") ??
    (portCalls.length > 0 ? portCalls[portCalls.length - 1] : null);

  const portOfDischarge = asRecord(entry.portOfDischarge);
  const portCallLegs = asArray(entry.legs);
  const lastLeg = portCallLegs.length > 0 ? asRecord(portCallLegs[portCallLegs.length - 1]) : null;
  const firstContainer = asRecord(asFirst(entry.containers));

  // Destination port call fields have highest priority — they represent the
  // actual arrival ETA at the final destination, not a transit movement.
  const etaRaw =
    destPortCall?.eta ??
    destPortCall?.estimatedArrival ??
    destPortCall?.estimatedTimeOfArrival ??
    portOfDischarge.eta ??
    portOfDischarge.estimatedArrival ??
    portOfDischarge.estimatedTimeOfArrival ??
    entry.eta ??
    entry.estimatedTimeOfArrival ??
    entry.estimatedArrival ??
    entry.plannedArrivalDate ??
    entry.predictedETA ??
    entry.latestEstimatedArrival ??
    entry.scheduledArrival ??
    lastLeg?.eta ??
    lastLeg?.estimatedArrival ??
    firstContainer.eta ??
    d.eta ??
    d.estimatedTimeOfArrival ??
    null;
  const etaDate = parseDate(etaRaw);
  let eta = etaDate ? etaDate.toISOString().slice(0, 10) : null;

  // ── Supplemental: recursive deep-scan for any ETA key we may have missed ────
  // Runs only when the primary field-path chain found nothing, so it never
  // overrides an already-extracted ETA.
  let deepEtaPath: string | null = null;
  if (!eta) {
    const deepResult = deepScanForEta(data);
    if (deepResult) {
      eta = deepResult.value;
      deepEtaPath = deepResult.path;
      logger.info(
        `[MaerskPublic] ${containerNumber}: ETA from deep-scan path=${deepResult.path} val=${deepResult.value}`
      );
    }
  }

  if (!latest && !eta) {
    logger.info(`[MaerskPublic] ${containerNumber}: response parseable but no useful data`);
    return { ...base, noData: true, error: "no_useful_data", raw: data };
  }

  logger.info(
    `[MaerskPublic] ${containerNumber}: success — status=${latest?.status ?? "?"} events=${events.length}` +
      ` eta=${eta ?? "none"}${deepEtaPath ? ` (deep-scan path=${deepEtaPath})` : ""}`
  );

  return {
    ...base,
    success: true,
    latestStatus: latest?.status ?? rawStr(entry.status) ?? rawStr(entry.latestStatus),
    latestLocation: latest?.location ?? null,
    latestEventDate: latest?.date ?? null,
    latestDescription: latest?.description ?? null,
    eta,
    events,
    raw: data,
  };
}
