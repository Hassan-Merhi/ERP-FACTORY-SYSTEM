import crypto from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { pool } from "../../db";
import { normalizeOpeningBalanceCurrency } from "./openingBalanceCurrency";
import { normalizeVoucherEntryAmounts } from "./currencyAmounts";
import { ownKey } from "../../lib/sqlTextGuards";

export type HistoricalRepairKind =
  | "voucherEntry"
  | "ledger"
  | "bank"
  | "customer"
  | "supplier"
  | "employee"
  | "fixedAsset";

export interface HistoricalRepairInput {
  kind: HistoricalRepairKind;
  id: number;
  currency: string;
  historicalRate: string | number;
  transactionDebitAmount?: string | number;
  transactionCreditAmount?: string | number;
  nativeAmount?: string | number;
  baseAmount?: string | number;
  side?: "Dr" | "Cr";
  note?: string;
}

export interface HistoricalRepairCase {
  kind: HistoricalRepairKind;
  id: number;
  label: string;
  currency: string | null;
  rawAmount: string | null;
  currentRate: string | null;
  currentBaseAmount: string | null;
  voucherId?: number;
  voucherDate?: string;
  debitAmount?: string | null;
  creditAmount?: string | null;
  transactionDebitAmount?: string | null;
  transactionCreditAmount?: string | null;
  side?: string | null;
  versionTag: string;
}

export interface HistoricalRepairPlanItem {
  input: HistoricalRepairInput;
  before: HistoricalRepairCase;
  after: Record<string, string | null>;
}

export interface HistoricalRepairPlan {
  companyId: number;
  createdAt: string;
  itemCount: number;
  fingerprint: string;
  items: HistoricalRepairPlanItem[];
}

interface OpeningConfig {
  table: string;
  labelColumn: string;
  amountColumn: string;
  nativeColumn: string;
  currencyColumn: string;
  rateColumn: string;
  baseColumn: string;
  sideColumn?: string;
  companyColumn?: string;
  deletedColumn?: string;
}

const OPENING_CONFIG: Record<Exclude<HistoricalRepairKind, "voucherEntry">, OpeningConfig> = {
  ledger: {
    table: "ledger_accounts",
    labelColumn: "name",
    amountColumn: "opening_balance",
    nativeColumn: "opening_balance_native_amount",
    currencyColumn: "opening_balance_currency",
    rateColumn: "opening_balance_historical_rate",
    baseColumn: "opening_balance_base_amount",
    sideColumn: "opening_balance_side",
    companyColumn: "company_id",
    deletedColumn: "deleted_at",
  },
  bank: {
    table: "bank_accounts",
    labelColumn: "name",
    amountColumn: "opening_balance",
    nativeColumn: "opening_balance_native_amount",
    currencyColumn: "opening_balance_currency",
    rateColumn: "opening_balance_historical_rate",
    baseColumn: "opening_balance_base_amount",
    sideColumn: "opening_balance_side",
    companyColumn: "company_id",
    deletedColumn: "deleted_at",
  },
  customer: {
    table: "customers",
    labelColumn: "legal_name",
    amountColumn: "opening_balance",
    nativeColumn: "opening_balance_native_amount",
    currencyColumn: "opening_balance_currency",
    rateColumn: "opening_balance_historical_rate",
    baseColumn: "opening_balance_base_amount",
    sideColumn: "opening_balance_side",
    companyColumn: "company_id",
    deletedColumn: "deleted_at",
  },
  supplier: {
    table: "suppliers",
    labelColumn: "legal_name",
    amountColumn: "opening_balance",
    nativeColumn: "opening_balance_native_amount",
    currencyColumn: "opening_balance_currency",
    rateColumn: "opening_balance_historical_rate",
    baseColumn: "opening_balance_base_amount",
    sideColumn: "opening_balance_side",
    deletedColumn: "deleted_at",
  },
  employee: {
    table: "employees",
    labelColumn: "CONCAT_WS(' ', first_name, last_name)",
    amountColumn: "opening_balance",
    nativeColumn: "opening_balance_native_amount",
    currencyColumn: "opening_balance_currency",
    rateColumn: "opening_balance_historical_rate",
    baseColumn: "opening_balance_base_amount",
    sideColumn: "opening_balance_side",
    companyColumn: "company_id",
    deletedColumn: "deleted_at",
  },
  fixedAsset: {
    table: "fixed_assets",
    labelColumn: "name",
    amountColumn: "purchase_amount",
    nativeColumn: "purchase_native_amount",
    currencyColumn: "purchase_currency",
    rateColumn: "purchase_historical_rate",
    baseColumn: "purchase_base_amount",
    companyColumn: "company_id",
  },
};

