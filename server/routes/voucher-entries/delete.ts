/**
 * voucherEntryRoutes: VoucherDelete endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage, errorStatus } from "../../lib/httpHandlers";
import { db, type DbTransaction } from "../../db";
import { writeAuditEvent } from "../../services/audit";
import { storage } from "../../storage";
import { requireAuth, requireRole } from "../../auth";
import { voucherMutationBlockReason } from "../../lib/migratedVoucherGuard";
import { recalculateIntercompanyForDate } from "../helpers/intercompanyHelpers";
import { syncEmployeeBalancesFromEntries, buildVoucherChangesForDelete } from "../_helpers";
import { readVoucherAuditState, writeVoucherAuditTx } from "../helpers/voucherAuditTrail";
import {
  vouchers,
  voucherEntries,
  interCompanyTransfers,
  propertyPayments,
  intercompanyPaymentRequests,
} from "@shared/schema";
import { eq, and, or, sql } from "drizzle-orm";
import { reverseVoucherStockTx } from "../../services/inventory/voucherStockReversal";
import { syncPurchaseOrderGitForVoucherTx } from "../../services/accounting/perpetualInventory/stockReceipts";
import { syncFactoryInvoiceForChargeVoucherTx } from "../../services/accounting/perpetualInventory/factoryInvoice";

type InterCompanyTransferRow = typeof interCompanyTransfers.$inferSelect;

/**
 * Wave 9 (ledger safety): deleting one side of an inter-company transfer takes
 * the other company's side out of the books by soft delete — deleted_at set,
 * lines kept, exactly like the voucher being deleted — never by hard delete.
 * The counterpart's audit row is written in the same transaction, under the
 * counterpart's company. The transfer link row is still removed, as before; the
 * audit row keeps a copy of it.
 */
export async function softDeleteInterCompanyCounterpartTx(
  tx: DbTransaction,
  params: {
    transfer: InterCompanyTransferRow;
    voucherId: number;
    voucherNumber: string;
    actor: { userId?: string | null; username?: string | null };
  }
): Promise<void> {
  const { transfer, voucherId } = params;
  const otherVoucherId = transfer.fromVoucherId === voucherId ? transfer.toVoucherId : transfer.fromVoucherId;
  if (!otherVoucherId || otherVoucherId === voucherId) return;

  const [counterpart] = await tx.select().from(vouchers).where(eq(vouchers.id, otherVoucherId));
  if (!counterpart || counterpart.deletedAt) return;

  const deletedAt = new Date();
  await tx.update(vouchers).set({ deletedAt }).where(eq(vouchers.id, otherVoucherId));

  const entries = await tx
    .select({
      ledgerAccountId: voucherEntries.ledgerAccountId,
      bankAccountId: voucherEntries.bankAccountId,
      supplierId: voucherEntries.supplierId,
      customerId: voucherEntries.customerId,
      employeeId: voucherEntries.employeeId,
      debitAmount: voucherEntries.debitAmount,
      creditAmount: voucherEntries.creditAmount,
      narration: voucherEntries.narration,
    })
    .from(voucherEntries)
    .where(eq(voucherEntries.voucherId, otherVoucherId));

  await writeAuditEvent(
    {
      userId: params.actor.userId ?? "unknown",
      username: params.actor.username || "unknown",
      companyId: counterpart.companyId,
      action: "delete",
      tableName: "vouchers",
      recordId: otherVoucherId,
      recordIdentifier: counterpart.voucherNumber,
      changes: {
        ...buildVoucherChangesForDelete(counterpart, entries),
        deletedAt: { old: null, new: deletedAt },
        interCompanyCounterpartOf: { old: { voucherId, voucherNumber: params.voucherNumber } },
        interCompanyTransfer: { old: transfer },
      },
    },
    tx
  );
}

