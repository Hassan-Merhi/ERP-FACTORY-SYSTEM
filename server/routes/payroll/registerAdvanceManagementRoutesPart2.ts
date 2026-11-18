// Extracted from ./advanceManagementRoutes.ts to keep that module under the source-size cap.
import { parseId, parseOptionalId } from "../../lib/parseId";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logAudit } from "../helpers/auditHelpers";
import { retireVouchersForRequestTx } from "../../services/accounting/voucherRetirement";
import { logger } from "../../lib/logger";
import { getClientDate } from "../../lib/dateUtils";
import type { Express, Request, Response } from "express";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { and, eq, sql } from "drizzle-orm";
import { postErpVoucherTx } from "../../services/accounting/erpVoucherPosting";
import {
  factoryAdvanceRepayments,
  factoryWorkerAdvances,
  factoryWorkers,
  ledgerAccounts,
  vouchers,
} from "@shared/schema";
import { toMoney } from "../../lib/money";
import { getFactoryCompanyId, writeDaybookEntry } from "./advanceRouteHelpers";
import { registerUnvoucheredAdvancesRoute } from "./advanceReadRoutes";

export function registerAdvanceManagementRoutesPart2(app: Express) {
  // POST /api/factory/advances/:id/reverse - Reverse a paid advance (restore to outstanding)
  app.post("/api/factory/advances/:id/reverse", requireAuth, async (req: Request, res: Response) => {
    try {
      const currentRole = req.session.currentRole;
      if (currentRole !== "Admin" && currentRole !== "Owner" && currentRole !== "Developer") {
        return res.status(403).json({ message: "Only Admin, Owner, or Developer can reverse advances" });
      }
      const companyId = req.body.companyId || getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });

      const [advance] = await db
        .select()
        .from(factoryWorkerAdvances)
        .where(and(eq(factoryWorkerAdvances.id, id), eq(factoryWorkerAdvances.companyId, companyId)));
      if (!advance) return res.status(404).json({ message: "Advance not found" });

      const [worker] = await db
        .select({ fullName: factoryWorkers.fullName })
        .from(factoryWorkers)
        .where(eq(factoryWorkers.id, advance.workerId));

      const today = getClientDate(req);

      await db.transaction(async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
        // Delete all repayment records for this advance
        const repayments = await tx
          .select()
          .from(factoryAdvanceRepayments)
          .where(eq(factoryAdvanceRepayments.advanceId, id));

        if (repayments.length > 0) {
          // Wave 7: each repayment's receipt voucher (RECEIPT-REPAY-{id}-* /
          // REPAY-SAL-{id}-*) goes with it, so reversing repayments leaves no
          // credit on Factory Worker Advances behind.
          for (const repayment of repayments) {
            const receiptVouchers = await tx
              .select({ id: vouchers.id })
              .from(vouchers)
              .where(
                and(
                  eq(vouchers.companyId, companyId),
                  sql`(${vouchers.voucherNumber} LIKE ${"RECEIPT-REPAY-" + repayment.id + "-%"} OR ${vouchers.voucherNumber} LIKE ${"REPAY-SAL-" + repayment.id + "-%"})`
                )
              );
            const receiptIds = receiptVouchers.map((v) => v.id);
            if (receiptIds.length === 0) continue;
            // Wave 16 (A): retired (soft delete with lines, audited here), not hard-deleted.
            await retireVouchersForRequestTx(tx, req, companyId, receiptIds, "advance-delete-or-reverse");
          }
          await tx.delete(factoryAdvanceRepayments).where(eq(factoryAdvanceRepayments.advanceId, id));
        }

        // Reset advance back to outstanding
        await tx
          .update(factoryWorkerAdvances)
          .set({ fullyPaid: false, remainingBalance: advance.amount })
          .where(eq(factoryWorkerAdvances.id, id));

        await writeDaybookEntry(tx, {
          companyId,
          txDate: today,
          txType: "ADVANCE_REVERSED",
          referenceId: id,
          referenceTable: "factory_worker_advances",
          description: `Advance reversed for ${worker?.fullName || "Unknown"}: $${toMoney(advance.amount).toFixed(2)} restored to outstanding (${repayments.length} repayment(s) removed)`,
          createdBy: req.session.userId ?? undefined,
        });
        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || req.session.userId!,
            companyId,
            action: "update",
            tableName: "factory_worker_advances",
            recordId: id,
            recordIdentifier: `Advance #${id} reversed`,
            changes: {
              remainingBalance: { old: advance.remainingBalance, new: advance.amount },
              repaymentsRemoved: { old: repayments.map((r) => r.id).join(", ") || null, new: null },
            },
          },
          tx
        );
      });

      res.json({ message: "Advance reversed and restored to outstanding" });
    } catch (error: unknown) {
      logger.error("Error reversing advance:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  registerUnvoucheredAdvancesRoute(app);

  app.post("/api/factory/advances/post-accounting", requireAuth, async (req: Request, res: Response) => {
    try {
      const currentRole = req.session.currentRole;
      if (currentRole !== "Admin" && currentRole !== "Owner" && currentRole !== "Developer") {
        return res.status(403).json({ message: "Only Admin or Owner can post accounting" });
      }
      const companyId = req.query.companyId ? parseOptionalId(req.query.companyId) : getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const cashAccountId = req.body.cashAccountId ? parseInt(req.body.cashAccountId) : null;
      if (!cashAccountId) return res.status(400).json({ message: "Cash account is required" });

      const [acct] = await db
        .select({ id: ledgerAccounts.id })
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.id, cashAccountId), eq(ledgerAccounts.companyId, companyId)));
      if (!acct) return res.status(400).json({ message: "Cash account not found for this company" });

      const result = await db.transaction(async (tx) => {
        const allAdvances = await tx
          .select({
            id: factoryWorkerAdvances.id,
            amount: factoryWorkerAdvances.amount,
            advanceDate: factoryWorkerAdvances.advanceDate,
            workerId: factoryWorkerAdvances.workerId,
            cashAccountId: factoryWorkerAdvances.cashAccountId,
            workerName: factoryWorkers.fullName,
          })
          .from(factoryWorkerAdvances)
          .innerJoin(factoryWorkers, eq(factoryWorkerAdvances.workerId, factoryWorkers.id))
          .where(eq(factoryWorkerAdvances.companyId, companyId));

        const existingVouchers = await tx
          .select({ voucherNumber: vouchers.voucherNumber })
          .from(vouchers)
          .where(and(eq(vouchers.companyId, companyId), sql`${vouchers.voucherNumber} LIKE 'PAYMENT-ADV-%'`));
        const alreadyPostedIds = new Set<number>();
        for (const v of existingVouchers) {
          const match = v.voucherNumber.match(/^PAYMENT-ADV-(\d+)-/);
          if (match) alreadyPostedIds.add(parseInt(match[1]));
        }

        const eligible = allAdvances.filter((a) => !alreadyPostedIds.has(a.id) || a.cashAccountId === null);
        const eligibleIds = new Set(eligible.map((a) => a.id));

        if (eligibleIds.size === 0) {
          return { posted: 0, skipped: 0 };
        }

        let [advancesAccount] = await tx
          .select({ id: ledgerAccounts.id })
          .from(ledgerAccounts)
          .where(and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.name, "Factory Worker Advances")));

        if (!advancesAccount) {
          const maxCodeResult = await tx
            .select({ maxCode: sql<number | null>`MAX(CAST(code AS INTEGER))` })
            .from(ledgerAccounts)
            .where(and(eq(ledgerAccounts.companyId, companyId), sql`code ~ '^[0-9]+$'`));
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

        let posted = 0;
        let skipped = 0;
        for (const adv of eligible) {
          if (alreadyPostedIds.has(adv.id)) {
            if (adv.cashAccountId === null) {
              await tx
                .update(factoryWorkerAdvances)
                .set({ cashAccountId: cashAccountId })
                .where(eq(factoryWorkerAdvances.id, adv.id));
            }
            skipped++;
            continue;
          }

          const amount = toMoney(adv.amount);
          const voucherNumber = `PAYMENT-ADV-${adv.id}-1`;
          const narration = `Advance to ${adv.workerName}: $${amount.toFixed(2)} (retroactive)`;

          await postErpVoucherTx(tx, {
            companyId,
            voucherNumber,
            voucherType: "Payment",
            voucherDate: adv.advanceDate,
            description: narration,
            currency: "USD",
            sourceModule: "FACTORY",
            lines: [
              { ledgerAccountId: advancesAccount.id, debit: amount.toFixed(2), narration: narration },
              { ledgerAccountId: cashAccountId, credit: amount.toFixed(2), narration: narration },
            ],
            source: { type: "worker-advance", id: adv.id },
          });

          await tx
            .update(factoryWorkerAdvances)
            .set({ cashAccountId: cashAccountId })
            .where(eq(factoryWorkerAdvances.id, adv.id));

          posted++;
        }

        return { posted, skipped };
      });

      res.json({
        message: `Posted accounting for ${result.posted} advance(s)${result.skipped ? ` (${result.skipped} already posted, skipped)` : ""}`,
        posted: result.posted,
        skipped: result.skipped,
      });
    } catch (error: unknown) {
      logger.error("Error posting advance accounting:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