function asPositiveId(value: unknown): number {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("Repair row id must be a positive integer");
  return parsed;
}

function stableFingerprint(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function versionTag(row: Record<string, unknown>): string {
  return stableFingerprint(row);
}

async function getBaseCurrency(companyId: number, client = pool): Promise<string> {
  const result = await client.query<{ base_currency: string | null }>(
    "SELECT base_currency FROM companies WHERE id = $1",
    [companyId]
  );
  return String(result.rows[0]?.base_currency || "USD").toUpperCase();
}

function supplierScope(alias: string): string {
  return `EXISTS (
    SELECT 1 FROM voucher_entries ve
    JOIN vouchers v ON v.id = ve.voucher_id
    WHERE ve.supplier_id = ${alias}.id
      AND v.company_id = $2
      AND v.deleted_at IS NULL
  )`;
}

async function loadVoucherEntryCase(
  companyId: number,
  id: number,
  client: Pool | PoolClient = pool
): Promise<HistoricalRepairCase | null> {
  const result = await client.query(
    `SELECT ve.id, ve.voucher_id, v.voucher_date, v.currency AS voucher_currency,
            ve.transaction_currency, ve.transaction_debit_amount, ve.transaction_credit_amount,
            ve.base_debit_amount, ve.base_credit_amount, ve.historical_exchange_rate,
            ve.debit_amount, ve.credit_amount, COALESCE(ve.narration, v.description, v.voucher_number) AS label
       FROM voucher_entries ve
       JOIN vouchers v ON v.id = ve.voucher_id
      WHERE ve.id = $1 AND v.company_id = $2 AND v.deleted_at IS NULL AND v.optional = false
      LIMIT 1`,
    [id, companyId]
  );
  const row = result.rows[0];
  if (!row) return null;
  const snapshot = {
    id: row.id,
    voucherId: row.voucher_id,
    voucherDate: row.voucher_date,
    currency: row.transaction_currency || row.voucher_currency || "USD",
    transactionDebitAmount: row.transaction_debit_amount,
    transactionCreditAmount: row.transaction_credit_amount,
    baseDebitAmount: row.base_debit_amount,
    baseCreditAmount: row.base_credit_amount,
    historicalRate: row.historical_exchange_rate,
    debitAmount: row.debit_amount,
    creditAmount: row.credit_amount,
  };
  return {
    kind: "voucherEntry",
    id: row.id,
    label: row.label || `Voucher entry #${row.id}`,
    currency: snapshot.currency,
    rawAmount: String(Number(row.debit_amount || 0) + Number(row.credit_amount || 0)),
    currentRate: row.historical_exchange_rate,
    currentBaseAmount: String(Number(row.base_debit_amount || 0) + Number(row.base_credit_amount || 0)),
    voucherId: row.voucher_id,
    voucherDate: String(row.voucher_date),
    debitAmount: row.debit_amount,
    creditAmount: row.credit_amount,
    transactionDebitAmount: row.transaction_debit_amount,
    transactionCreditAmount: row.transaction_credit_amount,
    versionTag: versionTag(snapshot),
  };
}

async function loadOpeningCase(
  companyId: number,
  kind: Exclude<HistoricalRepairKind, "voucherEntry">,
  id: number,
  client: Pool | PoolClient = pool
): Promise<HistoricalRepairCase | null> {
  if (!ownKey(OPENING_CONFIG, kind)) throw new Error("historical_repair_unknown_kind");
  const config = OPENING_CONFIG[kind];
  const clauses = ["target.id = $1"];
  if (config.companyColumn) clauses.push(`target.${config.companyColumn} = $2`);
  else clauses.push(supplierScope("target"));
  if (config.deletedColumn) clauses.push(`target.${config.deletedColumn} IS NULL`);
  const result = await client.query(
    `SELECT target.id, ${config.labelColumn} AS label,
            target.${config.amountColumn}::text AS raw_amount,
            target.${config.nativeColumn}::text AS native_amount,
            target.${config.currencyColumn} AS currency,
            target.${config.rateColumn}::text AS historical_rate,
            target.${config.baseColumn}::text AS base_amount
            ${config.sideColumn ? `, target.${config.sideColumn} AS side` : ""}
       FROM ${config.table} target
      WHERE ${clauses.join(" AND ")}
      LIMIT 1`,
    [id, companyId]
  );
  const row = result.rows[0];
  if (!row) return null;
  const snapshot = {
    id: row.id,
    rawAmount: row.raw_amount,
    nativeAmount: row.native_amount,
    currency: row.currency,
    historicalRate: row.historical_rate,
    baseAmount: row.base_amount,
    side: row.side || null,
  };
  return {
    kind,
    id: row.id,
    label: row.label || `${kind} #${row.id}`,
    currency: row.currency,
    rawAmount: row.raw_amount,
    currentRate: row.historical_rate,
    currentBaseAmount: row.base_amount,
    side: row.side || null,
    versionTag: versionTag(snapshot),
  };
}

export async function loadHistoricalRepairCase(
  companyId: number,
  kind: HistoricalRepairKind,
  id: number,
  client: Pool | PoolClient = pool
): Promise<HistoricalRepairCase | null> {
  return kind === "voucherEntry"
    ? loadVoucherEntryCase(companyId, id, client)
    : loadOpeningCase(companyId, kind, id, client);
}

export async function listHistoricalRepairCases(companyId: number): Promise<HistoricalRepairCase[]> {
  const entryResult = await pool.query<{ id: number }>(
    `SELECT ve.id
       FROM voucher_entries ve
       JOIN vouchers v ON v.id = ve.voucher_id
      WHERE v.company_id = $1 AND v.optional = false AND v.deleted_at IS NULL
        AND COALESCE(UPPER(v.currency), 'USD') <> 'USD'
        AND (ve.base_debit_amount IS NULL OR ve.base_credit_amount IS NULL)
      ORDER BY v.voucher_date, v.id, ve.id
      LIMIT 500`,
    [companyId]
  );
  const openingResult = await pool.query<{ kind: HistoricalRepairKind; id: number }>(
    `SELECT * FROM (
       SELECT 'ledger'::text AS kind, id FROM ledger_accounts WHERE company_id = $1 AND deleted_at IS NULL AND COALESCE(opening_balance, 0)::numeric <> 0 AND opening_balance_base_amount IS NULL
       UNION ALL SELECT 'bank', id FROM bank_accounts WHERE company_id = $1 AND deleted_at IS NULL AND COALESCE(opening_balance, 0)::numeric <> 0 AND opening_balance_base_amount IS NULL
       UNION ALL SELECT 'customer', id FROM customers WHERE company_id = $1 AND deleted_at IS NULL AND COALESCE(opening_balance, 0)::numeric <> 0 AND opening_balance_base_amount IS NULL
       UNION ALL SELECT 'supplier', s.id FROM suppliers s WHERE s.deleted_at IS NULL AND COALESCE(s.opening_balance, 0)::numeric <> 0 AND s.opening_balance_base_amount IS NULL AND ${supplierScope("s")}
       UNION ALL SELECT 'employee', id FROM employees WHERE company_id = $1 AND deleted_at IS NULL AND COALESCE(opening_balance, 0)::numeric <> 0 AND opening_balance_base_amount IS NULL
       UNION ALL SELECT 'fixedAsset', id FROM fixed_assets WHERE company_id = $1 AND COALESCE(purchase_amount, 0)::numeric <> 0 AND purchase_base_amount IS NULL
     ) unresolved ORDER BY kind, id LIMIT 500`,
    [companyId, companyId]
  );
  const cases: HistoricalRepairCase[] = [];
  for (const row of entryResult.rows) {
    const found = await loadVoucherEntryCase(companyId, row.id);
    if (found) cases.push(found);
  }
  for (const row of openingResult.rows) {
    const found = await loadOpeningCase(companyId, row.kind as Exclude<HistoricalRepairKind, "voucherEntry">, row.id);
    if (found) cases.push(found);
  }
  return cases;
}

function normalizePlanAfter(
  input: HistoricalRepairInput,
  before: HistoricalRepairCase,
  baseCurrency: string
): Record<string, string | null> {
  const currency = String(input.currency || before.currency || "")
    .trim()
    .toUpperCase();
  if (!currency) throw new Error(`${input.kind} #${input.id}: currency is required`);
  if (input.kind === "voucherEntry") {
    const normalized = normalizeVoucherEntryAmounts({
      transactionCurrency: currency,
      baseCurrency,
      transactionDebitAmount:
        input.transactionDebitAmount ?? before.transactionDebitAmount ?? before.debitAmount ?? "0",
      transactionCreditAmount:
        input.transactionCreditAmount ?? before.transactionCreditAmount ?? before.creditAmount ?? "0",
      historicalRate: input.historicalRate,
    });
    return {
      transactionCurrency: normalized.transactionCurrency,
      transactionDebitAmount: normalized.transactionDebitAmount,
      transactionCreditAmount: normalized.transactionCreditAmount,
      baseDebitAmount: normalized.baseDebitAmount,
      baseCreditAmount: normalized.baseCreditAmount,
      historicalExchangeRate: normalized.historicalExchangeRate,
      rateConvention: normalized.rateConvention,
      debitAmount: normalized.debitAmount,
      creditAmount: normalized.creditAmount,
    };
  }
  const normalized = normalizeOpeningBalanceCurrency({
    openingBalance: input.nativeAmount ?? before.rawAmount ?? "0",
    openingBalanceCurrency: currency,
    openingBalanceHistoricalRate: input.historicalRate,
    openingBalanceBaseAmount: input.baseAmount,
    baseCurrency,
  });
  return {
    nativeAmount: normalized.openingBalanceNativeAmount,
    currency: normalized.openingBalanceCurrency,
    historicalRate: normalized.openingBalanceHistoricalRate,
    baseAmount: normalized.openingBalanceBaseAmount,
    side: input.kind === "supplier" || input.kind === "employee" ? "Cr" : (input.side ?? before.side ?? "Dr"),
  };
}

export async function planHistoricalCurrencyRepairs(
  companyId: number,
  repairs: HistoricalRepairInput[]
): Promise<HistoricalRepairPlan> {
  if (!Array.isArray(repairs) || repairs.length === 0) throw new Error("At least one approved repair is required");
  if (repairs.length > 200) throw new Error("A repair batch cannot exceed 200 rows");
  const baseCurrency = await getBaseCurrency(companyId);
  const items: HistoricalRepairPlanItem[] = [];
  const seen = new Set<string>();
  for (const raw of repairs) {
    const input = { ...raw, id: asPositiveId(raw.id) };
    const key = `${input.kind}:${input.id}`;
    if (seen.has(key)) throw new Error(`Duplicate repair row: ${key}`);
    seen.add(key);
    const before = await loadHistoricalRepairCase(companyId, input.kind, input.id);
    if (!before) throw new Error(`${input.kind} #${input.id} was not found in the selected company`);
    items.push({ input, before, after: normalizePlanAfter(input, before, baseCurrency) });
  }
  const fingerprint = stableFingerprint(
    items.map(({ input, before, after }) => ({ input, versionTag: before.versionTag, after }))
  );
  return { companyId, createdAt: new Date().toISOString(), itemCount: items.length, fingerprint, items };
}

async function insertAudit(
  client: PoolClient,
  actor: { userId: string; username: string },
  companyId: number,
  item: HistoricalRepairPlanItem
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (user_id, username, company_id, action, table_name, record_id, record_identifier, changes)
     VALUES ($1, $2, $3, 'repair', $4, $5, $6, $7::jsonb)`,
    [
      actor.userId,
      actor.username,
      companyId,
      item.input.kind === "voucherEntry" ? "voucher_entries" : OPENING_CONFIG[item.input.kind].table,
      item.input.id,
      `historical-currency:${item.input.kind}:${item.input.id}`,
      JSON.stringify({ before: item.before, after: item.after, note: item.input.note || null }),
    ]
  );
}

async function applyPlanItem(client: PoolClient, companyId: number, item: HistoricalRepairPlanItem): Promise<void> {
  const current = await loadHistoricalRepairCase(companyId, item.input.kind, item.input.id, client);
  if (!current || current.versionTag !== item.before.versionTag) {
    throw new Error(`${item.input.kind} #${item.input.id} changed after preview; run the dry-run again`);
  }
  if (item.input.kind === "voucherEntry") {
    const after = item.after;
    await client.query(
      `UPDATE voucher_entries
          SET transaction_currency = $1, transaction_debit_amount = $2, transaction_credit_amount = $3,
              base_debit_amount = $4, base_credit_amount = $5, historical_exchange_rate = $6,
              rate_convention = $7, debit_amount = $8, credit_amount = $9
        WHERE id = $10`,
      [
        after.transactionCurrency,
        after.transactionDebitAmount,
        after.transactionCreditAmount,
        after.baseDebitAmount,
        after.baseCreditAmount,
        after.historicalExchangeRate,
        after.rateConvention,
        after.debitAmount,
        after.creditAmount,
        item.input.id,
      ]
    );
    return;
  }
  if (!ownKey(OPENING_CONFIG, item.input.kind)) throw new Error("historical_repair_unknown_kind");
  const config = OPENING_CONFIG[item.input.kind];
  const assignments = [
    `${config.amountColumn} = $1`,
    `${config.nativeColumn} = $2`,
    `${config.currencyColumn} = $3`,
    `${config.rateColumn} = $4`,
    `${config.baseColumn} = $5`,
  ];
  const values: Array<string | number | null> = [
    item.after.baseAmount,
    item.after.nativeAmount,
    item.after.currency,
    item.after.historicalRate,
    item.after.baseAmount,
  ];
  if (config.sideColumn) {
    assignments.push(`${config.sideColumn} = $6`);
    values.push(item.after.side);
  }
  values.push(item.input.id);
  await client.query(`UPDATE ${config.table} SET ${assignments.join(", ")} WHERE id = $${values.length}`, values);
}

export async function applyHistoricalCurrencyRepairPlan(
  plan: HistoricalRepairPlan,
  actor: { userId: string; username: string }
): Promise<{ appliedCount: number; fingerprint: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('historical-currency-repair'), $1)", [plan.companyId]);
    for (const item of plan.items) {
      await applyPlanItem(client, plan.companyId, item);
      await insertAudit(client, actor, plan.companyId, item);
    }
    await client.query("COMMIT");
    return { appliedCount: plan.items.length, fingerprint: plan.fingerprint };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
