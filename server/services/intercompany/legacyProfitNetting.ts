/**
 * Explicit, idempotent accounting normalization for old at-cost imports.
 *
 * Older imports recorded Dr COGS / Cr Purchases and Dr Intercompany Receivable
 * / Cr Internal Sales. The actual balances should be Dr Intercompany / Cr
 * External Supplier, with ZERO internal revenue/profit. An exact Dr Internal
 * Sales / Cr COGS journal clears the two technical balances without rewriting
 * original vouchers or changing any supplier, inventory or cash entry.
 *
 * This operation must be user-confirmed. Never run silently at startup.
 */
import { and, eq, sql } from "drizzle-orm";
import {
  intercompanyAuditEvents,
  intercompanyTradeRevisions,
  voucherEntries,
  vouchers,
} from "@shared/schema";
import { db } from "../../db";
import { postErpVoucherTx } from "../accounting/erpVoucherPosting";
import { cents } from "./tradeRevisionMath";
import { INTERCOMPANY_PAYMENT_LOCK_NAMESPACE } from "./paymentAllocationCore";
import {
  assertTradeAccess,
  isNettedIntercompanyTradeTx,
  loadTradeTx,
  postingDay,
  rejectEdit,
  requireUnreceived,
  type EditIdentity,
  withTradeScope,
} from "./tradeSync";

export async function normalizeLegacyIntercompanyProfit(input: {
  tradeId: number;
  expectedVersion: number;
  postingDate: string;
  confirmNoCashOrStockChange: boolean;
}, actor: EditIdentity) {
  postingDay(input.postingDate);
  if (!input.confirmNoCashOrStockChange || !["Owner", "Developer"].includes(actor.actorRole)) {
    rejectEdit("Owner or Developer confirmation is required", "IC_NETTING_FORBIDDEN", 403);
  }
  const pair = await assertTradeAccess(input.tradeId, actor);
  return withTradeScope(actor, [pair.sourceCompanyId, pair.destinationCompanyId], () =>
    db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${INTERCOMPANY_PAYMENT_LOCK_NAMESPACE}, ${pair.sourceCompanyId})`);
      const data = await loadTradeTx(tx, input.tradeId);
      if (data.trade.version !== input.expectedVersion) rejectEdit("Trade changed; refresh", "IC_NETTING_STALE");
      requireUnreceived(data);
      const alreadyNetted = await isNettedIntercompanyTradeTx(tx, data.trade.id);
      if (alreadyNetted) return { tradeId: data.trade.id, alreadyNetted: true, noCashOrStockChange: true };

      const revisions = await tx.select({ id: intercompanyTradeRevisions.id }).from(intercompanyTradeRevisions)
        .where(eq(intercompanyTradeRevisions.tradeId, input.tradeId)).limit(1);
      if (revisions.length) rejectEdit("Historical price revisions require a separate audited reconciliation", "IC_NETTING_REVISED");

      const [audit] = await tx.select({ payload: intercompanyAuditEvents.payload })
        .from(intercompanyAuditEvents)
        .where(and(
          eq(intercompanyAuditEvents.eventType, "container-import-confirmed"),
          sql`${intercompanyAuditEvents.eventKey} LIKE ${"ic-container-import:%:" + input.tradeId}`
        ))
        .limit(1);
      const payload = audit?.payload as { sourceSaleVoucherId?: number; sourceCostVoucherId?: number } | null;
      const saleId = payload?.sourceSaleVoucherId;
      const costId = payload?.sourceCostVoucherId;
      if (!Number.isSafeInteger(saleId) || !Number.isSafeInteger(costId) ||
          !saleId || !costId || saleId === costId) {
        rejectEdit("Cannot prove the original internal Sales and COGS vouchers", "IC_NETTING_EVIDENCE");
      }

      const original = await tx.select().from(vouchers)
        .where(sql`${vouchers.id} IN (${saleId}, ${costId})`);
      const sale = original.find((row) => row.id === saleId);
      const cost = original.find((row) => row.id === costId);
      const value = cents(data.imported.confirmedLandedCost ?? "0");
      if (!value.gt(0) || original.length !== 2 ||
          !sale || sale.companyId !== pair.sourceCompanyId || sale.voucherType !== "Sales" || sale.deletedAt ||
          !cost || cost.companyId !== pair.sourceCompanyId || cost.voucherType !== "Journal" || cost.deletedAt ||
          !cents(sale.totalAmount).eq(value) || !cents(cost.totalAmount).eq(value)) {
        rejectEdit("Original intercompany sale/cost vouchers do not match the confirmed landed cost", "IC_NETTING_VOUCHERS");
      }

      const lines = await tx.select().from(voucherEntries)
        .where(sql`${voucherEntries.voucherId} IN (${saleId}, ${costId})`);
      const exactly = (voucherId: number, ledgerId: number, side: "debit" | "credit") =>
        lines.filter((line) =>
          line.voucherId === voucherId && line.ledgerAccountId === ledgerId &&
          line.supplierId == null && line.bankAccountId == null &&
          cents(side === "debit" ? line.debitAmount ?? "0" : line.creditAmount ?? "0").eq(value) &&
          cents(side === "debit" ? line.creditAmount ?? "0" : line.debitAmount ?? "0").isZero()
        ).length === 1;
      if (lines.length !== 4 ||
          !exactly(saleId, data.policy.sourceReceivableAccountId!, "debit") ||
          !exactly(saleId, data.policy.sourceSalesAccountId!, "credit") ||
          !exactly(costId, data.policy.sourceCostAccountId!, "debit") ||
          !exactly(costId, data.policy.sourcePurchaseAccountId!, "credit")) {
        rejectEdit("Historical voucher entry evidence differs from the original at-cost import", "IC_NETTING_ENTRIES");
      }

      const posted = await postErpVoucherTx(tx, {
        companyId: pair.sourceCompanyId,
        voucherType: "Journal",
        voucherDate: input.postingDate,
        sourceModule: "INTERCOMPANY_CONTAINER",
        description: "Normalize internal Sales and COGS for " + data.physical.containerNumber,
        source: { type: "ic-technical-profit-netting", id: data.trade.id },
        actor: { userId: actor.actorUserId, reason: "Remove technical at-cost internal revenue and COGS" },
        lines: [
          { ledgerAccountId: data.policy.sourceSalesAccountId!, debit: value.toFixed(2),
            narration: "Eliminate internal sale with no markup" },
          { ledgerAccountId: data.policy.sourceCostAccountId!, credit: value.toFixed(2),
            narration: "Eliminate internal cost with no markup" },
        ],
      });
      await tx.insert(intercompanyAuditEvents).values({
        eventKey: "ic-technical-profit-normalized:" + data.trade.id,
        relationshipId: data.trade.relationshipId,
        sourceCompanyId: pair.sourceCompanyId,
        actorUserId: actor.actorUserId,
        eventType: "intercompany-internal-profit-netted",
        sourceReference: data.physical.containerNumber,
        payload: {
          tradeId: data.trade.id,
          amount: value.toFixed(2),
          voucherId: posted.voucher.id,
          originalSaleVoucherId: saleId,
          originalCostVoucherId: costId,
          destinationCompanyId: pair.destinationCompanyId,
          noCashOrStockChange: true,
        },
      });
      return {
        tradeId: data.trade.id,
        alreadyNetted: false,
        amount: value.toFixed(2),
        voucherId: posted.voucher.id,
        noCashOrStockChange: true,
      };
    })
  );
}
