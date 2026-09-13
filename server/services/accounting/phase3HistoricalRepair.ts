import type { PoolClient } from "pg";
import { pool } from "../../db";
import { logger } from "../../lib/logger";
import { allocatePayrollAccountingAmounts, moneyFromCents } from "./payrollAccountingAmounts";

export interface Phase3HistoricalRepairSummary {
  companiesChecked: number;
  purchaseDebitsAdded: number;
  duplicateSaleEntriesRemoved: number;
  noteInventoryLegsAdded: number;
  payrollPeriodsRebuilt: number;
  legacyMarkersRetired: number;
}

type LedgerOptions = {
  subType?: string | null;
  parentId?: number | null;
};

function dateText(value: unknown): string {
  return String(value ?? "").slice(0, 10);
}

async function scopeCompany(client: PoolClient, companyId: number): Promise<void> {
  await client.query("SELECT set_config('app.current_company_id', $1, true)", [String(companyId)]);
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`phase3-historical-repair:${companyId}`]);
}

async function ensureLedger(
  client: PoolClient,
  companyId: number,
  name: string,
  code: string,
  accountType: string,
  options: LedgerOptions = {}
): Promise<number> {
  const live = await client.query<{ id: number }>(
    `SELECT id
       FROM ledger_accounts
      WHERE company_id = $1 AND name = $2 AND deleted_at IS NULL
      ORDER BY id
      LIMIT 1`,
    [companyId, name]
  );
  if (live.rows[0]) {
    await client.query(
      `UPDATE ledger_accounts
          SET parent_id = COALESCE($3, parent_id),
              sub_type = COALESCE($4, sub_type),
              active = true
        WHERE company_id = $1 AND id = $2`,
      [companyId, live.rows[0].id, options.parentId ?? null, options.subType ?? null]
    );
    return live.rows[0].id;
  }

  const byCode = await client.query<{ id: number }>(
    `SELECT id FROM ledger_accounts WHERE company_id = $1 AND code = $2 ORDER BY id LIMIT 1`,
    [companyId, code]
  );
  if (byCode.rows[0]) {
    const id = byCode.rows[0].id;
    await client.query(
      `UPDATE ledger_accounts
          SET name = $3,
              account_type = $4,
              sub_type = COALESCE($5, sub_type),
              parent_id = COALESCE($6, parent_id),
              active = true,
              is_hidden = false,
              deleted_at = NULL
        WHERE company_id = $1 AND id = $2`,
      [companyId, id, name, accountType, options.subType ?? null, options.parentId ?? null]
    );
    return id;
  }

  const inserted = await client.query<{ id: number }>(
    `INSERT INTO ledger_accounts
       (company_id, code, name, account_type, sub_type, parent_id,
        opening_balance, opening_balance_side, active, is_hidden)
     VALUES ($1,$2,$3,$4,$5,$6,0,'Dr',true,false)
     RETURNING id`,
    [companyId, code, name, accountType, options.subType ?? null, options.parentId ?? null]
  );
  if (!inserted.rows[0]) throw new Error(`Phase 3 could not create ledger ${name} for company ${companyId}`);
  return inserted.rows[0].id;
}

async function insertUsdEntry(
  client: PoolClient,
  input: {
    voucherId: number;
    ledgerAccountId: number;
    debit?: string;
    credit?: string;
    narration: string;
  }
): Promise<void> {
  const debit = input.debit ?? "0.00";
  const credit = input.credit ?? "0.00";
  await client.query(
    `INSERT INTO voucher_entries
       (voucher_id, ledger_account_id, debit_amount, credit_amount,
        transaction_currency, transaction_debit_amount, transaction_credit_amount,
        base_debit_amount, base_credit_amount, historical_exchange_rate,
        rate_convention, narration)
     VALUES ($1,$2,$3,$4,'USD',$3,$4,$3,$4,1,'IDENTITY',$5)`,
    [input.voucherId, input.ledgerAccountId, debit, credit, input.narration]
  );
}