export function registerVoucherDeleteRoutes(app: Express) {
  // Delete a voucher (Admin only)
  app.delete("/api/vouchers/:id", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ message: "Invalid voucher ID" });
      }

      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      // Get voucher and entries before deleting for balance sync
      const voucher = await storage.getVoucherById(id);
      if (!voucher) {
        return res.status(404).json({ message: "Voucher not found" });
      }

      const blockedVoucherReason = voucherMutationBlockReason(voucher);
      if (blockedVoucherReason) {
        return res.status(403).json({ message: blockedVoucherReason });
      }

      const companyId = req.session.currentCompanyId;
      const occurredAt = new Date().toISOString();

      // Wrap balance sync and deletion in a transaction
      await db.transaction(async (tx) => {
        const auditBefore = await readVoucherAuditState(tx, id);
        // Wave 11: every stock document moves back exactly the value its lines
        // moved, and a sale's COGS journal leaves with it (voucherStockReversal).
        await reverseVoucherStockTx(tx, {
          companyId,
          voucher,
          occurredAt,
          actor: {
            userId: req.session.userId,
            username: req.session.username,
            reason: `Delete voucher ${voucher.voucherNumber}`,
          },
          sourcePrefix: "voucher_delete",
          keyPrefix: "voucher-delete",
        });

        if (!voucher.optional) {
          const entries = await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, id));

          // Reverse the entries' effect on employee balances, in this transaction (wave 12).
          await syncEmployeeBalancesFromEntries(
            entries.map((e) => ({
              ledgerAccountId: e.ledgerAccountId,
              employeeId: e.employeeId,
              debitAmount: e.debitAmount,
              creditAmount: e.creditAmount,
            })),
            companyId,
            true, // reverse
            tx
          );
        }

        // IMPORTANT: If this voucher is linked to a property payment entry,
        // reverse the monthly ledger and delete the payment log row so the
        // rent balance and payment history stay consistent.
        const linkedPayments = await tx.select().from(propertyPayments).where(eq(propertyPayments.voucherId, id));
        for (const pmt of linkedPayments) {
          if (pmt.ledgerRowId) {
            await tx.execute(sql`
                UPDATE property_monthly_ledger
                SET paid_amount = GREATEST(0, paid_amount - ${pmt.amount}::numeric)
                WHERE id = ${pmt.ledgerRowId}
              `);
          }
          await tx.delete(propertyPayments).where(eq(propertyPayments.id, pmt.id));
        }

        // IMPORTANT: If this voucher is one side of an inter-company transfer,
        // also take the OTHER side out of the books and remove the transfer record.
        // Wave 9: the other side is soft-deleted (lines kept) and audited under its
        // own company, in this transaction — it used to be hard-deleted unaudited.
        const linkedTransfersSingle = await tx
          .select()
          .from(interCompanyTransfers)
          .where(or(eq(interCompanyTransfers.fromVoucherId, id), eq(interCompanyTransfers.toVoucherId, id)));
        for (const transfer of linkedTransfersSingle) {
          await tx.delete(interCompanyTransfers).where(eq(interCompanyTransfers.id, transfer.id));
          await softDeleteInterCompanyCounterpartTx(tx, {
            transfer,
            voucherId: id,
            voucherNumber: voucher.voucherNumber,
            actor: { userId: req.session.userId, username: req.session.username },
          });
        }

        // Clean up any pending IC notification requests for this voucher
        // so recipients stop seeing the bell notification for a deleted payment.
        await tx
          .delete(intercompanyPaymentRequests)
          .where(
            and(eq(intercompanyPaymentRequests.fromVoucherId, id), eq(intercompanyPaymentRequests.status, "pending"))
          );

        // Soft delete: Keep voucher entries but set deletedAt on voucher
        // This automatically excludes entries from balance calculations
        // (calculateAccountBalance filters by isNull(vouchers.deletedAt))
        await tx.update(vouchers).set({ deletedAt: new Date() }).where(eq(vouchers.id, id));
        // Perpetual inventory (wave 8.2): a deleted PO voucher is no longer in transit.
        await syncPurchaseOrderGitForVoucherTx(tx, companyId, id);
        // Perpetual inventory (wave 8.4): an order whose charge this voucher carries re-syncs its invoice journal.
        await syncFactoryInvoiceForChargeVoucherTx(tx, companyId, id);

        // Wave 12 (decision 2): the deletion is audited with every line, in this
        // transaction; a failed audit write refuses the delete. (It used to be
        // written after commit, with lines read through `.catch(() => [])`.)
        await writeVoucherAuditTx(tx, {
          actor: { userId: req.session.userId, username: req.session.username, companyId },
          action: "delete",
          voucherId: id,
          before: auditBefore,
          after: null,
          extra: { softDelete: { new: true } },
        });
      });

      // A deleted cash sale must leave the intercompany POS mirror for its date.
      // The rebuild is atomic and never throws; a failure is logged and leaves
      // the previous mirror in place for a later recalculation.
      if (voucher.voucherType === "Sales" && !voucher.optional) {
        await recalculateIntercompanyForDate(companyId, voucher.voucherDate);
      }

      res.json({ message: "Voucher deleted successfully" });
    } catch (error: unknown) {
      res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
    }
  });
}
