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
import { db, type DbTransaction } from "../../db";
import { HttpError } from "../../lib/httpError";
import { writeAuditEvent } from "../../services/audit";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../../services/security/databaseScopeRuntimeContext";
import { getErrorMessage, errorStatus } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { voucherMutationBlockReason } from "../../lib/migratedVoucherGuard";
import { storage } from "../../storage";
import { applyEmployeeBalanceDeltasTx } from "../../services/accounting/employeeBalancePosting";
import { createDatabasePostingDependencies } from "../../services/accounting/databasePostingDependencies";
import { buildManualJournalPostingRequest } from "../../services/accounting/manualJournalPosting";
import { softDeleteInterCompanyCounterpartTx } from "../voucher-entries/delete";
import { recalculateOrderTotals } from "../factory/_helpers";
import { checkAccountWhatsAppRule } from "../factoryWhatsappRoutes";
import { readVoucherAuditState, writeVoucherAuditTx } from "../helpers/voucherAuditTrail";
import { allocateCents, sumMoney, toMoney } from "../../lib/money";
import { getAccessibleCompanyIds } from "../../security/companyAccessBoundary";
import type Decimal from "decimal.js";

const postingDependencies = createDatabasePostingDependencies();

/**
 * Wave 18 (B): the order charge a journal line pays and the order's invoice
 * balance follow the edit inside the edit's transaction (a failure rolls the
 * edit back; nothing is swallowed), in exact decimals, audited.
 */
