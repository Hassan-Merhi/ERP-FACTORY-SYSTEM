/**
 * jsonCargoTrackingService.ts — reusable ETA-refresh service backed by JSONCargo.
 *
 * This is deliberately independent of containerTrackingService.ts's multi-provider
 * status/location pipeline: JSONCargo only ever updates `containers.eta`, on its own
 * weekly cadence (JSONCARGO_REFRESH_HOURS, default 168h), for four supported carriers
 * (Maersk, Hapag-Lloyd, MSC, CMA CGM). It is tried FIRST for those carriers — see the
 * call from containerTrackingService.trackOneContainer.
 *
 * Never expose the JSONCargo API key, raw HTTP responses, or internal error detail
 * to API clients — only the safe status/message shapes below.
 */
import { db } from "../db";
import { getErrorMessage } from "../lib/httpHandlers";
import { containers } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import {
  track,
  isConfigured,
  isValidContainerNumber,
  normalizeJsonCargoCarrier,
  SUPPORTED_CARRIERS,
} from "../lib/trackingProviders/jsonCargoProvider";
import {
  INACTIVE_STATUSES,
  refreshWindowHours,
  friendlyMessage,
  BULK_CONCURRENCY,
  BULK_MAX_BATCH,
  type JsonCargoRefreshResult,
  type JsonCargoBulkSummary,
  type JsonCargoEtaSummary,
} from "./jsonCargoTrackingServiceHelpers";
export type {
  JsonCargoRefreshStatus,
  JsonCargoRefreshResult,
  JsonCargoBulkSummary,
  JsonCargoEtaSummary,
} from "./jsonCargoTrackingServiceHelpers";

/**
 * Refresh a single container's ETA via JSONCargo, honoring the weekly refresh window
 * unless `forceRefresh` is set. Never blanks an existing ETA on failure/no-data.
 */
export async function refreshContainerEta(
  containerId: number,
  opts: { forceRefresh?: boolean; companyId?: number } = {}
): Promise<JsonCargoRefreshResult> {
  const whereClause = opts.companyId
    ? and(eq(containers.id, containerId), eq(containers.companyId, opts.companyId))
    : eq(containers.id, containerId);

  const [row] = await db
    .select({
      id: containers.id,
      companyId: containers.companyId,
      containerNumber: containers.containerNumber,
      status: containers.status,
      eta: containers.eta,
      trackingCarrierHint: containers.trackingCarrierHint,
      trackingEnabled: containers.trackingEnabled,
      jsonCargoLastCheckedAt: containers.jsonCargoLastCheckedAt,
    })
    .from(containers)
    .where(whereClause)
    .limit(1);

  if (!row) {
    throw new Error("Container not found");
  }

  const base = { containerId: row.id, containerNumber: row.containerNumber, oldEta: row.eta ?? null };

  if (INACTIVE_STATUSES.includes((row.status || "").toLowerCase())) {
    return { ...base, status: "inactive", newEta: row.eta ?? null, message: friendlyMessage("inactive", null) };
  }

  if (row.trackingEnabled === false && !opts.forceRefresh) {
    return {
      ...base,
      status: "inactive",
      newEta: row.eta ?? null,
      message: "Tracking is disabled for this container.",
    };
  }

  const carrier = normalizeJsonCargoCarrier(row.trackingCarrierHint);
  if (!carrier) {
    return {
      ...base,
      status: "unsupported_carrier",
      newEta: row.eta ?? null,
      message: friendlyMessage("unsupported_carrier", null),
    };
  }

  if (!isValidContainerNumber(row.containerNumber)) {
    return {
      ...base,
      status: "invalid_container_number",
      newEta: row.eta ?? null,
      message: friendlyMessage("invalid_container_number", null),
    };
  }

  if (!opts.forceRefresh && row.jsonCargoLastCheckedAt) {
    const elapsedMs = Date.now() - new Date(row.jsonCargoLastCheckedAt).getTime();
    const windowMs = refreshWindowHours() * 60 * 60 * 1000;
    if (elapsedMs < windowMs) {
      return {
        ...base,
        status: "skipped_recent",
        newEta: row.eta ?? null,
        message: friendlyMessage("skipped_recent", null),
      };
    }
  }

  if (!isConfigured()) {
    return {
      ...base,
      status: "not_configured",
      newEta: row.eta ?? null,
      message: friendlyMessage("not_configured", null),
    };
  }

  const result = await track(row.containerNumber, carrier);
  const now = new Date();

  if (!result.success) {
    if (result.errorCategory === "not_found") {
      await db
        .update(containers)
        .set({ jsonCargoLastCheckedAt: now, jsonCargoTrackingStatus: "NOT_FOUND", jsonCargoError: null })
        .where(eq(containers.id, row.id));
      return { ...base, status: "not_found", newEta: row.eta ?? null, message: friendlyMessage("not_found", null) };
    }

    // Transient/other errors: record the attempt (protects the weekly quota from
    // being hammered every scheduler pass) but never touch the existing ETA.
    await db
      .update(containers)
      .set({
        jsonCargoLastCheckedAt: now,
        jsonCargoTrackingStatus: "ERROR",
        jsonCargoError: result.errorCategory,
      })
      .where(eq(containers.id, row.id));
    return { ...base, status: "error", newEta: row.eta ?? null, message: friendlyMessage("error", null) };
  }

  if (!result.eta) {
    await db
      .update(containers)
      .set({ jsonCargoLastCheckedAt: now, jsonCargoTrackingStatus: "NO_ETA", jsonCargoError: null })
      .where(eq(containers.id, row.id));
    return { ...base, status: "no_eta", newEta: row.eta ?? null, message: friendlyMessage("no_eta", null) };
  }

  const changed = result.eta !== row.eta;
  await db
    .update(containers)
    .set({
      eta: result.eta,
      etaSource: "api",
      jsonCargoLastCheckedAt: now,
      jsonCargoTrackingStatus: "SUCCESS",
      jsonCargoError: null,
    })
    .where(eq(containers.id, row.id));

  return {
    ...base,
    status: changed ? "updated" : "unchanged",
    newEta: result.eta,
    message: friendlyMessage(changed ? "updated" : "unchanged", result.eta),
  };
}

