// Extracted from ./loadingDispatchOrderReconciliationRoutes.ts
import type { Express } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import { requireAuth } from "../../../auth";
import { db } from "../../../db";
import { requireFactoryTabAccess } from "../../../lib/factoryAccessControl";
import { recalculateOrderTotals } from "../_helpers";
import { reversePriorityAllocationForDeletedBaleTx } from "./priorityAutoAllocation";
import { reactivateAutoCompletedPriorityLoadingsLockedTx } from "./priorityScanQueue";
import { customerOrderBales, customerOrderBaleRemovals, factoryBales } from "@shared/schema";
import { isPostedDispatchBaleTx } from "../../../services/factory/dispatchTripFinancialGuards";
import { assertFactoryDispatchReleaseReadyTx } from "../../../services/factory/dispatchReleaseReadiness";
import {
  loadOrderDispatchReconciliationTx,
  readOrderDispatchApprovalTx,
} from "./loadingDispatchOrderReconciliationData";
import {
  path,
  read,
  refusal,
  reason,
  expected,
  scope,
  supervisor,
  locks,
  writeEvent,
  handle,
} from "./loadingDispatchOrderReconciliationRoutesHelpers";

export const access = requireFactoryTabAccess("factory/invoicing", "hide_invoicing_loadings_tab");