async function assertVoucherBalanced(client: PoolClient, companyId: number, voucherId: number): Promise<void> {
  const checked = await client.query<{ debit: string; credit: string }>(
    `SELECT
       COALESCE(SUM(COALESCE(ve.base_debit_amount, ve.debit_amount, 0)),0)::text AS debit,
       COALESCE(SUM(COALESCE(ve.base_credit_amount, ve.credit_amount, 0)),0)::text AS credit
     FROM vouchers v
     LEFT JOIN voucher_entries ve ON ve.voucher_id = v.id
     WHERE v.company_id = $1 AND v.id = $2
     GROUP BY v.id`,
    [companyId, voucherId]
  );
  const row = checked.rows[0];
  if (!row || row.debit !== row.credit) {
    throw new Error(`Phase 3 repair left voucher ${voucherId} unbalanced (${row?.debit ?? "missing"}/${row?.credit ?? "missing"})`);
  }
}

async function repairMissingPurchaseDebits(client: PoolClient, companyId: number): Promise<number> {
  const candidates = await client.query<{ id: number; total_amount: string }>(
    `SELECT v.id, v.total_amount::text
       FROM vouchers v
       JOIN voucher_entries ve ON ve.voucher_id = v.id
      WHERE v.company_id = $1
        AND v.deleted_at IS NULL
        AND v.voucher_type = 'Purchase'
        AND v.voucher_number LIKE 'PO-PO-%'
        AND COALESCE(v.source_module, 'ERP') = 'ERP'
        AND upper(COALESCE(v.currency, 'USD')) = 'USD'
      GROUP BY v.id, v.total_amount
     HAVING COALESCE(SUM(COALESCE(ve.base_debit_amount, ve.debit_amount, 0)),0) = 0
        AND abs(COALESCE(SUM(COALESCE(ve.base_credit_amount, ve.credit_amount, 0)),0) - v.total_amount) < 0.005`,
    [companyId]
  );
  if (candidates.rows.length === 0) return 0;

  const purchasesAccountId = await ensureLedger(client, companyId, "Purchases", "PURCHASES", "Expense");
  for (const candidate of candidates.rows) {
    await insertUsdEntry(client, {
      voucherId: candidate.id,
      ledgerAccountId: purchasesAccountId,
      debit: Number(candidate.total_amount).toFixed(2),
      narration: "Phase 3 repair - missing Purchases debit for legacy PO",
    });
    await assertVoucherBalanced(client, companyId, candidate.id);
  }
  return candidates.rows.length;
}

