// Extracted from ./historicalRepair.ts to keep that module under the source-size cap.
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { MoneyDecimal } from "../../lib/money";

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

export async function scopeCompany(client: PoolClient, companyId: number): Promise<void> {
  await client.query("SELECT set_config('app.current_company_id', $1, true)", [String(companyId)]);
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`phase3-historical-repair:${companyId}`]);
}

export async function ensureLedger(
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

export async function insertUsdEntry(
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

export async function assertVoucherBalanced(client: PoolClient, companyId: number, voucherId: number): Promise<void> {
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

export async function derivePlan(client: PoolClient, companyId: number): Promise<Phase3HistoricalRepairPlan> {
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
