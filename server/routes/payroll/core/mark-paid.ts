/**
 * Payroll payment endpoints.
 *
 * Every PAID payroll with a non-zero net salary must converge across the payroll
 * row, one Payment voucher, its balanced ledger entries, the selected cash
 * account, and one factory Daybook mirror. Single and bulk flows use the same
 * invariant so retries cannot leave structurally different evidence.
 */
import type { Express, Request, Response } from "express";
import { parseId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { getClientDate } from "../../../lib/dateUtils";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { eq, and, inArray } from "drizzle-orm";
import { factoryWorkers, factoryPayrolls, factoryDaybookEntries, ledgerAccounts } from "@shared/schema";
import { findOrCreateLedger, getFactoryCompanyId } from "./_helpers";
import {
  financialOperationErrorStatus,
  financialOperationRequestPayload,
  resolveFinancialOperationKey,
} from "../../../services/accounting/financialOperationRequest";
import {
  financialOperationFingerprint,
  withDurableFinancialOperation,
} from "../../../services/accounting/durableFinancialOperation";
import { toMoney } from "../../../lib/money";
import {
  registerPayrollMarkPaidRoutesPart1,
  ensureNoPendingProductionBonuses,
  postPayrollPaymentVoucherTx,
  workerDisplayName,
  writePayrollPaymentDaybook,
} from "./registerPayrollMarkPaidRoutesPart1";

export function registerPayrollMarkPaidRoutes(app: Express) {
  registerPayrollMarkPaidRoutesPart1(app);

  app.patch("/api/factory/payrolls/:id/fix-accounting", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.body.companyId || getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const cashAccountId = req.body.cashAccountId ? parseInt(req.body.cashAccountId) : null;
      if (!cashAccountId) return res.status(400).json({ message: "cashAccountId is required" });

      const [cashAcc] = await db
        .select({ id: ledgerAccounts.id })
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.id, cashAccountId), eq(ledgerAccounts.companyId, companyId)));
      if (!cashAcc) return res.status(400).json({ message: "Cash account not found" });
      const payableAcc = await findOrCreateLedger(companyId, "Payroll Payable", "Liability");

      const result = await db.transaction(async (tx) => {
        const [payroll] = await tx
          .select()
          .from(factoryPayrolls)
          .where(and(eq(factoryPayrolls.id, id), eq(factoryPayrolls.companyId, companyId)));
        if (!payroll) throw new Error("Payroll not found");
        if (!["PAID", "APPROVED"].includes(payroll.status))
          throw new Error("Payroll must be in PAID or APPROVED status");
        if (payroll.cashAccountId) throw new Error("Accounting entry already exists for this payroll");

        const [worker] = await tx
          .select({ fullName: factoryWorkers.fullName })
          .from(factoryWorkers)
          .where(eq(factoryWorkers.id, payroll.workerId));
        const workerName = workerDisplayName(worker?.fullName, payroll.workerId);
        const paidDate = payroll.paidAt ? new Date(payroll.paidAt).toISOString().split("T")[0] : getClientDate(req);
        const netAmt = toMoney(payroll.netSalary);
        const narration = `Payroll payment (backdated): ${workerName} (${payroll.periodStart} – ${payroll.periodEnd})`;

        let voucherId: number | null = null;
        if (netAmt.gt(0)) {
          const { voucher: pVoucher } = await postPayrollPaymentVoucherTx(tx, {
            companyId: Number(companyId),
            payrollId: payroll.id,
            paymentDate: paidDate,
            narration,
            amount: netAmt,
            payableAccountId: payableAcc.id,
            cashAccountId: cashAccountId,
          });
          voucherId = pVoucher.id;
        }

        await tx.update(factoryPayrolls).set({ cashAccountId }).where(eq(factoryPayrolls.id, id));

        if (payroll.status === "PAID") {
          const [existingDaybook] = await tx
            .select({ id: factoryDaybookEntries.id })
            .from(factoryDaybookEntries)
            .where(
              and(
                eq(factoryDaybookEntries.companyId, Number(companyId)),
                eq(factoryDaybookEntries.txType, "PAYROLL_PAYMENT"),
                eq(factoryDaybookEntries.referenceTable, "factory_payrolls"),
                eq(factoryDaybookEntries.referenceId, payroll.id)
              )
            )
            .limit(1);
          if (!existingDaybook) {
            await writePayrollPaymentDaybook(tx, {
              companyId: Number(companyId),
              payrollId: payroll.id,
              paymentDate: paidDate,
              workerName,
              netSalary: netAmt.toNumber(),
              periodStart: payroll.periodStart,
              periodEnd: payroll.periodEnd,
            });
          }
        }

        return { voucherId };
      });

      res.json({ message: "Accounting entry generated", voucherId: result.voucherId });
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      if (message === "Payroll not found") return res.status(404).json({ message });
      if (
        message === "Payroll must be in PAID or APPROVED status" ||
        message === "Accounting entry already exists for this payroll"
      )
        return res.status(400).json({ message });
      res.status(500).json({ message });
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
      const paymentDate = req.body.paymentDate || getClientDate(req);

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
          if (payrollsToMark.length !== normalizedIds.length)
            throw new Error("One or more payroll records were not found");
          if (!cashId && payrollsToMark.some((payroll) => toMoney(payroll.netSalary).gt(0))) {
            throw new Error("cashAccountId is required for non-zero payroll payment");
          }

          await tx
            .update(factoryPayrolls)
            .set({ status: "PAID", paidAt: new Date(paymentDate), cashAccountId: cashId })
            .where(and(eq(factoryPayrolls.companyId, companyId), inArray(factoryPayrolls.id, normalizedIds)));

          const workerIds = Array.from(new Set<number>(payrollsToMark.map((payroll) => payroll.workerId)));
          const workerRows = await tx
            .select({ id: factoryWorkers.id, fullName: factoryWorkers.fullName })
            .from(factoryWorkers)
            .where(inArray(factoryWorkers.id, workerIds));
          const workerMap = new Map(workerRows.map((worker) => [worker.id, worker.fullName]));

          for (const payroll of payrollsToMark) {
            const netAmt = toMoney(payroll.netSalary);
            const workerName = workerDisplayName(
              workerMap.get(payroll.workerId) as string | null | undefined,
              payroll.workerId
            );
            const narration = `Payroll payment: ${workerName} (${payroll.periodStart} – ${payroll.periodEnd})`;

            let paymentReplayed = false;
            if (netAmt.gt(0) && cashId && payableAccBulk) {
              const { replayed } = await postPayrollPaymentVoucherTx(tx, {
                companyId: Number(companyId),
                payrollId: payroll.id,
                paymentDate: paymentDate,
                narration,
                amount: netAmt,
                payableAccountId: payableAccBulk.id,
                cashAccountId: cashId,
              });
              paymentReplayed = replayed;
            }

            if (!paymentReplayed)
              await writePayrollPaymentDaybook(tx, {
                companyId: Number(companyId),
                payrollId: payroll.id,
                paymentDate,
                workerName,
                netSalary: netAmt.toNumber(),
                periodStart: payroll.periodStart,
                periodEnd: payroll.periodEnd,
              });
          }

          return { value: { updated: normalizedIds.length }, resultReference: operationKey };
        }
      );

      res.json(operation.value);
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      if (message === "cashAccountId is required for non-zero payroll payment")
        return res.status(400).json({ message });
      if (message === "One or more payroll records were not found") return res.status(404).json({ message });
      res.status(financialOperationErrorStatus(error)).json({ message });
    }
  });
}
