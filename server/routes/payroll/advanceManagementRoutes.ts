import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { getClientDate } from "../../lib/dateUtils";
import type { Express, Request, Response } from "express";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { eq, and, sql, inArray } from "drizzle-orm";
import { postErpVoucherTx } from "../../services/accounting/erpVoucherPosting";
import {
  assertVoucherEditableTx,
  recordVoucherEditAuditTx,
  sendVoucherCorrectionRefusal,
} from "../../services/accounting/voucherCorrection";
import { factoryWorkers, factoryWorkerAdvances, ledgerAccounts, vouchers, voucherEntries } from "@shared/schema";
import { toMoney } from "../../lib/money";
import { getFactoryCompanyId, writeDaybookEntry } from "./advanceRouteHelpers";
import { registerWorkerAdvanceBalanceRoute } from "./advanceReadRoutes";
import { registerAdvanceManagementRoutesPart1 } from "./registerAdvanceManagementRoutesPart1";
import { registerAdvanceManagementRoutesPart2 } from "./registerAdvanceManagementRoutesPart2";
export {
  ADVANCE_HAS_PAYROLL_RECOVERY_MESSAGE,
  ADVANCE_HAS_REPAYMENTS_MESSAGE,
} from "./registerAdvanceManagementRoutesPart1";

export function registerAdvanceManagementRoutes(app: Express) {
  registerAdvanceManagementRoutesPart1(app);
  registerAdvanceManagementRoutesPart2(app);
  registerAdvanceManagementRoutesPart3(app);
}

