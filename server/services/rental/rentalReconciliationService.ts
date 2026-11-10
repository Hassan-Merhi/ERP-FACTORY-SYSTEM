/**
 * server/services/rental/rentalReconciliationService.ts
 *
 * Rental payment reconciliation service.
 * Detects discrepancies between expected ledger state and actual DB state.
 *
 * Mismatch types detected:
 *   A) paid_amount cache drift vs POSTED payments sum
 *   B) Future-dated POSTED payments (should be SCHEDULED)
 *   C) usedPrepaidAccount / usedAdvanceAccount flag drift on ledger rows
 *   D) Accrual rows without a subsequent payment (orphan accruals)
 *   E) Premature accruals (month accrued before its billing date)
 *   F) SCHEDULED payments whose date has arrived (ready to post)
 */

import { pool } from "../../db";

export interface ReconciliationMismatch {
  type: "A" | "B" | "C" | "D" | "E" | "F";
  description: string;
  contractId?: number;
  paymentId?: number;
  ledgerRowId?: number;
  amount?: number;
  detail?: Record<string, unknown>;
}

export interface ReconciliationSummary {
  totalChecked: {
    contracts: number;
    payments: number;
    ledgerRows: number;
  };
  mismatches: ReconciliationMismatch[];
  counts: {
    A_paidAmountDrift: number;
    B_futurePosted: number;
    C_flagDrift: number;
    D_orphanAccrual: number;
    E_prematureAccrual: number;
    F_scheduledDue: number;
    total: number;
  };
  // FIX #10: cash / rent-payable balance comparison
  balances: {
    totalExpectedAsOf: number;
    totalPostedPaid: number;
    totalScheduledPending: number;
    totalAccrualPayablePosted: number;
    netOutstanding: number;
  };
}

