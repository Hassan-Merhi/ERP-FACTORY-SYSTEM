/**
 * Phase 3 historical accounting repair (accounting audit wave 16 A: reviewed
 * tool, no longer a boot step).
 *
 * It ran before every listen, for every company, adding and deleting lines
 * of posted vouchers (Purchases debits on legacy POs, Inventory legs on credit
 * and debit notes, a known duplicate POS import, payroll journal rebuilds,
 * a header-only marker), renaming, retyping and undeleting ledger accounts
 * found by code, with no audit, and failing the boot on any unbalanced voucher
 * of any company. It now runs only as an Owner preview/apply for the current
 * company:
 * - planPhase3HistoricalRepair (read-only) lists every voucher it would
 *   change, with the amounts, the vouchers it skips (PERIOD_CLOSED, by voucher
 *   and effective date) and a plan hash;
 * - applyPhase3HistoricalRepair runs in one transaction under an advisory
 *   lock, derives the plan again and applies it only when its hash is the
 *   reviewed one, retires (soft delete, voucherRetirement.ts) the duplicate
 *   payroll journals it used to hard-delete, releases posting identities
 *   instead of deleting them, never renames, retypes or undeletes an account
 *   (a code held by another account refuses the apply), checks the vouchers
 *   it touched balance, and writes one audit row with every line before and
 *   after in the same transaction.
 */
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "../../db";
import { MoneyDecimal } from "../../lib/money";
import { allocatePayrollAccountingAmounts, moneyFromCents } from "./payrollAccountingAmounts";
import {
  RETIRED_POSTING_IDENTITY_MARK,
  retireVouchersWithClient,
  type VoucherRetirementActor,
} from "./voucherRetirement";

export interface Phase3RepairVoucherRef {
  voucherId: number;
  voucherNumber: string;
  voucherDate: string;
  effectiveDate: string | null;
}

export interface Phase3HistoricalRepairPlan {
  companyId: number;
  /** Legacy USD POs posted with no debit: a Purchases debit of the total is added. */
  purchaseDebits: (Phase3RepairVoucherRef & { amount: string })[];
  /** Company 1, voucher 3000: the four duplicate POS import lines removed. */
  duplicatePosEntries: { voucherId: number; entryIds: number[]; amount: string } | null;
  /** Credit/debit notes posted one-sided: the Inventory leg of their items' value is added. */
  noteInventoryLegs: (Phase3RepairVoucherRef & { voucherType: string; side: "debit" | "credit"; amount: string })[];
  /** Unbalanced PAYROLL-GEN periods rebuilt from their payrolls; duplicates retired. */
  payrollPeriods: { periodStart: string; periodEnd: string; survivorId: number; duplicateIds: number[] }[];
  /** Company 10's empty JOURNAL-ICB-ADJ header, soft-deleted. */
  legacyMarker: { voucherId: number } | null;
  skipped: { voucherId: number; voucherNumber: string; reason: "PERIOD_CLOSED" }[];
  planHash: string;
}

export class Phase3RepairRefusal extends Error {
  constructor(
    readonly code: "PLAN_CHANGED" | "NOTHING_TO_APPLY" | "ACCOUNT_CODE_TAKEN" | "REPAIR_REFUSED",
    message: string
  ) {
    super(message);
    this.name = "Phase3RepairRefusal";
  }
}

const money = (value: string | number | null | undefined) => new MoneyDecimal(value ?? 0).toFixed(2);

