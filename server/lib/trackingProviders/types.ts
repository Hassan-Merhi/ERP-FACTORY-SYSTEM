/**
 * types.ts — Shared interface for all carrier tracking providers.
 *
 * Every provider normalises its response into this shape so the tracking
 * service can treat them interchangeably and fall back cleanly.
 *
 * Provider ids in use:
 *   "maersk"        — Maersk official OAuth2 API
 *   "maersk_public" — Maersk public webpage (no credentials)
 *   "cma_public"    — CMA CGM public webpage (no credentials)
 *   "parcelsapp"    — ParcelsApp multi-carrier fallback
 */

export interface TrackingEvent {
  date: Date | null;
  status: string | null;
  location: string | null;
  description: string | null;
}

export interface CarrierTrackResult {
  success: boolean;
  /** Canonical provider id */
  provider: string;
  /** Detected/confirmed carrier name */
  carrier: string | null;
  containerNumber: string;
  latestStatus: string | null;
  latestLocation: string | null;
  latestEventDate: Date | null;
  latestDescription: string | null;
  /** ISO date YYYY-MM-DD or null */
  eta: string | null;
  events: TrackingEvent[];
  raw: unknown;
  error?: string;
  /** Provider not configured — safe fallback, not a hard error */
  notConfigured?: boolean;
  /** Provider was blocked by bot protection (Akamai, DataDome, Cloudflare) */
  blocked?: boolean;
  /** Provider responded but returned no useful tracking data */
  noData?: boolean;
}

/** Object view over an unknown carrier payload node, when it actually is one. */
export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Array view over an unknown carrier payload node, when it actually is one. */
export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** First element of an unknown payload node, when it actually is an array. */
export function asFirst(value: unknown): unknown {
  return Array.isArray(value) && value.length > 0 ? value[0] : null;
}

export interface CarrierRawEventLocation {
  portName?: unknown;
  locationName?: unknown;
}

/**
 * Loose shape of one carrier event before normalization. Carriers name the
 * same concept differently, so every field is optional.
 */
export interface CarrierRawEvent {
  eventDateTime?: unknown;
  eventDate?: unknown;
  actualDate?: unknown;
  timestamp?: unknown;
  date?: unknown;
  typeCode?: unknown;
  eventCode?: unknown;
  activityCode?: unknown;
  activityName?: unknown;
  transportEventTypeCode?: unknown;
  status?: unknown;
  description?: unknown;
  eventDescription?: unknown;
  location?: unknown;
  locationName?: unknown;
  portName?: unknown;
}

/** Read a raw event field as a nullable string. */
export function rawStr(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** Object form of a raw event's `location`, when it is one. */
export function asRawEventLocationObject(value: unknown): CarrierRawEventLocation | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as CarrierRawEventLocation) : null;
}
