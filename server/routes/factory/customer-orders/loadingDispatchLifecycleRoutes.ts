/**
 * Phase 6 — End Dispatch, discrepancy approval and controlled reopening.
 *
 * Option A: the only writes are dispatch status, closure history and audit
 * events. Main loading, inventory, invoice and ledger data stay untouched.
 */
import { createHash } from "node:crypto";
import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { getFactoryAccessState, requireFactoryTabAccess } from "../../../lib/factoryAccessControl";
import { parseId } from "../../../lib/parseId";
import { resultRows } from "../../../lib/queryResult";
import { logger } from "../../../lib/logger";
import { compareFactoryLoadingDispatch } from "./loadingDispatchComparison";
import { assessFactoryLoadingDispatchClose } from "./loadingDispatchClosePolicy";
import { loadFactoryLoadingDispatchComparisonSnapshot } from "./loadingDispatchComparisonRoutes";

const access = requireFactoryTabAccess("factory/invoicing", "hide_invoicing_loadings_tab");
type Raw = Record<string, unknown>;
type RequestScope = { companyId: number; orderId: number; dispatchId: number; userId: string; username: string; role: string };
class LifecycleError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
  }
}
function refusal(statusCode: number, code: string, message: string): never {
  throw new LifecycleError(statusCode, code, message);
}
function supervisor(role: string) {
  return ["owner", "admin", "developer"].includes(role.trim().toLowerCase());
}
function writable(role: string) {
  return !["view only", "create only"].includes(role.trim().toLowerCase());
}
function rows(result: unknown): Raw[] { return resultRows(result); }
function reason(raw: unknown, min: number): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value.length >= min && value.length <= 1000 ? value : null;
}
async function getScope(req: Request): Promise<RequestScope> {
  const state = await getFactoryAccessState(req);
  if (!state) refusal(403, "NO_FACTORY_ACCESS", "Factory access unavailable");
  const orderId = parseId(req.params.id);
  const dispatchId = parseId(req.params.dispatchId);
  if (orderId === null || dispatchId === null) refusal(400, "INVALID_DISPATCH", "Invalid loading/dispatch ID");
  return {
    companyId: state.companyId, orderId, dispatchId,
    userId: String(state.userId), username: String(req.session.username || state.userId),
    role: state.role,
  };
}
function sendFailure(res: Response, error: unknown, message: string) {
  if (error instanceof LifecycleError) {
    return res.status(error.statusCode).json({ code: error.code, message: error.message });
  }
  logger.error(message, { error });
  return res.status(500).json({ message: "Unable to process dispatch lifecycle request" });
}

type LoadedSnapshot = NonNullable<Awaited<ReturnType<typeof loadFactoryLoadingDispatchComparisonSnapshot>>>;
function evaluate(snapshot: Exclude<LoadedSnapshot, { notFoundTrip: true }>, dispatchId: number) {
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
  const scannedIds = new Set(snapshot.scans
    .filter((scan) => scan.dispatchId === id).map((scan) => scan.baleId));
  const fingerprint = createHash("sha256").update(JSON.stringify({
    order: snapshot.order,
    trip,
    loaded: snapshot.loaded.filter((bale) => scannedIds.has(bale.baleId)),
    scans: snapshot.scans.filter((scan) => scan.dispatchId === id),
  })).digest("hex");
  return {
    dispatchId, dispatchNumber: trip.dispatchNumber, status: trip.status,
    fingerprint, issues: policy.issues,
    needsApproval: policy.needsApproval,
    canCloseClean: policy.canCloseClean,
    hasAnyScans: policy.hasAnyScans,
    summary: s, comparison,
  };
}