async function syncJournalToOrderChargeTx(
  tx: DbTransaction,
  companyId: number,
  savedEntries: Array<{
    customerId: number | null;
    ledgerAccountId: number | null;
    debitAmount: string | null;
    creditAmount: string | null;
  }>,
  voucherId: number,
  actor: { userId?: string | null; username?: string | null }
): Promise<void> {
  const customerEntry = savedEntries.find((entry) => entry.customerId !== null);
  if (!customerEntry) return;

  const ledgerCreditEntries = savedEntries.filter(
    (entry) => entry.ledgerAccountId !== null && entry.customerId === null && toMoney(entry.creditAmount).gt(0)
  );

  for (const ledgerEntry of ledgerCreditEntries) {
    const newAmount = toMoney(ledgerEntry.creditAmount).toDecimalPlaces(2);
    if (!newAmount.gt(0)) continue;

    let matchingCharges: Array<{
      id: number;
      orderId: number;
      amount: string;
      chargeType: string;
      voucherId: number | null;
    }> = await tx
      .select({
        id: customerOrderCharges.id,
        orderId: customerOrderCharges.orderId,
        amount: customerOrderCharges.amount,
        chargeType: customerOrderCharges.chargeType,
        voucherId: customerOrderCharges.voucherId,
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
      const byLedger = await tx
        .select({
          id: customerOrderCharges.id,
          orderId: customerOrderCharges.orderId,
          amount: customerOrderCharges.amount,
          chargeType: customerOrderCharges.chargeType,
          voucherId: customerOrderCharges.voucherId,
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
    const amountChanged = !toMoney(charge.amount).equals(newAmount);
    if (!amountChanged && charge.voucherId === voucherId) continue;

    await tx
      .update(customerOrderCharges)
      .set({ amount: newAmount.toFixed(2), voucherId })
      .where(eq(customerOrderCharges.id, charge.id));

    const auditActor = {
      userId: actor.userId ?? "unknown",
      username: actor.username || "unknown",
      companyId,
    };
    await writeAuditEvent(
      {
        ...auditActor,
        action: "update",
        tableName: "customer_order_charges",
        recordId: charge.id,
        recordIdentifier: charge.chargeType,
        changes: {
          amount: { old: charge.amount, new: newAmount.toFixed(2) },
          voucherId: { old: charge.voucherId, new: voucherId },
          syncedFromJournal: { new: voucherId },
        },
      },
      tx
    );

    if (!amountChanged) continue;
    await recalculateOrderTotals(tx, charge.orderId);

    const [updatedOrder] = await tx
      .select({ grandTotal: customerOrders.grandTotal })
      .from(customerOrders)
      .where(eq(customerOrders.id, charge.orderId));

    if (updatedOrder) {
      const balanceRows = await tx
        .update(customerBalances)
        .set({ debitAmount: updatedOrder.grandTotal, balance: updatedOrder.grandTotal })
        .where(
          and(
            eq(customerBalances.companyId, companyId),
            eq(customerBalances.referenceId, charge.orderId),
            eq(customerBalances.referenceType, "INVOICE")
          )
        )
        .returning({ id: customerBalances.id });
      for (const row of balanceRows) {
        await writeAuditEvent(
          {
            ...auditActor,
            action: "update",
            tableName: "customer_balances",
            recordId: row.id,
            recordIdentifier: `order:${charge.orderId}`,
            changes: {
              debitAmount: { new: updatedOrder.grandTotal },
              balance: { new: updatedOrder.grandTotal },
              syncedFromJournal: { new: voucherId },
            },
          },
          tx
        );
      }
    }
  }
}

export const INTERCOMPANY_COUNTERPART_MIXED_CURRENCY_MESSAGE =
  "The intercompany counterpart voucher has lines in more than one currency or rate, so this edit cannot rescale it. Delete the journal and post the transfer again instead.";
export const INTERCOMPANY_COUNTERPART_ZERO_TOTAL_MESSAGE =
  "The journal had a zero total, so its intercompany counterpart cannot be rescaled. Delete the journal and post the transfer again instead.";

class CounterpartSyncRefused extends HttpError {
  constructor(message: string) {
    super(409, message);
  }
}

/** The intercompany transfer naming the voucher and the other company, when there is one. */
async function findIntercompanyCounterpart(
  voucherId: number,
  companyId: number
): Promise<{ otherVoucherId: number; otherCompanyId: number } | null> {
  const [transfer] = await db
    .select()
    .from(interCompanyTransfers)
    .where(or(eq(interCompanyTransfers.fromVoucherId, voucherId), eq(interCompanyTransfers.toVoucherId, voucherId)))
    .limit(1);
  if (!transfer) return null;
  const isSource = transfer.fromVoucherId === voucherId;
  const otherVoucherId = isSource ? transfer.toVoucherId : transfer.fromVoucherId;
  const ownCompanyId = isSource ? transfer.fromCompanyId : transfer.toCompanyId;
  if (!otherVoucherId || otherVoucherId === voucherId || ownCompanyId !== companyId) return null;
  return { otherVoucherId, otherCompanyId: isSource ? transfer.toCompanyId : transfer.fromCompanyId };
}

/** Base amount of a transaction amount under the line's stored rate (as the currency trigger computes it). */
function baseOf(amount: Decimal, convention: string | null, rate: string | null): Decimal {
  if (!convention || convention === "IDENTITY") return amount;
  const exactRate = toMoney(rate);
  if (!exactRate.gt(0)) throw new Error("Counterpart line has no positive historical rate");
  const base = convention === "BASE_PER_TRANSACTION" ? amount.times(exactRate) : amount.dividedBy(exactRate);
  return base.toDecimalPlaces(6);
}

/**
 * Wave 18 (B): the intercompany counterpart follows a journal edit inside the
 * edit's transaction (a failure rolls the edit back; nothing is swallowed).
 * Its lines are rescaled by the same ratio as the edited journal (new total /
 * old total) in their own transaction currency, each side allocated to the
 * exact cent so the voucher still balances; a normalized line gets its
 * transaction_* and base amounts written together at its stored rate, so the
 * currency trigger v2 accepts it. A counterpart with lines in several
 * currencies or rates is refused (409).
 */
async function syncIntercompanyCounterpartTx(
  tx: DbTransaction,
  params: {
    voucherId: number;
    otherVoucherId: number;
    otherCompanyId: number;
    oldTotal: string | null;
    newTotal: string | null;
    actor: { userId?: string | null; username?: string | null };
  }
): Promise<void> {
  const { voucherId, otherVoucherId } = params;
  const oldTotal = toMoney(params.oldTotal);
  const newTotal = toMoney(params.newTotal);
  if (oldTotal.equals(newTotal)) return;
  if (!oldTotal.gt(0)) throw new CounterpartSyncRefused(INTERCOMPANY_COUNTERPART_ZERO_TOTAL_MESSAGE);

  await tx.execute(
    sql`SELECT id FROM vouchers WHERE id = ${otherVoucherId} AND company_id = ${params.otherCompanyId} FOR UPDATE`
  );
  const [otherVoucher] = await tx
    .select()
    .from(vouchers)
    .where(and(eq(vouchers.id, otherVoucherId), eq(vouchers.companyId, params.otherCompanyId)));
  if (!otherVoucher || otherVoucher.deletedAt) return;

  const otherEntries = await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, otherVoucherId));
  const shapes = new Set(
    otherEntries.map((entry) =>
      entry.transactionCurrency
        ? `${entry.transactionCurrency}|${entry.rateConvention ?? ""}|${toMoney(entry.historicalExchangeRate).toFixed()}`
        : "legacy"
    )
  );
  if (shapes.size > 1) throw new CounterpartSyncRefused(INTERCOMPANY_COUNTERPART_MIXED_CURRENCY_MESSAGE);

  const txDebit = (entry: (typeof otherEntries)[number]) =>
    toMoney(entry.transactionCurrency ? entry.transactionDebitAmount : entry.debitAmount);
  const txCredit = (entry: (typeof otherEntries)[number]) =>
    toMoney(entry.transactionCurrency ? entry.transactionCreditAmount : entry.creditAmount);
  const debitLines = otherEntries.filter((entry) => txDebit(entry).gt(0));
  const creditLines = otherEntries.filter((entry) => txCredit(entry).gt(0));
  const oldSideTotal = sumMoney(debitLines.map(txDebit));
  const newSideTotal = oldSideTotal.times(newTotal).dividedBy(oldTotal).toDecimalPlaces(2);
  // Each side to the same exact total, so the voucher balances in its own currency.
  const newDebits = allocateCents(debitLines.map(txDebit), newSideTotal);
  const newCredits = allocateCents(creditLines.map(txCredit), newSideTotal);

  const auditBefore = await readVoucherAuditState(tx, otherVoucherId);
  let newBaseTotal = toMoney(0);
  const writeLine = async (entry: (typeof otherEntries)[number], amount: Decimal, side: "debit" | "credit") => {
    if (!entry.transactionCurrency) {
      // Legacy line (no transaction amounts): the base column is the amount.
      newBaseTotal = side === "debit" ? newBaseTotal.plus(amount) : newBaseTotal;
      await tx
        .update(voucherEntries)
        .set(side === "debit" ? { debitAmount: amount.toFixed(2) } : { creditAmount: amount.toFixed(2) })
        .where(eq(voucherEntries.id, entry.id));
      return;
    }
    const base = baseOf(amount, entry.rateConvention, entry.historicalExchangeRate);
    if (side === "debit") newBaseTotal = newBaseTotal.plus(base);
    const transaction = amount.toFixed(6);
    const baseText = base.toFixed(6);
    await tx
      .update(voucherEntries)
      .set(
        side === "debit"
          ? {
              transactionDebitAmount: transaction,
              transactionCreditAmount: "0.000000",
              baseDebitAmount: baseText,
              baseCreditAmount: "0.000000",
              debitAmount: baseText,
              creditAmount: "0",
            }
          : {
              transactionDebitAmount: "0.000000",
              transactionCreditAmount: transaction,
              baseDebitAmount: "0.000000",
              baseCreditAmount: baseText,
              debitAmount: "0",
              creditAmount: baseText,
            }
      )
      .where(eq(voucherEntries.id, entry.id));
  };
  for (const [index, entry] of debitLines.entries()) await writeLine(entry, newDebits[index], "debit");
  for (const [index, entry] of creditLines.entries()) await writeLine(entry, newCredits[index], "credit");

  await tx
    .update(vouchers)
    .set({ totalAmount: newBaseTotal.toFixed(6) })
    .where(eq(vouchers.id, otherVoucherId));
  await tx
    .update(factoryDaybookEntries)
    .set({ amountCurrency: newSideTotal.toFixed(2), amountUsd: newBaseTotal.toFixed(2) })
    .where(
      and(eq(factoryDaybookEntries.referenceTable, "vouchers"), eq(factoryDaybookEntries.referenceId, otherVoucherId))
    );
  // Wave 12: the counterpart's rescaled lines are audited under its own company, in this transaction.
  await writeVoucherAuditTx(tx, {
    actor: { ...params.actor, companyId: otherVoucher.companyId },
    action: "update",
    voucherId: otherVoucherId,
    before: auditBefore,
    after: await readVoucherAuditState(tx, otherVoucherId),
    extra: {
      interCompanyCounterpartOf: { new: { voucherId } },
      rescale: { old: oldTotal.toFixed(), new: newTotal.toFixed() },
    },
  });
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

    // Wave 18 (B): the order-charge sync and the intercompany counterpart run
    // inside this transaction. The counterpart belongs to the other company of
    // the transfer, so the transaction is scoped to both (as the intercompany
    // POS mirror is).
    const counterpart = await findIntercompanyCounterpart(voucherId, companyId);
    // The counterpart is the other company's posted voucher: the editor must
    // have access to that company too, or the edit is refused (it would
    // otherwise rewrite books the user cannot see).
    if (counterpart && counterpart.otherCompanyId !== companyId) {
      const accessible = userId ? await getAccessibleCompanyIds(String(userId)) : new Set<number>();
      if (!accessible.has(counterpart.otherCompanyId)) {
        throw new HttpError(
          403,
          "This journal has an intercompany counterpart in a company you cannot access; it cannot be edited here."
        );
      }
    }
    const inEditScope = <T>(work: () => Promise<T>): Promise<T> =>
      counterpart && counterpart.otherCompanyId !== companyId
        ? runWithDatabaseScopeRuntimeContext(
            createTenantDatabaseScope(companyId, [counterpart.otherCompanyId], "authorized-companies"),
            work
          )
        : work();

    const result = await inEditScope(() =>
      db.transaction(async (tx) => {
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
        const auditBefore = { voucher: lockedVoucher, entries: oldEntries };

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

        // Wave 12 (decision 2): full before/after snapshot in this transaction; a
        // failed audit write refuses the edit.
        await writeVoucherAuditTx(tx, {
          actor: { userId, username: req.session.username, companyId },
          action: "update",
          voucherId,
          before: auditBefore,
          after: { voucher: updatedVoucher, entries: createdEntries },
        });

        const actor = { userId, username: req.session.username };
        await syncJournalToOrderChargeTx(tx, companyId, createdEntries, updatedVoucher.id, actor);
        if (counterpart) {
          await syncIntercompanyCounterpartTx(tx, {
            voucherId,
            otherVoucherId: counterpart.otherVoucherId,
            otherCompanyId: counterpart.otherCompanyId,
            oldTotal: lockedVoucher.totalAmount,
            newTotal: updatedVoucher.totalAmount,
            actor,
          });
        }

        return {
          voucher: updatedVoucher,
          entries: createdEntries,
          oldEntries,
          existingVoucher: lockedVoucher,
        };
      })
    );

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
        // Wave 9: the other company's voucher is soft-deleted and audited, never hard-deleted.
        await tx.delete(interCompanyTransfers).where(eq(interCompanyTransfers.id, transfer.id));
        await softDeleteInterCompanyCounterpartTx(tx, {
          transfer,
          voucherId,
          voucherNumber: voucher.voucherNumber,
          actor: { userId: req.session.userId, username: req.session.username },
        });
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

      // Wave 12 (decision 2): audited with every line in this transaction.
      await writeVoucherAuditTx(tx, {
        actor: { userId: req.session.userId, username: req.session.username, companyId },
        action: "delete",
        voucherId,
        before: { voucher: lockedVoucher, entries },
        after: null,
        extra: { softDelete: { new: true } },
      });

      return { replayed: false, voucher: lockedVoucher, entries };
    });

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
