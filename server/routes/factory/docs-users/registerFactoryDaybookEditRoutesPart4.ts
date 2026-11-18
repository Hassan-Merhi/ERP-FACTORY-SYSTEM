// Extracted from ./daybookEditRoutes.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import { getClientDate } from "../../../lib/dateUtils";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { resultRows } from "../../../lib/queryResult";
import { requireAuth } from "../../../auth";
import { writeDaybookEntry } from "../_helpers";
import {
  accountingPostingRequests,
  employees,
  factoryAdvanceRepayments,
  factoryDaybookEntries,
  factoryPayrolls,
  factoryWorkerAdvances,
  voucherEntries,
  vouchers,
} from "@shared/schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type Decimal from "decimal.js";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { retireVouchersTx, sessionRetirementActor } from "../../../services/accounting/voucherRetirement";
import { cancelFxAgentSettlementVoucherTx } from "../../../services/factory/fxAgentSettlementCancellation";
import { EMPLOYEE_CASH_POSTING_SOURCE_TYPES, reverseBonusFromDaybook, voucherFxRate } from "./daybookEditPolicy";

export function registerFactoryDaybookEditRoutesPart4(app: Express) {
  // DELETE /api/factory/daybook/entry/:id/void — Void a voucher-backed daybook entry
  app.delete("/api/factory/daybook/entry/:id/void", requireAuth, async (req: Request, res: Response) => {
    try {
      const session = req.session;
      const companyId = session.factoryCompanyId || session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const role = (session.currentRole || session.role || "").toLowerCase();
      if (role !== "admin" && role !== "owner" && role !== "developer") {
        return res.status(403).json({ message: "Only Admin or Owner can void vouchers" });
      }

      const rawId = Number(req.params.id);
      if (isNaN(rawId)) return res.status(400).json({ message: "Invalid entry ID" });

      let voucherId: number;
      let daybookEntryId: number | null = null;

      if (rawId < 0) {
        voucherId = Math.abs(rawId);
      } else {
        const [entry] = await db
          .select()
          .from(factoryDaybookEntries)
          .where(and(eq(factoryDaybookEntries.id, rawId), eq(factoryDaybookEntries.companyId, companyId)));
        if (!entry) return res.status(404).json({ message: "Daybook entry not found" });
        if (entry.referenceTable !== "vouchers" || !entry.referenceId) {
          return res.status(400).json({ message: "This entry is not voucher-backed and cannot be voided" });
        }
        voucherId = entry.referenceId;
        daybookEntryId = entry.id;
      }

      const [voucher] = await db
        .select()
        .from(vouchers)
        .where(and(eq(vouchers.id, voucherId), eq(vouchers.companyId, companyId), sql`${vouchers.deletedAt} IS NULL`));
      if (!voucher) return res.status(404).json({ message: "Voucher not found or already voided" });

      if (!["Payment", "Receipt", "Journal"].includes(voucher.voucherType)) {
        return res.status(400).json({ message: `Cannot void ${voucher.voucherType} vouchers from the daybook` });
      }

      // A synthetic voucher row can also represent a bonus payment. Its
      // generic retirement would strand a POSTED bonus claim. Intercept it here.
      const bonusVoucher = resultRows(
        await db.execute(sql`
        SELECT id, 'daily' AS kind, payment_voucher_id AS "paymentVoucherId",
               reversal_voucher_id AS "reversalVoucherId"
        FROM factory_target_bonus_payments
        WHERE company_id = ${companyId}
          AND (payment_voucher_id = ${voucherId} OR reversal_voucher_id = ${voucherId})
        UNION ALL
        SELECT id, 'weekly' AS kind, payment_voucher_id AS "paymentVoucherId",
               reversal_voucher_id AS "reversalVoucherId"
        FROM factory_target_bonus_weekly_payments
        WHERE company_id = ${companyId}
          AND (payment_voucher_id = ${voucherId} OR reversal_voucher_id = ${voucherId})
        LIMIT 1
      `)
      ) as unknown as Array<{
        id: number;
        kind: "daily" | "weekly";
        paymentVoucherId: number;
        reversalVoucherId: number | null;
      }>;
      if (bonusVoucher.length) {
        if (role !== "admin" && role !== "owner")
          return res.status(403).json({ message: "Only Admin or Owner can reverse bonuses" });
        const claimed = bonusVoucher[0];
        if (Number(claimed.reversalVoucherId) === voucherId)
          return res
            .status(409)
            .json({ message: "This is an accounting reversal voucher and must remain in audit history" });
        const result = await reverseBonusFromDaybook(req, Number(companyId), {
          kind: claimed.kind,
          id: Number(claimed.id),
        });
        return res.json({ success: true, retainedAudit: true, ...result });
      }
      const vNum = voucher.voucherNumber || "";
      const voucherTxTypeMap: Record<string, string> = { Payment: "PAYMENT", Receipt: "RECEIPT", Journal: "JOURNAL" };
      const txTypeVal = voucherTxTypeMap[voucher.voucherType] || "JOURNAL";
      const today = getClientDate(req);

      let fxPaymentCancelled = false;
      await db.transaction(async (tx) => {
        // Cancel the linked native EUR payout and USD voucher together. A generic
        // voucher retirement alone would strand the wallet movement.
        fxPaymentCancelled = await cancelFxAgentSettlementVoucherTx({
          tx,
          companyId,
          voucherId,
          actor: sessionRetirementActor(req),
          asOfDate: today,
        });
        if (fxPaymentCancelled) return;

        // 0. Read employee-linked entries BEFORE deletion so we can reverse balances
        const empEntries = await tx
          .select()
          .from(voucherEntries)
          .where(and(eq(voucherEntries.voucherId, voucherId), sql`${voucherEntries.employeeId} IS NOT NULL`));
        // Phase 22 (C) engine-numbers the employee deposit / withdrawal / bulk
        // payroll vouchers (they were EMP-DEP- / EMP-WD- / EMP-PAY-{Date.now()}),
        // so they are recognised by their posting identity as well as by the
        // legacy number (read before the retirement renames the identity key).
        const [employeeCashPosting] = await tx
          .select({ sourceType: accountingPostingRequests.sourceType })
          .from(accountingPostingRequests)
          .where(
            and(
              eq(accountingPostingRequests.companyId, companyId),
              eq(accountingPostingRequests.voucherId, voucherId),
              inArray(accountingPostingRequests.sourceType, EMPLOYEE_CASH_POSTING_SOURCE_TYPES)
            )
          )
          .limit(1);

        // 1-2. Retire the voucher (phase 19 A, G3): soft-deleted with its lines
        // kept, number given up, posting identity released, one audit row with
        // the header and every line, in this transaction. It hard-deleted the
        // lines before soft-deleting the voucher, so the history was lost.
        await retireVouchersTx(tx, {
          companyId,
          voucherIds: [voucherId],
          reason: "factory-daybook-void",
          actor: sessionRetirementActor(req),
        });

        // 3. Delete the real daybook entry if it exists
        if (daybookEntryId) {
          await tx.delete(factoryDaybookEntries).where(eq(factoryDaybookEntries.id, daybookEntryId));
        }

        // 4. Cascade effects based on voucher number pattern
        const advPayMatch = vNum.match(/^PAYMENT-ADV-(\d+)-/);
        const payPayMatch = vNum.match(/^PAYMENT-PAY-(\d+)-/);
        const repayMatch = vNum.match(/^RECEIPT-REPAY-(\d+)-/);

        if (advPayMatch) {
          const advanceId = parseInt(advPayMatch[1]);
          await tx
            .update(factoryWorkerAdvances)
            .set({ cashAccountId: null })
            .where(and(eq(factoryWorkerAdvances.id, advanceId), eq(factoryWorkerAdvances.companyId, companyId)));
        } else if (payPayMatch) {
          const payrollId = parseInt(payPayMatch[1]);
          const [payroll] = await tx
            .select()
            .from(factoryPayrolls)
            .where(and(eq(factoryPayrolls.id, payrollId), eq(factoryPayrolls.companyId, companyId)));

          await tx
            .update(factoryPayrolls)
            .set({ status: "DRAFT", cashAccountId: null, paidAt: null })
            .where(and(eq(factoryPayrolls.id, payrollId), eq(factoryPayrolls.companyId, companyId)));

          if (payroll) {
            const advAmt = toMoney(payroll.advances);
            if (advAmt.greaterThan(0)) {
              const workerAdvances = await tx
                .select()
                .from(factoryWorkerAdvances)
                .where(
                  and(
                    eq(factoryWorkerAdvances.companyId, companyId),
                    eq(factoryWorkerAdvances.workerId, payroll.workerId),
                    eq(factoryWorkerAdvances.repaymentType, "salary_deduction")
                  )
                )
                .orderBy(desc(factoryWorkerAdvances.advanceDate));

              let toRestore = advAmt;
              for (const adv of workerAdvances) {
                if (toRestore.lessThanOrEqualTo(0)) break;
                const bal = toMoney(adv.remainingBalance);
                const room = toMoney(adv.amount).minus(bal);
                if (room.lessThanOrEqualTo(0)) continue;
                const restoreAmt = MoneyDecimal.min(room, toRestore);
                const newBal = bal.plus(restoreAmt);
                await tx
                  .update(factoryWorkerAdvances)
                  .set({
                    remainingBalance: newBal.toFixed(2),
                    fullyPaid: false,
                  })
                  .where(eq(factoryWorkerAdvances.id, adv.id));
                toRestore = toRestore.minus(restoreAmt);
              }
            }
          }
        } else if (repayMatch) {
          const repaymentId = parseInt(repayMatch[1]);
          const [repayment] = await tx
            .select()
            .from(factoryAdvanceRepayments)
            .where(
              and(eq(factoryAdvanceRepayments.id, repaymentId), eq(factoryAdvanceRepayments.companyId, companyId))
            );
          if (repayment) {
            const [advance] = await tx
              .select()
              .from(factoryWorkerAdvances)
              .where(
                and(eq(factoryWorkerAdvances.id, repayment.advanceId), eq(factoryWorkerAdvances.companyId, companyId))
              );
            if (advance) {
              const newBalance = toMoney(advance.remainingBalance).plus(toMoney(repayment.amount));
              await tx
                .update(factoryWorkerAdvances)
                .set({
                  remainingBalance: newBalance.toFixed(2),
                  fullyPaid: false,
                })
                .where(eq(factoryWorkerAdvances.id, advance.id));
            }
            await tx.delete(factoryAdvanceRepayments).where(eq(factoryAdvanceRepayments.id, repaymentId));
          }
        }

        // 4b. Reverse employee balance/deposit/withdrawal for EMP-DEP, EMP-WD, EMP-PAY vouchers
        if (
          empEntries.length > 0 &&
          (Boolean(employeeCashPosting) ||
            vNum.startsWith("EMP-DEP-") ||
            vNum.startsWith("EMP-WD-") ||
            vNum.startsWith("EMP-PAY-"))
        ) {
          // Group deltas by employeeId
          const empDeltas = new Map<number, { creditTotal: Decimal; debitTotal: Decimal }>();
          for (const entry of empEntries) {
            const empId = entry.employeeId as number;
            const d = empDeltas.get(empId) ?? { creditTotal: new MoneyDecimal(0), debitTotal: new MoneyDecimal(0) };
            d.creditTotal = d.creditTotal.plus(toMoney(entry.creditAmount));
            d.debitTotal = d.debitTotal.plus(toMoney(entry.debitAmount));
            empDeltas.set(empId, d);
          }
          for (const [empId, delta] of empDeltas) {
            const [emp] = await tx
              .select()
              .from(employees)
              .where(and(eq(employees.id, empId), eq(employees.companyId, companyId)));
            if (!emp) continue;
            // CR entries = deposits (balance went up) → reverse: subtract
            // DR entries = withdrawals/deductions (balance went down) → reverse: add back
            const newBal = toMoney(emp.currentBalance).minus(delta.creditTotal).plus(delta.debitTotal);
            const newDep = MoneyDecimal.max(0, toMoney(emp.totalDeposits).minus(delta.creditTotal));
            const newWith = MoneyDecimal.max(0, toMoney(emp.totalWithdrawals).minus(delta.debitTotal));
            await tx
              .update(employees)
              .set({
                currentBalance: newBal.toFixed(2),
                totalDeposits: newDep.toFixed(2),
                ...(delta.debitTotal.greaterThan(0) ? { totalWithdrawals: newWith.toFixed(2) } : {}),
              })
              .where(eq(employees.id, empId));
          }
        }

        // 5. Write a VOIDED audit daybook entry (no voucher reference so it won't be filtered by soft-delete logic)
        const voidTxType = `${txTypeVal}_VOIDED`;
        const amt = toMoney(voucher.totalAmount);
        const currency = voucher.currency || "USD";
        const fxRate = voucherFxRate(voucher.exchangeRate);
        const amtUsd = currency === "USD" ? amt : amt.times(fxRate);
        await writeDaybookEntry(tx, {
          companyId,
          txDate: today,
          txType: voidTxType,
          description: `VOIDED: ${voucher.description || voucher.voucherNumber} (voucher #${voucherId})`,
          currencyCode: currency,
          amountCurrency: amt.toNumber(),
          fxRateToUsd: fxRate.toNumber(),
          amountUsd: amtUsd.toNumber(),
          createdBy: session.userId || undefined,
        });
      });

      res.json({
        message: fxPaymentCancelled ? "FX payment deleted and EUR restored" : "Voucher voided successfully",
        voucherId,
        fxPaymentCancelled,
      });
    } catch (error: unknown) {
      logger.error("Error voiding voucher:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
