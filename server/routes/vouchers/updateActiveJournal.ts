// Extracted from ./centralJournalLifecycleRoute.ts to keep that module under the source-size cap.
import type { NextFunction, Request, Response } from "express";
import { and, eq, sql } from "drizzle-orm";
import { voucherEntries, vouchers } from "@shared/schema";
import { db } from "../../db";
import { HttpError } from "../../lib/httpError";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../../services/security/databaseScopeRuntimeContext";
import { errorStatus, getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { voucherMutationBlockReason } from "../../lib/migratedVoucherGuard";
import { storage } from "../../storage";
import { applyEmployeeBalanceDeltasTx } from "../../services/accounting/employeeBalancePosting";
import { buildManualJournalPostingRequest } from "../../services/accounting/manualJournalPosting";
import { checkAccountWhatsAppRule } from "../factoryWhatsappRoutes";
import { findIntercompanyCounterpart, syncIntercompanyCounterpartTx } from "./intercompanyCounterpartRescale";
import {
  assertVoucherEditableTx,
  recordVoucherEditAuditTx,
  sendVoucherCorrectionRefusal,
} from "../../services/accounting/voucherCorrection";
import { rebalanceVoucherRoundingTx } from "../../services/accounting/engineRounding";
import { getAccessibleCompanyIds } from "../../security/companyAccessBoundary";
import { postingDependencies, syncJournalToOrderChargeTx } from "./syncJournalToOrderChargeTx";

export async function updateActiveJournal(req: Request, res: Response, next: NextFunction): Promise<void> {
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
        // Phase 22 A (correction policy): open period only (409
        // VOUCHER_CLOSED_PERIOD_REVERSE_INSTEAD otherwise); a reversed journal is not edited.
        const editContext = await assertVoucherEditableTx(tx, voucherId, {
          companyId,
          newVoucherDate: built.request.voucher.voucherDate,
          newEffectiveDate: built.request.voucher.effectiveDate ?? null,
        });

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
        const insertedEntries = await tx
          .insert(voucherEntries)
          .values(built.request.entries.map((entry) => ({ voucherId, ...entry })))
          .returning();

        await applyEmployeeBalanceDeltasTx({
          tx,
          companyId,
          entries: insertedEntries,
          direction: "apply",
          missingEmployeeBehavior: "throw",
        });

        // Phase 22 A (D3): an engine journal balances exactly; the rounding
        // remainder of the new lines goes to its ROUNDING line.
        await rebalanceVoucherRoundingTx(tx, { companyId, voucherId });

        // Wave 12 / phase 22 A: full before/after snapshot in this transaction; a
        // failed audit write refuses the edit.
        const audited = await recordVoucherEditAuditTx(tx, {
          voucherId,
          before: editContext.before,
          actor: { userId, username: req.session.username, companyId },
          reason: "Manual journal update",
        });
        const createdEntries = audited.entries;

        const actor = { userId, username: req.session.username };
        await syncJournalToOrderChargeTx(tx, companyId, createdEntries, updatedVoucher.id, actor);
        if (counterpart) {
          await syncIntercompanyCounterpartTx(tx, {
            voucherId,
            counterpart,
            oldTotal: lockedVoucher.totalAmount,
            newTotal: updatedVoucher.totalAmount,
            newVoucherDate: updatedVoucher.voucherDate,
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
    if (sendVoucherCorrectionRefusal(res, error)) return;
    res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
  }
}
