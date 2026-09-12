/**
 * payrollCoreRoutes: PayrollMarkPaid endpoints.
 *
 * Production-bonus proposals must be decided before any single/bulk payment
 * route can move payroll to PAID.
 */
import type { Express, Request, Response } from "express";
import { parseId, parseOptionalId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { getClientDate } from "../../../lib/dateUtils";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { eq, and, gte, lte, inArray } from "drizzle-orm";
import {
  factoryWorkers,
  factoryPayrolls,
  factoryAttendance,
  ledgerAccounts,
  vouchers,
  voucherEntries,
} from "@shared/schema";
import { findOrCreateLedger, getFactoryCompanyId, normUsd, writeDaybookEntry } from "./_helpers";
import {
  getProductionBonusTotalsForPayrollIds,
  prepareProductionBonusesForPayroll,
} from "../../../services/payroll/productionBonusPayrollService";
import {
  financialOperationErrorStatus,
  financialOperationRequestPayload,
  resolveFinancialOperationKey,
} from "../../../services/accounting/financialOperationRequest";
import {
  financialOperationFingerprint,
  withDurableFinancialOperation,
} from "../../../services/accounting/durableFinancialOperation";

async function ensureNoPendingProductionBonuses(companyId: number, payrollIds: number[]) {
  if (payrollIds.length === 0) return { ok: true as const };
  const scoped = await db
    .select({ id: factoryPayrolls.id, status: factoryPayrolls.status })
    .from(factoryPayrolls)
    .where(and(eq(factoryPayrolls.companyId, companyId), inArray(factoryPayrolls.id, payrollIds)));
  if (scoped.length !== new Set(payrollIds).size)
    return { ok: false as const, status: 404, message: "One or more payroll records were not found" };

  for (const payroll of scoped) {
    if (payroll.status === "DRAFT") await prepareProductionBonusesForPayroll(db, payroll.id);
  }
  const totals = await getProductionBonusTotalsForPayrollIds(
    db,
    scoped.map((payroll) => payroll.id)
  );
  const pending = scoped
    .map((payroll) => ({ payrollId: payroll.id, totals: totals.get(payroll.id) }))
    .filter((row) => (row.totals?.pendingCount ?? 0) > 0);
  if (pending.length > 0) {
    const pendingAmount = pending.reduce((sum, row) => sum + (row.totals?.pending ?? 0), 0);
    return {
      ok: false as const,
      status: 409,
      message: `Decide pending production bonuses before paying payroll (${pending.length} payroll record${pending.length === 1 ? "" : "s"}, $${pendingAmount.toFixed(2)} pending).`,
      payrollIds: pending.map((row) => row.payrollId),
    };
  }
  return { ok: true as const };
}

export function registerPayrollMarkPaidRoutes(app: Express) {
  app.get("/api/factory/payrolls/:id/detail", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.query.companyId ? parseOptionalId(req.query.companyId) : getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });

      const [payroll] = await db
        .select()
        .from(factoryPayrolls)
        .where(and(eq(factoryPayrolls.id, id), eq(factoryPayrolls.companyId, companyId)));
      if (!payroll) return res.status(404).json({ message: "Payroll not found" });

      const attendanceRows = await db
        .select()
        .from(factoryAttendance)
        .where(
          and(
            eq(factoryAttendance.companyId, companyId),
            eq(factoryAttendance.workerId, payroll.workerId),
            gte(factoryAttendance.attendanceDate, payroll.periodStart),
            lte(factoryAttendance.attendanceDate, payroll.periodEnd)
          )
        )
        .orderBy(factoryAttendance.attendanceDate);

      res.json({ payroll, attendance: attendanceRows });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.patch("/api/factory/payrolls/:id/mark-paid", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.body.companyId || getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const cashAccountId = req.body.cashAccountId ? parseInt(req.body.cashAccountId) : null;
      const paymentDate = req.body.paymentDate || getClientDate(req);

      const pendingGuard = await ensureNoPendingProductionBonuses(Number(companyId), [id]);
      if (!pendingGuard.ok) return res.status(pendingGuard.status).json(pendingGuard);

      const payableAccSingle = cashAccountId
        ? await findOrCreateLedger(companyId, "Payroll Payable", "Liability")
        : null;

       const operationKey = resolveFinancialOperationKey(req);
       const operation = await withDurableFinancialOperation(
         {
           companyId: Number(companyId),
           operationName: "factory.payroll.mark-paid",
           idempotencyKey: operationKey,
           requestFingerprint: financialOperationFingerprint({
             method: req.method,
             path: req.path,
             companyId: Number(companyId),
             body: financialOperationRequestPayload(req.body),
             payrollId: id,
           }),
         },
         async (tx) => {
        const [payroll] = await tx
          .update(factoryPayrolls)
          .set({ status: "PAID", paidAt: new Date(paymentDate), cashAccountId })
          .where(and(eq(factoryPayrolls.id, id), eq(factoryPayrolls.companyId, companyId)))
          .returning();
        if (!payroll) throw new Error("Payroll record not found");

        const [prWorker] = await tx
          .select({ fullName: factoryWorkers.fullName })
          .from(factoryWorkers)
          .where(eq(factoryWorkers.id, payroll.workerId));
        const workerName = prWorker?.fullName?.trim() || `Worker #${payroll.workerId}`;
        const prToday = paymentDate;

        if (cashAccountId) {
          const payableAcc = payableAccSingle!;
          const netAmt = parseFloat(payroll.netSalary || "0");
          const narration = `Payroll payment: ${workerName} (${payroll.periodStart} – ${payroll.periodEnd})`;
          const [pVoucher] = await tx
            .insert(vouchers)
            .values({
              companyId,
              voucherNumber: `PAYMENT-PAY-${payroll.id}-${Date.now()}`,
              voucherType: "Payment",
              voucherDate: prToday,
              description: narration,
              totalAmount: netAmt.toFixed(2),
              currency: "USD",
              sourceModule: "FACTORY",
            })
            .returning();
          if (netAmt > 0) {
            await tx.insert(voucherEntries).values([
              { voucherId: pVoucher.id, ledgerAccountId: payableAcc.id, ...normUsd(netAmt.toFixed(2), "0"), narration },
              { voucherId: pVoucher.id, ledgerAccountId: cashAccountId, ...normUsd("0", netAmt.toFixed(2)), narration },
            ]);
          }
        }

        await writeDaybookEntry(tx, {
          companyId,
          txDate: prToday,
          txType: "PAYROLL_PAYMENT",
          referenceId: payroll.id,
          referenceTable: "factory_payrolls",
          description: `Payroll paid: ${workerName} – ${parseFloat(payroll.netSalary || "0").toFixed(2)} (${payroll.periodStart} – ${payroll.periodEnd})`,
          amountCurrency: parseFloat(payroll.netSalary || "0"),
          amountUsd: parseFloat(payroll.netSalary || "0"),
        });
         return { value: payroll, resultReference: payroll.id };
       });

       res.json(operation.value);
    } catch (error: unknown) {
      if (getErrorMessage(error) === "Payroll record not found")
        return res.status(404).json({ message: getErrorMessage(error) });
       const status = financialOperationErrorStatus(error);
       res.status(status).json({ message: getErrorMessage(error) });
    }
  });

  app.patch("/api/factory/payrolls/:id/fix-accounting", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.body.companyId || getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const cashAccountId = req.body.cashAccountId ? parseInt(req.body.cashAccountId) : null;
      if (!cashAccountId) return res.status(400).json({ message: "cashAccountId is required" });

      const [payroll] = await db
        .select()
        .from(factoryPayrolls)
        .where(and(eq(factoryPayrolls.id, id), eq(factoryPayrolls.companyId, companyId)));
      if (!payroll) return res.status(404).json({ message: "Payroll not found" });
      if (!["PAID", "APPROVED"].includes(payroll.status))
        return res.status(400).json({ message: "Payroll must be in PAID or APPROVED status" });
      if (payroll.cashAccountId)
        return res.status(400).json({ message: "Accounting entry already exists for this payroll" });

      const [cashAcc] = await db
        .select()
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.id, cashAccountId), eq(ledgerAccounts.companyId, companyId)));
      if (!cashAcc) return res.status(400).json({ message: "Cash account not found" });

      const payableAcc = await findOrCreateLedger(companyId, "Payroll Payable", "Liability");
      const [prWorker] = await db
        .select({ fullName: factoryWorkers.fullName })
        .from(factoryWorkers)
        .where(eq(factoryWorkers.id, payroll.workerId));
      const workerName = prWorker?.fullName?.trim() || `Worker #${payroll.workerId}`;
      const paidDate = payroll.paidAt ? new Date(payroll.paidAt).toISOString().split("T")[0] : getClientDate(req);
      const netAmt = parseFloat(payroll.netSalary || "0");
      const narration = `Payroll payment (backdated): ${workerName} (${payroll.periodStart} – ${payroll.periodEnd})`;

      const [pVoucher] = await db
        .insert(vouchers)
        .values({
          companyId,
          voucherNumber: `PAYMENT-PAY-${payroll.id}-${Date.now()}`,
          voucherType: "Payment",
          voucherDate: paidDate,
          description: narration,
          totalAmount: netAmt.toFixed(2),
          currency: "USD",
          sourceModule: "FACTORY",
        })
        .returning();
      if (netAmt > 0) {
        await db.insert(voucherEntries).values([
          { voucherId: pVoucher.id, ledgerAccountId: payableAcc.id, ...normUsd(netAmt.toFixed(2), "0"), narration },
          { voucherId: pVoucher.id, ledgerAccountId: cashAccountId, ...normUsd("0", netAmt.toFixed(2)), narration },
        ]);
      }
      await db.update(factoryPayrolls).set({ cashAccountId }).where(eq(factoryPayrolls.id, id));
      res.json({ message: "Accounting entry generated", voucherId: pVoucher.id });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/factory/payrolls/mark-paid-bulk", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.body.companyId || getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { payrollIds, cashAccountId } = req.body;
      if (!payrollIds?.length) return res.status(400).json({ message: "payrollIds required" });
      const normalizedIds = [
        ...new Set((payrollIds as unknown[]).map(Number).filter((id) => Number.isInteger(id) && id > 0)),
      ];
      if (normalizedIds.length === 0) return res.status(400).json({ message: "Valid payrollIds required" });
      const cashId = cashAccountId ? parseInt(cashAccountId) : null;
      const bulkPrToday = req.body.paymentDate || getClientDate(req);

      const pendingGuard = await ensureNoPendingProductionBonuses(Number(companyId), normalizedIds);
      if (!pendingGuard.ok) return res.status(pendingGuard.status).json(pendingGuard);

      const payableAccBulk = cashId ? await findOrCreateLedger(companyId, "Payroll Payable", "Liability") : null;
       const operationKey = resolveFinancialOperationKey(req);
       const operation = await withDurableFinancialOperation(
         {
           companyId: Number(companyId),
           operationName: "factory.payroll.mark-paid-bulk",
           idempotencyKey: operationKey,
           requestFingerprint: financialOperationFingerprint({
             method: req.method,
             path: req.path,
             companyId: Number(companyId),
             body: financialOperationRequestPayload(req.body),
             payrollIds: normalizedIds,
           }),
         },
         async (tx) => {
        const payrollsToMark = await tx
          .select()
          .from(factoryPayrolls)
          .where(and(eq(factoryPayrolls.companyId, companyId), inArray(factoryPayrolls.id, normalizedIds)));

        await tx
          .update(factoryPayrolls)
          .set({ status: "PAID", paidAt: new Date(bulkPrToday), cashAccountId: cashId })
          .where(and(eq(factoryPayrolls.companyId, companyId), inArray(factoryPayrolls.id, normalizedIds)));

        const workerIds = Array.from(new Set<number>(payrollsToMark.map((payroll) => payroll.workerId)));
        const workerRows = await tx
          .select({ id: factoryWorkers.id, fullName: factoryWorkers.fullName })
          .from(factoryWorkers)
          .where(inArray(factoryWorkers.id, workerIds));
        const workerMap = new Map(workerRows.map((worker) => [worker.id, worker.fullName]));

        for (const payroll of payrollsToMark) {
          if (cashId && payableAccBulk) {
            const netAmt = parseFloat(payroll.netSalary || "0");
            const workerName = (workerMap.get(payroll.workerId) as string)?.trim() || `Worker #${payroll.workerId}`;
            const narration = `Payroll payment: ${workerName} (${payroll.periodStart} – ${payroll.periodEnd})`;
            const [pVoucher] = await tx
              .insert(vouchers)
              .values({
                companyId,
                voucherNumber: `PAYMENT-PAY-${payroll.id}-${Date.now()}`,
                voucherType: "Payment",
                voucherDate: bulkPrToday,
                description: narration,
                totalAmount: netAmt.toFixed(2),
                currency: "USD",
                sourceModule: "FACTORY",
              })
              .returning();
            if (netAmt > 0) {
              await tx.insert(voucherEntries).values([
                {
                  voucherId: pVoucher.id,
                  ledgerAccountId: payableAccBulk.id,
                  ...normUsd(netAmt.toFixed(2), "0"),
                  narration,
                },
                { voucherId: pVoucher.id, ledgerAccountId: cashId, ...normUsd("0", netAmt.toFixed(2)), narration },
              ]);
            }
          }
        }

        await writeDaybookEntry(tx, {
          companyId,
          txDate: bulkPrToday,
          txType: "PAYROLL_PAYMENT",
          description: `Payroll bulk paid: ${normalizedIds.length} worker${normalizedIds.length !== 1 ? "s" : ""}`,
        });
         return { value: { updated: normalizedIds.length }, resultReference: operationKey };
       });

       res.json(operation.value);
    } catch (error: unknown) {
       res.status(financialOperationErrorStatus(error)).json({ message: getErrorMessage(error) });
    }
  });
}
