import type { Express, NextFunction, Request, Response } from "express";
import { and, eq, or, sql } from "drizzle-orm";
import {
  customerBalances,
  customerOrderCharges,
  customerOrders,
  factoryDaybookEntries,
  interCompanyTransfers,
  intercompanyPaymentRequests,
  propertyPayments,
  voucherEntries,
  vouchers,
} from "@shared/schema";
import { requireAuth, requireNonPOS, requireRole } from "../../auth";
import { db } from "../../db";
import { getErrorMessage, errorStatus } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { voucherMutationBlockReason } from "../../lib/migratedVoucherGuard";
import { storage } from "../../storage";
import { applyEmployeeBalanceDeltasTx } from "../../services/accounting/employeeBalancePosting";
import { createDatabasePostingDependencies } from "../../services/accounting/databasePostingDependencies";
import { buildManualJournalPostingRequest } from "../../services/accounting/manualJournalPosting";
import { recalculateOrderTotals } from "../factory/_helpers";
import { checkAccountWhatsAppRule } from "../factoryWhatsappRoutes";
import {
  buildVoucherChangesForDelete,
  buildVoucherChangesForUpdate,
  logAudit,
  snapshotVoucherEntries,
} from "../_helpers";

const postingDependencies = createDatabasePostingDependencies();

async function syncJournalToOrderCharge(
  companyId: number,
  savedEntries: Array<{
    customerId: number | null;
    ledgerAccountId: number | null;
    debitAmount: string | null;
    creditAmount: string | null;
  }>,
  voucherId: number
): Promise<void> {
  const customerEntry = savedEntries.find((entry) => entry.customerId !== null);
  if (!customerEntry) return;

  const ledgerCreditEntries = savedEntries.filter(
    (entry) => entry.ledgerAccountId !== null && entry.customerId === null && Number(entry.creditAmount || 0) > 0
  );

  for (const ledgerEntry of ledgerCreditEntries) {
    const newAmount = Number(ledgerEntry.creditAmount || 0);
    if (newAmount <= 0) continue;

    let matchingCharges: Array<{
      id: number;
      orderId: number;
      amount: string;
      chargeType: string;
    }> = await db
      .select({
        id: customerOrderCharges.id,
        orderId: customerOrderCharges.orderId,
        amount: customerOrderCharges.amount,
        chargeType: customerOrderCharges.chargeType,
      })
      .from(customerOrderCharges)
      .innerJoin(
        customerOrders,
        and(eq(customerOrderCharges.orderId, customerOrders.id), eq(customerOrders.companyId, companyId))
      )
      .where(
        and(
          eq(customerOrderCharges.voucherId, voucherId),
          eq(customerOrderCharges.ledgerAccountId, ledgerEntry.ledgerAccountId!)
        )
      );

    if (matchingCharges.length === 0) {
      const byLedger = await db
        .select({
          id: customerOrderCharges.id,
          orderId: customerOrderCharges.orderId,
          amount: customerOrderCharges.amount,
          chargeType: customerOrderCharges.chargeType,
        })
        .from(customerOrderCharges)
        .innerJoin(
          customerOrders,
          and(
            eq(customerOrderCharges.orderId, customerOrders.id),
            eq(customerOrders.customerId, customerEntry.customerId!),
            eq(customerOrders.companyId, companyId)
          )
        )
        .where(
          and(
            eq(customerOrderCharges.ledgerAccountId, ledgerEntry.ledgerAccountId!),
            sql`${customerOrderCharges.voucherId} IS NULL`
          )
        );

      if (byLedger.length === 1) matchingCharges = byLedger;
    }

    if (matchingCharges.length === 0) continue;
    const charge = matchingCharges[0];
    const amountChanged = Math.abs(Number(charge.amount || 0) - newAmount) >= 0.01;

    await db.transaction(async (tx) => {
      await tx
        .update(customerOrderCharges)
        .set({ amount: newAmount.toFixed(2), voucherId })
        .where(eq(customerOrderCharges.id, charge.id));

      if (!amountChanged) return;
      await recalculateOrderTotals(tx, charge.orderId);

      const [updatedOrder] = await tx
        .select({ grandTotal: customerOrders.grandTotal })
        .from(customerOrders)
        .where(eq(customerOrders.id, charge.orderId));

      if (updatedOrder) {
        await tx
          .update(customerBalances)
          .set({ debitAmount: updatedOrder.grandTotal, balance: updatedOrder.grandTotal })
          .where(
            and(
              eq(customerBalances.companyId, companyId),
              eq(customerBalances.referenceId, charge.orderId),
              eq(customerBalances.referenceType, "INVOICE")
            )
          );
      }
    });
  }
}

