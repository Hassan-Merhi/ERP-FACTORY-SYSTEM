// Extracted from ./mark-paid.ts
import type { Express, Request, Response } from "express";
import { parseId, parseOptionalId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { getClientDate } from "../../../lib/dateUtils";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { eq, and, gte, lte, inArray } from "drizzle-orm";
import { factoryWorkers, factoryPayrolls, factoryAttendance } from "@shared/schema";
import { findOrCreateLedger, getFactoryCompanyId, writeDaybookEntry } from "./_helpers";
import type Decimal from "decimal.js";
import { postErpVoucherTx } from "../../../services/accounting/erpVoucherPosting";
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
import { toMoney } from "../../../lib/money";

export async function ensureNoPendingProductionBonuses(companyId: number, payrollIds: number[]) {
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

/**
 * Phase 22 (B): the payroll payment voucher (Dr Payroll Payable / Cr cash)
 * through the central engine. The PAYMENT-PAY-<payrollId>- family prefix is
 * kept (the integrity diagnostic and the worker-statement repair find the
 * payment by it) with the payment date as a deterministic suffix instead of
 * Date.now(); the posting identity is the payroll and its payment date, so a
 * repeated mark-paid returns the voucher already posted.
 */
export async function postPayrollPaymentVoucherTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: {
    companyId: number;
    payrollId: number;
    paymentDate: string;
    narration: string;
    amount: Decimal;
    payableAccountId: number;
    cashAccountId: number;
  }
) {
  return postErpVoucherTx(tx, {
    companyId: input.companyId,
    voucherNumber: `PAYMENT-PAY-${input.payrollId}-${input.paymentDate.replace(/-/g, "")}`,
    voucherType: "Payment",
    voucherDate: input.paymentDate,
    description: input.narration,
    sourceModule: "FACTORY",
    lines: [
      { ledgerAccountId: input.payableAccountId, debit: input.amount, narration: input.narration },
      { ledgerAccountId: input.cashAccountId, credit: input.amount, narration: input.narration },
    ],
    source: { type: "payroll-payment", id: input.payrollId, revision: input.paymentDate },
  });
}

export function workerDisplayName(value: string | null | undefined, workerId: number): string {
  return value?.trim() || `Worker #${workerId}`;
}

export async function writePayrollPaymentDaybook(
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

export function registerPayrollMarkPaidRoutesPart1(app: Express) {
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
          const netAmt = toMoney(payroll.netSalary);
          if (netAmt.gt(0) && !cashAccountId) throw new Error("cashAccountId is required for non-zero payroll payment");

          let paymentReplayed = false;
          if (netAmt.gt(0)) {
            const payableAcc = payableAccSingle!;
            const narration = `Payroll payment: ${workerName} (${payroll.periodStart} – ${payroll.periodEnd})`;
            const { replayed } = await postPayrollPaymentVoucherTx(tx, {
              companyId: Number(companyId),
              payrollId: payroll.id,
              paymentDate: paymentDate,
              narration,
              amount: netAmt,
              payableAccountId: payableAcc.id,
              cashAccountId: cashAccountId!,
            });
            paymentReplayed = replayed;
          }

          // A replayed payment (already posted) already has its daybook mirror.
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
}