export function registerFactoryDispatchOrderReconciliationRoutesPart1(app: Express) {
  app.get(path, requireAuth, access, async (req, res) => {
    try {
      const s = await scope(req);
      const snapshot = await db.transaction(async (tx) => {
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
        const current = await loadOrderDispatchReconciliationTx(tx, s);
        const [invoice] = read(
          await tx.execute(sql`
          SELECT c.status,c.invoice_number AS "invoiceNumber",
                 c.finalization_details AS "finalization",
                 o.invoice_number AS "orderInvoice"
            FROM factory_dispatch_order_consolidations c
            JOIN customer_orders o ON o.id=c.order_id AND o.company_id=c.company_id
           WHERE c.company_id=${s.companyId} AND c.order_id=${s.orderId} LIMIT 1
        `)
        );
        const details = invoice?.finalization;
        const finalized = Boolean(
          current.stored &&
          current.orderStatus === "FINALIZED" &&
          invoice?.status === "FINALIZED" &&
          invoice?.invoiceNumber === invoice?.orderInvoice &&
          details &&
          typeof details === "object" &&
          (details as Record<string, unknown>).customerReceivableReposted === false
        );
        return { ...current, finalized };
      });
      res.set("Cache-Control", "private, no-store");
      return res.json({
        orderId: s.orderId,
        loadingStatus: snapshot.orderStatus,
        ...snapshot.result,
        // The physical source's status becomes FINALIZED and each trip moves
        // POSTED -> CONSOLIDATED in Phase 8, intentionally changing the live
        // Phase 7 preview fingerprint. Its original signed fingerprint and
        // immutable finalization are the authority after finalizing.
        ...(snapshot.finalized ? { blockingReasons: [], fingerprint: snapshot.stored!.fingerprint } : {}),
        approval: snapshot.stored,
        approvalCurrent: Boolean(
          snapshot.stored && (snapshot.finalized || snapshot.stored.fingerprint === snapshot.result.fingerprint)
        ),
        canApprove: ["admin", "owner", "developer"].includes(s.role) && snapshot.result.ready && !snapshot.stored,
      });
    } catch (error) {
      return handle(res, error);
    }
  });

  app.post(path + "/remove-unshipped", requireAuth, access, async (req, res) => {
    try {
      const s = await scope(req);
      supervisor(s.role);
      const fp = expected(req.body);
      const why = reason(req.body);
      if (
        req.body?.confirm !== true ||
        !Array.isArray(req.body?.orderBaleIds) ||
        req.body.orderBaleIds.length === 0 ||
        req.body.orderBaleIds.length > 2000
      ) {
        refusal("RECONCILIATION_SELECTION_INVALID", "Confirm one to 2,000 selected unshipped bales", 400);
      }
      const ids = (req.body.orderBaleIds as unknown[]).map(Number);
      if (ids.some((n) => !Number.isSafeInteger(n) || n < 1) || new Set(ids).size !== ids.length) {
        refusal("RECONCILIATION_SELECTION_INVALID", "Duplicate or invalid bale links were selected", 400);
      }
      const output = await db.transaction(async (tx) => {
        await assertFactoryDispatchReleaseReadyTx(tx, "RECONCILIATION");
        await locks(tx, s);
        if (await readOrderDispatchApprovalTx(tx, s)) {
          refusal(
            "RECONCILIATION_ALREADY_SIGNED",
            "This order was already signed. A new reconciliation requires an authorized reversal."
          );
        }
        const before = (await loadOrderDispatchReconciliationTx(tx, s)).result;
        if (before.fingerprint !== fp)
          refusal(
            "RECONCILIATION_CHANGED",
            "Trucks, scans, prices or loading changed; refresh the comparison before removing bales"
          );
        if (
          !before.trips.length ||
          before.summary.openTrips > 0 ||
          before.unexpectedScans.length ||
          before.duplicateScans.length
        ) {
          refusal(
            "RECONCILIATION_TRIPS_UNRESOLVED",
            "Finish and resolve all physical dispatches before adjusting unshipped Pending Loading"
          );
        }
        const missing = new Map(before.missingBales.map((b) => [b.orderBaleId, b]));
        for (const id of ids) {
          if (!missing.has(id)) {
            refusal(
              "RECONCILIATION_BALE_NOT_MISSING",
              "One selected bale was scanned or is no longer an unshipped loading bale"
            );
          }
          const b = missing.get(id)!;
          if (await isPostedDispatchBaleTx(tx, s.companyId, s.orderId, b.baleId)) {
            refusal("RECONCILIATION_BALE_ALREADY_POSTED", "A financially posted trip bale cannot be returned to stock");
          }
        }
        const links = await tx
          .select()
          .from(customerOrderBales)
          .where(and(eq(customerOrderBales.orderId, s.orderId), inArray(customerOrderBales.id, ids)))
          .for("update");
        if (links.length !== ids.length) refusal("RECONCILIATION_CHANGED", "Loading changed before approval; refresh");
        const physicalIds = links.map((l) => l.baleId);
        const active = read(
          await tx.execute(sql`
          SELECT bale_id FROM factory_loading_dispatch_scans
           WHERE company_id=${s.companyId} AND order_id=${s.orderId}
             AND bale_id IN (${sql.join(
               physicalIds.map((n) => sql`${n}`),
               sql`,`
             )})
             AND removed_at IS NULL LIMIT 1
        `)
        );
        if (active.length)
          refusal(
            "RECONCILIATION_BALE_ALREADY_SCANNED",
            "A selected bale has a live physical scan and cannot be returned to stock"
          );
        const bales = await tx
          .select()
          .from(factoryBales)
          .where(and(eq(factoryBales.companyId, s.companyId), inArray(factoryBales.id, physicalIds)))
          .for("update");
        if (bales.length !== physicalIds.length)
          refusal(
            "RECONCILIATION_BALE_STOCK_MISSING",
            "One selected physical bale is missing or no longer in this Factory company"
          );
        // Legacy loadings reserve their linked bales as RESERVED_FOR_ORDER,
        // but V5 deliberately leaves linked bales as IN_STOCK. Both are valid
        // for a currently linked, physically UNLOADED bale. Never revive a
        // SOLD/DELETED/other state or free a bale shared by an active loading.
        if (bales.some((b) => !["RESERVED_FOR_ORDER", "IN_STOCK"].includes(b.status))) {
          refusal(
            "RECONCILIATION_STOCK_OWNERSHIP_CHANGED",
            "An unshipped bale has an unexpected stock status; inspect its original loading and inventory"
          );
        }
        const [otherOwner] = read(
          await tx.execute(sql`
          SELECT 1 FROM customer_order_bales cob
          JOIN customer_orders co ON co.id=cob.order_id AND co.company_id=${s.companyId}
          WHERE cob.bale_id IN (${sql.join(
            physicalIds.map((n) => sql`${n}`),
            sql`,`
          )})
            AND cob.order_id<>${s.orderId}
            AND co.deleted_at IS NULL AND co.status NOT IN ('CANCELLED')
          LIMIT 1
        `)
        );
        if (otherOwner) {
          refusal(
            "RECONCILIATION_BALE_SHARED_WITH_OTHER_LOADING",
            "The selected bale also belongs to another active loading; release requires inventory reconciliation"
          );
        }
        const removed = await tx
          .delete(customerOrderBales)
          .where(and(eq(customerOrderBales.orderId, s.orderId), inArray(customerOrderBales.id, ids)))
          .returning({ id: customerOrderBales.id, baleId: customerOrderBales.baleId });
        if (removed.length !== ids.length)
          refusal("RECONCILIATION_CHANGED", "One selected bale was removed concurrently");
        const updated = await tx
          .update(factoryBales)
          .set({ status: "IN_STOCK", updatedAt: new Date() })
          .where(and(eq(factoryBales.companyId, s.companyId), inArray(factoryBales.id, physicalIds)))
          .returning({ id: factoryBales.id });
        if (updated.length !== physicalIds.length)
          refusal("RECONCILIATION_STOCK_UPDATE_FAILED", "Could not restore every unshipped bale to stock");
        await tx.insert(customerOrderBaleRemovals).values(
          bales.map((b) => ({
            orderId: s.orderId,
            baleId: b.id,
            referenceNumber: b.referenceNumber,
            articleCode: b.articleCode || null,
            productName: b.productName || null,
            weightKg: b.weightKg,
            removedByUserId: s.userId,
            removedByUsername: s.username,
          }))
        );
        await recalculateOrderTotals(tx, s.orderId);
        // For active LOADING/PENDING_VERIFICATION there is no finalized invoice
        // or ORDER_VERIFIED daybook to rewrite. Do not call syncOrderTotalsTx,
        // which would invoke legacy full-invoice posting on a posted dispatch.
        for (const row of removed) {
          await reversePriorityAllocationForDeletedBaleTx(tx, {
            companyId: s.companyId,
            baleId: row.baleId,
            detachedOrderId: s.orderId,
            actor: s.username,
            actorId: s.userId,
            reason: "Phase 7 approved unshipped dispatch reconciliation",
            deferQueueRecovery: true,
          });
        }
        await reactivateAutoCompletedPriorityLoadingsLockedTx(tx, s.companyId, [s.orderId]);
        const after = (await loadOrderDispatchReconciliationTx(tx, s)).result;
        await writeEvent(tx, s, "ORDER_UNSHIPPED_BALES_REMOVED", why, {
          orderBaleIds: ids,
          baleIds: physicalIds,
          references: bales.map((b) => b.referenceNumber),
          originalFingerprint: fp,
          newFingerprint: after.fingerprint,
          removedCount: removed.length,
          remainingUnshipped: after.summary.unshippedBales,
        });
        return {
          removed: removed.length,
          remainingUnshipped: after.summary.unshippedBales,
          fingerprint: after.fingerprint,
          ready: after.ready,
        };
      });
      res.set("Cache-Control", "private, no-store");
      return res.json(output);
    } catch (error) {
      return handle(res, error);
    }
  });
}
