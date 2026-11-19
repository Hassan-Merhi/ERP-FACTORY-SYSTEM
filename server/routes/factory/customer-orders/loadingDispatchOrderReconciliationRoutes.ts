/**
 * Phase 7 — approved, all-truck reconciliation and atomic unshipped correction.
 * No vouchers, customer balances or final invoice are written here.
 * The signed DRAFT consolidation record is an immutable Phase 8 prerequisite.
 */
import type { Express } from "express";
import { sql } from "drizzle-orm";
import { requireAuth } from "../../../auth";
import { db } from "../../../db";
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
import {
  registerFactoryDispatchOrderReconciliationRoutesPart1,
  access,
} from "./registerFactoryDispatchOrderReconciliationRoutesPart1";

export function registerFactoryDispatchOrderReconciliationRoutes(app: Express): void {
  registerFactoryDispatchOrderReconciliationRoutesPart1(app);

  app.post(path + "/approve", requireAuth, access, async (req, res) => {
    try {
      const s = await scope(req);
      supervisor(s.role);
      const fp = expected(req.body);
      const why = reason(req.body);
      if (req.body?.confirm !== true) {
        refusal(
          "RECONCILIATION_CONFIRM_REQUIRED",
          "Confirm all signed trip totals and scanned barcodes before approval",
          400
        );
      }
      const result = await db.transaction(async (tx) => {
        await assertFactoryDispatchReleaseReadyTx(tx, "RECONCILIATION");
        await locks(tx, s);
        const existing = await readOrderDispatchApprovalTx(tx, s, true);
        const evaluated = (await loadOrderDispatchReconciliationTx(tx, s)).result;
        if (fp !== evaluated.fingerprint) {
          refusal("RECONCILIATION_CHANGED", "The scanned or financial source changed; refresh before approval");
        }
        if (existing) {
          if (existing.fingerprint !== fp)
            refusal(
              "RECONCILIATION_ALREADY_SIGNED",
              "Previously signed reconciliation no longer matches; escalate for accounting review"
            );
          return { approved: true, replayed: true, approval: existing };
        }
        if (!evaluated.ready) {
          refusal("RECONCILIATION_UNRESOLVED", evaluated.blockingReasons.join("; "));
        }
        const [existingConsolidation] = read(
          await tx.execute(sql`
          SELECT id,status,reconciled_at AS "reconciledAt"
            FROM factory_dispatch_order_consolidations
           WHERE company_id=${s.companyId} AND order_id=${s.orderId} FOR UPDATE
        `)
        );
        if (existingConsolidation && (existingConsolidation.status !== "DRAFT" || existingConsolidation.reconciledAt)) {
          refusal("RECONCILIATION_ALREADY_CONSOLIDATED", "This order already has a finalized or signed consolidation");
        }
        const snap = {
          version: 1,
          summary: evaluated.summary,
          trips: evaluated.trips.map((t) => ({
            dispatchId: t.dispatchId,
            dispatchNumber: t.dispatchNumber,
            financialId: t.financialId,
            postingId: t.postingId,
            revision: t.revision,
            goodsSubtotal: t.goodsSubtotal,
            billableChargesTotal: t.billableChargesTotal,
            discountTotal: t.discountTotal,
            customerTotal: t.customerTotal,
            postedBales: t.postedBales,
          })),
          approvedAt: new Date().toISOString(),
          reason: why,
          orderChargesExcludedFromPostedTrips: evaluated.summary.existingOrderChargeTotal,
          notes: evaluated.warnings,
        };
        const signedRows = read(
          await tx.execute(sql`
          INSERT INTO factory_dispatch_order_consolidations
            (company_id,order_id,status,reconciliation_fingerprint,
             reconciliation_snapshot,reconciled_at,reconciled_by_user_id,
             reconciliation_reason,included_posting_ids,goods_subtotal,
             billable_charges_total,discount_total,customer_total)
          VALUES (${s.companyId},${s.orderId},'DRAFT',${fp},
                  ${JSON.stringify(snap)}::jsonb,NOW(),${s.userId},
                  ${why},${JSON.stringify(evaluated.includedPostingIds)}::jsonb,
                  ${evaluated.summary.goodsSubtotal},${evaluated.summary.billableChargesTotal},
                  ${evaluated.summary.discountTotal},${evaluated.summary.customerTotal})
          ON CONFLICT (company_id,order_id) DO UPDATE
           SET reconciliation_fingerprint=EXCLUDED.reconciliation_fingerprint,
               reconciliation_snapshot=EXCLUDED.reconciliation_snapshot,
               reconciled_at=EXCLUDED.reconciled_at,
               reconciled_by_user_id=EXCLUDED.reconciled_by_user_id,
               reconciliation_reason=EXCLUDED.reconciliation_reason,
               included_posting_ids=EXCLUDED.included_posting_ids,
               goods_subtotal=EXCLUDED.goods_subtotal,
               billable_charges_total=EXCLUDED.billable_charges_total,
               discount_total=EXCLUDED.discount_total,customer_total=EXCLUDED.customer_total,
               updated_at=NOW()
           WHERE factory_dispatch_order_consolidations.status='DRAFT'
             AND factory_dispatch_order_consolidations.reconciled_at IS NULL
          RETURNING id
        `)
        );
        if (signedRows.length !== 1) {
          refusal(
            "RECONCILIATION_SIGNOFF_CONFLICT",
            "This loading has already been signed or its consolidation changed; no approval was committed"
          );
        }
        await writeEvent(tx, s, "ORDER_DISPATCH_RECONCILIATION_APPROVED", why, {
          fingerprint: fp,
          summary: evaluated.summary,
          includedPostingIds: evaluated.includedPostingIds,
          tripIds: evaluated.trips.map((t) => t.dispatchId),
        });
        return { approved: true, replayed: false, approval: await readOrderDispatchApprovalTx(tx, s) };
      });
      res.set("Cache-Control", "private, no-store");
      return res.json(result);
    } catch (error) {
      return handle(res, error);
    }
  });
}
