/**
 * Shared scope, refusal and close-evaluation helpers for the Phase 6 dispatch
 * lifecycle routes (loadingDispatchLifecycleRoutes.ts). Split out to keep that
 * route file under the source-size cap.
 */
import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import { factoryActionCapabilities } from "@shared/factoryActionCapabilities";
import { getFactoryAccessState } from "../../../lib/factoryAccessControl";
import { parseId } from "../../../lib/parseId";
import { resultRows } from "../../../lib/queryResult";
import { logger } from "../../../lib/logger";
import { compareFactoryLoadingDispatch } from "./loadingDispatchComparison";
import { assessFactoryLoadingDispatchClose } from "./loadingDispatchClosePolicy";
import type { loadFactoryLoadingDispatchComparisonSnapshot } from "./loadingDispatchComparisonRoutes";

export type Raw = Record<string, unknown>;
export type RequestScope = {
  companyId: number;
  orderId: number;
  dispatchId: number;
  userId: string;
  username: string;
  role: string;
};
export class LifecycleError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}
export function refusal(statusCode: number, code: string, message: string): never {
  throw new LifecycleError(statusCode, code, message);
}
export function supervisor(role: string) {
  return factoryActionCapabilities({ role })["dispatch.approve-discrepancy"];
}
export function writable(role: string) {
  return factoryActionCapabilities({ role })["dispatch.close"];
}
export function rows(result: unknown): Raw[] {
  return resultRows(result);
}
export function reason(raw: unknown, min: number): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value.length >= min && value.length <= 1000 ? value : null;
}
export async function getScope(req: Request): Promise<RequestScope> {
  const state = await getFactoryAccessState(req);
  if (!state) refusal(403, "NO_FACTORY_ACCESS", "Factory access unavailable");
  const orderId = parseId(req.params.id);
  const dispatchId = parseId(req.params.dispatchId);
  if (orderId === null || dispatchId === null) refusal(400, "INVALID_DISPATCH", "Invalid loading/dispatch ID");
  return {
    companyId: state.companyId,
    orderId,
    dispatchId,
    userId: String(state.userId),
    username: String(req.session.username || state.userId),
    role: state.role,
  };
}
export function sendFailure(res: Response, error: unknown, message: string) {
  if (error instanceof LifecycleError) {
    return res.status(error.statusCode).json({ code: error.code, message: error.message });
  }
  logger.error(message, { error });
  return res.status(500).json({ message: "Unable to process dispatch lifecycle request" });
}

export type LoadedSnapshot = NonNullable<Awaited<ReturnType<typeof loadFactoryLoadingDispatchComparisonSnapshot>>>;
export function evaluate(snapshot: Exclude<LoadedSnapshot, { notFoundTrip: true }>, dispatchId: number) {
  const id = String(dispatchId);
  const trip = snapshot.trips.find((t) => t.id === id);
  if (!trip) refusal(404, "DISPATCH_NOT_FOUND", "Dispatch not found for this loading");

  const comparison = compareFactoryLoadingDispatch({
    loaded: snapshot.loaded,
    scans: snapshot.scans,
    expectedBales: [],
    expectedArticles: [],
    trips: snapshot.trips,
    selectedDispatchId: id,
  });
  const s = comparison.summary;
  const policy = assessFactoryLoadingDispatchClose(comparison);

  // Fingerprint just this trip's physical scan evidence. An unrelated
  // truck's activity or a removed legacy trip allocation cannot block closure.
  const scannedIds = new Set(snapshot.scans.filter((scan) => scan.dispatchId === id).map((scan) => scan.baleId));
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        order: snapshot.order,
        trip,
        loaded: snapshot.loaded.filter((bale) => scannedIds.has(bale.baleId)),
        scans: snapshot.scans.filter((scan) => scan.dispatchId === id),
      })
    )
    .digest("hex");
  return {
    dispatchId,
    dispatchNumber: trip.dispatchNumber,
    status: trip.status,
    fingerprint,
    issues: policy.issues,
    needsApproval: policy.needsApproval,
    canCloseClean: policy.canCloseClean,
    hasAnyScans: policy.hasAnyScans,
    summary: s,
    comparison,
  };
}