async function repairKnownDuplicatePosImport(client: PoolClient, companyId: number): Promise<number> {
  if (companyId !== 1) return 0;

  const voucher = await client.query<{ id: number; total_amount: string }>(
    `SELECT id, total_amount::text
       FROM vouchers
      WHERE company_id = 1
        AND id = 3000
        AND voucher_number = 'SALES-1769602742935'
        AND voucher_type = 'Sales'
        AND description = 'POS Import - 38 items'
        AND deleted_at IS NULL
      LIMIT 1`
  );
  if (!voucher.rows[0]) return 0;

  const bad = await client.query<{ id: number }>(
    `SELECT id
       FROM voucher_entries
      WHERE voucher_id = 3000
        AND id = ANY($1::int[])
        AND (
          (id IN (8965,8967) AND COALESCE(base_debit_amount,debit_amount,0) = 22796.36 AND COALESCE(base_credit_amount,credit_amount,0) = 0)
          OR
          (id IN (8966,8968) AND COALESCE(base_credit_amount,credit_amount,0) = 22796.36 AND COALESCE(base_debit_amount,debit_amount,0) = 0)
        )
      ORDER BY id`,
    [[8965, 8966, 8967, 8968]]
  );
  if (bad.rows.length === 0) return 0;
  if (bad.rows.length !== 4) {
    throw new Error(`Phase 3 refused duplicate-sale repair: voucher 3000 matched ${bad.rows.length}/4 corrupt entries`);
  }

  const remainder = await client.query<{ debit: string; credit: string }>(
    `SELECT
       COALESCE(SUM(COALESCE(base_debit_amount,debit_amount,0)),0)::text AS debit,
       COALESCE(SUM(COALESCE(base_credit_amount,credit_amount,0)),0)::text AS credit
     FROM voucher_entries
     WHERE voucher_id = 3000 AND id <> ALL($1::int[])`,
    [[8965, 8966, 8967, 8968]]
  );
  const expected = Number(voucher.rows[0].total_amount).toFixed(2);
  if (!remainder.rows[0] || Number(remainder.rows[0].debit).toFixed(2) !== expected || Number(remainder.rows[0].credit).toFixed(2) !== expected) {
    throw new Error("Phase 3 refused duplicate-sale repair: the preserved voucher 3000 entries do not equal its source total");
  }

  await client.query(`DELETE FROM voucher_entries WHERE voucher_id = 3000 AND id = ANY($1::int[])`, [[8965, 8966, 8967, 8968]]);
  await assertVoucherBalanced(client, companyId, 3000);
  return 4;
}

async function repairMissingNoteInventoryLegs(client: PoolClient, companyId: number): Promise<number> {
  const candidates = await client.query<{
    id: number;
    voucher_type: "Credit Note" | "Debit Note";
    debit: string;
    credit: string;
    inventory_value: string;
  }>(
    `WITH ledger_totals AS (
       SELECT v.id, v.voucher_type,
              COALESCE(SUM(COALESCE(ve.base_debit_amount,ve.debit_amount,0)),0) AS debit,
              COALESCE(SUM(COALESCE(ve.base_credit_amount,ve.credit_amount,0)),0) AS credit
         FROM vouchers v
         LEFT JOIN voucher_entries ve ON ve.voucher_id=v.id
        WHERE v.company_id=$1 AND v.deleted_at IS NULL
          AND v.voucher_type IN ('Credit Note','Debit Note')
        GROUP BY v.id,v.voucher_type
     ), item_value AS (
       SELECT cni.voucher_id,
              COALESCE(SUM(cni.quantity * COALESCE(cni.inventory_cost,cni.rate,0)),0) AS inventory_value
         FROM credit_note_items cni
         JOIN vouchers v ON v.id=cni.voucher_id
        WHERE v.company_id=$1 AND v.deleted_at IS NULL
        GROUP BY cni.voucher_id
     )
     SELECT lt.id,lt.voucher_type,lt.debit::text,lt.credit::text,iv.inventory_value::text
       FROM ledger_totals lt JOIN item_value iv ON iv.voucher_id=lt.id
      WHERE (lt.voucher_type='Credit Note' AND lt.debit=0 AND abs(lt.credit-iv.inventory_value)<0.005)
         OR (lt.voucher_type='Debit Note' AND lt.credit=0 AND abs(lt.debit-iv.inventory_value)<0.005)
      ORDER BY lt.id`,
    [companyId]
  );
  if (candidates.rows.length === 0) return 0;

  const inventoryAccountId = await ensureLedger(client, companyId, "Inventory", "INVENTORY", "Asset", {
    subType: "Current Asset",
  });
  for (const candidate of candidates.rows) {
    const amount = Number(candidate.inventory_value).toFixed(2);
    await insertUsdEntry(client, {
      voucherId: candidate.id,
      ledgerAccountId: inventoryAccountId,
      debit: candidate.voucher_type === "Credit Note" ? amount : "0.00",
      credit: candidate.voucher_type === "Debit Note" ? amount : "0.00",
      narration: `Phase 3 repair - ${candidate.voucher_type} inventory control leg`,
    });
    await assertVoucherBalanced(client, companyId, candidate.id);
  }
  return candidates.rows.length;
}

