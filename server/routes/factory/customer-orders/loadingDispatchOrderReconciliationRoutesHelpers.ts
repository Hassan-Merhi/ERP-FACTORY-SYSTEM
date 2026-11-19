// Extracted from ./loadingDispatchOrderReconciliationRoutes.ts
import type { Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../../db";
import { getFactoryAccessState } from "../../../lib/factoryAccessControl";
import { logger } from "../../../lib/logger";
import { parseId } from "../../../lib/parseId";
import { resultRows } from "../../../lib/queryResult";
import { acquireProformaCapacityTransactionLock } from "./proformaCapacityConcurrency";
import { PRIORITY_SCAN_LOCK_NAMESPACE } from "./priorityScanQueue";
import { DispatchReleaseNotReadyError } from "../../../services/factory/dispatchReleaseReadiness";
import { OrderReconciliationError } from "./loadingDispatchOrderReconciliationModel";
import { type OrderReconciliationScope } from "./loadingDispatchOrderReconciliationData";

export const path = "/api/factory/customer-orders/:id/loading-dispatches/order-reconciliation";

export const read = (v: unknown) => resultRows(v);

// Explicitly typed so TypeScript narrows after a refusal (an inferred arrow type does not).
export const refusal: (code: string, message: string, status?: number) => never = (code, message, status = 409) => {
  throw new OrderReconciliationError(code, message, status);
};

export function reason(body: unknown, min = 10): string {
  const raw = (body as Record<string, unknown> | null)?.reason;
  if (typeof raw !== "string" || raw.trim().length < min || raw.trim().length > 1000) {
    return refusal("RECONCILIATION_REASON_REQUIRED", "Enter an approval reason of 10–1,000 characters", 400);
  }
  return raw.trim();
}

export function expected(body: unknown): string {
  const value = (body as Record<string, unknown> | null)?.expectedFingerprint;
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    return refusal(
      "RECONCILIATION_PREVIEW_REQUIRED",
      "Refresh the all-trucks reconciliation and confirm its exact fingerprint",
      400
    );
  }
  return value;
}

export async function scope(req: Request): Promise<OrderReconciliationScope & { role: string }> {
  const state = await getFactoryAccessState(req);
  if (!state?.hasFactoryAccess) return refusal("FACTORY_ACCESS_REQUIRED", "Factory access required", 403);
  const orderId = parseId(req.params.id);
  if (orderId === null) return refusal("INVALID_ORDER_ID", "Invalid Pending Loading", 400);
  return {
    companyId: state.companyId,
    orderId,
    userId: String(state.userId),
    username: String(req.session.username || state.userId),
    role: state.role.toLowerCase(),
  };
}

export function supervisor(role: string): void {
  if (!["admin", "owner", "developer"].includes(role)) {
    refusal("SUPERVISOR_REQUIRED", "Only Admin, Owner and Developer can approve the final truck reconciliation", 403);
  }
}

export async function locks(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], s: OrderReconciliationScope) {
  // Priority lock precedes order lock to match the existing loading correction
  // and prevent a priority auto-allocation from attaching new bales mid-review.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRIORITY_SCAN_LOCK_NAMESPACE},${s.companyId})`);
  const [order] = read(
    await tx.execute(sql`
    SELECT id,proforma_id_used AS "proformaIdUsed" FROM customer_orders
     WHERE company_id=${s.companyId} AND id=${s.orderId}
  `)
  );
  if (!order) refusal("ORDER_NOT_FOUND", "Pending Loading not found", 404);
  if (order.proformaIdUsed) {
    await acquireProformaCapacityTransactionLock(tx, {
      companyId: s.companyId,
      proformaId: Number(order.proformaIdUsed),
    });
  }
  const [locked] = read(
    await tx.execute(sql`
    SELECT id,status,deleted_at AS "deletedAt",invoice_number AS "invoiceNumber"
      FROM customer_orders
     WHERE company_id=${s.companyId} AND id=${s.orderId} FOR UPDATE
  `)
  );
  if (
    !locked ||
    locked.deletedAt ||
    locked.invoiceNumber ||
    !["LOADING", "PENDING_VERIFICATION"].includes(String(locked.status))
  ) {
    refusal(
      "RECONCILIATION_ORDER_NOT_OPEN",
      "Only unfinalized active Pending Loading orders can reconcile missing bales"
    );
  }
  // All physical dispatches are locked in an unambiguous order. No closed trip
  // can reopen, scan or change closure between approval and transaction commit.
  await tx.execute(sql`
    SELECT id FROM factory_loading_dispatches
     WHERE company_id=${s.companyId} AND order_id=${s.orderId}
     ORDER BY id FOR UPDATE
  `);
}

export async function writeEvent(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  s: OrderReconciliationScope,
  eventType: string,
  reasonValue: string,
  details: Record<string, unknown>
) {
  await tx.execute(sql`
    INSERT INTO factory_dispatch_financial_events
      (company_id,order_id,dispatch_id,financial_id,event_type,details,
       reason,actor_user_id,actor_username)
    VALUES (${s.companyId},${s.orderId},NULL,NULL,${eventType},
      ${JSON.stringify(details)}::jsonb,${reasonValue},${s.userId},${s.username})
  `);
}

export function handle(res: Response, error: unknown) {
  if (error instanceof DispatchReleaseNotReadyError) {
    return res.status(error.status).json({ code: error.code, message: error.message, missing: error.report.missing });
  }
  if (error instanceof OrderReconciliationError) {
    return res.status(error.status).json({ code: error.code, message: error.message });
  }
  if (["42P01", "42703"].includes(String((error as { code?: string } | null)?.code))) {
    return res.status(503).json({
      code: "RECONCILIATION_SQL_PENDING",
      message:
        "Phase 7 financial reconciliation needs the saved TablePlus schema and approval fields. No SQL has been run.",
    });
  }
  logger.error("Factory all-truck reconciliation failed", { error });
  return res
    .status(500)
    .json({ code: "RECONCILIATION_ERROR", message: "Unable to process this all-truck reconciliation" });
}