export function registerFactoryLoadingDispatchLifecycleRoutes(app: Express): void {
  const base = "/api/factory/customer-orders/:id/loading-dispatches/:dispatchId";

  app.get(base + "/close-preview", requireAuth, access, async (req, res) => {
    try {
      const scope = await getScope(req);
      const data = await db.transaction(async (tx) => {
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
        const snapshot = await loadFactoryLoadingDispatchComparisonSnapshot(
          tx, scope.companyId, scope.orderId, scope.dispatchId,
        );
        if (!snapshot) refusal(404, "LOADING_NOT_FOUND", "Loading not found");
        if ("notFoundTrip" in snapshot) refusal(404, "DISPATCH_NOT_FOUND", "Dispatch not found");
        return evaluate(snapshot, scope.dispatchId);
      });
      res.set("Cache-Control", "private, no-store");
      return res.json({
        dispatchId: data.dispatchId, dispatchNumber: data.dispatchNumber, status: data.status,
        fingerprint: data.fingerprint, issues: data.issues,
        needsApproval: data.needsApproval, canCloseClean: data.canCloseClean,
        hasAnyScans: data.hasAnyScans, summary: data.summary,
      });
    } catch (error) {
      return sendFailure(res, error, "Error preparing dispatch close preview");
    }
  });

  // Once closed, scan/plan/edit routes already enforce OPEN. This endpoint
  // serializes with those writers by locking order first and trip second.
  app.post(base + "/close", requireAuth, access, async (req, res) => {
    try {
      const scope = await getScope(req);
      if (!writable(scope.role)) refusal(403, "NO_CLOSE_PERMISSION", "This role cannot end a dispatch");
      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) ||
          req.body.confirm !== true ||
          typeof req.body.fingerprint !== "string" ||
          !/^[a-f0-9]{64}$/.test(req.body.fingerprint)) {
        refusal(400, "CONFIRMATION_REQUIRED", "Refresh the close review and explicitly confirm End Dispatch");
      }
      const approvalReason = reason(req.body?.discrepancyReason, 10);
      const result = await db.transaction(async (tx) => {
        const order = rows(await tx.execute(sql`
          SELECT id, status, deleted_at AS "deletedAt" FROM customer_orders
           WHERE company_id = ${scope.companyId} AND id = ${scope.orderId} FOR UPDATE
        `))[0];
        if (!order) refusal(404, "LOADING_NOT_FOUND", "Loading not found");
        if (order.deletedAt || order.status === "CANCELLED") {
          refusal(409, "LOADING_INACTIVE", "Cannot close a dispatch on a cancelled or deleted loading");
        }
        const lockedTrip = rows(await tx.execute(sql`
          SELECT id, status, dispatch_number AS "dispatchNumber",
                 truck_plate AS "truckPlate", driver_name AS "driverName",
                 destination, notes, container_number_snapshot AS "containerNumberSnapshot",
                 created_by_username AS "createdByUsername", created_at AS "createdAt"
            FROM factory_loading_dispatches
           WHERE company_id = ${scope.companyId} AND order_id = ${scope.orderId}
             AND id = ${scope.dispatchId} FOR UPDATE
        `))[0];
        if (!lockedTrip) refusal(404, "DISPATCH_NOT_FOUND", "Dispatch not found for this loading");
        if (lockedTrip.status !== "OPEN") refusal(409, "ALREADY_CLOSED", "Only an open dispatch can be ended");

        const snapshot = await loadFactoryLoadingDispatchComparisonSnapshot(
          tx, scope.companyId, scope.orderId, scope.dispatchId,
        );
        if (!snapshot || "notFoundTrip" in snapshot) refusal(404, "DISPATCH_NOT_FOUND", "Dispatch not found");
        const evaluation = evaluate(snapshot, scope.dispatchId);
        if (evaluation.fingerprint !== req.body.fingerprint) {
          refusal(409, "REVIEW_CHANGED", "Loaded bales, truck plans or scan records have changed. Refresh and review before ending this dispatch");
        }
        if (!evaluation.hasAnyScans) {
          refusal(409, "EMPTY_DISPATCH", "At least one physically verified bale is required before ending a dispatch");
        }
        if (evaluation.needsApproval && !supervisor(scope.role)) {
          refusal(403, "SUPERVISOR_APPROVAL_REQUIRED", "A supervisor must review and approve these discrepancies before this dispatch can end");
        }
        if (evaluation.needsApproval && !approvalReason) {
          refusal(400, "REASON_REQUIRED", "Describe the discrepancy approval in at least 10 characters (maximum 1,000)");
        }

        const revisionRows = rows(await tx.execute(sql`
          SELECT COALESCE(MAX(revision), 0) + 1 AS "nextRevision"
            FROM factory_loading_dispatch_closure_history
           WHERE company_id = ${scope.companyId} AND order_id = ${scope.orderId}
             AND dispatch_id = ${scope.dispatchId}
        `));
        const revision = Number(revisionRows[0]?.nextRevision ?? 1);
        const closed = rows(await tx.execute(sql`
          UPDATE factory_loading_dispatches
             SET status = 'CLOSED', closed_at = NOW(),
                 closed_by_user_id = ${scope.userId}, updated_at = NOW()
           WHERE company_id = ${scope.companyId} AND order_id = ${scope.orderId}
             AND id = ${scope.dispatchId} AND status = 'OPEN'
          RETURNING id, dispatch_number AS "dispatchNumber", status,
                    closed_at AS "closedAt"
        `))[0];
        if (!closed) refusal(409, "ALREADY_CLOSED", "This dispatch has already been ended");

        // Capture physical scan evidence and truck identity at this closure.
        // Later reopen/edit/scan actions cannot change a signed manifest.
        const manifest = rows(await tx.execute(sql`
          SELECT s.id AS "scanId", s.bale_id AS "baleId",
                 s.bale_reference AS "baleReference",
                 s.article_code AS "articleCode", s.product_name AS "productName",
                 s.weight_kg AS "weightKg", s.scanned_by_username AS "scannedByUsername",
                 s.scanned_at AS "scannedAt"
            FROM factory_loading_dispatch_scans s
           WHERE s.company_id = ${scope.companyId} AND s.order_id = ${scope.orderId}
             AND s.dispatch_id = ${scope.dispatchId} AND s.removed_at IS NULL
           ORDER BY s.scanned_at, s.id
        `));
        // Freeze human-readable loading labels as well as truck fields.
        // A later customer/proforma rename must not rewrite this manifest.
        const labelRows = rows(await tx.execute(sql`
          SELECT co.status AS "loadingStatus",
                 co.container_number AS "containerNumber",
                 c.legal_name AS "customerName", p.name AS "proformaName",
                 cmp.name AS "companyName"
            FROM customer_orders co
            LEFT JOIN customers c ON c.id = co.customer_id AND c.company_id = co.company_id
            LEFT JOIN customer_proformas p ON p.id = co.proforma_id_used AND p.company_id = co.company_id
            JOIN companies cmp ON cmp.id = co.company_id
           WHERE co.company_id = ${scope.companyId} AND co.id = ${scope.orderId}
           LIMIT 1
        `));
        const label = labelRows[0] ?? {};
        const truckAtClosure = {
          dispatchId: String(lockedTrip.id), dispatchNumber: lockedTrip.dispatchNumber,
          truckPlate: lockedTrip.truckPlate, driverName: lockedTrip.driverName,
          destination: lockedTrip.destination, notes: lockedTrip.notes,
          containerNumberSnapshot: lockedTrip.containerNumberSnapshot,
          createdByUsername: lockedTrip.createdByUsername, createdAt: lockedTrip.createdAt,
          loadingMetadata: {
            companyName: label.companyName ?? null,
            customerName: label.customerName ?? null,
            proformaName: label.proformaName ?? null,
            containerNumber: label.containerNumber ?? null,
            status: label.loadingStatus ?? null,
          },
        };
        const summaryJson = JSON.stringify(evaluation.summary);
        const comparisonJson = JSON.stringify(evaluation.comparison);
        const issuesJson = JSON.stringify(evaluation.issues);
        const manifestJson = JSON.stringify(manifest);
        const truckJson = JSON.stringify(truckAtClosure);
        const history = rows(await tx.execute(sql`
          INSERT INTO factory_loading_dispatch_closure_history
            (company_id, order_id, dispatch_id, revision, close_fingerprint,
             comparison_snapshot, summary_snapshot, issues_snapshot,
             manifest_snapshot, truck_snapshot,
             approved_with_discrepancies, discrepancy_reason,
             closed_by_user_id, closed_by_username)
          VALUES (${scope.companyId}, ${scope.orderId}, ${scope.dispatchId},
                  ${revision}, ${evaluation.fingerprint}, ${comparisonJson}::jsonb,
                  ${summaryJson}::jsonb, ${issuesJson}::jsonb,
                  ${manifestJson}::jsonb, ${truckJson}::jsonb,
                  ${evaluation.needsApproval}, ${evaluation.needsApproval ? approvalReason : null},
                  ${scope.userId}, ${scope.username})
          RETURNING id, closed_at AS "closedAt"
        `))[0];
        if (!history) throw Error("No closure history returned");

        await tx.execute(sql`
          INSERT INTO factory_loading_dispatch_events
            (company_id, order_id, dispatch_id, event_type,
             actor_user_id, actor_username, event_data)
          VALUES (${scope.companyId}, ${scope.orderId}, ${scope.dispatchId},
                  'DISPATCH_CLOSED', ${scope.userId}, ${scope.username},
                  ${JSON.stringify({
                    closureId: String(history.id),
                    revision,
                    fingerprint: evaluation.fingerprint,
                    approvedWithDiscrepancies: evaluation.needsApproval,
                    reason: evaluation.needsApproval ? approvalReason : null,
                    summary: evaluation.summary,
                    issues: evaluation.issues,
                  })}::jsonb)
        `);
        return {
          id: closed.id, dispatchNumber: closed.dispatchNumber,
          status: closed.status, closedAt: closed.closedAt,
          closedByUsername: scope.username, revision,
          closureId: String(history.id),
          issues: evaluation.issues, approvedWithDiscrepancies: evaluation.needsApproval,
        };
      });
      return res.status(200).json(result);
    } catch (error) {
      return sendFailure(res, error, "Error ending Factory truck dispatch");
    }
  });

  app.post(base + "/reopen", requireAuth, access, async (req, res) => {
    try {
      const scope = await getScope(req);
      if (!supervisor(scope.role)) {
        refusal(403, "SUPERVISOR_ONLY", "Only Admin, Owner or Developer may reopen a completed dispatch");
      }
      const reopenReason = reason(req.body?.reason, 10);
      if (!reopenReason) refusal(400, "REOPEN_REASON_REQUIRED", "Enter a reopening reason (10–1,000 characters)");
      const result = await db.transaction(async (tx) => {
        const order = rows(await tx.execute(sql`
          SELECT id, status, deleted_at AS "deletedAt" FROM customer_orders
           WHERE company_id = ${scope.companyId} AND id = ${scope.orderId} FOR UPDATE
        `))[0];
        if (!order) refusal(404, "LOADING_NOT_FOUND", "Loading not found");
        if (order.deletedAt || order.status === "CANCELLED") refusal(409, "LOADING_INACTIVE", "This loading cannot be reopened");
        const trip = rows(await tx.execute(sql`
          SELECT id, status FROM factory_loading_dispatches
           WHERE company_id = ${scope.companyId} AND order_id = ${scope.orderId}
             AND id = ${scope.dispatchId} FOR UPDATE
        `))[0];
        if (!trip) refusal(404, "DISPATCH_NOT_FOUND", "Dispatch not found");
        if (trip.status !== "CLOSED") refusal(409, "NOT_CLOSED", "Only completed dispatches can be reopened");

        const record = rows(await tx.execute(sql`
          SELECT id, revision FROM factory_loading_dispatch_closure_history
           WHERE company_id = ${scope.companyId} AND order_id = ${scope.orderId}
             AND dispatch_id = ${scope.dispatchId} AND reopened_at IS NULL
           ORDER BY revision DESC LIMIT 1 FOR UPDATE
        `))[0];
        if (!record) refusal(409, "CLOSURE_NOT_FOUND", "No active closure record was found");
        await tx.execute(sql`
          UPDATE factory_loading_dispatch_closure_history
             SET reopened_at = NOW(), reopened_by_user_id = ${scope.userId},
                 reopened_by_username = ${scope.username},
                 reopen_reason = ${reopenReason}
           WHERE id = ${record.id}
        `);
        const changed = rows(await tx.execute(sql`
          UPDATE factory_loading_dispatches SET status = 'OPEN',
              closed_at = NULL, closed_by_user_id = NULL,
              reopened_at = NOW(), reopened_by_user_id = ${scope.userId},
              reopen_reason = ${reopenReason}, updated_at = NOW()
           WHERE company_id = ${scope.companyId} AND order_id = ${scope.orderId}
             AND id = ${scope.dispatchId} AND status = 'CLOSED'
          RETURNING id, status, reopened_at AS "reopenedAt"
        `))[0];
        if (!changed) refusal(409, "NOT_CLOSED", "Dispatch is no longer closed");
        await tx.execute(sql`
          INSERT INTO factory_loading_dispatch_events
            (company_id, order_id, dispatch_id, event_type,
             actor_user_id, actor_username, event_data)
          VALUES (${scope.companyId}, ${scope.orderId}, ${scope.dispatchId},
                  'DISPATCH_REOPENED', ${scope.userId}, ${scope.username},
                  ${JSON.stringify({ closureId: String(record.id), revision: record.revision, reason: reopenReason })}::jsonb)
        `);
        return { ...changed, revision: record.revision, reopenedByUsername: scope.username };
      });
      return res.json(result);
    } catch (error) {
      return sendFailure(res, error, "Error reopening Factory truck dispatch");
    }
  });

  app.get(base + "/lifecycle", requireAuth, access, async (req, res) => {
    try {
      const scope = await getScope(req);
      const trip = rows(await db.execute(sql`
        SELECT id, status, dispatch_number AS "dispatchNumber",
               closed_at AS "closedAt", reopened_at AS "reopenedAt"
          FROM factory_loading_dispatches
         WHERE company_id = ${scope.companyId} AND order_id = ${scope.orderId}
           AND id = ${scope.dispatchId} LIMIT 1
      `))[0];
      if (!trip) refusal(404, "DISPATCH_NOT_FOUND", "Dispatch not found");
      const history = rows(await db.execute(sql`
        SELECT id, revision, summary_snapshot AS "summary",
               issues_snapshot AS "issues",
               approved_with_discrepancies AS "approvedWithDiscrepancies",
               discrepancy_reason AS "discrepancyReason",
               closed_by_user_id AS "closedByUserId",
               closed_by_username AS "closedByUsername",
               closed_at AS "closedAt", reopened_at AS "reopenedAt",
               reopened_by_username AS "reopenedByUsername",
               reopen_reason AS "reopenReason"
          FROM factory_loading_dispatch_closure_history
         WHERE company_id = ${scope.companyId} AND order_id = ${scope.orderId}
           AND dispatch_id = ${scope.dispatchId}
         ORDER BY revision DESC
      `));
      const events = rows(await db.execute(sql`
        SELECT id, event_type AS "eventType", actor_username AS "actorUsername",
               event_data AS "details", created_at AS "createdAt"
          FROM factory_loading_dispatch_events
         WHERE company_id = ${scope.companyId} AND order_id = ${scope.orderId}
           AND dispatch_id = ${scope.dispatchId}
         ORDER BY id DESC LIMIT 100
      `));
      res.set("Cache-Control", "private, no-store");
      return res.json({ trip, closures: history, events, eventsLimitedTo: 100 });
    } catch (error) {
      return sendFailure(res, error, "Error reading Factory truck lifecycle history");
    }
  });

  // Snapshots are immutable across later loading changes and reopen cycles.
  app.get(base + "/lifecycle/closures/:closureId", requireAuth, access, async (req, res) => {
    try {
      const scope = await getScope(req);
      const closureId = parseId(req.params.closureId);
      if (closureId === null) refusal(400, "INVALID_CLOSURE", "Invalid closure record");
      const row = rows(await db.execute(sql`
        SELECT id, revision, close_fingerprint AS "fingerprint",
               comparison_snapshot AS "comparison", summary_snapshot AS "summary",
               issues_snapshot AS "issues",
               approved_with_discrepancies AS "approvedWithDiscrepancies",
               discrepancy_reason AS "discrepancyReason",
               closed_by_username AS "closedByUsername",
               closed_at AS "closedAt", reopened_at AS "reopenedAt",
               reopened_by_username AS "reopenedByUsername",
               reopen_reason AS "reopenReason"
          FROM factory_loading_dispatch_closure_history
         WHERE company_id = ${scope.companyId} AND order_id = ${scope.orderId}
           AND dispatch_id = ${scope.dispatchId} AND id = ${closureId}
         LIMIT 1
      `))[0];
      if (!row) refusal(404, "CLOSURE_NOT_FOUND", "Closure history record not found");
      res.set("Cache-Control", "private, no-store");
      return res.json(row);
    } catch (error) {
      return sendFailure(res, error, "Error reading closure snapshot");
    }
  });
}