async function ensurePayrollLedgers(client: PoolClient, companyId: number, workerId: number, workerName: string) {
  const salaryGroup = await ensureLedger(client, companyId, "Salary Expense - Workers", "PH3-SAL-GRP", "Expense", {
    subType: "Group",
  });
  const bonusGroup = await ensureLedger(client, companyId, "Bonus Expense - Workers", "PH3-BON-GRP", "Expense", {
    subType: "Group",
  });
  const salaryId = await ensureLedger(
    client,
    companyId,
    `Salary Expense - ${workerName}`,
    `PH3-SAL-${workerId}`,
    "Expense",
    { parentId: salaryGroup }
  );
  const bonusId = await ensureLedger(
    client,
    companyId,
    `Bonus Expense - ${workerName}`,
    `PH3-BON-${workerId}`,
    "Expense",
    { parentId: bonusGroup }
  );
  return { salaryId, bonusId };
}

async function rebuildPayrollPeriod(
  client: PoolClient,
  companyId: number,
  periodStart: string,
  periodEnd: string
): Promise<void> {
  const payrolls = await client.query<{
    worker_id: number;
    full_name: string | null;
    net_salary: string;
    advances: string;
    bonuses: string;
  }>(
    `SELECT p.worker_id,w.full_name,p.net_salary::text,p.advances::text,p.bonuses::text
       FROM factory_payrolls p
       LEFT JOIN factory_workers w ON w.id=p.worker_id
      WHERE p.company_id=$1 AND p.period_start=$2::date AND p.period_end=$3::date
      ORDER BY p.id`,
    [companyId, periodStart, periodEnd]
  );
  if (payrolls.rows.length === 0) throw new Error(`Phase 3 payroll repair found no source payrolls for ${periodStart}..${periodEnd}`);

  let totalNetCents = 0;
  let totalAdvanceCents = 0;
  const workerRows: Array<{
    workerId: number;
    workerName: string;
    salary: string;
    bonus: string;
    salaryId: number;
    bonusId: number;
  }> = [];

  for (const row of payrolls.rows) {
    const accounting = allocatePayrollAccountingAmounts({
      netSalary: row.net_salary ?? "0",
      advances: row.advances ?? "0",
      bonus: row.bonuses ?? "0",
    });
    const workerName = row.full_name || `Worker #${row.worker_id}`;
    const ledgers = await ensurePayrollLedgers(client, companyId, row.worker_id, workerName);
    workerRows.push({
      workerId: row.worker_id,
      workerName,
      salary: accounting.salaryExpense,
      bonus: accounting.bonusExpense,
      ...ledgers,
    });
    totalNetCents += accounting.netCents;
    totalAdvanceCents += accounting.advanceCents;
  }

  const payableId = await ensureLedger(client, companyId, "Payroll Payable", "PH3-PAYROLL-PAYABLE", "Liability");
  const advancesId = await ensureLedger(client, companyId, "Factory Worker Advances", "PH3-WORKER-ADV", "Asset");
  const old = await client.query<{ id: number }>(
    `SELECT id FROM vouchers
      WHERE company_id=$1 AND voucher_number LIKE 'PAYROLL-GEN-%'
        AND voucher_date=$2::date AND description LIKE ('%' || $3 || '%')`,
    [companyId, periodStart, periodEnd]
  );
  const oldIds = old.rows.map((row) => row.id);
  if (oldIds.length > 0) {
    await client.query(`DELETE FROM accounting_posting_requests WHERE company_id=$1 AND voucher_id=ANY($2::int[])`, [companyId, oldIds]);
    await client.query(`DELETE FROM voucher_entries WHERE voucher_id=ANY($1::int[])`, [oldIds]);
    await client.query(`DELETE FROM vouchers WHERE company_id=$1 AND id=ANY($2::int[])`, [companyId, oldIds]);
  }

  const totalGrossCents = totalNetCents + totalAdvanceCents;
  const description = `Payroll expense: ${payrolls.rows.length} worker${payrolls.rows.length === 1 ? "" : "s"} (${periodStart} – ${periodEnd})`;
  const created = await client.query<{ id: number }>(
    `INSERT INTO vouchers
       (company_id,voucher_number,voucher_type,voucher_date,description,total_amount,currency,source_module,optional)
     VALUES ($1,$2,'Journal',$3::date,$4,$5,'USD','FACTORY',false)
     RETURNING id`,
    [companyId, `PH3-PAYROLL-GEN-${periodStart}-${periodEnd}`, periodStart, description, moneyFromCents(totalGrossCents)]
  );
  const voucherId = created.rows[0]?.id;
  if (!voucherId) throw new Error(`Phase 3 payroll repair could not create ${periodStart}..${periodEnd}`);

  for (const row of workerRows) {
    if (Number(row.salary) > 0) {
      await insertUsdEntry(client, {
        voucherId,
        ledgerAccountId: row.salaryId,
        debit: row.salary,
        narration: `Salary - ${row.workerName} (${periodStart} – ${periodEnd})`,
      });
    }
    if (Number(row.bonus) > 0) {
      await insertUsdEntry(client, {
        voucherId,
        ledgerAccountId: row.bonusId,
        debit: row.bonus,
        narration: `Bonus - ${row.workerName} (${periodStart} – ${periodEnd})`,
      });
    }
  }
  if (totalNetCents > 0) {
    await insertUsdEntry(client, {
      voucherId,
      ledgerAccountId: payableId,
      credit: moneyFromCents(totalNetCents),
      narration: description,
    });
  }
  if (totalAdvanceCents > 0) {
    await insertUsdEntry(client, {
      voucherId,
      ledgerAccountId: advancesId,
      credit: moneyFromCents(totalAdvanceCents),
      narration: `Advance deductions settled - ${payrolls.rows.length} worker${payrolls.rows.length === 1 ? "" : "s"} (${periodStart} – ${periodEnd})`,
    });
  }
  await assertVoucherBalanced(client, companyId, voucherId);
}

