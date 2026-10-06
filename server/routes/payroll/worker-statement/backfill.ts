/**
 * workerStatementRoutes: PayrollVoucherBackfill endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { getClientDate } from "../../../lib/dateUtils";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { eq, and, sql, inArray, isNotNull } from "drizzle-orm";
import { factoryWorkers, factoryPayrolls, ledgerAccounts, vouchers, voucherEntries } from "@shared/schema";

import { getFactoryCompanyId } from "./_helpers";

export function registerPayrollVoucherBackfillRoutes(app: Express) {
  app.post("/api/admin/backfill-payroll-vouchers", requireAuth, async (req: Request, res: Response) => {
    try {
      const currentRole = req.session.currentRole;
      if (currentRole !== "Admin" && currentRole !== "Owner" && currentRole !== "Developer") {
        return res.status(403).json({ message: "Only Admin or Owner can run backfill" });
      }

      const companyId = req.body.companyId || getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const paidPayrolls = await db
        .select({
          id: factoryPayrolls.id,
          companyId: factoryPayrolls.companyId,
          workerId: factoryPayrolls.workerId,
          netSalary: factoryPayrolls.netSalary,
          cashAccountId: factoryPayrolls.cashAccountId,
          periodStart: factoryPayrolls.periodStart,
          periodEnd: factoryPayrolls.periodEnd,
          paidAt: factoryPayrolls.paidAt,
        })
        .from(factoryPayrolls)
        .where(
          and(
            eq(factoryPayrolls.companyId, companyId),
            eq(factoryPayrolls.status, "PAID"),
            isNotNull(factoryPayrolls.cashAccountId)
          )
        );

      const existingVouchers = await db
        .select({
          voucherNumber: vouchers.voucherNumber,
        })
        .from(vouchers)
        .where(
          and(
            eq(vouchers.sourceModule, "FACTORY"),
            eq(vouchers.voucherType, "Payment"),
            sql`${vouchers.voucherNumber} LIKE 'PAYMENT-PAY-%'`
          )
        );

      const existingPayrollIds = new Set(
        existingVouchers
          .map((v) => {
            const parts = v.voucherNumber.split("-");
            return parseInt(parts[2]);
          })
          .filter((id: number) => !isNaN(id))
      );

      const toBackfill = paidPayrolls.filter((p) => {
        const net = parseFloat(p.netSalary || "0");
        return net > 0 && !existingPayrollIds.has(p.id);
      });

      const skipped = paidPayrolls
        .filter((p) => {
          const net = parseFloat(p.netSalary || "0");
          return net <= 0 || existingPayrollIds.has(p.id);
        })
        .map((p) => p.id);

      if (toBackfill.length === 0) {
        return res.json({ message: "No payrolls need backfill", found: paidPayrolls.length, backfilled: 0, skipped });
      }

      const companyIds = [...new Set(toBackfill.map((p) => p.companyId))];
      const workerIds = [...new Set(toBackfill.map((p) => p.workerId))];

      const workerRows = await db
        .select({ id: factoryWorkers.id, fullName: factoryWorkers.fullName })
        .from(factoryWorkers)
        .where(inArray(factoryWorkers.id, workerIds));
      const workerMap = new Map(workerRows.map((w) => [w.id, w.fullName]));

      const backfilledIds: number[] = [];

      await db.transaction(async (tx) => {
        const payrollAccountCache = new Map<number, number>();

        for (const cid of companyIds) {
          let [found] = await tx
            .select({ id: ledgerAccounts.id })
            .from(ledgerAccounts)
            .where(and(eq(ledgerAccounts.companyId, cid), eq(ledgerAccounts.name, "Factory Worker Payroll")));

          if (!found) {
            const [maxCode] = await tx
              .select({ maxCode: sql<number | null>`MAX(CAST(code AS INTEGER))` })
              .from(ledgerAccounts)
              .where(and(eq(ledgerAccounts.companyId, cid), sql`code ~ '^[0-9]+$'`));
            const nextCode = String((maxCode?.maxCode ?? 0) + 1);
            [found] = await tx
              .insert(ledgerAccounts)
              .values({
                companyId: cid,
                code: nextCode,
                name: "Factory Worker Payroll",
                accountType: "Expense",
                active: true,
                isHidden: false,
              })
              .returning();
          }
          payrollAccountCache.set(cid, found.id);
        }

        for (const pr of toBackfill) {
          const netAmt = parseFloat(pr.netSalary || "0");
          const cashAcctId = pr.cashAccountId!;
          const payrollAcctId = payrollAccountCache.get(pr.companyId)!;
          const workerName = ((workerMap.get(pr.workerId) as string) || "").trim() || `Worker #${pr.workerId}`;
          const narration = `Payroll backfill: ${workerName} (${pr.periodStart} – ${pr.periodEnd})`;
          const voucherDate = pr.paidAt ? new Date(pr.paidAt).toISOString().split("T")[0] : getClientDate(req);

          const [pVoucher] = await tx
            .insert(vouchers)
            .values({
              companyId: pr.companyId,
              voucherNumber: `PAYMENT-PAY-${pr.id}-${Date.now()}`,
              voucherType: "Payment",
              voucherDate,
              description: narration,
              totalAmount: netAmt.toFixed(2),
              currency: "USD",
              sourceModule: "FACTORY",
            })
            .returning();

          await tx.insert(voucherEntries).values([
            {
              voucherId: pVoucher.id,
              ledgerAccountId: payrollAcctId,
              debitAmount: netAmt.toFixed(2),
              creditAmount: "0",
              narration,
            },
            {
              voucherId: pVoucher.id,
              ledgerAccountId: cashAcctId,
              debitAmount: "0",
              creditAmount: netAmt.toFixed(2),
              narration,
            },
          ]);

          backfilledIds.push(pr.id);
        }
      });

      res.json({
        message: `Backfilled ${backfilledIds.length} payroll(s)`,
        found: paidPayrolls.length,
        backfilled: backfilledIds.length,
        backfilledPayrollIds: backfilledIds,
        skippedPayrollIds: skipped,
      });
    } catch (error: unknown) {
      logger.error("Error backfilling payroll vouchers:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
