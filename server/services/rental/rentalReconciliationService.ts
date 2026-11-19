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
import { runRentalReconciliationPart1, type ReconciliationMismatch } from "./runRentalReconciliationPart1";
export type { ReconciliationMismatch } from "./runRentalReconciliationPart1";

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
  const { mismatches, contractRows, paymentRows, ledgerRows } = await runRentalReconciliationPart1(
    companyId,
    module,
    asOf
  );

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