export async function runRentalReconciliation(
  companyId: number,
  module: string,
  asOf: string
): Promise<ReconciliationSummary> {
  const mismatches: ReconciliationMismatch[] = [];

  // ── Count totals ──────────────────────────────────────────────────────────
  const { rows: contractRows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM property_contracts WHERE company_id = $1 AND module = $2 AND status = 'ACTIVE'`,
    [companyId, module]
  );
  const { rows: paymentRows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM property_payments WHERE company_id = $1 AND module = $2`,
    [companyId, module]
  );
  const { rows: ledgerRows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM property_monthly_ledger WHERE company_id = $1 AND module = $2`,
    [companyId, module]
  );

  // ── Type A: paid_amount cache drift ──────────────────────────────────────
  const { rows: driftRows } = await pool.query(
    `SELECT
       ml.id AS ledger_row_id,
       ml.contract_id,
       ml.year,
       ml.month,
       ml.paid_amount AS cached,
       COALESCE(SUM(pp.amount::numeric), 0) AS actual
     FROM property_monthly_ledger ml
     LEFT JOIN property_payments pp ON pp.ledger_row_id = ml.id AND pp.posting_status = 'POSTED'
     WHERE ml.company_id = $1 AND ml.module = $2
     GROUP BY ml.id, ml.contract_id, ml.year, ml.month, ml.paid_amount
     HAVING ABS(ml.paid_amount::numeric - COALESCE(SUM(pp.amount::numeric), 0)) > 0.01`,
    [companyId, module]
  );
  for (const r of driftRows) {
    mismatches.push({
      type: "A",
      description: `paid_amount cache drift: cached=${Number(r.cached).toFixed(2)}, actual POSTED=${Number(r.actual).toFixed(2)} (contract ${r.contract_id}, ${r.year}-${String(r.month).padStart(2,"0")})`,
      contractId: r.contract_id,
      ledgerRowId: r.ledger_row_id,
      amount: Math.abs(Number(r.cached) - Number(r.actual)),
      detail: { cached: Number(r.cached), actual: Number(r.actual) },
    });
  }

  // ── Type B: future-dated POSTED payments ────────────────────────────────
  const { rows: futurePosted } = await pool.query(
    `SELECT id, contract_id, amount, payment_date
     FROM property_payments
     WHERE company_id = $1 AND module = $2 AND posting_status = 'POSTED' AND payment_date > $3`,
    [companyId, module, asOf]
  );
  for (const r of futurePosted) {
    mismatches.push({
      type: "B",
      description: `Future-dated POSTED payment: id=${r.id}, date=${r.payment_date}, amount=${Number(r.amount).toFixed(2)}`,
      contractId: r.contract_id,
      paymentId: r.id,
      amount: Number(r.amount),
      detail: { paymentDate: r.payment_date },
    });
  }

  // ── Type C: flag drift (usedPrepaidAccount / usedAdvanceAccount) ─────────
  // A row should have usedPrepaidAccount/usedAdvanceAccount set if its accrual
  // voucher was posted with the advance-rent path (accrualVoucherId != null + 
  // voucher type = "Journal" with "Advance Rent Paid").
  // Simplified check: any accrualVoucherId row that has neither flag set but
  // corresponds to an advance-type voucher description.
  const { rows: flagDriftRows } = await pool.query(
    `SELECT ml.id AS ledger_row_id, ml.contract_id, ml.year, ml.month,
            ml.accrual_voucher_id, ml.used_prepaid_account, ml.used_advance_account
     FROM property_monthly_ledger ml
     WHERE ml.company_id = $1 AND ml.module = $2
       AND ml.accrual_voucher_id IS NOT NULL
       AND ml.used_prepaid_account IS NULL
       AND ml.used_advance_account IS NULL`,
    [companyId, module]
  );
  for (const r of flagDriftRows) {
    mismatches.push({
      type: "C",
      description: `Flag drift: accrualVoucherId=${r.accrual_voucher_id} set but usedPrepaidAccount/usedAdvanceAccount both null (contract ${r.contract_id}, ${r.year}-${String(r.month).padStart(2,"0")})`,
      contractId: r.contract_id,
      ledgerRowId: r.ledger_row_id,
      detail: { accrualVoucherId: r.accrual_voucher_id },
    });
  }

  // ── Type D: orphan accruals — accrual_voucher_id references a deleted/missing voucher ─
  // FIX #10: only flag rows whose accrual voucher is DELETED or missing,
  //          not every accrued-but-not-yet-paid row (those are normal pending state).
  const { rows: orphanAccruals } = await pool.query(
    `SELECT ml.id AS ledger_row_id, ml.contract_id, ml.year, ml.month, ml.accrual_voucher_id,
            v.deleted_at AS voucher_deleted_at
     FROM property_monthly_ledger ml
     LEFT JOIN vouchers v ON v.id = ml.accrual_voucher_id AND v.company_id = ml.company_id
     WHERE ml.company_id = $1 AND ml.module = $2
       AND ml.accrual_voucher_id IS NOT NULL
       AND (v.id IS NULL OR v.deleted_at IS NOT NULL OR v.optional = TRUE)`,
    [companyId, module]
  );
  for (const r of orphanAccruals) {
    mismatches.push({
      type: "D",
      description: `Orphan accrual: accrualVoucherId=${r.accrual_voucher_id} references a deleted/missing voucher (contract ${r.contract_id}, ${r.year}-${String(r.month).padStart(2,"0")})`,
      contractId: r.contract_id,
      ledgerRowId: r.ledger_row_id,
      detail: { accrualVoucherId: r.accrual_voucher_id, voucherDeletedAt: r.voucher_deleted_at },
    });
  }

  // ── Type E: premature accruals (month accrued before billing date) ───────
  // FIX #10: use real last-day-of-month to cap billing day (not LEAST(..., 28)).
  //          MAKE_DATE(year, month+1, 1) - 1 = last day of that month.
  const { rows: prematureAccruals } = await pool.query(
    `SELECT ml.id AS ledger_row_id, ml.contract_id, ml.year, ml.month, ml.accrual_voucher_id,
            pc.start_date,
            MAKE_DATE(
              ml.year,
              ml.month,
              LEAST(
                EXTRACT(DAY FROM pc.start_date::date)::int,
                EXTRACT(DAY FROM (
                  DATE_TRUNC('MONTH', MAKE_DATE(ml.year, ml.month, 1)) + INTERVAL '1 MONTH' - INTERVAL '1 DAY'
                ))::int
              )
            ) AS billing_date
     FROM property_monthly_ledger ml
     JOIN property_contracts pc ON pc.id = ml.contract_id
     LEFT JOIN vouchers v ON v.id = ml.accrual_voucher_id
     WHERE ml.company_id = $1 AND ml.module = $2
       AND ml.accrual_voucher_id IS NOT NULL
       AND v.id IS NOT NULL AND v.deleted_at IS NULL
       AND MAKE_DATE(
             ml.year,
             ml.month,
             LEAST(
               EXTRACT(DAY FROM pc.start_date::date)::int,
               EXTRACT(DAY FROM (
                 DATE_TRUNC('MONTH', MAKE_DATE(ml.year, ml.month, 1)) + INTERVAL '1 MONTH' - INTERVAL '1 DAY'
               ))::int
             )
           ) > $3::date`,
    [companyId, module, asOf]
  );
  for (const r of prematureAccruals) {
    const billingDate = String(r.billing_date).slice(0, 10);
    mismatches.push({
      type: "E",
      description: `Premature accrual: month ${r.year}-${String(r.month).padStart(2,"0")} accrued before billing date ${billingDate} (contract ${r.contract_id})`,
      contractId: r.contract_id,
      ledgerRowId: r.ledger_row_id,
      detail: { billingDate, accrualVoucherId: r.accrual_voucher_id },
    });
  }

  // ── Type F: SCHEDULED payments ready to post (paymentDate <= asOf) ───────
  const { rows: scheduledDue } = await pool.query(
    `SELECT id, contract_id, amount, payment_date, payment_group_id
     FROM property_payments
     WHERE company_id = $1 AND module = $2 AND posting_status = 'SCHEDULED' AND payment_date <= $3`,
    [companyId, module, asOf]
  );
  for (const r of scheduledDue) {
    mismatches.push({
      type: "F",
      description: `SCHEDULED payment due: id=${r.id}, paymentDate=${r.payment_date}, amount=${Number(r.amount).toFixed(2)}, groupId=${r.payment_group_id}`,
      contractId: r.contract_id,
      paymentId: r.id,
      amount: Number(r.amount),
      detail: { paymentDate: r.payment_date, paymentGroupId: r.payment_group_id },
    });
  }

  const counts = {
    A_paidAmountDrift: mismatches.filter((m) => m.type === "A").length,
    B_futurePosted: mismatches.filter((m) => m.type === "B").length,
    C_flagDrift: mismatches.filter((m) => m.type === "C").length,
    D_orphanAccrual: mismatches.filter((m) => m.type === "D").length,
    E_prematureAccrual: mismatches.filter((m) => m.type === "E").length,
    F_scheduledDue: mismatches.filter((m) => m.type === "F").length,
    total: mismatches.length,
  };

  // ── FIX #10: cash / rent-payable balance summary ─────────────────────────
  const { rows: balanceRows } = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN ml.accrual_voucher_id IS NOT NULL THEN ml.expected_amount::numeric ELSE 0 END), 0) AS total_accrual_payable_posted,
       COALESCE(SUM(
         CASE WHEN bill_date.billing_date <= $3::date THEN ml.expected_amount::numeric ELSE 0 END
       ), 0) AS total_expected_as_of
     FROM property_monthly_ledger ml
     JOIN property_contracts pc ON pc.id = ml.contract_id
     CROSS JOIN LATERAL (
       SELECT MAKE_DATE(
         ml.year, ml.month,
         LEAST(
           EXTRACT(DAY FROM pc.start_date::date)::int,
           EXTRACT(DAY FROM (DATE_TRUNC('MONTH', MAKE_DATE(ml.year, ml.month, 1)) + INTERVAL '1 MONTH' - INTERVAL '1 DAY'))::int
         )
       ) AS billing_date
     ) bill_date
     WHERE ml.company_id = $1 AND ml.module = $2`,
    [companyId, module, asOf]
  );
  const { rows: paymentBalRows } = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN posting_status = 'POSTED' AND payment_date <= $3 THEN amount::numeric ELSE 0 END), 0) AS total_posted_paid,
       COALESCE(SUM(CASE WHEN posting_status = 'SCHEDULED' THEN amount::numeric ELSE 0 END), 0) AS total_scheduled_pending
     FROM property_payments
     WHERE company_id = $1 AND module = $2`,
    [companyId, module, asOf]
  );

  const totalExpectedAsOf = Number(balanceRows[0]?.total_expected_as_of ?? 0);
  const totalPostedPaid = Number(paymentBalRows[0]?.total_posted_paid ?? 0);
  const totalScheduledPending = Number(paymentBalRows[0]?.total_scheduled_pending ?? 0);
  const totalAccrualPayablePosted = Number(balanceRows[0]?.total_accrual_payable_posted ?? 0);
  const netOutstanding = totalExpectedAsOf - totalPostedPaid;

  return {
    totalChecked: {
      contracts: parseInt(contractRows[0]?.count ?? "0"),
      payments: parseInt(paymentRows[0]?.count ?? "0"),
      ledgerRows: parseInt(ledgerRows[0]?.count ?? "0"),
    },
    mismatches,
    counts,
    balances: {
      totalExpectedAsOf,
      totalPostedPaid,
      totalScheduledPending,
      totalAccrualPayablePosted,
      netOutstanding,
    },
  };
}