type LedgerOptions = {
  subType?: string | null;
  parentId?: number | null;
};

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
  // Wave 16 (A): an account found by name is used as it is; one found only by
  // its code (another name, or deleted) is never renamed, retyped or undeleted.
  const live = await client.query<{ id: number }>(
    `SELECT id
       FROM ledger_accounts
      WHERE company_id = $1 AND name = $2 AND deleted_at IS NULL
      ORDER BY id
      LIMIT 1`,
    [companyId, name]
  );
  if (live.rows[0]) return live.rows[0].id;

  const byCode = await client.query<{ id: number }>(
    `SELECT id FROM ledger_accounts WHERE company_id = $1 AND code = $2 ORDER BY id LIMIT 1`,
    [companyId, code]
  );
  if (byCode.rows[0]) {
    throw new Phase3RepairRefusal(
      "ACCOUNT_CODE_TAKEN",
      `Account code ${code} is held by another account; the repair does not rename, retype or restore it`
    );
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
    throw new Error(
      `Phase 3 repair left voucher ${voucherId} unbalanced (${row?.debit ?? "missing"}/${row?.credit ?? "missing"})`
    );
  }
}

type VoucherRow = {
  id: number;
  voucher_number: string;
  voucher_date: string;
  effective_date: string | null;
};

/** The company's closed-books date, if any. */
async function lockedThrough(client: PoolClient, companyId: number): Promise<string | null> {
  const result = await client.query<{ locked: string | null }>(
    `SELECT max(period_end_date)::text AS locked FROM fiscal_period_closures WHERE company_id = $1 AND status = 'CLOSED'`,
    [companyId]
  );
  return result.rows[0]?.locked ?? null;
}

/** In a closed period by its voucher date or COALESCE(effective_date, voucher_date). */
function inClosedPeriod(locked: string | null, row: { voucher_date: string; effective_date: string | null }): boolean {
  if (!locked) return false;
  return row.voucher_date <= locked || (row.effective_date ?? row.voucher_date) <= locked;
}

const ref = (row: VoucherRow): Phase3RepairVoucherRef => ({
  voucherId: row.id,
  voucherNumber: row.voucher_number,
  voucherDate: row.voucher_date,
  effectiveDate: row.effective_date,
});

