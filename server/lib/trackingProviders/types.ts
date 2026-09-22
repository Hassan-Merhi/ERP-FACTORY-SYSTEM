/**
 * types.ts — Shared interface for all carrier tracking providers.
 */

export interface TrackingEvent {
  date: Date | null;
  status: string | null;
  location: string | null;
  description: string | null;
}

export interface CarrierVesselIdentity {
  name: string | null;
  imo: string | null;
  mmsi: string | null;
  voyage: string | null;
}

export interface CarrierTrackResult {
  success: boolean;
  provider: string;
  carrier: string | null;
  containerNumber: string;
  latestStatus: string | null;
  latestLocation: string | null;
  latestEventDate: Date | null;
  latestDescription: string | null;
  /** ISO date YYYY-MM-DD or null */
  eta: string | null;
  /** Explicit vessel identity supplied by the provider. Never populated by fuzzy guessing. */
  vessel?: CarrierVesselIdentity | null;
  events: TrackingEvent[];
  raw: unknown;
  error?: string;
  notConfigured?: boolean;
  blocked?: boolean;
  noData?: boolean;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asFirst(value: unknown): unknown {
  return Array.isArray(value) && value.length > 0 ? value[0] : null;
}

export interface CarrierRawEventLocation {
  portName?: unknown;
  locationName?: unknown;
}

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

export function rawStr(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function asRawEventLocationObject(value: unknown): CarrierRawEventLocation | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as CarrierRawEventLocation) : null;
}