async function syncIntercompanyCounterpart(voucherId: number, newTotal: number): Promise<void> {
  try {
    const [transfer] = await db
      .select()
      .from(interCompanyTransfers)
      .where(or(eq(interCompanyTransfers.fromVoucherId, voucherId), eq(interCompanyTransfers.toVoucherId, voucherId)))
      .limit(1);
    if (!transfer) return;

    const otherVoucherId = transfer.fromVoucherId === voucherId ? transfer.toVoucherId : transfer.fromVoucherId;
    if (!otherVoucherId) return;

    const [otherVoucher] = await db.select().from(vouchers).where(eq(vouchers.id, otherVoucherId));
    if (!otherVoucher) return;

    const oldTotal = Number(otherVoucher.totalAmount || 0);
    const ratio = oldTotal > 0 ? newTotal / oldTotal : 1;
    const otherEntries = await db.select().from(voucherEntries).where(eq(voucherEntries.voucherId, otherVoucherId));

    for (const entry of otherEntries) {
      await db
        .update(voucherEntries)
        .set({
          debitAmount: (Number(entry.debitAmount || 0) * ratio).toFixed(2),
          creditAmount: (Number(entry.creditAmount || 0) * ratio).toFixed(2),
        })
        .where(eq(voucherEntries.id, entry.id));
    }

    await db
      .update(vouchers)
      .set({ totalAmount: newTotal.toFixed(2) })
      .where(eq(vouchers.id, otherVoucherId));
    await db
      .update(factoryDaybookEntries)
      .set({ amountCurrency: newTotal.toFixed(2), amountUsd: newTotal.toFixed(2) })
      .where(
        and(eq(factoryDaybookEntries.referenceTable, "vouchers"), eq(factoryDaybookEntries.referenceId, otherVoucherId))
      );
  } catch (error: unknown) {
    logger.error("[Central journal lifecycle] Intercompany counterpart update failed (non-fatal)", {
      voucherId,
      error: getErrorMessage(error),
    });
  }
}