function registerAdvanceManagementRoutesPart3(app: Express) {
  // POST /api/factory/advances/bulk-update-cash-account
  // Updates cashAccountId on selected advances, creates/patches PAYMENT-ADV-* vouchers, and writes daybook entries.
  app.post("/api/factory/advances/bulk-update-cash-account", requireAuth, async (req: Request, res: Response) => {
    try {
      const currentRole = req.session.currentRole;
      if (currentRole !== "Admin" && currentRole !== "Owner" && currentRole !== "Developer") {
        return res.status(403).json({ message: "Only Admin or Owner can update advance cash accounts" });
      }
      const companyId = getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { advanceIds, cashAccountId: rawCashAccountId } = req.body;
      if (!Array.isArray(advanceIds) || advanceIds.length === 0) {
        return res.status(400).json({ message: "advanceIds must be a non-empty array" });
      }
      const cashAccountId = rawCashAccountId ? parseInt(rawCashAccountId) : null;
      if (!cashAccountId) return res.status(400).json({ message: "cashAccountId is required" });

      // Verify cash account belongs to this company
      const [acct] = await db
        .select({ id: ledgerAccounts.id, name: ledgerAccounts.name })
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.id, cashAccountId), eq(ledgerAccounts.companyId, companyId)));
      if (!acct) return res.status(400).json({ message: "Cash account not found for this company" });

      const ids = advanceIds.map((x) => parseInt(x)).filter((x: number) => !isNaN(x));
      const today = getClientDate(req);

      const result = await db.transaction(async (tx) => {
        // Load the advance records we're updating (need amount, date, workerId)
        const advanceRows = await tx
          .select()
          .from(factoryWorkerAdvances)
          .where(and(eq(factoryWorkerAdvances.companyId, companyId), inArray(factoryWorkerAdvances.id, ids)));

        // Load worker names for narration
        const workerIds = [...new Set(advanceRows.map((a) => a.workerId))];
        const workerRows =
          workerIds.length > 0
            ? await tx
                .select({ id: factoryWorkers.id, fullName: factoryWorkers.fullName })
                .from(factoryWorkers)
                .where(inArray(factoryWorkers.id, workerIds as number[]))
            : [];
        const workerMap = new Map<number, string>(workerRows.map((w) => [w.id, w.fullName]));

        // Find or create the "Factory Worker Advances" asset ledger account
        let [advancesAccount] = await tx
          .select({ id: ledgerAccounts.id })
          .from(ledgerAccounts)
          .where(and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.name, "Factory Worker Advances")));
        if (!advancesAccount) {
          const maxCodeResult = await tx
            .select({ maxCode: sql<number | null>`MAX(CAST(code AS INTEGER))` })
            .from(ledgerAccounts)
            .where(and(eq(ledgerAccounts.companyId, companyId), sql`code ~ '^\\d+$'`));
          const nextCode = String((maxCodeResult[0]?.maxCode ?? 0) + 1);
          [advancesAccount] = await tx
            .insert(ledgerAccounts)
            .values({
              companyId,
              code: nextCode,
              name: "Factory Worker Advances",
              accountType: "Asset",
              active: true,
              isHidden: false,
            })
            .returning();
        }
        const advancesAccountId = advancesAccount.id;

        // Update cashAccountId on each advance record
        await tx
          .update(factoryWorkerAdvances)
          .set({ cashAccountId })
          .where(and(eq(factoryWorkerAdvances.companyId, companyId), inArray(factoryWorkerAdvances.id, ids)));

        // Find existing PAYMENT-ADV-* vouchers for these advances
        const matchingVouchers = await tx
          .select({ id: vouchers.id, voucherNumber: vouchers.voucherNumber })
          .from(vouchers)
          .where(and(eq(vouchers.companyId, companyId), sql`${vouchers.voucherNumber} LIKE 'PAYMENT-ADV-%'`));

        // Map advance id → voucher id (for those that already have a voucher)
        const advVoucherMap = new Map<number, number>();
        for (const v of matchingVouchers) {
          const match = v.voucherNumber.match(/^PAYMENT-ADV-(\d+)-/);
          if (match) {
            const advId = parseInt(match[1]);
            if (ids.includes(advId)) advVoucherMap.set(advId, v.id);
          }
        }

        let vouchersPatched = 0;
        let vouchersCreated = 0;

        for (const adv of advanceRows) {
          const workerName = workerMap.get(adv.workerId) ?? "Worker";
          const amount = toMoney(adv.amount);
          const advDate = adv.advanceDate ?? today;
          const narration = `Advance to ${workerName}: $${amount.toFixed(2)}`;

          if (advVoucherMap.has(adv.id)) {
            // Patch the credit leg of the existing voucher to the new cash account.
            // Phase 22 (B), G4: an open-period edit audited in this transaction;
            // a voucher in a closed period is refused (409, reverse instead).
            const voucherId = advVoucherMap.get(adv.id)!;
            const editContext = await assertVoucherEditableTx(tx, voucherId, { companyId });
            const entries = await tx
              .select({ id: voucherEntries.id, creditAmount: voucherEntries.creditAmount })
              .from(voucherEntries)
              .where(eq(voucherEntries.voucherId, voucherId));

            const creditEntry = entries
              .filter((e) => toMoney(e.creditAmount).gt(0))
              .sort((a, b) => toMoney(b.creditAmount).comparedTo(toMoney(a.creditAmount)))[0];

            if (creditEntry) {
              await tx
                .update(voucherEntries)
                .set({ ledgerAccountId: cashAccountId })
                .where(eq(voucherEntries.id, creditEntry.id));
              await recordVoucherEditAuditTx(tx, {
                voucherId,
                before: editContext.before,
                actor: { userId: req.session.userId, username: req.session.username, companyId },
                reason: "Advance cash account reassigned",
              });
              vouchersPatched++;
            }
          } else {
            // No voucher existed — create one now: DR Factory Worker Advances / CR Cash
            const voucherNumber = `PAYMENT-ADV-${adv.id}-1`;
            await postErpVoucherTx(tx, {
              companyId,
              voucherNumber,
              voucherType: "Payment",
              voucherDate: advDate,
              description: narration,
              currency: "USD",
              sourceModule: "FACTORY",
              lines: [
                { ledgerAccountId: advancesAccountId, debit: amount.toFixed(2), narration: narration },
                { ledgerAccountId: cashAccountId, credit: amount.toFixed(2), narration: narration },
              ],
              source: { type: "worker-advance", id: adv.id },
            });
            vouchersCreated++;
          }

          // Daybook entry for every advance updated
          await writeDaybookEntry(tx, {
            companyId,
            txDate: today,
            txType: "ADVANCE_CASH_UPDATED",
            referenceId: adv.id,
            referenceTable: "factory_worker_advances",
            description: `Cash account assigned for advance to ${workerName}: $${amount.toFixed(2)} → ${acct.name}`,
            amountCurrency: amount.toNumber(),
            amountUsd: amount.toNumber(),
            createdBy: req.session.userId ?? undefined,
          });
        }

        return { updated: advanceRows.length, vouchersPatched, vouchersCreated };
      });

      res.json({
        message: `Updated ${result.updated} advance(s); ${result.vouchersCreated} voucher(s) created, ${result.vouchersPatched} patched`,
        updated: result.updated,
        vouchersCreated: result.vouchersCreated,
        vouchersPatched: result.vouchersPatched,
      });
    } catch (error: unknown) {
      logger.error("Error bulk-updating advance cash accounts:", { error: error });
      if (sendVoucherCorrectionRefusal(res, error)) return;
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // GET /api/factory/workers/:id/advance-balance - Get total outstanding advance balance
  registerWorkerAdvanceBalanceRoute(app);
}