async function repairPayrollJournals(client: PoolClient, companyId: number): Promise<number> {
  const bad = await client.query<{ description: string }>(
    `SELECT v.description
       FROM vouchers v
       JOIN voucher_entries ve ON ve.voucher_id=v.id
      WHERE v.company_id=$1 AND v.deleted_at IS NULL
        AND v.voucher_type='Journal' AND v.voucher_number LIKE 'PAYROLL-GEN-%'
      GROUP BY v.id,v.description
     HAVING COALESCE(SUM(COALESCE(ve.base_debit_amount,ve.debit_amount,0)),0)
         <> COALESCE(SUM(COALESCE(ve.base_credit_amount,ve.credit_amount,0)),0)`,
    [companyId]
  );
  const periods = new Map<string, { start: string; end: string }>();
  for (const row of bad.rows) {
    const match = String(row.description ?? "").match(/\((\d{4}-\d{2}-\d{2})\s+[–-]\s+(\d{4}-\d{2}-\d{2})\)/);
    if (!match) throw new Error(`Phase 3 could not parse payroll period from: ${row.description}`);
    periods.set(`${match[1]}:${match[2]}`, { start: match[1], end: match[2] });
  }
  for (const period of periods.values()) {
    await rebuildPayrollPeriod(client, companyId, period.start, period.end);
  }
  return periods.size;
}

async function retireLegacyHeaderOnlyMarker(client: PoolClient, companyId: number): Promise<number> {
  if (companyId !== 10) return 0;
  const result = await client.query(
    `UPDATE vouchers v
        SET deleted_at=NOW()
      WHERE v.company_id=10 AND v.id=2663
        AND v.voucher_number='JOURNAL-ICB-ADJ'
        AND v.voucher_type='Journal'
        AND v.description='Import Cycle Balance Adjustment - Opening HADI Credit'
        AND v.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM voucher_entries ve WHERE ve.voucher_id=v.id)
      RETURNING v.id`
  );
  return result.rowCount ?? 0;
}

