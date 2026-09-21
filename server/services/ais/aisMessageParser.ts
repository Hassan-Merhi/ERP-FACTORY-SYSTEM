import type { AisUpdate } from "./aisTypes";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function finite(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function normalizeMmsi(value: unknown): string | null {
  const raw = typeof value === "number" ? String(Math.trunc(value)) : typeof value === "string" ? value.trim() : "";
  return /^\d{9}$/.test(raw) ? raw : null;
}

function dateValue(value: unknown, fallback = new Date()): Date {
  if (typeof value !== "string" && typeof value !== "number") return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

/** Parse only the AISStream message families the ERP consumes; unknown messages are ignored. */
export function parseAisStreamMessage(raw: string | Buffer): AisUpdate | null {
  let root: JsonRecord;
  try {
    const parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
    const obj = record(parsed);
    if (!obj) return null;
    root = obj;
  } catch {
    return null;
  }

  const metadata = record(root.MetaData) ?? record(root.metadata) ?? {};
  const message = record(root.Message) ?? record(root.message);
  if (!message) return null;

  const mmsi = normalizeMmsi(metadata.MMSI ?? metadata.mmsi);
  if (!mmsi) return null;
  const vesselName = stringValue(metadata.ShipName ?? metadata.shipName);
  const observedAt = dateValue(metadata.time_utc ?? metadata.TimeUtc ?? metadata.timestamp);

  const position = record(message.PositionReport ?? message.positionReport);
  if (position) {
    const latitude = finite(position.Latitude ?? position.latitude);
    const longitude = finite(position.Longitude ?? position.longitude);
    if (latitude === null || longitude === null || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      return null;
    }
    return {
      kind: "position",
      mmsi,
      vesselName,
      latitude,
      longitude,
      speedKnots: finite(position.Sog ?? position.SOG ?? position.speedOverGround),
      course: finite(position.Cog ?? position.COG ?? position.courseOverGround),
      heading: finite(position.TrueHeading ?? position.trueHeading),
      navigationStatus: stringValue(position.NavigationalStatus ?? position.navigationStatus),
      observedAt,
    };
  }

  const staticData = record(message.ShipStaticData ?? message.shipStaticData);
  if (staticData) {
    const imoRaw = finite(staticData.ImoNumber ?? staticData.IMO ?? staticData.imo);
    const etaRaw = staticData.Eta ?? staticData.ETA ?? staticData.eta;
    const eta = typeof etaRaw === "string" || typeof etaRaw === "number" ? dateValue(etaRaw, new Date(NaN)) : new Date(NaN);
    return {
      kind: "static",
      mmsi,
      vesselName: stringValue(staticData.Name ?? staticData.name) ?? vesselName,
      imo: imoRaw && imoRaw > 0 ? String(Math.trunc(imoRaw)) : null,
      destination: stringValue(staticData.Destination ?? staticData.destination),
      eta: Number.isNaN(eta.getTime()) ? null : eta,
      observedAt,
    };
  }

  return null;
}
