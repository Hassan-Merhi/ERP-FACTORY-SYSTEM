/**
 * Owner-requested, backend-only October payroll journal inspection.
 * Read-only, tenant-scoped. Does not alter ledger balances, payroll rows,
 * worker advances, cash, voucher visibility or audit history.
 *
 * The purpose is to verify the *posted journal lines*, not infer an accounting
 * balance from a payroll-record sum or force cash paid to equal expense.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../db";
import { logger } from "../lib/logger";
import { resultRows } from "../lib/queryResult";
import { toMoney } from "../lib/money";
import { runInCompanyPostingScope } from "../services/accounting/scheduledPostingScope";

const COMPANY = 12;
const SERVICE = "srv-d6kibgtactks739u7vl0";
const DATABASE = "erp_db_qscj_64lv_e7rz_8744_2lm3";
const ENABLED = "company-12-october-2026-payroll-audit-v1";

type Accrual = {
  voucher_number: string;
  voucher_date: string;
  source_period: string;
  salary_debit: string;
  bonus_debit: string;
  payable_credit: string;
  advance_credit: string;
  total_debit: string;
  total_credit: string;
};
type Payment = {
  payroll_id: number;
  worker_id: number;
  status: string;
  net: string;
  advance: string;
  payment_vouchers: number;
  payment_payable_debit: string;
  payment_cash_credit: string;
  daybook_rows: number;
  daybook_cash: string;
  repayment_rows: number;
  repayment_total: string;
};
type Summary = {
  status: string;
  active: boolean;
  payroll_rows: number;
  net: string;
  advances: string;
  gross: string;
};
const amount = (value: string | number | null | undefined) => toMoney(value ?? "0").toFixed(2);

export async function inspectOctoberPayrollJournalIntegrity20261103(): Promise<void> {
  if (process.env.OCTOBER_PAYROLL_JOURNAL_INSPECTION !== ENABLED) return;
  if (process.env.RENDER_SERVICE_ID !== SERVICE) throw new Error("OCT_PAYROLL_AUDIT_BAD_RENDER_SERVICE");
  const [dbName] = (await pool.query<{ name: string }>("SELECT current_database() AS name")).rows;
  if (dbName?.name !== DATABASE) throw new Error("OCT_PAYROLL_AUDIT_BAD_DATABASE");

  const report = await runInCompanyPostingScope(
    COMPANY,
    () => db.transaction(async (tx) => {
      const summary = resultRows<Summary>(await tx.execute(sql`
        SELECT p.status, w.active, count(*)::int AS payroll_rows,
               COALESCE(sum(p.net_salary),0)::text AS net,
               COALESCE(sum(p.advances),0)::text AS advances,
               COALESCE(sum(p.net_salary+p.advances),0)::text AS gross
        FROM factory_payrolls p
        JOIN factory_workers w ON w.id=p.worker_id AND w.company_id=p.company_id
        WHERE p.company_id=${COMPANY}
          AND p.period_start>=DATE '2026-10-01' AND p.period_end<=DATE '2026-10-31'
        GROUP BY p.status,w.active ORDER BY w.active DESC,p.status
      `)).map((r) => ({
        status: r.status, active: r.active, payrollRows: r.payroll_rows,
        net: amount(r.net), advances: amount(r.advances), gross: amount(r.gross),
      }));

      const accruals = resultRows<Accrual>(await tx.execute(sql`
        SELECT v.voucher_number,
               v.voucher_date::text AS voucher_date,
               substring(v.voucher_number FROM 'PAYROLL-GEN-12-(.*)$') AS source_period,
               COALESCE(sum(e.debit_amount)
                 FILTER (WHERE la.name LIKE 'Salary Expense - %'),0)::text AS salary_debit,
               COALESCE(sum(e.debit_amount)
                 FILTER (WHERE la.name LIKE 'Bonus Expense - %'),0)::text AS bonus_debit,
               COALESCE(sum(e.credit_amount)
                 FILTER (WHERE la.name='Payroll Payable'),0)::text AS payable_credit,
               COALESCE(sum(e.credit_amount)
                 FILTER (WHERE la.name='Factory Worker Advances'),0)::text AS advance_credit,
               COALESCE(sum(e.debit_amount),0)::text AS total_debit,
               COALESCE(sum(e.credit_amount),0)::text AS total_credit
        FROM vouchers v
        JOIN voucher_entries e ON e.voucher_id=v.id AND e.company_id=${COMPANY}
        LEFT JOIN ledger_accounts la ON la.id=e.ledger_account_id AND la.company_id=${COMPANY}
        WHERE v.company_id=${COMPANY} AND v.deleted_at IS NULL AND v.optional=false
          AND v.voucher_number LIKE 'PAYROLL-GEN-12-2026-10-01-%'
        GROUP BY v.id,v.voucher_number,v.voucher_date ORDER BY v.voucher_number
      `)).map((r) => ({
        voucher: r.voucher_number, date: r.voucher_date, period: r.source_period,
        salaryDr: amount(r.salary_debit), bonusDr: amount(r.bonus_debit),
        payrollPayableCr: amount(r.payable_credit), advancesCr: amount(r.advance_credit),
        debit: amount(r.total_debit), credit: amount(r.total_credit),
      }));

      // Payment vouchers and Daybook are independent cash evidence. A PAID
      // status or a nonzero cash-account ID alone is not payment evidence.
      const payments = resultRows<Payment>(await tx.execute(sql`
        SELECT p.id AS payroll_id, p.worker_id, p.status,
               p.net_salary::text AS net, p.advances::text AS advance,
               (SELECT count(*)::int FROM vouchers v
                 WHERE v.company_id=${COMPANY} AND v.deleted_at IS NULL
                   AND v.voucher_number LIKE ('PAYMENT-PAY-' || p.id::text || '-%')
               ) AS payment_vouchers,
               (SELECT COALESCE(sum(e.debit_amount),0)::text
                 FROM vouchers v JOIN voucher_entries e ON e.voucher_id=v.id AND e.company_id=${COMPANY}
                 JOIN ledger_accounts la ON la.id=e.ledger_account_id AND la.company_id=${COMPANY}
                 WHERE v.company_id=${COMPANY} AND v.deleted_at IS NULL
                   AND v.voucher_number LIKE ('PAYMENT-PAY-' || p.id::text || '-%')
                   AND la.name='Payroll Payable'
               ) AS payment_payable_debit,
               (SELECT COALESCE(sum(e.credit_amount),0)::text
                 FROM vouchers v JOIN voucher_entries e ON e.voucher_id=v.id AND e.company_id=${COMPANY}
                 JOIN ledger_accounts la ON la.id=e.ledger_account_id AND la.company_id=${COMPANY}
                 WHERE v.company_id=${COMPANY} AND v.deleted_at IS NULL
                   AND v.voucher_number LIKE ('PAYMENT-PAY-' || p.id::text || '-%')
                   AND la.name <> 'Payroll Payable'
               ) AS payment_cash_credit,
               (SELECT count(*)::int FROM factory_daybook_entries d
                 WHERE d.company_id=${COMPANY} AND d.reference_table='factory_payrolls'
                   AND d.reference_id=p.id AND d.tx_type='PAYROLL_PAYMENT'
               ) AS daybook_rows,
               (SELECT COALESCE(sum(d.amount_usd),0)::text FROM factory_daybook_entries d
                 WHERE d.company_id=${COMPANY} AND d.reference_table='factory_payrolls'
                   AND d.reference_id=p.id AND d.tx_type='PAYROLL_PAYMENT'
               ) AS daybook_cash,
               (SELECT count(*)::int FROM factory_advance_repayments a
                 WHERE a.company_id=${COMPANY} AND a.payroll_id=p.id
               ) AS repayment_rows,
               (SELECT COALESCE(sum(a.amount),0)::text FROM factory_advance_repayments a
                 WHERE a.company_id=${COMPANY} AND a.payroll_id=p.id
               ) AS repayment_total
        FROM factory_payrolls p
        WHERE p.company_id=${COMPANY}
          AND p.id IN (1174,1182,1184,1180,1183,1185,1202,1204,1276)
        ORDER BY p.id
      `)).map((r) => ({
        payrollId: r.payroll_id, workerId: r.worker_id, status: r.status,
        net: amount(r.net), advance: amount(r.advance),
        paymentVouchers: r.payment_vouchers, paymentPayableDr: amount(r.payment_payable_debit),
        paymentOtherCr: amount(r.payment_cash_credit),
        daybookRows: r.daybook_rows, daybookCash: amount(r.daybook_cash),
        repaymentRows: r.repayment_rows, repaymentTotal: amount(r.repayment_total),
      }));

      const [closed] = resultRows<{ closed_through: string | null }>(await tx.execute(sql`
        SELECT max(period_end_date)::text AS closed_through
        FROM fiscal_period_closures WHERE company_id=${COMPANY} AND status='CLOSED'
      `));

      return { companyId: COMPANY, month: "2026-10", closedThrough: closed?.closed_through ?? null,
        summary, accruals, payments };
    }),
    "owner-approved-october-payroll-journal-inspection"
  );
  // Render's default human-readable logger prints only approved structured
  // keys. Emit bounded, individual rows under accountingSnapshots so the
  // verified account/period evidence is visible without changing LOG_FORMAT.
  logger.info("[october-payroll-journal-audit] READ_ONLY summary", {
    companyId: COMPANY,
    accountingSnapshots: {
      closedThrough: report.closedThrough,
      payrollGroups: report.summary,
      accrualVoucherCount: report.accruals.length,
      paymentRecordCount: report.payments.length,
    },
  });
  for (const row of report.accruals) {
    logger.info("[october-payroll-journal-audit] READ_ONLY accrual", {
      companyId: COMPANY,
      accountingSnapshots: row,
    });
  }
  for (const row of report.payments) {
    logger.info("[october-payroll-journal-audit] READ_ONLY source payment", {
      companyId: COMPANY,
      accountingSnapshots: row,
    });
  }
}