async function derivePlan(client: PoolClient, companyId: number): Promise<Phase3HistoricalRepairPlan> {
  const locked = await lockedThrough(client, companyId);
  const skipped: Phase3HistoricalRepairPlan["skipped"] = [];
  const open = <T extends VoucherRow>(rows: T[]): T[] =>
    rows.filter((row) => {
      if (!inClosedPeriod(locked, row)) return true;
      skipped.push({ voucherId: row.id, voucherNumber: row.voucher_number, reason: "PERIOD_CLOSED" });
      return false;
    });

  const purchases = await client.query<VoucherRow & { total_amount: string }>(
    `SELECT v.id, v.voucher_number, v.voucher_date::text AS voucher_date, v.effective_date::text AS effective_date,
            v.total_amount::text AS total_amount
       FROM vouchers v
       JOIN voucher_entries ve ON ve.voucher_id = v.id
      WHERE v.company_id = $1
        AND v.deleted_at IS NULL
        AND v.voucher_type = 'Purchase'
        AND v.voucher_number LIKE 'PO-PO-%'
        AND COALESCE(v.source_module, 'ERP') = 'ERP'
        AND upper(COALESCE(v.currency, 'USD')) = 'USD'
      GROUP BY v.id, v.voucher_number, v.voucher_date, v.effective_date, v.total_amount
     HAVING COALESCE(SUM(COALESCE(ve.base_debit_amount, ve.debit_amount, 0)),0) = 0
        AND abs(COALESCE(SUM(COALESCE(ve.base_credit_amount, ve.credit_amount, 0)),0) - v.total_amount) < 0.005
      ORDER BY v.id`,
    [companyId]
  );

  let duplicatePosEntries: Phase3HistoricalRepairPlan["duplicatePosEntries"] = null;
  if (companyId === 1) {
    const voucher = await client.query<VoucherRow & { total_amount: string }>(
      `SELECT id, voucher_number, voucher_date::text AS voucher_date, effective_date::text AS effective_date,
              total_amount::text AS total_amount
         FROM vouchers
        WHERE company_id = 1 AND id = 3000 AND voucher_number = 'SALES-1769602742935'
          AND voucher_type = 'Sales' AND description = 'POS Import - 38 items' AND deleted_at IS NULL
        LIMIT 1`
    );
    const found = open(voucher.rows)[0];
    if (found) {
      const bad = await client.query<{ id: number }>(
        `SELECT id FROM voucher_entries
          WHERE voucher_id = 3000 AND id = ANY($1::int[])
            AND (
              (id IN (8965,8967) AND COALESCE(base_debit_amount,debit_amount,0) = 22796.36 AND COALESCE(base_credit_amount,credit_amount,0) = 0)
              OR
              (id IN (8966,8968) AND COALESCE(base_credit_amount,credit_amount,0) = 22796.36 AND COALESCE(base_debit_amount,debit_amount,0) = 0)
            )
          ORDER BY id`,
        [[8965, 8966, 8967, 8968]]
      );
      if (bad.rows.length > 0 && bad.rows.length !== 4) {
        throw new Phase3RepairRefusal(
          "REPAIR_REFUSED",
          `Phase 3 refused duplicate-sale repair: voucher 3000 matched ${bad.rows.length}/4 corrupt entries`
        );
      }
      if (bad.rows.length === 4) {
        const remainder = await client.query<{ debit: string; credit: string }>(
          `SELECT COALESCE(SUM(COALESCE(base_debit_amount,debit_amount,0)),0)::text AS debit,
                  COALESCE(SUM(COALESCE(base_credit_amount,credit_amount,0)),0)::text AS credit
             FROM voucher_entries WHERE voucher_id = 3000 AND id <> ALL($1::int[])`,
          [[8965, 8966, 8967, 8968]]
        );
        const expected = money(found.total_amount);
        if (money(remainder.rows[0]?.debit) !== expected || money(remainder.rows[0]?.credit) !== expected) {
          throw new Phase3RepairRefusal(
            "REPAIR_REFUSED",
            "Phase 3 refused duplicate-sale repair: the preserved voucher 3000 entries do not equal its source total"
          );
        }
        duplicatePosEntries = { voucherId: 3000, entryIds: bad.rows.map((row) => row.id), amount: "22796.36" };
      }
    }
  }

  const notes = await client.query<VoucherRow & { voucher_type: string; inventory_value: string }>(
    `WITH ledger_totals AS (
       SELECT v.id, v.voucher_number, v.voucher_date, v.effective_date, v.voucher_type,
              COALESCE(SUM(COALESCE(ve.base_debit_amount,ve.debit_amount,0)),0) AS debit,
              COALESCE(SUM(COALESCE(ve.base_credit_amount,ve.credit_amount,0)),0) AS credit
         FROM vouchers v
         LEFT JOIN voucher_entries ve ON ve.voucher_id=v.id
        WHERE v.company_id=$1 AND v.deleted_at IS NULL
          AND v.voucher_type IN ('Credit Note','Debit Note')
        GROUP BY v.id
     ), item_value AS (
       SELECT cni.voucher_id,
              COALESCE(SUM(cni.quantity * COALESCE(cni.inventory_cost,cni.rate,0)),0) AS inventory_value
         FROM credit_note_items cni
         JOIN vouchers v ON v.id=cni.voucher_id
        WHERE v.company_id=$1 AND v.deleted_at IS NULL
        GROUP BY cni.voucher_id
     )
     SELECT lt.id, lt.voucher_number, lt.voucher_date::text AS voucher_date,
            lt.effective_date::text AS effective_date, lt.voucher_type, iv.inventory_value::text AS inventory_value
       FROM ledger_totals lt JOIN item_value iv ON iv.voucher_id=lt.id
      WHERE (lt.voucher_type='Credit Note' AND lt.debit=0 AND abs(lt.credit-iv.inventory_value)<0.005)
         OR (lt.voucher_type='Debit Note' AND lt.credit=0 AND abs(lt.debit-iv.inventory_value)<0.005)
      ORDER BY lt.id`,
    [companyId]
  );

  const badPayroll = await client.query<{ description: string }>(
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
  for (const row of badPayroll.rows) {
    const match = String(row.description ?? "").match(/\((\d{4}-\d{2}-\d{2})\s+[–-]\s+(\d{4}-\d{2}-\d{2})\)/);
    if (!match) {
      throw new Phase3RepairRefusal(
        "REPAIR_REFUSED",
        `Phase 3 could not parse payroll period from: ${row.description}`
      );
    }
    periods.set(`${match[1]}:${match[2]}`, { start: match[1], end: match[2] });
  }
  const payrollPeriods: Phase3HistoricalRepairPlan["payrollPeriods"] = [];
  for (const period of periods.values()) {
    const old = await client.query<VoucherRow>(
      `SELECT id, voucher_number, voucher_date::text AS voucher_date, effective_date::text AS effective_date
         FROM vouchers
        WHERE company_id=$1 AND deleted_at IS NULL AND voucher_number LIKE 'PAYROLL-GEN-%'
          AND voucher_date=$2::date AND description LIKE ('%' || $3 || '%')
        ORDER BY id`,
      [companyId, period.start, period.end]
    );
    const closed = old.rows.some((row) => inClosedPeriod(locked, row));
    if (closed || old.rows.length === 0) {
      for (const row of old.rows) {
        skipped.push({ voucherId: row.id, voucherNumber: row.voucher_number, reason: "PERIOD_CLOSED" });
      }
      continue;
    }
    payrollPeriods.push({
      periodStart: period.start,
      periodEnd: period.end,
      survivorId: old.rows[0].id,
      duplicateIds: old.rows.slice(1).map((row) => row.id),
    });
  }

  let legacyMarker: Phase3HistoricalRepairPlan["legacyMarker"] = null;
  if (companyId === 10) {
    const marker = await client.query<VoucherRow>(
      `SELECT v.id, v.voucher_number, v.voucher_date::text AS voucher_date, v.effective_date::text AS effective_date
         FROM vouchers v
        WHERE v.company_id=10 AND v.id=2663 AND v.voucher_number='JOURNAL-ICB-ADJ' AND v.voucher_type='Journal'
          AND v.description='Import Cycle Balance Adjustment - Opening HADI Credit' AND v.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM voucher_entries ve WHERE ve.voucher_id=v.id)`
    );
    const found = open(marker.rows)[0];
    if (found) legacyMarker = { voucherId: found.id };
  }

  const plan = {
    companyId,
    purchaseDebits: open(purchases.rows).map((row) => ({ ...ref(row), amount: money(row.total_amount) })),
    duplicatePosEntries,
    noteInventoryLegs: open(notes.rows).map((row) => ({
      ...ref(row),
      voucherType: row.voucher_type,
      side: row.voucher_type === "Credit Note" ? ("debit" as const) : ("credit" as const),
      amount: money(row.inventory_value),
    })),
    payrollPeriods,
    legacyMarker,
    skipped,
  };
  return { ...plan, planHash: createHash("sha256").update(JSON.stringify(plan)).digest("hex") };
}

function hasWork(plan: Phase3HistoricalRepairPlan): boolean {
  return (
    plan.purchaseDebits.length > 0 ||
    plan.duplicatePosEntries !== null ||
    plan.noteInventoryLegs.length > 0 ||
    plan.payrollPeriods.length > 0 ||
    plan.legacyMarker !== null
  );
}

async function voucherLines(client: PoolClient, voucherIds: number[]): Promise<Record<string, unknown>[]> {
  if (voucherIds.length === 0) return [];
  const result = await client.query(
    `SELECT id, voucher_id, ledger_account_id, debit_amount::text AS debit, credit_amount::text AS credit, narration
       FROM voucher_entries WHERE voucher_id = ANY($1::int[]) ORDER BY voucher_id, id`,
    [voucherIds]
  );
  return result.rows;
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
  period: Phase3HistoricalRepairPlan["payrollPeriods"][number],
  actor: VoucherRetirementActor
): Promise<void> {
  const { periodStart, periodEnd, survivorId: voucherId, duplicateIds } = period;
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
  if (payrolls.rows.length === 0) {
    throw new Phase3RepairRefusal(
      "REPAIR_REFUSED",
      `Phase 3 payroll repair found no source payrolls for ${periodStart}..${periodEnd}`
    );
  }

  let totalNetCents = 0;
  let totalAdvanceCents = 0;
  const workerRows: Array<{ workerName: string; salary: string; bonus: string; salaryId: number; bonusId: number }> =
    [];
  for (const row of payrolls.rows) {
    const accounting = allocatePayrollAccountingAmounts({
      netSalary: row.net_salary ?? "0",
      advances: row.advances ?? "0",
      bonus: row.bonuses ?? "0",
    });
    const workerName = row.full_name || `Worker #${row.worker_id}`;
    const ledgers = await ensurePayrollLedgers(client, companyId, row.worker_id, workerName);
    workerRows.push({ workerName, salary: accounting.salaryExpense, bonus: accounting.bonusExpense, ...ledgers });
    totalNetCents += accounting.netCents;
    totalAdvanceCents += accounting.advanceCents;
  }

  const payableId = await ensureLedger(client, companyId, "Payroll Payable", "PH3-PAYROLL-PAYABLE", "Liability");
  const advancesId = await ensureLedger(client, companyId, "Factory Worker Advances", "PH3-WORKER-ADV", "Asset");

  // Duplicates are retired (soft delete with their lines, audited), not hard-deleted.
  await retireVouchersWithClient(client, {
    voucherIds: duplicateIds,
    reason: "phase3-payroll-duplicate",
    actor,
  });
  // The survivor's posting identity is released, not deleted, before its payload changes.
  await client.query(
    `UPDATE accounting_posting_requests
        SET idempotency_key = idempotency_key || $3 || voucher_id::text
      WHERE company_id=$1 AND voucher_id=$2 AND position($3 in idempotency_key) = 0`,
    [companyId, voucherId, RETIRED_POSTING_IDENTITY_MARK]
  );

  const totalGrossCents = totalNetCents + totalAdvanceCents;
  const description = `Payroll expense: ${payrolls.rows.length} worker${payrolls.rows.length === 1 ? "" : "s"} (${periodStart} – ${periodEnd})`;
  await client.query(
    `UPDATE vouchers
        SET voucher_type='Journal', voucher_date=$3::date, description=$4, total_amount=$5,
            currency='USD', source_module='FACTORY', optional=false
      WHERE company_id=$1 AND id=$2 AND deleted_at IS NULL`,
    [companyId, voucherId, periodStart, description, moneyFromCents(totalGrossCents)]
  );
  await client.query(`DELETE FROM voucher_entries WHERE voucher_id=$1`, [voucherId]);

  for (const row of workerRows) {
    if (new MoneyDecimal(row.salary).gt(0)) {
      await insertUsdEntry(client, {
        voucherId,
        ledgerAccountId: row.salaryId,
        debit: row.salary,
        narration: `Salary - ${row.workerName} (${periodStart} – ${periodEnd})`,
      });
    }
    if (new MoneyDecimal(row.bonus).gt(0)) {
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

async function withCompanyClient<T>(companyId: number, work: (client: PoolClient) => Promise<T>, readOnly: boolean) {
  const client = await pool.connect();
  try {
    await client.query(readOnly ? "BEGIN READ ONLY" : "BEGIN");
    await scopeCompany(client, companyId);
    const result = await work(client);
    await client.query(readOnly ? "ROLLBACK" : "COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Read-only: what the repair would change for the company. */
export function planPhase3HistoricalRepair(companyId: number): Promise<Phase3HistoricalRepairPlan> {
  return withCompanyClient(companyId, (client) => derivePlan(client, companyId), true);
}

/**
 * Applies the reviewed plan for the company in one transaction, audited in it.
 * Refused (Phase3RepairRefusal) when the plan changed, there is nothing to
 * apply, or an account code it needs is held by another account.
 */
export function applyPhase3HistoricalRepair(
  companyId: number,
  options: { planHash: string; actor: VoucherRetirementActor }
): Promise<Phase3HistoricalRepairPlan> {
  return withCompanyClient(
    companyId,
    async (client) => {
      const plan = await derivePlan(client, companyId);
      if (plan.planHash !== options.planHash) {
        throw new Phase3RepairRefusal(
          "PLAN_CHANGED",
          "The repair plan changed since it was reviewed; review it again before applying"
        );
      }
      if (!hasWork(plan)) throw new Phase3RepairRefusal("NOTHING_TO_APPLY", "There is nothing to repair");

      const touched = [
        ...plan.purchaseDebits.map((row) => row.voucherId),
        ...(plan.duplicatePosEntries ? [plan.duplicatePosEntries.voucherId] : []),
        ...plan.noteInventoryLegs.map((row) => row.voucherId),
        ...plan.payrollPeriods.map((period) => period.survivorId),
      ];
      const before = await voucherLines(client, touched);

      if (plan.purchaseDebits.length > 0) {
        const purchasesAccountId = await ensureLedger(client, companyId, "Purchases", "PURCHASES", "Expense");
        for (const row of plan.purchaseDebits) {
          await insertUsdEntry(client, {
            voucherId: row.voucherId,
            ledgerAccountId: purchasesAccountId,
            debit: row.amount,
            narration: "Phase 3 repair - missing Purchases debit for legacy PO",
          });
        }
      }
      if (plan.duplicatePosEntries) {
        await client.query(`DELETE FROM voucher_entries WHERE voucher_id = $1 AND id = ANY($2::int[])`, [
          plan.duplicatePosEntries.voucherId,
          plan.duplicatePosEntries.entryIds,
        ]);
      }
      if (plan.noteInventoryLegs.length > 0) {
        const inventoryAccountId = await ensureLedger(client, companyId, "Inventory", "INVENTORY", "Asset", {
          subType: "Current Asset",
        });
        for (const row of plan.noteInventoryLegs) {
          await insertUsdEntry(client, {
            voucherId: row.voucherId,
            ledgerAccountId: inventoryAccountId,
            debit: row.side === "debit" ? row.amount : "0.00",
            credit: row.side === "credit" ? row.amount : "0.00",
            narration: `Phase 3 repair - ${row.voucherType} inventory control leg`,
          });
        }
      }
      for (const period of plan.payrollPeriods) {
        await rebuildPayrollPeriod(client, companyId, period, options.actor);
      }
      if (plan.legacyMarker) {
        await retireVouchersWithClient(client, {
          voucherIds: [plan.legacyMarker.voucherId],
          reason: "phase3-legacy-header-only-marker",
          actor: options.actor,
        });
      }
      for (const voucherId of new Set(touched)) await assertVoucherBalanced(client, companyId, voucherId);

      const after = await voucherLines(client, touched);
      await client.query(
        `INSERT INTO audit_log (user_id, username, company_id, action, table_name, record_identifier, changes)
         VALUES ($1, $2, $3, 'update', 'voucher_entries', 'phase3-historical-repair', $4::jsonb)`,
        [
          String(options.actor.userId),
          options.actor.username,
          companyId,
          JSON.stringify({
            lines: { old: before, new: after },
            plan: { new: { ...plan, skipped: plan.skipped } },
          }),
        ]
      );
      return plan;
    },
    false
  );
}
