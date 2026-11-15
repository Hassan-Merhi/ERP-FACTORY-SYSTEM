import { finishWithAudit, type AuditTxHook } from "../lib/auditTxHook";
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { stockTransferItems, stockTransferRevisionItems } from "@shared/schema";
import { lifecycleError, positiveInteger } from "./immutableStockTransferRevisionQueries";
import { MoneyDecimal, lineAmount } from "../lib/money";
import {
  toRevisionAuditItems,
  type ReviewImmutableRevisionResult,
} from "./immutableStockTransferRevisionLifecycleAssertCompanyScope";
import { lockedRevision } from "./createImmutableStockTransferRevision";
export type {
  CreateImmutableRevisionInput,
  ImmutableRevisionResult,
  ReviewImmutableRevisionResult,
  RevisionAuditItem,
} from "./immutableStockTransferRevisionLifecycleAssertCompanyScope";
export { createImmutableStockTransferRevision } from "./createImmutableStockTransferRevision";
export { approveImmutableStockTransferRevision } from "./approveImmutableStockTransferRevision";

export { normalizeImmutableRevisionItems } from "./immutableStockTransferRevisionInput";
export type { ImmutableRevisionItemInput } from "./immutableStockTransferRevisionInput";
export {
  listImmutableStockTransferRevisions,
  resolveTransferIdByVoucher,
  type StockTransferRevisionStatus,
} from "./immutableStockTransferRevisionQueries";

export async function rejectImmutableStockTransferRevision(
  companyIdInput: number,
  revisionIdInput: number,
  reviewerIdInput: string,
  reasonInput?: string | null,
  auditTx?: AuditTxHook<ReviewImmutableRevisionResult>,
  existingTx?: Parameters<Parameters<typeof db.transaction>[0]>[0]
): Promise<ReviewImmutableRevisionResult> {
  const companyId = positiveInteger(companyIdInput, "Company ID");
  const revisionId = positiveInteger(revisionIdInput, "Revision ID");
  const reviewerId = String(reviewerIdInput || "").trim();
  if (!reviewerId) throw new Error("Reviewer ID is required");
  const reason = reasonInput?.trim() || null;

  const run = async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
    const finish = finishWithAudit(tx, auditTx);
    const requested = await lockedRevision(tx, revisionId);
    if (!requested) throw new Error("Revision not found");
    if (Number(requested.company_id) !== companyId) {
      throw lifecycleError("Revision belongs to a different company", "STOCK_TRANSFER_REVISION_SCOPE");
    }
    const transferId = Number(requested.transfer_id);
    const voucherId = Number(requested.voucher_id);
    const revisionNumber = Number(requested.revision_number);
    const inventoryApplied = Boolean(requested.inventory_applied);
    const rejectedRevisionItems = await tx
      .select()
      .from(stockTransferRevisionItems)
      .where(eq(stockTransferRevisionItems.revisionId, revisionId));

    if (requested.status === "rejected") {
      const currentItems = await tx
        .select({ quantity: stockTransferItems.quantity, rate: stockTransferItems.rate })
        .from(stockTransferItems)
        .where(eq(stockTransferItems.transferId, transferId));
      return finish({
        revisionId,
        transferId,
        voucherId,
        revisionNumber,
        transition: "no-op",
        changedItemCount: 0,
        inventoryApplied,
        totalAmount: currentItems
          .reduce((sum, item) => sum.plus(lineAmount(item.quantity, item.rate)), new MoneyDecimal(0))
          .toFixed(2),
        items: toRevisionAuditItems(rejectedRevisionItems),
      });
    }
    if (requested.status !== "pending") {
      throw lifecycleError(
        `Revision #${revisionNumber} is ${requested.status} and cannot be rejected`,
        "STOCK_TRANSFER_REVISION_STATUS"
      );
    }

    await tx.execute(sql`
      UPDATE stock_transfer_revisions
      SET
        status = 'rejected',
        optional = false,
        reviewed_at = now(),
        reviewed_by = ${reviewerId},
        rejection_reason = ${reason}
      WHERE id = ${revisionId} AND status = 'pending'
    `);
    const currentItems = await tx
      .select({ quantity: stockTransferItems.quantity, rate: stockTransferItems.rate })
      .from(stockTransferItems)
      .where(eq(stockTransferItems.transferId, transferId));
    return finish({
      revisionId,
      transferId,
      voucherId,
      revisionNumber,
      transition: "rejected",
      changedItemCount: 0,
      inventoryApplied,
      totalAmount: currentItems
        .reduce((sum, item) => sum.plus(lineAmount(item.quantity, item.rate)), new MoneyDecimal(0))
        .toFixed(2),
      items: toRevisionAuditItems(rejectedRevisionItems),
    });
  };
  return existingTx ? run(existingTx) : db.transaction(run);
}
