export interface AisDestinationCoordinates { latitude: number; longitude: number; label: string; }

let cachedRaw: string | undefined;
let cachedMap = new Map<string, AisDestinationCoordinates>();

function normalize(value: string) { return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }

function configuredDestinations() {
  const raw = process.env.AISSTREAM_DESTINATION_COORDINATES || "";
  if (raw === cachedRaw) return cachedMap;
  cachedRaw = raw;
  cachedMap = new Map();
  if (!raw) return cachedMap;
  try {
    const parsed = JSON.parse(raw) as Record<string, { latitude?: unknown; longitude?: unknown }>;
    for (const [label, value] of Object.entries(parsed || {})) {
      const latitude = Number(value?.latitude), longitude = Number(value?.longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) continue;
      cachedMap.set(normalize(label), { latitude, longitude, label });
    }
  } catch {
    // Invalid optional configuration disables calculated ETA rather than affecting tracking.
  }
  return cachedMap;
}

/** Exact normalized match only: never guess a port from fuzzy AIS destination text. */
export function resolveAisDestinationCoordinates(destination: string | null | undefined): AisDestinationCoordinates | null {
  if (!destination) return null;
  return configuredDestinations().get(normalize(destination)) ?? null;
}
