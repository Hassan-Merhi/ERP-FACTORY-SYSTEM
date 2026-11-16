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
 *   D) Stale accrual references (deleted/optional/missing vouchers)
 *   E) Premature accruals (month accrued before its billing date)
 *   F) SCHEDULED payments whose date has arrived (ready to post)
 *   G) POSTED rental payments missing a live accounting voucher
 *   H) Due-month payments that did not settle an existing AP accrual
 */

import { pool } from "../../db";

export interface ReconciliationMismatch {
  type: "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H";
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
    G_missingPostedVoucher: number;
    H_unsettledAccrualPayment: number;
    total: number;
  };
  // FIX #10: cash / rent-payable balance comparison
  balances: {
    totalExpectedAsOf: number;
    totalPostedPaid: number;
    totalScheduledPending: number;
    /** Actual net payable on company-local accrued-rent controls, not gross accrual stamps. */
    totalAccrualPayablePosted: number;
    /** Due rent left unpaid, never offset by a different contract's prepayment. */
    netOutstanding: number;
    tenantRentPayable: number;
    landlordRentReceivable: number;
    totalAppliedAgainstDueAsOf: number;
    prepaidRentAllocated: number;
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
       AND pc.company_id=ml.company_id AND pc.module=ml.module
     LEFT JOIN vouchers v ON v.id = ml.accrual_voucher_id
       AND v.company_id=ml.company_id AND v.optional=FALSE
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

  // ── Type G: posted rent must have a real, live voucher ─────────────────
  const { rows: invalidPosted } = await pool.query(
    `SELECT p.id, p.contract_id, p.ledger_row_id, p.voucher_id, p.amount
     FROM property_payments p
     LEFT JOIN vouchers pv ON pv.id=p.voucher_id AND pv.company_id=p.company_id
       AND pv.deleted_at IS NULL AND pv.optional=FALSE
     WHERE p.company_id=$1 AND p.module=$2 AND p.posting_status='POSTED'
       AND p.ledger_row_id IS NOT NULL AND pv.id IS NULL`,
    [companyId, module]
  );
  for (const r of invalidPosted) {
    mismatches.push({
      type: "G",
      description: `POSTED rent allocation #${r.id} has no live payment voucher (contract ${r.contract_id})`,
      contractId: r.contract_id,
      paymentId: r.id,
      ledgerRowId: r.ledger_row_id,
      amount: Number(r.amount),
      detail: { voucherId: r.voucher_id },
    });
  }

  // ── Type H: detect settlement debits missing from real payable accruals ─
  // Existing historical AP-CLEAR-{paymentVoucherId} journals are legitimate;
  // never create a correcting journal automatically.
  const { rows: unsettledAccruals } = await pool.query(
    `SELECT p.id, p.contract_id, p.ledger_row_id,
            p.voucher_id, ml.accrual_voucher_id, p.amount
     FROM property_payments p
     JOIN property_monthly_ledger ml ON ml.id=p.ledger_row_id
       AND ml.company_id=p.company_id AND ml.module=p.module
     JOIN vouchers accrual ON accrual.id=ml.accrual_voucher_id
       AND accrual.company_id=p.company_id
       AND accrual.deleted_at IS NULL AND accrual.optional=FALSE
     JOIN vouchers payment ON payment.id=p.voucher_id
       AND payment.company_id=p.company_id
       AND payment.deleted_at IS NULL AND payment.optional=FALSE
     WHERE p.company_id=$1 AND p.module=$2
       AND p.posting_status='POSTED'
       AND p.payment_date >= COALESCE(accrual.effective_date,accrual.voucher_date)
       -- The very first partial due payment legitimately debits Advance Paid;
       -- its SAME-GROUP ADV-REC voucher establishes the residual AP.
       AND NOT (
         accrual.voucher_number LIKE 'ADV-REC-%'
         AND payment.voucher_number = REPLACE(accrual.voucher_number,'ADV-REC-','RENT-')
       )
       AND EXISTS (
          SELECT 1 FROM voucher_entries ae
          JOIN ledger_accounts la ON la.id=ae.ledger_account_id
            AND la.company_id=p.company_id AND la.deleted_at IS NULL
          WHERE ae.company_id=p.company_id AND ae.voucher_id=accrual.id
            AND ae.credit_amount::numeric > 0
            AND la.account_type='Liability'
            AND (la.name='Accrued Rent Payable'
              OR la.code IN ('ACCR-RENT-PAY','ACC-RENT-PAY')
              OR la.code LIKE 'ACCR-RENT-PAY-%'
              OR la.code LIKE 'ACC-RENT-PAY-%')
       )
       AND NOT EXISTS (
          SELECT 1 FROM voucher_entries settled
          JOIN ledger_accounts la ON la.id=settled.ledger_account_id
            AND la.company_id=p.company_id AND la.deleted_at IS NULL
          WHERE settled.company_id=p.company_id
            AND settled.voucher_id=payment.id AND settled.debit_amount::numeric > 0
            AND la.account_type='Liability'
            AND (la.name='Accrued Rent Payable'
              OR la.code IN ('ACCR-RENT-PAY','ACC-RENT-PAY')
              OR la.code LIKE 'ACCR-RENT-PAY-%'
              OR la.code LIKE 'ACC-RENT-PAY-%')
       )
       AND NOT EXISTS (
          SELECT 1 FROM vouchers clearing
          JOIN voucher_entries settled ON settled.voucher_id=clearing.id
            AND settled.company_id=p.company_id
          JOIN ledger_accounts la ON la.id=settled.ledger_account_id
            AND la.company_id=p.company_id AND la.deleted_at IS NULL
          WHERE clearing.company_id=p.company_id AND clearing.deleted_at IS NULL
            AND clearing.optional=FALSE
            AND clearing.voucher_number='AP-CLEAR-' || payment.id::text
            AND settled.debit_amount::numeric > 0
            AND la.account_type='Liability'
            AND (la.name='Accrued Rent Payable'
              OR la.code IN ('ACCR-RENT-PAY','ACC-RENT-PAY')
              OR la.code LIKE 'ACCR-RENT-PAY-%'
              OR la.code LIKE 'ACC-RENT-PAY-%')
       )`,
    [companyId, module]
  );
  for (const r of unsettledAccruals) {
    mismatches.push({
      type: "H",
      description: `Payment voucher #${r.voucher_id} lacks a payable settlement for accrued rent (contract ${r.contract_id})`,
      contractId: r.contract_id,
      paymentId: r.id,
      ledgerRowId: r.ledger_row_id,
      amount: Number(r.amount),
      detail: { voucherId: r.voucher_id, accrualVoucherId: r.accrual_voucher_id },
    });
  }

  const counts = {
    A_paidAmountDrift: mismatches.filter((m) => m.type === "A").length,
    B_futurePosted: mismatches.filter((m) => m.type === "B").length,
    C_flagDrift: mismatches.filter((m) => m.type === "C").length,
    D_orphanAccrual: mismatches.filter((m) => m.type === "D").length,
    E_prematureAccrual: mismatches.filter((m) => m.type === "E").length,
    F_scheduledDue: mismatches.filter((m) => m.type === "F").length,
    G_missingPostedVoucher: mismatches.filter((m) => m.type === "G").length,
    H_unsettledAccrualPayment: mismatches.filter((m) => m.type === "H").length,
    total: mismatches.length,
  };

  // ── Phase 4: operational due balances vs actual GL control balance ─────
  // A paid future rental month is an asset/deferred receipt, NOT a reduction
  // of an unrelated due rental month. Guarantees and cashbox payments with
  // no rental-month allocation are excluded.
  const { rows: operationalRows } = await pool.query(
    `WITH monthly AS (
       SELECT ml.id, ml.expected_amount::numeric AS expected,
              pc.linked_company_id, u.unit_type,
              MAKE_DATE(ml.year, ml.month,
                LEAST(EXTRACT(DAY FROM pc.start_date::date)::int,
                  EXTRACT(DAY FROM
                    DATE_TRUNC('MONTH', MAKE_DATE(ml.year,ml.month,1))
                    + INTERVAL '1 MONTH' - INTERVAL '1 DAY')::int)
              ) AS billing_date
       FROM property_monthly_ledger ml
       JOIN property_contracts pc ON pc.id=ml.contract_id
          AND pc.company_id=ml.company_id AND pc.module=ml.module
       JOIN property_units u ON u.id=ml.unit_id AND u.company_id=ml.company_id
       WHERE ml.company_id=$1 AND ml.module=$2
     ), effective_payments AS (
       SELECT p.ledger_row_id, SUM(p.amount::numeric) AS amount
       FROM property_payments p
       JOIN vouchers v ON v.id=p.voucher_id AND v.company_id=p.company_id
         AND v.deleted_at IS NULL AND v.optional=FALSE
       WHERE p.company_id=$1 AND p.module=$2 AND p.posting_status='POSTED'
         AND p.payment_date<=$3::date AND p.ledger_row_id IS NOT NULL
       GROUP BY p.ledger_row_id
     ), valued AS (
       SELECT m.*,
              COALESCE(pay.amount,0)::numeric AS paid,
              GREATEST(0,m.expected-COALESCE(pay.amount,0)) AS remaining
       FROM monthly m LEFT JOIN effective_payments pay ON pay.ledger_row_id=m.id
     )
     SELECT
       COALESCE(SUM(expected) FILTER (WHERE billing_date<=$3::date),0)
         AS total_expected_as_of,
       COALESCE(SUM(LEAST(expected,paid)) FILTER (WHERE billing_date<=$3::date),0)
         AS applied_to_due,
       COALESCE(SUM(remaining) FILTER (WHERE billing_date<=$3::date),0)
         AS outstanding,
       COALESCE(SUM(remaining) FILTER
         (WHERE billing_date<=$3::date
          AND (unit_type='SHOP' OR linked_company_id IS NOT NULL)),0)
         AS tenant_payable,
       COALESCE(SUM(remaining) FILTER
         (WHERE billing_date<=$3::date
          AND unit_type<>'SHOP' AND linked_company_id IS NULL),0)
         AS landlord_receivable,
       COALESCE(SUM(paid) FILTER (WHERE billing_date>$3::date),0)
         AS prepaid_future
     FROM valued`,
    [companyId, module, asOf]
  );

  const { rows: paymentBalRows } = await pool.query(
    `SELECT
       COALESCE(SUM(p.amount::numeric) FILTER (
         WHERE p.posting_status='POSTED' AND p.payment_date<=$3::date
           AND p.ledger_row_id IS NOT NULL AND v.id IS NOT NULL),0) AS total_posted_paid,
       COALESCE(SUM(p.amount::numeric) FILTER (
         WHERE p.posting_status='SCHEDULED' AND p.ledger_row_id IS NOT NULL),0)
         AS total_scheduled_pending
     FROM property_payments p
     LEFT JOIN vouchers v ON v.id=p.voucher_id AND v.company_id=p.company_id
       AND v.deleted_at IS NULL AND v.optional=FALSE
     WHERE p.company_id=$1 AND p.module=$2`,
    [companyId, module, asOf]
  );

  // The payable-control balance comes from REAL posted voucher entries, never
  // SUM(expected_amount) for months whose accrual_voucher_id happens to be set.
  // This is company-wide because a shared GL account can contain rental flows
  // from more than one module; operational month balances above are module-specific.
  const { rows: payableGL } = await pool.query(
    `SELECT COALESCE(SUM(ve.credit_amount::numeric-ve.debit_amount::numeric),0) AS net
     FROM voucher_entries ve
     JOIN vouchers v ON v.id=ve.voucher_id AND v.company_id=ve.company_id
       AND v.deleted_at IS NULL AND v.optional=FALSE
       AND COALESCE(v.effective_date,v.voucher_date)<=$2::date
     JOIN ledger_accounts la ON la.id=ve.ledger_account_id
       AND la.company_id=ve.company_id AND la.deleted_at IS NULL
     WHERE ve.company_id=$1
       AND la.account_type='Liability'
       AND (la.name='Accrued Rent Payable'
         OR la.code IN ('ACCR-RENT-PAY','ACC-RENT-PAY')
         OR la.code LIKE 'ACCR-RENT-PAY-%'
         OR la.code LIKE 'ACC-RENT-PAY-%')`,
    [companyId, asOf]
  );

  const operational = operationalRows[0] ?? {};
  const totalExpectedAsOf = Number(operational.total_expected_as_of ?? 0);
  const totalPostedPaid = Number(paymentBalRows[0]?.total_posted_paid ?? 0);
  const totalScheduledPending = Number(paymentBalRows[0]?.total_scheduled_pending ?? 0);
  const totalAccrualPayablePosted = Number(payableGL[0]?.net ?? 0);
  const netOutstanding = Number(operational.outstanding ?? 0);

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
      tenantRentPayable: Number(operational.tenant_payable ?? 0),
      landlordRentReceivable: Number(operational.landlord_receivable ?? 0),
      totalAppliedAgainstDueAsOf: Number(operational.applied_to_due ?? 0),
      prepaidRentAllocated: Number(operational.prepaid_future ?? 0),
    },
  };
}
