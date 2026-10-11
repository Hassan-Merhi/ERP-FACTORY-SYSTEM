/**
 * Wave 7 leftovers (2026-10-09): payroll and advance postings that history
 * left without their voucher. Listed, never back-filled.
 *
 *   factory_payroll_paid_without_payment_voucher — a PAID factory payroll with
 *     a net salary and no live PAYMENT-PAY-{payroll}-* voucher (marked paid
 *     through PATCH /api/factory/payroll/:id before that posted the payment).
 *   factory_payroll_period_without_accrual — a payroll period whose payrolls
 *     carry an amount but no live PAYROLL-GEN accrual (generated through
 *     POST /api/factory/payroll/generate before that posted it).
 *   factory_advance_repayment_voucher_orphaned — a live RECEIPT-REPAY-{n}-* or
 *     REPAY-SAL-{n}-* voucher whose repayment n no longer exists (left by an
 *     advance or repayment deleted before either removed it).
 */
import { sql } from "drizzle-orm";

import { db } from "../../../db";
import { sumMoney } from "../../../lib/money";
import type { IntegrityCheck } from "./accountingIntegrityDiagnostic";

const SAMPLE_LIMIT = 20;

type Row = Record<string, unknown>;

async function rows<T extends Row>(query: ReturnType<typeof sql>): Promise<T[]> {
  const result = await db.execute<T>(query);
  return result.rows as unknown as T[];
}

function warnCheck(key: string, explanation: string, samples: Row[], amount: string | null): IntegrityCheck {
  return {
    key,
    status: samples.length ? "warn" : "pass",
    count: samples.length,
    amount: samples.length ? amount : null,
    explanation,
    samples: samples.slice(0, SAMPLE_LIMIT),
  };
}

export async function payrollAdvancePostingChecks(companyId: number): Promise<IntegrityCheck[]> {
  const paidWithoutVoucher = await rows<{
    id: number;
    worker_id: number;
    period_start: string;
    period_end: string;
    net_salary: string;
    paid_at: string | null;
  }>(sql`
    SELECT p.id, p.worker_id, p.period_start::text AS period_start, p.period_end::text AS period_end,
           p.net_salary::text AS net_salary, p.paid_at::text AS paid_at
      FROM factory_payrolls p
     WHERE p.company_id = ${companyId} AND p.status = 'PAID' AND COALESCE(p.net_salary, 0) > 0
       AND NOT EXISTS (
         SELECT 1 FROM vouchers v
          WHERE v.company_id = p.company_id AND v.deleted_at IS NULL
            AND v.voucher_number LIKE 'PAYMENT-PAY-' || p.id::text || '-%')
     ORDER BY p.id
  `);

  const periodsWithoutAccrual = await rows<{
    period_start: string;
    period_end: string;
    payrolls: number;
    gross: string;
  }>(sql`
    SELECT p.period_start::text AS period_start, p.period_end::text AS period_end,
           COUNT(*)::int AS payrolls,
           SUM(COALESCE(p.net_salary, 0) + COALESCE(p.advances, 0))::text AS gross
      FROM factory_payrolls p
     WHERE p.company_id = ${companyId}
     GROUP BY p.period_start, p.period_end
    HAVING SUM(COALESCE(p.net_salary, 0) + COALESCE(p.advances, 0)) <> 0
       AND NOT EXISTS (
         SELECT 1 FROM vouchers v
          WHERE v.company_id = ${companyId} AND v.deleted_at IS NULL
            AND v.voucher_number LIKE 'PAYROLL-GEN-%'
            AND v.voucher_date = p.period_start
            AND v.description LIKE '%' || p.period_end::text || '%')
     ORDER BY p.period_start, p.period_end
  `);

  const orphanedRepaymentVouchers = await rows<{
    id: number;
    voucher_number: string;
    voucher_date: string;
    total_amount: string;
  }>(sql`
    SELECT v.id, v.voucher_number, v.voucher_date::text AS voucher_date, v.total_amount::text AS total_amount
      FROM vouchers v
     WHERE v.company_id = ${companyId} AND v.deleted_at IS NULL
       AND v.voucher_number ~ '^(RECEIPT-REPAY|REPAY-SAL)-[0-9]+-'
       AND NOT EXISTS (
         SELECT 1 FROM factory_advance_repayments r
          WHERE r.id = substring(v.voucher_number from '^(?:RECEIPT-REPAY|REPAY-SAL)-([0-9]+)-')::int)
     ORDER BY v.id
  `);

  return [
    warnCheck(
      "factory_payroll_paid_without_payment_voucher",
      "PAID factory payrolls with a net salary and no PAYMENT-PAY payment voucher: marked paid before wave 7 made marking PAID post Dr Payroll Payable / Cr the paying account. The payable stays open and the cash account does not show the payment; they are not back-filled.",
      paidWithoutVoucher,
      sumMoney(paidWithoutVoucher.map((row) => row.net_salary)).toFixed(2)
    ),
    warnCheck(
      "factory_payroll_period_without_accrual",
      "Factory payroll periods with no PAYROLL-GEN accrual (Dr salary/bonus expense / Cr Payroll Payable and worker advances): generated before wave 7 made generation post it. Regenerating or editing a payroll of the period posts it; nothing is back-filled.",
      periodsWithoutAccrual,
      sumMoney(periodsWithoutAccrual.map((row) => row.gross)).toFixed(2)
    ),
    warnCheck(
      "factory_advance_repayment_voucher_orphaned",
      "Advance repayment vouchers (RECEIPT-REPAY / REPAY-SAL) whose repayment no longer exists: left by an advance or repayment deleted before wave 7 removed them together. They still credit Factory Worker Advances; they are listed for review, not removed.",
      orphanedRepaymentVouchers,
      sumMoney(orphanedRepaymentVouchers.map((row) => row.total_amount)).toFixed(2)
    ),
  ];
}
