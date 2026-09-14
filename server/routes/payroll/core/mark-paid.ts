/**
 * Payroll payment endpoints.
 *
 * Every PAID payroll with a non-zero net salary must converge across the payroll
 * row, one Payment voucher, its balanced ledger entries, the selected cash
 * account, and one factory Daybook mirror. Single and bulk flows use the same
 * invariant so retries cannot leave structurally different evidence.
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
  factoryDaybookEntries,
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

function workerDisplayName(value: string | null | undefined, workerId: number): string {
  return value?.trim() || `Worker #${workerId}`;
}

async function writePayrollPaymentDaybook(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: {
    companyId: number;
    payrollId: number;
    paymentDate: string;
    workerName: string;
    netSalary: number;
    periodStart: string;
    periodEnd: string;
  }
) {
  await writeDaybookEntry(tx, {
    companyId: input.companyId,
    txDate: input.paymentDate,
    txType: "PAYROLL_PAYMENT",
    referenceId: input.payrollId,
    referenceTable: "factory_payrolls",
    description: `Payroll paid: ${input.workerName} – ${input.netSalary.toFixed(2)} (${input.periodStart} – ${input.periodEnd})`,
    amountCurrency: input.netSalary,
    amountUsd: input.netSalary,
  });
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

          const [worker] = await tx
            .select({ fullName: factoryWorkers.fullName })
            .from(factoryWorkers)
            .where(eq(factoryWorkers.id, payroll.workerId));
          const workerName = workerDisplayName(worker?.fullName, payroll.workerId);
          const netAmt = parseFloat(payroll.netSalary || "0");
          if (netAmt > 0 && !cashAccountId) throw new Error("cashAccountId is required for non-zero payroll payment");

          if (netAmt > 0) {
            const payableAcc = payableAccSingle!;
            const narration = `Payroll payment: ${workerName} (${payroll.periodStart} – ${payroll.periodEnd})`;
            const [pVoucher] = await tx
              .insert(vouchers)
              .values({
                companyId,
                voucherNumber: `PAYMENT-PAY-${payroll.id}-${Date.now()}`,
                voucherType: "Payment",
                voucherDate: paymentDate,
                description: narration,
                totalAmount: netAmt.toFixed(2),
                currency: "USD",
                sourceModule: "FACTORY",
              })
              .returning();
            await tx.insert(voucherEntries).values([
              { voucherId: pVoucher.id, ledgerAccountId: payableAcc.id, ...normUsd(netAmt.toFixed(2), "0"), narration },
              { voucherId: pVoucher.id, ledgerAccountId: cashAccountId!, ...normUsd("0", netAmt.toFixed(2)), narration },
            ]);
          }

          await writePayrollPaymentDaybook(tx, {
            companyId: Number(companyId),
            payrollId: payroll.id,
            paymentDate,
            workerName,
            netSalary: netAmt,
            periodStart: payroll.periodStart,
            periodEnd: payroll.periodEnd,
          });
          return { value: payroll, resultReference: payroll.id };
        }
      );

      res.json(operation.value);
    } catch (error: unknown) {
      if (getErrorMessage(error) === "Payroll record not found")
        return res.status(404).json({ message: getErrorMessage(error) });
      const message = getErrorMessage(error);
      if (message === "cashAccountId is required for non-zero payroll payment")
        return res.status(400).json({ message });
      res.status(financialOperationErrorStatus(error)).json({ message });
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
        if (!["PAID", "APPROVED"].includes(payroll.status)) throw new Error("Payroll must be in PAID or APPROVED status");
        if (payroll.cashAccountId) throw new Error("Accounting entry already exists for this payroll");

        const [worker] = await tx
          .select({ fullName: factoryWorkers.fullName })
          .from(factoryWorkers)
          .where(eq(factoryWorkers.id, payroll.workerId));
        const workerName = workerDisplayName(worker?.fullName, payroll.workerId);
        const paidDate = payroll.paidAt ? new Date(payroll.paidAt).toISOString().split("T")[0] : getClientDate(req);
        const netAmt = parseFloat(payroll.netSalary || "0");
        const narration = `Payroll payment (backdated): ${workerName} (${payroll.periodStart} – ${payroll.periodEnd})`;

        let voucherId: number | null = null;
        if (netAmt > 0) {
          const [pVoucher] = await tx
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
          voucherId = pVoucher.id;
          await tx.insert(voucherEntries).values([
            { voucherId: pVoucher.id, ledgerAccountId: payableAcc.id, ...normUsd(netAmt.toFixed(2), "0"), narration },
            { voucherId: pVoucher.id, ledgerAccountId: cashAccountId, ...normUsd("0", netAmt.toFixed(2)), narration },
          ]);
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
              netSalary: netAmt,
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
      if (message === "Payroll must be in PAID or APPROVED status" || message === "Accounting entry already exists for this payroll")
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
          if (payrollsToMark.length !== normalizedIds.length) throw new Error("One or more payroll records were not found");
          if (!cashId && payrollsToMark.some((payroll) => parseFloat(payroll.netSalary || "0") > 0)) {
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
            const netAmt = parseFloat(payroll.netSalary || "0");
            const workerName = workerDisplayName(workerMap.get(payroll.workerId) as string | null | undefined, payroll.workerId);
            const narration = `Payroll payment: ${workerName} (${payroll.periodStart} – ${payroll.periodEnd})`;

            if (netAmt > 0 && cashId && payableAccBulk) {
              const [pVoucher] = await tx
                .insert(vouchers)
                .values({
                  companyId,
                  voucherNumber: `PAYMENT-PAY-${payroll.id}-${Date.now()}`,
                  voucherType: "Payment",
                  voucherDate: paymentDate,
                  description: narration,
                  totalAmount: netAmt.toFixed(2),
                  currency: "USD",
                  sourceModule: "FACTORY",
                })
                .returning();
              await tx.insert(voucherEntries).values([
                { voucherId: pVoucher.id, ledgerAccountId: payableAccBulk.id, ...normUsd(netAmt.toFixed(2), "0"), narration },
                { voucherId: pVoucher.id, ledgerAccountId: cashId, ...normUsd("0", netAmt.toFixed(2)), narration },
              ]);
            }

            await writePayrollPaymentDaybook(tx, {
              companyId: Number(companyId),
              payrollId: payroll.id,
              paymentDate,
              workerName,
              netSalary: netAmt,
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
      if (message === "One or more payroll records were not found")
        return res.status(404).json({ message });
      res.status(financialOperationErrorStatus(error)).json({ message });
    }
  });
}
