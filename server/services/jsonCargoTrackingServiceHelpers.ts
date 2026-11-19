// Extracted from ./jsonCargoTrackingService.ts
import { type JsonCargoCarrier } from "../lib/trackingProviders/jsonCargoProvider";

export const INACTIVE_STATUSES = ["offloaded", "closed", "completed"];

export function refreshWindowHours(): number {
  const raw = process.env.JSONCARGO_REFRESH_HOURS;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  // Default: weekly. This intentionally overrides the JSONCargo spec's 24h suggestion —
  // the business wants a 7-day cadence for this provider, kept configurable via env var.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 168;
}

export type JsonCargoRefreshStatus =
  | "updated"
  | "unchanged"
  | "no_eta"
  | "not_found"
  | "skipped_recent"
  | "unsupported_carrier"
  | "inactive"
  | "invalid_container_number"
  | "not_configured"
  | "error";

export interface JsonCargoRefreshResult {
  containerId: number;
  containerNumber: string | null;
  status: JsonCargoRefreshStatus;
  oldEta: string | null;
  newEta: string | null;
  message: string;
}

export function friendlyMessage(status: JsonCargoRefreshStatus, eta: string | null): string {
  switch (status) {
    case "updated":
      return `ETA updated to ${eta}.`;
    case "unchanged":
      return `ETA confirmed — still ${eta}.`;
    case "no_eta":
      return "JSONCargo has no ETA for this container yet. Existing ETA left unchanged.";
    case "not_found":
      return "JSONCargo could not find this container. Existing ETA left unchanged.";
    case "skipped_recent":
      return "Already checked recently — skipped to avoid unnecessary API calls.";
    case "unsupported_carrier":
      return "Carrier is not one of the JSONCargo-supported lines (Maersk, Hapag-Lloyd, MSC, CMA CGM).";
    case "inactive":
      return "Container is not active (offloaded/closed/completed) — tracking skipped.";
    case "invalid_container_number":
      return "Container number is not in a valid format for tracking.";
    case "not_configured":
      return "ETA tracking is temporarily unavailable.";
    case "error":
    default:
      return "Could not refresh ETA right now. Please try again later.";
  }
}

export const BULK_CONCURRENCY = 4;

export const BULK_MAX_BATCH = 200;

export interface JsonCargoBulkSummary {
  total: number;
  updated: number;
  unchanged: number;
  noEta: number;
  notFound: number;
  skippedRecent: number;
  unsupportedCarrier: number;
  inactive: number;
  errors: number;
  results: JsonCargoRefreshResult[];
}

export interface JsonCargoEtaSummary {
  configured: boolean;
  refreshWindowHours: number;
  supportedCarriers: JsonCargoCarrier[];
  eligibleContainers: number;
  byStatus: Record<string, number>;
}