/**
 * Refresh ETAs for many containers with bounded concurrency and de-duplication.
 * If `containerIds` is omitted, refreshes every active, tracking-enabled container
 * whose carrier hint maps to a JSONCargo-supported carrier (scoped to companyId).
 */
export async function refreshMultipleContainerEtas(
  containerIds?: number[],
  opts: { forceRefresh?: boolean; companyId?: number } = {}
): Promise<JsonCargoBulkSummary> {
  let ids: number[];

  if (containerIds && containerIds.length > 0) {
    ids = Array.from(new Set(containerIds)).slice(0, BULK_MAX_BATCH);
  } else {
    const whereClauses = [
      eq(containers.trackingEnabled, true),
      opts.companyId ? eq(containers.companyId, opts.companyId) : undefined,
    ].filter(Boolean);

    const rows = await db
      .select({ id: containers.id, status: containers.status, trackingCarrierHint: containers.trackingCarrierHint })
      .from(containers)
      .where(and(...whereClauses));

    ids = rows
      .filter(
        (r) =>
          !INACTIVE_STATUSES.includes((r.status || "").toLowerCase()) &&
          !!normalizeJsonCargoCarrier(r.trackingCarrierHint)
      )
      .map((r) => r.id)
      .slice(0, BULK_MAX_BATCH);
  }

  const results: JsonCargoRefreshResult[] = [];
  let cursor = 0;

  async function worker() {
    while (cursor < ids.length) {
      const idx = cursor++;
      const id = ids[idx];
      try {
        const r = await refreshContainerEta(id, opts);
        results.push(r);
      } catch (err: unknown) {
        results.push({
          containerId: id,
          containerNumber: null,
          status: "error",
          oldEta: null,
          newEta: null,
          message: getErrorMessage(err) ?? "Refresh failed",
        });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(BULK_CONCURRENCY, ids.length) }, () => worker()));

  const summary: JsonCargoBulkSummary = {
    total: results.length,
    updated: results.filter((r) => r.status === "updated").length,
    unchanged: results.filter((r) => r.status === "unchanged").length,
    noEta: results.filter((r) => r.status === "no_eta").length,
    notFound: results.filter((r) => r.status === "not_found").length,
    skippedRecent: results.filter((r) => r.status === "skipped_recent").length,
    unsupportedCarrier: results.filter((r) => r.status === "unsupported_carrier").length,
    inactive: results.filter((r) => r.status === "inactive").length,
    errors: results.filter((r) => r.status === "error" || r.status === "not_configured").length,
    results,
  };
  return summary;
}

/** Lightweight dashboard summary — no per-container detail, no secrets. */
export async function getEtaTrackingSummary(companyId?: number): Promise<JsonCargoEtaSummary> {
  const whereClauses = [companyId ? eq(containers.companyId, companyId) : undefined].filter(Boolean);

  const rows = await db
    .select({
      status: containers.status,
      trackingCarrierHint: containers.trackingCarrierHint,
      jsonCargoTrackingStatus: containers.jsonCargoTrackingStatus,
      trackingEnabled: containers.trackingEnabled,
    })
    .from(containers)
    .where(whereClauses.length ? and(...whereClauses) : undefined);

  const eligible = rows.filter(
    (r) =>
      r.trackingEnabled !== false &&
      !INACTIVE_STATUSES.includes((r.status || "").toLowerCase()) &&
      !!normalizeJsonCargoCarrier(r.trackingCarrierHint)
  );

  const byStatus: Record<string, number> = {};
  for (const r of eligible) {
    const key = r.jsonCargoTrackingStatus || "NEVER_CHECKED";
    byStatus[key] = (byStatus[key] || 0) + 1;
  }

  return {
    configured: isConfigured(),
    refreshWindowHours: refreshWindowHours(),
    supportedCarriers: SUPPORTED_CARRIERS,
    eligibleContainers: eligible.length,
    byStatus,
  };
}
