import type { PoolClient } from "pg";
import { pool } from "../../db";
import { logger } from "../../lib/logger";

export interface Phase3PayrollDaybookRepairSummary {
  companiesChecked: number;
  legacyRowsRelinked: number;
  missingRowsInserted: number;
  zeroAmountBulkMarkersRemoved: number;
}

async function scopeCompany(client: PoolClient, companyId: number): Promise<void> {
  await client.query("SELECT set_config('app.current_company_id', $1, true)", [String(companyId)]);
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`phase3-payroll-daybook:${companyId}`]);
}

async function repairCompany(
  client: PoolClient,
  companyId: number
): Promise<{ relinked: number; inserted: number; removed: number }> {
  await scopeCompany(client, companyId);

  // Early payroll writers stored reference_id but omitted reference_table. Relink
  // only rows whose id and amount both match an existing PAID payroll exactly.
  const relinked = await client.query(
    `UPDATE factory_daybook_entries d
        SET reference_table = 'factory_payrolls'
       FROM factory_payrolls p
      WHERE d.company_id = $1
        AND p.company_id = d.company_id
        AND d.tx_type = 'PAYROLL_PAYMENT'
        AND d.reference_table IS NULL
        AND d.reference_id = p.id
        AND upper(COALESCE(p.status,'')) = 'PAID'
        AND abs(d.amount_usd - p.net_salary) < 0.005
        AND NOT EXISTS (
          SELECT 1 FROM factory_daybook_entries x
          WHERE x.company_id=d.company_id
            AND x.tx_type='PAYROLL_PAYMENT'
            AND x.reference_table='factory_payrolls'
            AND x.reference_id=p.id
        )
      RETURNING d.id`,
    [companyId]
  );

  // Old bulk mark-paid wrote one zero-value marker for the whole batch. Those
  // rows do not represent money movement and have no source identity; once the
  // per-payroll mirrors are reconstructed they are redundant noise.
  const removed = await client.query(
    `DELETE FROM factory_daybook_entries
      WHERE company_id=$1
        AND tx_type='PAYROLL_PAYMENT'
        AND reference_table IS NULL
        AND reference_id IS NULL
        AND amount_currency=0
        AND amount_usd=0
        AND description LIKE 'Payroll bulk paid:%'
      RETURNING id`,
    [companyId]
  );

  // Recreate a missing Daybook mirror only when the payroll's persisted payment
  // evidence is unambiguous: exactly one live Payment voucher, header=net salary,
  // balanced debit/credit=net salary, and the selected cash account was credited
  // by that same amount. The voucher date is the authoritative payment date.
  const inserted = await client.query(
    `WITH payment_evidence AS (
       SELECT
         p.id AS payroll_id,
         p.company_id,
         p.worker_id,
         p.period_start,
         p.period_end,
         p.net_salary,
         p.cash_account_id,
         MIN(pv.voucher_date) AS payment_date,
         COUNT(DISTINCT pv.id) AS voucher_count,
         COALESCE(SUM(DISTINCT pv.total_amount),0) AS voucher_total,
         COALESCE(SUM(COALESCE(ve.base_debit_amount,ve.debit_amount,0)),0) AS debit,
         COALESCE(SUM(COALESCE(ve.base_credit_amount,ve.credit_amount,0)),0) AS credit,
         COALESCE(SUM(
           CASE WHEN ve.ledger_account_id=p.cash_account_id
                THEN COALESCE(ve.base_credit_amount,ve.credit_amount,0)
                ELSE 0 END
         ),0) AS cash_credit
       FROM factory_payrolls p
       JOIN vouchers pv
         ON pv.company_id=p.company_id
        AND pv.deleted_at IS NULL
        AND pv.voucher_type='Payment'
        AND pv.voucher_number LIKE ('PAYMENT-PAY-' || p.id::text || '-%')
       JOIN voucher_entries ve ON ve.voucher_id=pv.id
       WHERE p.company_id=$1
         AND upper(COALESCE(p.status,''))='PAID'
         AND p.net_salary<>0
         AND p.cash_account_id IS NOT NULL
       GROUP BY p.id,p.company_id,p.worker_id,p.period_start,p.period_end,p.net_salary,p.cash_account_id
       HAVING COUNT(DISTINCT pv.id)=1
          AND abs(COALESCE(SUM(DISTINCT pv.total_amount),0)-p.net_salary)<0.005
          AND abs(COALESCE(SUM(COALESCE(ve.base_debit_amount,ve.debit_amount,0)),0)-p.net_salary)<0.005
          AND abs(COALESCE(SUM(COALESCE(ve.base_credit_amount,ve.credit_amount,0)),0)-p.net_salary)<0.005
          AND abs(COALESCE(SUM(
            CASE WHEN ve.ledger_account_id=p.cash_account_id
                 THEN COALESCE(ve.base_credit_amount,ve.credit_amount,0)
                 ELSE 0 END
          ),0)-p.net_salary)<0.005
     )
     INSERT INTO factory_daybook_entries
       (company_id,tx_date,tx_type,reference_id,reference_table,description,
        currency_code,amount_currency,fx_rate_to_usd,amount_usd,created_by)
     SELECT
       e.company_id,
       e.payment_date,
       'PAYROLL_PAYMENT',
       e.payroll_id,
       'factory_payrolls',
       'Payroll paid: ' || COALESCE(NULLIF(trim(w.full_name),''),'Worker #' || e.worker_id::text)
         || ' – ' || to_char(e.net_salary,'FM999999999990.00')
         || ' (' || e.period_start::text || ' – ' || e.period_end::text || ')',
       'USD',e.net_salary,1,e.net_salary,'phase3-historical-repair'
     FROM payment_evidence e
     LEFT JOIN factory_workers w ON w.id=e.worker_id
     WHERE NOT EXISTS (
       SELECT 1 FROM factory_daybook_entries d
       WHERE d.company_id=e.company_id
         AND d.tx_type='PAYROLL_PAYMENT'
         AND d.reference_table='factory_payrolls'
         AND d.reference_id=e.payroll_id
     )
     RETURNING id`,
    [companyId]
  );

  // The Phase 3 invariant for non-zero PAID payrolls is strict after repair.
  // Any remaining row means the source payment evidence was ambiguous or broken,
  // so fail closed instead of fabricating a Daybook record.
  const unresolved = await client.query<{ id: number }>(
    `SELECT p.id
       FROM factory_payrolls p
      WHERE p.company_id=$1
        AND upper(COALESCE(p.status,''))='PAID'
        AND p.net_salary<>0
        AND (
          SELECT COUNT(*)
          FROM factory_daybook_entries d
          WHERE d.company_id=p.company_id
            AND d.tx_type='PAYROLL_PAYMENT'
            AND d.reference_table='factory_payrolls'
            AND d.reference_id=p.id
        ) <> 1
      LIMIT 25`,
    [companyId]
  );
  if (unresolved.rows.length > 0) {
    throw new Error(
      `Phase 3 payroll Daybook repair could not prove ${unresolved.rows.length} payroll mirror(s) in company ${companyId}: ` +
        unresolved.rows.map((row) => row.id).join(", ")
    );
  }

  const wrongAmount = await client.query<{ id: number }>(
    `SELECT p.id
       FROM factory_payrolls p
       JOIN factory_daybook_entries d
         ON d.company_id=p.company_id
        AND d.tx_type='PAYROLL_PAYMENT'
        AND d.reference_table='factory_payrolls'
        AND d.reference_id=p.id
      WHERE p.company_id=$1
        AND upper(COALESCE(p.status,''))='PAID'
        AND p.net_salary<>0
        AND abs(d.amount_usd-p.net_salary)>=0.005
      LIMIT 25`,
    [companyId]
  );
  if (wrongAmount.rows.length > 0) {
    throw new Error(
      `Phase 3 payroll Daybook repair found amount mismatch(es) in company ${companyId}: ` +
        wrongAmount.rows.map((row) => row.id).join(", ")
    );
  }

  return {
    relinked: relinked.rowCount ?? 0,
    inserted: inserted.rowCount ?? 0,
    removed: removed.rowCount ?? 0,
  };
}

/** Idempotent repair/backfill for payroll ↔ payment ↔ Daybook convergence. */
export async function runPhase3PayrollDaybookRepair(): Promise<Phase3PayrollDaybookRepairSummary> {
  const companies = await pool.query<{ id: number }>("SELECT id FROM companies ORDER BY id");
  const summary: Phase3PayrollDaybookRepairSummary = {
    companiesChecked: companies.rows.length,
    legacyRowsRelinked: 0,
    missingRowsInserted: 0,
    zeroAmountBulkMarkersRemoved: 0,
  };

  for (const company of companies.rows) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await repairCompany(client, Number(company.id));
      summary.legacyRowsRelinked += result.relinked;
      summary.missingRowsInserted += result.inserted;
      summary.zeroAmountBulkMarkersRemoved += result.removed;
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  logger.info("Phase 3 payroll Daybook repair complete", {
    module: "phase3-accounting",
    action: "payroll-daybook-repair",
    ...summary,
  });
  return summary;
}
