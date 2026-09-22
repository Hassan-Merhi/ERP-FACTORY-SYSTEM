export type AisEtaConfidence = "low" | "medium";

export interface AisEtaEstimate {
  eta: Date | null;
  confidence: AisEtaConfidence | null;
  source: "ais_calculated" | null;
  reason: string;
  speedKnots: number | null;
  distanceNm: number | null;
}

const EARTH_RADIUS_NM = 3440.065;
const MIN_SPEED_KNOTS = 2;
const MAX_SPEED_KNOTS = 35;
const MAX_ESTIMATE_DAYS = 45;
const MAX_POSITION_AGE_HOURS = 12;

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function rad(deg: number) { return deg * Math.PI / 180; }

export function greatCircleDistanceNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Conservative fallback only. This intentionally never writes factoryContainers.arrivalDate.
 * Carrier/provider ETA remains authoritative; this estimate is returned separately to the UI.
 */
export function estimateAisEta(input: {
  latitude: unknown;
  longitude: unknown;
  speedKnots: unknown;
  lastPositionAt: Date | string | null | undefined;
  destinationLatitude?: unknown;
  destinationLongitude?: unknown;
  now?: Date;
}): AisEtaEstimate {
  const lat = num(input.latitude), lon = num(input.longitude);
  const destLat = num(input.destinationLatitude), destLon = num(input.destinationLongitude);
  const speed = num(input.speedKnots);
  const now = input.now ?? new Date();
  const observedAt = input.lastPositionAt ? new Date(input.lastPositionAt) : null;

  if (lat === null || lon === null) return { eta: null, confidence: null, source: null, reason: "No current AIS position", speedKnots: speed, distanceNm: null };
  if (destLat === null || destLon === null) return { eta: null, confidence: null, source: null, reason: "Destination coordinates are unavailable", speedKnots: speed, distanceNm: null };
  if (!observedAt || Number.isNaN(observedAt.getTime()) || now.getTime() - observedAt.getTime() > MAX_POSITION_AGE_HOURS * 3600_000) return { eta: null, confidence: null, source: null, reason: "AIS position is stale", speedKnots: speed, distanceNm: null };
  if (speed === null || speed < MIN_SPEED_KNOTS || speed > MAX_SPEED_KNOTS) return { eta: null, confidence: null, source: null, reason: "Vessel speed is not suitable for an ETA estimate", speedKnots: speed, distanceNm: null };

  const distanceNm = greatCircleDistanceNm(lat, lon, destLat, destLon);
  const hours = distanceNm / speed;
  if (!Number.isFinite(hours) || hours < 0 || hours > MAX_ESTIMATE_DAYS * 24) return { eta: null, confidence: null, source: null, reason: "Remaining distance is outside the safe estimate window", speedKnots: speed, distanceNm };

  // Straight-line distance does not model lanes, port queues, weather or transshipment. Keep confidence bounded.
  const confidence: AisEtaConfidence = distanceNm <= 150 ? "medium" : "low";
  return {
    eta: new Date(now.getTime() + hours * 3600_000),
    confidence,
    source: "ais_calculated",
    reason: distanceNm <= 150 ? "Near-destination estimate from current AIS speed" : "Great-circle fallback from current AIS speed; shipping lanes and port delays are not modeled",
    speedKnots: speed,
    distanceNm,
  };
}