async function validateTrueDoubleEntry(client: PoolClient, companyId: number): Promise<void> {
  const broken = await client.query<{ id: number; voucher_number: string; voucher_type: string; debit: string; credit: string }>(
    `WITH totals AS (
       SELECT v.id,v.voucher_number,v.voucher_type,v.currency,v.total_amount,
              COALESCE(SUM(COALESCE(ve.base_debit_amount,ve.debit_amount,0)),0) AS debit,
              COALESCE(SUM(COALESCE(ve.base_credit_amount,ve.credit_amount,0)),0) AS credit
         FROM vouchers v LEFT JOIN voucher_entries ve ON ve.voucher_id=v.id
        WHERE v.company_id=$1 AND v.deleted_at IS NULL
          AND v.voucher_type IN ('Journal','Payment','Receipt','Sales','Purchase','Credit Note','Debit Note')
        GROUP BY v.id,v.voucher_number,v.voucher_type,v.currency,v.total_amount
     )
     SELECT id,voucher_number,voucher_type,debit::text,credit::text
       FROM totals
      WHERE debit<>credit
         OR (
           upper(COALESCE(currency,'USD'))='USD'
           AND voucher_type IN ('Journal','Payment','Receipt','Sales','Purchase')
           AND (abs(debit-total_amount)>=0.01 OR abs(credit-total_amount)>=0.01)
         )
      ORDER BY id
      LIMIT 25`,
    [companyId]
  );
  if (broken.rows.length > 0) {
    throw new Error(
      `Phase 3 historical repair left ${broken.rows.length} true double-entry exception(s) in company ${companyId}: ` +
        broken.rows.map((row) => `${row.id}/${row.voucher_number} ${row.debit}:${row.credit}`).join(", ")
    );
  }
}

async function repairCompany(companyId: number, summary: Phase3HistoricalRepairSummary): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await scopeCompany(client, companyId);

    summary.purchaseDebitsAdded += await repairMissingPurchaseDebits(client, companyId);
    summary.duplicateSaleEntriesRemoved += await repairKnownDuplicatePosImport(client, companyId);
    summary.noteInventoryLegsAdded += await repairMissingNoteInventoryLegs(client, companyId);
    summary.payrollPeriodsRebuilt += await repairPayrollJournals(client, companyId);
    summary.legacyMarkersRetired += await retireLegacyHeaderOnlyMarker(client, companyId);

    await validateTrueDoubleEntry(client, companyId);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * One-time-compatible, idempotent historical repair pass for Phase 3.
 *
 * Every mutation is guarded by a source-specific proof. Once repaired, the row
 * no longer matches the repair predicate, so repeated deployments are no-ops.
 * Ambiguous vouchers are never force-balanced: validation fails and startup is
 * aborted, leaving the previous Render instance serving traffic.
 */
export async function runPhase3HistoricalRepair(): Promise<Phase3HistoricalRepairSummary> {
  const companies = await pool.query<{ id: number }>("SELECT id FROM companies ORDER BY id");
  const summary: Phase3HistoricalRepairSummary = {
    companiesChecked: companies.rows.length,
    purchaseDebitsAdded: 0,
    duplicateSaleEntriesRemoved: 0,
    noteInventoryLegsAdded: 0,
    payrollPeriodsRebuilt: 0,
    legacyMarkersRetired: 0,
  };

  for (const company of companies.rows) {
    await repairCompany(Number(company.id), summary);
  }

  logger.info("Phase 3 historical accounting repair complete", {
    module: "phase3-accounting",
    action: "historical-repair",
    ...summary,
  });
  return summary;
}
