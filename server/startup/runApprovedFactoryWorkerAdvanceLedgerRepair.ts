/**
 * One-time, owner-approved factory worker advance ledger repair, backend only.
 *
 * Corrects exactly three payroll accruals whose underlying, paid payroll rows
 * exist but whose Factory Worker Advances credits were missing or stale.
 * No frontend feature, report override, worker advance write, opening balance
 * change, cash/bank mutation, or supplier movement.
 *
 * A balanced PAYROLL-GEN accrual necessarily also debits salary expense and
 * credits Payroll Payable. Never post a naked credit to the advances account.
 */
import { sql } from "drizzle-orm";
import { db, pool, type DbTransaction } from "../db";
import { logger } from "../lib/logger";
import { resultRows } from "../lib/queryResult";
import { toMoney } from "../lib/money";
import { rebuildPayrollGenVoucher } from "../routes/payroll/_payrollAccountingHelper";
import { runInCompanyPostingScope } from "../services/accounting/scheduledPostingScope";

const EXPECTED_SERVICE = "srv-d6kibgtactks739u7vl0";
const EXPECTED_DATABASE = "erp_db_qscj_64lv_e7rz_8744_2lm3";
const COMPANY_ID = 12;
const ENABLE_ENV = "FACTORY_ADVANCE_LEDGER_REPAIR_20261103";
const ENABLE_VALUE = "approved-company-12-accrual-v1";

type Period = Readonly<{
  start: string;
  end: string;
  workers: number;
  expected: string;
  net: string;
  bonuses: string;
  paymentVouchers: number;
  before: string;
  vouchers: number;
}>;
const PERIODS: readonly Period[] = [
  {
    start: "2026-08-01",
    end: "2026-08-31",
    workers: 91,
    expected: "13240.00",
    net: "27559.92",
    bonuses: "0.00",
    paymentVouchers: 91,
    before: "0.00",
    vouchers: 0,
  },
  {
    start: "2026-09-01",
    end: "2026-09-18",
    workers: 1,
    expected: "33.33",
    net: "0.00",
    bonuses: "0.00",
    paymentVouchers: 0,
    before: "0.00",
    vouchers: 0,
  },
  {
    start: "2026-09-01",
    end: "2026-09-30",
    workers: 92,
    expected: "18051.00",
    net: "26157.47",
    bonuses: "0.00",
    paymentVouchers: 92,
    before: "17851.00",
    vouchers: 1,
  },
];

export interface Snapshot {
  workers: number;
  paidWorkers: number;
  expected: string;
  net: string;
  bonuses: string;
  paymentVouchers: number;
  payableDebits: string;
  posted: string;
  vouchers: number;
}

export function classifyApprovedAccrualSnapshot(period: Period, actual: Snapshot): "pending" | "done" {
  if (
    actual.workers !== period.workers ||
    actual.paidWorkers !== period.workers ||
    actual.expected !== period.expected ||
    actual.net !== period.net ||
    actual.bonuses !== period.bonuses ||
    actual.paymentVouchers !== period.paymentVouchers ||
    actual.payableDebits !== period.net
  ) {
    throw new Error("FACTORY_ADVANCE_REPAIR_PAYROLL_SOURCE_CHANGED_" + period.end);
  }
  if (actual.posted === period.expected && actual.vouchers === 1) return "done";
  if (actual.posted !== period.before || actual.vouchers !== period.vouchers) {
    throw new Error("FACTORY_ADVANCE_REPAIR_UNEXPECTED_POSTED_STATE_" + period.end);
  }
  return "pending";
}