async function updateActiveJournal(req: Request, res: Response, next: NextFunction): Promise<void> {
  const startedAt = Date.now();
  const voucherId = Number(req.params.id);
  const companyId = req.session.currentCompanyId;
  const userId = req.session.userId;

  if (!Number.isInteger(voucherId) || voucherId <= 0) {
    res.status(400).json({ message: "Invalid voucher ID" });
    return;
  }
  if (!companyId) {
    res.status(400).json({ message: "No company selected" });
    return;
  }

  try {
    const existing = await storage.getVoucherById(voucherId);
    if (!existing) {
      res.status(404).json({ message: "Voucher not found" });
      return;
    }
    if (existing.companyId !== companyId) {
      res.status(403).json({ message: "Access denied: Voucher belongs to a different company" });
      return;
    }
    const blockedVoucherReason = voucherMutationBlockReason(existing);
    if (blockedVoucherReason) {
      res.status(403).json({ message: blockedVoucherReason });
      return;
    }

    // Only active Journal -> active Journal updates are converged here. Optional
    // transitions retain the unchanged legacy behavior until their draft lifecycle
    // is separately designed.
    if (existing.voucherType !== "Journal" || existing.optional || req.body?.optional === true) {
      next();
      return;
    }

    const {
      voucherDate,
      entries,
      notes,
      currency,
      exchangeRate,
      effectiveDate,
      clientRequestId,
      mainAccountId,
      mainAccountType,
    } = req.body ?? {};
    if (!voucherDate || !Array.isArray(entries) || entries.length === 0) {
      res.status(400).json({ message: "Missing required fields" });
      return;
    }

    const built = buildManualJournalPostingRequest({
      companyId,
      voucherNumber: existing.voucherNumber,
      voucherDate,
      entries,
      notes,
      currency: currency || "USD",
      exchangeRate: exchangeRate ?? null,
      effectiveDate: effectiveDate || null,
      clientRequestId: clientRequestId || `journal-update-${voucherId}-${Date.now()}`,
      actor: {
        userId: userId ?? null,
        username: req.session.username || "unknown",
        reason: "Manual journal update",
      },
    });

    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT id FROM vouchers
        WHERE id = ${voucherId} AND company_id = ${companyId}
        FOR UPDATE
      `);

      const [lockedVoucher] = await tx
        .select()
        .from(vouchers)
        .where(and(eq(vouchers.id, voucherId), eq(vouchers.companyId, companyId)))
        .limit(1);
      if (!lockedVoucher || lockedVoucher.deletedAt) {
        throw new Error("Voucher not found or already deleted");
      }
      if (lockedVoucher.optional) {
        throw new Error("Optional journal transitions must use the compatibility route");
      }

      const oldEntries = await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, voucherId));

      await postingDependencies.ownership.validateVoucherOwnership({
        tx,
        companyId,
        voucher: built.request.voucher,
        entries: built.request.entries,
      });

      await applyEmployeeBalanceDeltasTx({
        tx,
        companyId,
        entries: oldEntries,
        direction: "reverse",
        missingEmployeeBehavior: "skip",
      });

      const [updatedVoucher] = await tx
        .update(vouchers)
        .set({
          voucherDate: built.request.voucher.voucherDate,
          description: built.request.voucher.description ?? null,
          totalAmount: built.request.voucher.totalAmount,
          optional: false,
          currency: built.request.voucher.currency ?? "USD",
          exchangeRate: built.request.voucher.exchangeRate ?? null,
          effectiveDate: built.request.voucher.effectiveDate ?? null,
        })
        .where(and(eq(vouchers.id, voucherId), eq(vouchers.companyId, companyId)))
        .returning();

      await tx.delete(voucherEntries).where(eq(voucherEntries.voucherId, voucherId));
      const createdEntries = await tx
        .insert(voucherEntries)
        .values(built.request.entries.map((entry) => ({ voucherId, ...entry })))
        .returning();

      await applyEmployeeBalanceDeltasTx({
        tx,
        companyId,
        entries: createdEntries,
        direction: "apply",
        missingEmployeeBehavior: "throw",
      });

      return {
        voucher: updatedVoucher,
        entries: createdEntries,
        oldEntries,
        existingVoucher: lockedVoucher,
      };
    });

    await syncJournalToOrderCharge(companyId, result.entries, result.voucher.id).catch((error: unknown) =>
      logger.error("Central journal order-charge update failed (non-fatal)", {
        companyId,
        voucherId,
        error,
      })
    );
    await syncIntercompanyCounterpart(voucherId, Number(result.voucher.totalAmount || 0));

    let whatsapp: {
      prompt: boolean;
      accountId?: number;
      voucherDate?: string;
      month?: string;
    } = { prompt: false };
    try {
      let accountId = mainAccountId ? Number(mainAccountId) : null;
      let accountType = mainAccountType ? String(mainAccountType) : "ledger";
      if (!accountId) {
        const firstLedgerDebit = entries.find(
          (entry) => entry.accountType === "ledger" && entry.type === "DR" && Number(entry.accountId) > 0
        );
        if (firstLedgerDebit) {
          accountId = Number(firstLedgerDebit.accountId);
          accountType = "ledger";
        }
      }
      if (accountId) {
        whatsapp = await checkAccountWhatsAppRule({
          companyId,
          accountId,
          accountType,
          voucherType: "Journal",
          voucherDate,
        });
      }
    } catch (error: unknown) {
      logger.error("Central journal update WhatsApp check failed (non-fatal)", {
        companyId,
        voucherId,
        error,
      });
    }

    try {
      const oldSnapshot = await snapshotVoucherEntries(result.oldEntries);
      const newSnapshot = await snapshotVoucherEntries(result.entries);
      await logAudit({
        userId: userId!,
        username: req.session.username || "unknown",
        companyId,
        action: "update",
        tableName: "vouchers",
        recordId: voucherId,
        recordIdentifier: result.voucher.voucherNumber,
        changes: buildVoucherChangesForUpdate(
          {
            voucherType: result.existingVoucher.voucherType,
            voucherDate: result.existingVoucher.voucherDate,
            totalAmount: result.existingVoucher.totalAmount,
            description: result.existingVoucher.description,
            optional: result.existingVoucher.optional,
          },
          {
            voucherType: result.voucher.voucherType,
            voucherDate: result.voucher.voucherDate,
            totalAmount: result.voucher.totalAmount,
            description: result.voucher.description,
            optional: result.voucher.optional,
          },
          oldSnapshot,
          newSnapshot
        ),
      });
    } catch {
      // The voucher and employee deltas are already transactionally consistent.
    }

    logger.info("central journal update succeeded", {
      module: "vouchers",
      action: "updateJournalCentral",
      userId,
      companyId,
      voucherId,
      durationMs: Date.now() - startedAt,
    });
    res.json({ voucher: result.voucher, entries: result.entries, whatsapp });
  } catch (error: unknown) {
    logger.error("central journal update failed", {
      module: "vouchers",
      action: "updateJournalCentral",
      userId,
      companyId,
      voucherId,
      durationMs: Date.now() - startedAt,
      error,
    });
    res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
  }
}

async function deleteActiveJournal(req: Request, res: Response, next: NextFunction): Promise<void> {
  const voucherId = Number(req.params.id);
  const companyId = req.session.currentCompanyId;
  if (!Number.isInteger(voucherId) || voucherId <= 0) {
    res.status(400).json({ message: "Invalid voucher ID" });
    return;
  }
  if (!companyId) {
    res.status(400).json({ message: "No company selected" });
    return;
  }

  try {
    const voucher = await storage.getVoucherById(voucherId);
    if (!voucher) {
      res.status(404).json({ message: "Voucher not found" });
      return;
    }
    if (voucher.companyId !== companyId) {
      res.status(403).json({ message: "Access denied: Voucher belongs to a different company" });
      return;
    }
    const blockedVoucherReason = voucherMutationBlockReason(voucher);
    if (blockedVoucherReason) {
      res.status(403).json({ message: blockedVoucherReason });
      return;
    }

    // Keep every non-journal and optional-voucher deletion on the existing route.
    if (voucher.voucherType !== "Journal" || voucher.optional) {
      next();
      return;
    }

    const deletion = await db.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT id FROM vouchers
        WHERE id = ${voucherId} AND company_id = ${companyId}
        FOR UPDATE
      `);
      const [lockedVoucher] = await tx
        .select()
        .from(vouchers)
        .where(and(eq(vouchers.id, voucherId), eq(vouchers.companyId, companyId)))
        .limit(1);
      if (!lockedVoucher) throw new Error("Voucher not found");
      if (lockedVoucher.deletedAt) {
        return { replayed: true, voucher: lockedVoucher, entries: [] };
      }

      const entries = await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, voucherId));
      await applyEmployeeBalanceDeltasTx({
        tx,
        companyId,
        entries,
        direction: "reverse",
        missingEmployeeBehavior: "skip",
      });

      const linkedPayments = await tx.select().from(propertyPayments).where(eq(propertyPayments.voucherId, voucherId));
      for (const payment of linkedPayments) {
        if (payment.ledgerRowId) {
          await tx.execute(sql`
            UPDATE property_monthly_ledger
            SET paid_amount = GREATEST(0, paid_amount - ${payment.amount}::numeric)
            WHERE id = ${payment.ledgerRowId}
          `);
        }
        await tx.delete(propertyPayments).where(eq(propertyPayments.id, payment.id));
      }

      const linkedTransfers = await tx
        .select()
        .from(interCompanyTransfers)
        .where(
          or(eq(interCompanyTransfers.fromVoucherId, voucherId), eq(interCompanyTransfers.toVoucherId, voucherId))
        );
      for (const transfer of linkedTransfers) {
        const otherVoucherId = transfer.fromVoucherId === voucherId ? transfer.toVoucherId : transfer.fromVoucherId;
        await tx.delete(interCompanyTransfers).where(eq(interCompanyTransfers.id, transfer.id));
        if (otherVoucherId && otherVoucherId !== voucherId) {
          await tx.delete(voucherEntries).where(eq(voucherEntries.voucherId, otherVoucherId));
          await tx.delete(vouchers).where(eq(vouchers.id, otherVoucherId));
        }
      }

      await tx
        .delete(intercompanyPaymentRequests)
        .where(
          and(
            eq(intercompanyPaymentRequests.fromVoucherId, voucherId),
            eq(intercompanyPaymentRequests.status, "pending")
          )
        );
      await tx
        .update(vouchers)
        .set({ deletedAt: new Date() })
        .where(and(eq(vouchers.id, voucherId), eq(vouchers.companyId, companyId)));

      return { replayed: false, voucher: lockedVoucher, entries };
    });

    if (!deletion.replayed) {
      try {
        const entrySnapshot = await snapshotVoucherEntries(deletion.entries);
        await logAudit({
          userId: req.session.userId!,
          username: req.session.username || "unknown",
          companyId,
          action: "delete",
          tableName: "vouchers",
          recordId: voucherId,
          recordIdentifier: deletion.voucher.voucherNumber,
          changes: buildVoucherChangesForDelete(deletion.voucher, entrySnapshot),
        });
      } catch {
        // Deletion and employee reversal already committed atomically.
      }
    }

    res.json({
      message: "Voucher deleted successfully",
      replayed: deletion.replayed,
    });
  } catch (error: unknown) {
    logger.error("central journal delete failed", {
      module: "vouchers",
      action: "deleteJournalCentral",
      companyId,
      voucherId,
      error,
    });
    res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
  }
}

export function registerCentralJournalLifecycleRoutes(app: Express): void {
  app.patch(
    "/api/vouchers/:id/journal",
    requireAuth,
    requireNonPOS,
    (req, res, next) => void updateActiveJournal(req, res, next)
  );
  app.delete(
    "/api/vouchers/:id",
    requireAuth,
    requireRole("Admin"),
    (req, res, next) => void deleteActiveJournal(req, res, next)
  );
}
