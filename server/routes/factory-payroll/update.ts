/**
 * factoryPayrollRoutes: FactoryPayrollUpdate endpoints.
 */
import type { Database } from "../../db";
import type { Express, Request, Response, RequestHandler } from "express";
import { logAudit } from "../helpers/auditHelpers";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { parseId, parseOptionalId } from "../../lib/parseId";
import { getClientDate } from "../../lib/dateUtils";
import { checkFactoryAdmin } from "../factory/_helpers";
import { eq, and, sql, inArray } from "drizzle-orm";
import { rebuildPayrollGenVoucher } from "../payroll/_payrollAccountingHelper";
import {
  getProductionBonusTotalsForPayrollIds,
  prepareProductionBonusesForPayroll,
} from "../../services/payroll/productionBonusPayrollService";
import {
  factoryPayrolls,
  factoryDaybookEntries,
  factoryWorkerAdvances,
  factoryAdvanceRepayments,
  vouchers,
  voucherEntries,
} from "@shared/schema";
import { writeDaybookEntry } from "./_helpers";
import type Decimal from "decimal.js";
import { MoneyDecimal, parseMoneyInput, toMoney } from "../../lib/money";

export function registerFactoryPayrollUpdateRoutes(app: Express, requireAuth: RequestHandler, db: Database) {
  app.patch("/api/factory/payroll/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const {
        bonuses,
        otherBonuses,
        deductions,
        advances,
        overtimeHours,
        overtimePay,
        notes,
        status,
        paymentSource,
        paymentDate,
        paymentReference,
        effectiveDate,
      } = req.body;

      const [existing] = await db
        .select()
        .from(factoryPayrolls)
        .where(and(eq(factoryPayrolls.id, id), eq(factoryPayrolls.companyId, companyId)));
      if (!existing) return res.status(404).json({ message: "Payroll record not found" });

      await prepareProductionBonusesForPayroll(db, id);
      // Preparation may reattach a previously-approved orphan allocation and
      // adjust total bonus/net. Use a fresh row as the adjustment baseline.
      const [current] = await db
        .select()
        .from(factoryPayrolls)
        .where(and(eq(factoryPayrolls.id, id), eq(factoryPayrolls.companyId, companyId)));
      if (!current) return res.status(404).json({ message: "Payroll record not found" });

      const productionTotals = (await getProductionBonusTotalsForPayrollIds(db, [id])).get(id) ?? {
        approved: 0,
        pending: 0,
        rejected: 0,
        totalSuggested: 0,
        pendingCount: 0,
        approvedCount: 0,
        rejectedCount: 0,
      };
      const approvedProductionBonus = productionTotals.approved;

      if ((status === "APPROVED" || status === "PAID") && productionTotals.pendingCount > 0) {
        return res.status(409).json({
          message: `Decide the ${productionTotals.pendingCount} pending production bonus item(s) before approving or paying this payroll.`,
          pendingProductionBonus: productionTotals.pending.toFixed(2),
        });
      }

      const approvedBonusExact = toMoney(approvedProductionBonus);
      let updatedBonuses: Decimal | null;
      if (otherBonuses !== undefined) {
        const parsedOther = parseMoneyInput(otherBonuses);
        if (!parsedOther || parsedOther.lessThan(0)) {
          return res.status(400).json({ message: "Other bonus must be 0 or more" });
        }
        updatedBonuses = approvedBonusExact.plus(parsedOther);
      } else if (bonuses !== undefined) {
        const parsedTotal = parseMoneyInput(bonuses);
        if (!parsedTotal || parsedTotal.lessThan(approvedBonusExact.minus(0.001))) {
          return res.status(400).json({
            message: `Total bonuses cannot be lower than the approved production bonus ($${approvedProductionBonus.toFixed(2)}).`,
          });
        }
        updatedBonuses = parsedTotal;
      } else {
        updatedBonuses = toMoney(current.bonuses);
      }

      // Request values are read the way parseFloat reads them; null marks one
      // that does not parse.
      const oldBonuses = toMoney(current.bonuses);
      const oldDeductions = toMoney(current.deductions);
      const oldAdvances = toMoney(current.advances);
      const oldOvertimePay = toMoney(current.overtimePay);
      const updatedDeductions = deductions !== undefined ? parseMoneyInput(deductions) : oldDeductions;
      const updatedAdvances = advances !== undefined ? parseMoneyInput(advances) : oldAdvances;
      const updatedOvertimeHours =
        overtimeHours !== undefined ? parseMoneyInput(overtimeHours) : toMoney(current.overtimeHours);
      const updatedOvertimePay = overtimePay !== undefined ? parseMoneyInput(overtimePay) : oldOvertimePay;

      if (!updatedBonuses || !updatedDeductions || !updatedAdvances || !updatedOvertimeHours || !updatedOvertimePay) {
        return res.status(400).json({ message: "Payroll numeric values are invalid" });
      }

      const netSalaryExact = toMoney(current.netSalary)
        .plus(updatedBonuses.minus(oldBonuses))
        .minus(updatedDeductions.minus(oldDeductions))
        .minus(updatedAdvances.minus(oldAdvances))
        .plus(updatedOvertimePay.minus(oldOvertimePay))
        .toDecimalPlaces(2, MoneyDecimal.ROUND_HALF_UP);
      const netSalary = netSalaryExact.toNumber();
      const otherBonusExact = MoneyDecimal.max(0, updatedBonuses.minus(approvedBonusExact));

      const updateData: Partial<typeof factoryPayrolls.$inferInsert> = {
        bonuses: updatedBonuses.toFixed(2),
        deductions: updatedDeductions.toFixed(2),
        advances: updatedAdvances.toFixed(2),
        overtimeHours: updatedOvertimeHours.toFixed(2),
        overtimePay: updatedOvertimePay.toFixed(2),
        netSalary: netSalaryExact.toFixed(2),
      };
      if (notes !== undefined) updateData.notes = notes;
      if (status !== undefined) updateData.status = status;
      if (status === "APPROVED") updateData.approvedAt = new Date();

      const [updated] = await db
        .update(factoryPayrolls)
        .set(updateData)
        .where(and(eq(factoryPayrolls.id, id), eq(factoryPayrolls.companyId, companyId)))
        .returning();

      const financialChanged =
        bonuses !== undefined ||
        otherBonuses !== undefined ||
        deductions !== undefined ||
        advances !== undefined ||
        overtimePay !== undefined;
      if (financialChanged) {
        await db.transaction(async (tx) => {
          await rebuildPayrollGenVoucher(tx, current.companyId, current.periodStart, current.periodEnd);
        });
      }

      if (status && status !== current.status) {
        const entryDate = status === "PAID" && paymentDate ? paymentDate : getClientDate(req);
        if (status === "PAID") {
          const source = paymentSource || "Cash";
          const ref = paymentReference ? ` | Ref: ${paymentReference}` : "";
          await writeDaybookEntry(db, {
            companyId: current.companyId,
            txDate: entryDate,
            txType: "PAYROLL_PAYMENT",
            referenceId: id,
            referenceTable: "factory_payrolls",
            description: `Payroll payment via ${source}${ref} — Payroll #${id}`,
            amountCurrency: netSalary,
            amountUsd: netSalary,
            metaJson: JSON.stringify({ paymentSource: source, paymentReference: paymentReference || null }),
            effectiveDate: (effectiveDate as string) || null,
          });
        } else {
          await writeDaybookEntry(db, {
            companyId: current.companyId,
            txDate: entryDate,
            txType: "PAYROLL_STATUS_CHANGE",
            referenceId: id,
            referenceTable: "factory_payrolls",
            description: `Payroll #${id} status changed from ${current.status} to ${status}`,
            amountCurrency: netSalary,
            amountUsd: netSalary,
          });
        }
      }

      try {
        await logAudit({
          userId: req.session.userId!,
          username: req.session.username || req.session.userId!,
          companyId: current.companyId,
          action: "update",
          tableName: "factory_payrolls",
          recordId: id,
          recordIdentifier: `Payroll #${id} (Worker #${current.workerId})`,
          changes: {
            ...(bonuses !== undefined || otherBonuses !== undefined
              ? {
                  bonuses: { old: current.bonuses ?? null, new: updatedBonuses.toFixed(2) },
                  productionBonus: { old: null, new: approvedBonusExact.toFixed(2) },
                  otherBonus: { old: null, new: otherBonusExact.toFixed(2) },
                }
              : {}),
            ...(deductions !== undefined
              ? { deductions: { old: current.deductions ?? null, new: updatedDeductions.toFixed(2) } }
              : {}),
            ...(status !== undefined && status !== current.status
              ? { status: { old: current.status, new: status } }
              : {}),
            ...(notes !== undefined ? { notes: { old: current.notes ?? null, new: notes } } : {}),
          },
        });
      } catch (auditErr) {
        logger.error("[payroll update audit] non-fatal", { error: auditErr });
      }

      res.json({
        ...updated,
        productionBonus: approvedBonusExact.toFixed(2),
        pendingProductionBonus: productionTotals.pending.toFixed(2),
        otherBonuses: otherBonusExact.toFixed(2),
      });
    } catch (error: unknown) {
      logger.error("Error updating payroll", { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/factory/payroll/:id/undo", requireAuth, async (req: Request, res: Response) => {
    try {
      if (!checkFactoryAdmin(req, res)) return;
      const companyId = req.query.companyId
        ? parseOptionalId(req.query.companyId)
        : req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const [existing] = await db
        .select()
        .from(factoryPayrolls)
        .where(and(eq(factoryPayrolls.id, id), eq(factoryPayrolls.companyId, companyId)));
      if (!existing) return res.status(404).json({ message: "Payroll record not found" });

      await db.transaction(async (tx) => {
        // Advance deductions belong to payroll generation, not payment. A paid
        // undo keeps the generated payroll as DRAFT, so its repayments must stay
        // applied. Restore them only when the generated payroll itself is removed.
        if (existing.status !== "PAID") {
          if (toMoney(existing.advances).greaterThan(0)) {
            const repayments = await tx
              .select()
              .from(factoryAdvanceRepayments)
              .where(
                and(
                  eq(factoryAdvanceRepayments.companyId, companyId),
                  eq(factoryAdvanceRepayments.workerId, existing.workerId),
                  eq(factoryAdvanceRepayments.payrollId, id)
                )
              );
            for (const repayment of repayments) {
              const [advance] = await tx
                .select()
                .from(factoryWorkerAdvances)
                .where(eq(factoryWorkerAdvances.id, repayment.advanceId));
              if (!advance) continue;
              const restoredBalance = toMoney(advance.remainingBalance).plus(toMoney(repayment.amount));
              await tx
                .update(factoryWorkerAdvances)
                .set({ remainingBalance: restoredBalance.toFixed(2), fullyPaid: false })
                .where(eq(factoryWorkerAdvances.id, advance.id));
            }
            await tx.delete(factoryAdvanceRepayments).where(eq(factoryAdvanceRepayments.payrollId, id));
          }
        }

        if (existing.status === "PAID") {
          // Payment reversal keeps the generated DRAFT. Remove payment/status
          // history but preserve the authoritative PAYROLL_GENERATED evidence.
          await tx
            .delete(factoryDaybookEntries)
            .where(
              and(
                eq(factoryDaybookEntries.companyId, companyId),
                eq(factoryDaybookEntries.referenceId, id),
                eq(factoryDaybookEntries.referenceTable, "factory_payrolls"),
                sql`${factoryDaybookEntries.txType} <> 'PAYROLL_GENERATED'`
              )
            );
        } else {
          await tx
            .delete(factoryDaybookEntries)
            .where(
              and(
                eq(factoryDaybookEntries.companyId, companyId),
                eq(factoryDaybookEntries.referenceId, id),
                eq(factoryDaybookEntries.referenceTable, "factory_payrolls")
              )
            );
        }

        const paymentVouchers = await tx
          .select({ id: vouchers.id })
          .from(vouchers)
          .where(
            and(eq(vouchers.companyId, companyId), sql`${vouchers.voucherNumber} LIKE ${"PAYMENT-PAY-" + id + "-%"}`)
          );
        if (paymentVouchers.length > 0) {
          const voucherIds = paymentVouchers.map((voucher) => voucher.id);
          await tx.delete(voucherEntries).where(inArray(voucherEntries.voucherId, voucherIds));
          await tx.delete(vouchers).where(inArray(vouchers.id, voucherIds));
        }

        // production-bonus allocation payroll_id is ON DELETE SET NULL. Decisions
        // survive a deleted draft and are reattached once if this period is regenerated.
        if (existing.status === "PAID") {
          await tx
            .update(factoryPayrolls)
            .set({
              // Payment reversal returns the generated run to an unpaid draft.
              // Clear the selected payment account together with paid/approval state.
              status: "DRAFT",
              paidAt: null,
              approvedAt: null,
              cashAccountId: null,
            })
            .where(eq(factoryPayrolls.id, id));
          await rebuildPayrollGenVoucher(tx, companyId, existing.periodStart, existing.periodEnd);
        } else {
          await rebuildPayrollGenVoucher(tx, companyId, existing.periodStart, existing.periodEnd, id);
          await tx.delete(factoryPayrolls).where(eq(factoryPayrolls.id, id));
        }
      });

      res.json({ message: "Payroll undone successfully", previousStatus: existing.status });
    } catch (error: unknown) {
      logger.error("Error undoing payroll", { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