async function snapshot(tx: DbTransaction, start: string, end: string): Promise<Snapshot> {
  const [row] = resultRows<{
    workers: number;
    paid_workers: number;
    expected: string;
    net: string;
    bonuses: string;
    payment_vouchers: number;
    payable_debits: string;
    posted: string;
    vouchers: number;
  }>(await tx.execute(sql`
    WITH payroll AS (
      SELECT COUNT(*)::int AS workers,
             COUNT(*) FILTER (WHERE status = 'PAID')::int AS paid_workers,
             COALESCE(SUM(advances), 0)::text AS expected,
             COALESCE(SUM(net_salary), 0)::text AS net,
             COALESCE(SUM(bonuses), 0)::text AS bonuses
        FROM factory_payrolls
       WHERE company_id = ${COMPANY_ID}
         AND period_start = ${start}::date AND period_end = ${end}::date
    ),
    active AS (
      SELECT id
        FROM vouchers
       WHERE company_id = ${COMPANY_ID}
         AND deleted_at IS NULL AND voucher_number LIKE 'PAYROLL-GEN-%'
         AND voucher_date = ${start}::date
         AND description LIKE ('%' || ${end} || '%')
    )
    SELECT payroll.workers, payroll.paid_workers, payroll.expected,
           payroll.net, payroll.bonuses,
      (SELECT COUNT(DISTINCT v.id)::int
         FROM factory_payrolls p
         JOIN vouchers v
           ON v.company_id = ${COMPANY_ID}
          AND v.deleted_at IS NULL
          AND v.voucher_number LIKE ('PAYMENT-PAY-' || p.id::text || '-%')
        WHERE p.company_id = ${COMPANY_ID}
          AND p.period_start = ${start}::date AND p.period_end = ${end}::date
      ) AS payment_vouchers,
      (SELECT COALESCE(SUM(e.debit_amount), 0)::text
         FROM factory_payrolls p
         JOIN vouchers v
           ON v.company_id = ${COMPANY_ID}
          AND v.deleted_at IS NULL
          AND v.voucher_number LIKE ('PAYMENT-PAY-' || p.id::text || '-%')
         JOIN voucher_entries e ON e.voucher_id = v.id AND e.company_id = ${COMPANY_ID}
        WHERE p.company_id = ${COMPANY_ID}
          AND p.period_start = ${start}::date AND p.period_end = ${end}::date
          AND e.ledger_account_id = 811
      ) AS payable_debits,
      (SELECT COALESCE(SUM(e.credit_amount), 0)::text
         FROM active v
         JOIN voucher_entries e ON e.voucher_id = v.id AND e.company_id = ${COMPANY_ID}
         JOIN ledger_accounts la ON la.id = e.ledger_account_id
        WHERE la.company_id = ${COMPANY_ID}
          AND la.name = 'Factory Worker Advances' AND la.deleted_at IS NULL
      ) AS posted,
      (SELECT COUNT(*)::int FROM active) AS vouchers
    FROM payroll
  `));
  if (!row) throw new Error("FACTORY_ADVANCE_AUDIT_NO_PERIOD");
  return {
    workers: Number(row.workers),
    paidWorkers: Number(row.paid_workers),
    expected: toMoney(row.expected).toFixed(2),
    net: toMoney(row.net).toFixed(2),
    bonuses: toMoney(row.bonuses).toFixed(2),
    paymentVouchers: Number(row.payment_vouchers),
    payableDebits: toMoney(row.payable_debits).toFixed(2),
    posted: toMoney(row.posted).toFixed(2),
    vouchers: Number(row.vouchers),
  };
}

async function operationalBalance(tx: DbTransaction): Promise<string> {
  const [row] = resultRows<{ remaining: string }>(await tx.execute(sql`
    SELECT COALESCE(SUM(remaining_balance), 0)::text AS remaining
      FROM factory_worker_advances
     WHERE company_id = ${COMPANY_ID} AND fully_paid = false
  `));
  return toMoney(row?.remaining ?? "0").toFixed(2);
}

/**
 * Boot-only, exact-snapshot, atomic repair. Calling repeatedly does nothing
 * once all three accruals have been corrected. Any changed source snapshot,
 * including an extra prior voucher, aborts without touching production.
 */
export async function runApprovedFactoryWorkerAdvanceLedgerRepair(): Promise<void> {
  if (process.env[ENABLE_ENV] !== ENABLE_VALUE) return;
  if (process.env.RENDER_SERVICE_ID !== EXPECTED_SERVICE) {
    throw new Error("FACTORY_ADVANCE_REPAIR_UNEXPECTED_RENDER_SERVICE");
  }
  const [database] = (await pool.query<{ db: string }>("SELECT current_database() AS db")).rows;
  if (database?.db !== EXPECTED_DATABASE) {
    throw new Error("FACTORY_ADVANCE_REPAIR_UNEXPECTED_DATABASE");
  }

  const outcome = await runInCompanyPostingScope(
    COMPANY_ID,
    () => db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(20261103, ${COMPANY_ID})`);
      const before = await Promise.all(PERIODS.map((p) => snapshot(tx, p.start, p.end)));
      const pending: Period[] = [];

      for (let i = 0; i < PERIODS.length; i++) {
        const period = PERIODS[i];
        const actual = before[i];
        if (!period || !actual) throw new Error("FACTORY_ADVANCE_REPAIR_PERIOD_MISSING");
        if (classifyApprovedAccrualSnapshot(period, actual) === "pending") pending.push(period);
      }

      if (pending.length === 0) return { posted: 0, unchangedOutstanding: await operationalBalance(tx) };

      // Protect the worker records and ensure this repair never changes them.
      const outstandingBefore = await operationalBalance(tx);

      for (const period of pending) {
        // Existing engine retires any incomplete journal and replaces it with
        // a balanced voucher, preserving per-worker salary/bonus expense legs.
        await rebuildPayrollGenVoucher(tx, COMPANY_ID, period.start, period.end);
      }

      for (const period of pending) {
        const after = await snapshot(tx, period.start, period.end);
        if (
          classifyApprovedAccrualSnapshot(period, {
            ...after,
            posted: period.expected,
            vouchers: 1,
          }) !== "done" ||
          after.posted !== period.expected ||
          after.vouchers !== 1
        ) {
          throw new Error("FACTORY_ADVANCE_REPAIR_POSTCONDITION_FAILED_" + period.end);
        }
      }
      const outstandingAfter = await operationalBalance(tx);
      if (outstandingBefore !== outstandingAfter) {
        throw new Error("FACTORY_ADVANCE_REPAIR_WORKER_BALANCE_CHANGED");
      }
      return { posted: pending.length, unchangedOutstanding: outstandingAfter };
    }),
    "approved-factory-advance-accruals-20261103"
  );

  logger.info("[startup] Approved factory worker advance accrual repair", outcome);
}
