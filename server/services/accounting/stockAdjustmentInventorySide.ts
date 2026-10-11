/**
 * One-sided stock adjustment vouchers: an Owner preview/apply that gives them
 * their Inventory side (merge of main 365cf55, replacing its boot backfill).
 *
 * main's 2bf7351 balanced every old Production / Consumption / Mixed / Stock
 * Adjustment voucher whose lines are all on the adjustment accounts by adding
 * a mirror on INVENTORY, as a boot step over every company, with no audit, no
 * review and a rename/retype/undelete of the INVENTORY account. Under the
 * accounting audit's rules (no boot-time history rewrites, history changes
 * only through a reviewed tool) it runs only as:
 *
 * - planStockAdjustmentInventorySide (read-only): every voucher it would give
 *   an Inventory line, with the amount and side, the vouchers it skips with
 *   the reason, blockers, and a sha256 plan hash;
 * - applyStockAdjustmentInventorySide: current company only, one transaction
 *   (company scope, advisory lock, the vouchers locked FOR UPDATE), the plan
 *   derived again and applied only when its hash is the reviewed one
 *   (PLAN_CHANGED), each voucher checked to balance, one audit row with every
 *   line before and after in the same transaction. The closed-period trigger
 *   is never bypassed and closed-period vouchers are skipped in the plan.
 *
 * What it writes, and how it fits the perpetual model (wave 8.3 / 11):
 * - Under periodic inventory (before the company's cut-over) a one-sided
 *   stock adjustment is correct by design and the balance guard exempts it;
 *   this tool is optional. When applied, each voucher gets ONE line on the
 *   canonical INVENTORY account for the net of its other lines (production
 *   Dr Inventory, consumption Cr Inventory), USD, marked with the narration
 *   syncStockAdjustmentInventoryTx owns. So a later edit, re-date, optional
 *   toggle or restore re-derives it like any other stock adjustment line:
 *   before the cut-over it is removed again (periodic), after it the
 *   value-exact line replaces it. It can never be counted twice.
 * - Vouchers dated on or after the cut-over are skipped (PERPETUAL_ACTIVE):
 *   their inventory line is the value-exact one the sync posts.
 * - The opening inventory journal posts the sub-ledger value less what the
 *   INVENTORY account already holds on the eve, so lines added here are
 *   absorbed at the cut-over, not added to it.
 * - INVENTORY is resolved by code only (never a "Stock in Hand" account by
 *   name). It is created when missing; an INVENTORY row that is deleted,
 *   inactive, not an asset or still named as the old credit-note expense is
 *   never renamed, retyped or restored: the plan is blocked
 *   (INVENTORY_ACCOUNT_NEEDS_REVIEW).
 * - Supplier-partner companies keep their stock in sp_stock and carry no
 *   Inventory line (blocked: SUPPLIER_PARTNER_COMPANY).
 */
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

import { pool } from "../../db";
import { MoneyDecimal } from "../../lib/money";
import { STOCK_ADJUSTMENT_INVENTORY_NARRATION } from "./perpetualInventory/stockAdjustments";

/** The accounts the stock adjustment writers post to, now and in older versions. */
const ADJUSTMENT_CODES = ["STOCK_ADJUSTMENT", "PRODUCTION_ADJUSTMENT", "CONSUMPTION_EXPENSE"];
const STOCK_ADJUSTMENT_TYPES = ["Production", "Consumption", "Mixed", "Stock Adjustment"];

export type StockAdjustmentInventorySkipReason = "PERIOD_CLOSED" | "PERPETUAL_ACTIVE" | "NON_USD_VOUCHER";
export type StockAdjustmentInventoryBlocker = "SUPPLIER_PARTNER_COMPANY" | "INVENTORY_ACCOUNT_NEEDS_REVIEW";

export interface StockAdjustmentInventoryPlan {
  companyId: number;
  inventoryAccount: { id: number | null; action: "use" | "create" };
  vouchers: {
    voucherId: number;
    voucherNumber: string;
    voucherType: string;
    voucherDate: string;
    effectiveDate: string | null;
    debit: string;
    credit: string;
    inventoryLine: { side: "debit" | "credit"; amount: string };
  }[];
  skipped: { voucherId: number; voucherNumber: string; reason: StockAdjustmentInventorySkipReason }[];
  blockers: { code: StockAdjustmentInventoryBlocker; message: string }[];
  total: { debit: string; credit: string };
  planHash: string;
}

export class StockAdjustmentInventoryRefusal extends Error {
  constructor(
    readonly code: "PLAN_CHANGED" | "NOTHING_TO_APPLY" | "PLAN_BLOCKED",
    message: string
  ) {
    super(message);
    this.name = "StockAdjustmentInventoryRefusal";
  }
}

type CandidateRow = {
  id: number;
  voucher_number: string;
  voucher_type: string;
  voucher_date: string;
  effective_date: string | null;
  voucher_currency: string;
  foreign_lines: boolean;
  perpetual: boolean;
  debit: string;
  credit: string;
};

async function scopeCompany(client: PoolClient, companyId: number): Promise<void> {
  await client.query("SELECT set_config('app.current_company_id', $1, true)", [String(companyId)]);
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`stock-adjustment-inventory-side:${companyId}`]);
}

async function lockedThrough(client: PoolClient, companyId: number): Promise<string | null> {
  const result = await client.query<{ locked: string | null }>(
    `SELECT max(period_end_date)::text AS locked FROM fiscal_period_closures WHERE company_id = $1 AND status = 'CLOSED'`,
    [companyId]
  );
  return result.rows[0]?.locked ?? null;
}

async function derivePlan(client: PoolClient, companyId: number): Promise<StockAdjustmentInventoryPlan> {
  const blockers: StockAdjustmentInventoryPlan["blockers"] = [];
  const company = await client.query<{ company_type: string | null }>(
    `SELECT company_type FROM companies WHERE id = $1`,
    [companyId]
  );
  if (company.rows[0]?.company_type === "supplier_partner") {
    blockers.push({
      code: "SUPPLIER_PARTNER_COMPANY",
      message: "A supplier-partner company keeps its stock in sp_stock; its stock adjustments carry no Inventory line",
    });
  }

  const account = await client.query<{
    id: number;
    name: string;
    account_type: string | null;
    active: boolean | null;
    deleted: boolean;
  }>(
    `SELECT id, name, account_type, active, deleted_at IS NOT NULL AS deleted
       FROM ledger_accounts WHERE company_id = $1 AND code = 'INVENTORY' ORDER BY id LIMIT 1`,
    [companyId]
  );
  const existing = account.rows[0];
  let inventoryAccount: StockAdjustmentInventoryPlan["inventoryAccount"] = { id: null, action: "create" };
  if (existing) {
    inventoryAccount = { id: existing.id, action: "use" };
    const usable =
      !existing.deleted &&
      existing.active !== false &&
      ["Asset", "Current Asset"].includes(existing.account_type ?? "") &&
      existing.name.trim().toLowerCase() !== "credit note - customer return";
    if (!usable) {
      blockers.push({
        code: "INVENTORY_ACCOUNT_NEEDS_REVIEW",
        message:
          "The INVENTORY account is deleted, inactive, not an asset or still named as the credit-note expense; it is not renamed, retyped or restored here",
      });
    }
  }

  const locked = await lockedThrough(client, companyId);
  const candidates = await client.query<CandidateRow>(
    `SELECT v.id, v.voucher_number, v.voucher_type,
            v.voucher_date::text AS voucher_date, v.effective_date::text AS effective_date,
            upper(COALESCE(NULLIF(btrim(v.currency), ''), 'USD')) AS voucher_currency,
            COALESCE(bool_or(ve.transaction_currency IS NOT NULL AND upper(ve.transaction_currency) <> 'USD'), false)
              AS foreign_lines,
            EXISTS (SELECT 1 FROM gl_inventory_cutovers c
                     WHERE c.company_id = v.company_id AND c.effective_from <= v.voucher_date) AS perpetual,
            COALESCE(SUM(ve.debit_amount), 0)::text AS debit,
            COALESCE(SUM(ve.credit_amount), 0)::text AS credit
       FROM vouchers v
       JOIN voucher_entries ve ON ve.voucher_id = v.id
       LEFT JOIN ledger_accounts la ON la.id = ve.ledger_account_id AND la.company_id = v.company_id
      WHERE v.company_id = $1
        AND v.deleted_at IS NULL
        AND COALESCE(v.optional, false) = false
        AND v.voucher_type = ANY($2::text[])
        AND EXISTS (SELECT 1 FROM stock_adjustment_vouchers sav WHERE sav.voucher_id = v.id)
      GROUP BY v.id
     HAVING bool_and(COALESCE(la.code = ANY($3::text[]), false))
        AND round(COALESCE(SUM(ve.debit_amount), 0), 2) <> round(COALESCE(SUM(ve.credit_amount), 0), 2)
      ORDER BY v.id`,
    [companyId, STOCK_ADJUSTMENT_TYPES, ADJUSTMENT_CODES]
  );

  const vouchers: StockAdjustmentInventoryPlan["vouchers"] = [];
  const skipped: StockAdjustmentInventoryPlan["skipped"] = [];
  let totalDebit = new MoneyDecimal(0);
  let totalCredit = new MoneyDecimal(0);
  for (const row of candidates.rows) {
    const skip = (reason: StockAdjustmentInventorySkipReason) =>
      skipped.push({ voucherId: row.id, voucherNumber: row.voucher_number, reason });
    if (locked && (row.voucher_date <= locked || (row.effective_date ?? row.voucher_date) <= locked)) {
      skip("PERIOD_CLOSED");
      continue;
    }
    if (row.perpetual) {
      skip("PERPETUAL_ACTIVE");
      continue;
    }
    if (row.voucher_currency !== "USD" || row.foreign_lines) {
      skip("NON_USD_VOUCHER");
      continue;
    }
    const debit = new MoneyDecimal(row.debit).toDecimalPlaces(2);
    const credit = new MoneyDecimal(row.credit).toDecimalPlaces(2);
    // The Inventory line takes the side the adjustment lines leave open.
    const net = credit.minus(debit);
    const amount = net.abs();
    if (net.isPositive()) totalDebit = totalDebit.plus(amount);
    else totalCredit = totalCredit.plus(amount);
    vouchers.push({
      voucherId: row.id,
      voucherNumber: row.voucher_number,
      voucherType: row.voucher_type,
      voucherDate: row.voucher_date,
      effectiveDate: row.effective_date,
      debit: debit.toFixed(2),
      credit: credit.toFixed(2),
      inventoryLine: { side: net.isPositive() ? "debit" : "credit", amount: amount.toFixed(2) },
    });
  }

  const plan = {
    companyId,
    inventoryAccount,
    vouchers,
    skipped,
    blockers,
    total: { debit: totalDebit.toFixed(2), credit: totalCredit.toFixed(2) },
  };
  return { ...plan, planHash: createHash("sha256").update(JSON.stringify(plan)).digest("hex") };
}

async function voucherLines(client: PoolClient, companyId: number, voucherIds: number[]) {
  if (voucherIds.length === 0) return [];
  const result = await client.query(
    `SELECT ve.id, ve.voucher_id, ve.ledger_account_id, ve.debit_amount::text AS debit,
            ve.credit_amount::text AS credit, ve.narration
       FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
      WHERE v.company_id = $1 AND ve.voucher_id = ANY($2::int[])
      ORDER BY ve.voucher_id, ve.id`,
    [companyId, voucherIds]
  );
  return result.rows;
}

async function withCompanyClient<T>(
  companyId: number,
  work: (client: PoolClient) => Promise<T>,
  readOnly: boolean
): Promise<T> {
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

/** Read-only: what the apply would write for the company. */
export function planStockAdjustmentInventorySide(companyId: number): Promise<StockAdjustmentInventoryPlan> {
  return withCompanyClient(companyId, (client) => derivePlan(client, companyId), true);
}

/** Applies the reviewed plan for the current company in one audited transaction. */
export function applyStockAdjustmentInventorySide(
  companyId: number,
  options: { planHash: string; actor: { userId: string; username: string } }
): Promise<StockAdjustmentInventoryPlan> {
  return withCompanyClient(
    companyId,
    async (client) => {
      // Lock what the plan names, then derive it again under the locks: an
      // edit takes the same voucher lock, so the plan cannot change under us.
      const first = await derivePlan(client, companyId);
      const ids = first.vouchers.map((row) => row.voucherId);
      if (ids.length > 0) {
        await client.query(
          `SELECT id FROM vouchers WHERE company_id = $1 AND id = ANY($2::int[]) ORDER BY id FOR UPDATE`,
          [companyId, ids]
        );
      }
      const plan = await derivePlan(client, companyId);
      if (plan.planHash !== options.planHash) {
        throw new StockAdjustmentInventoryRefusal(
          "PLAN_CHANGED",
          "The plan changed since it was reviewed; review it again before applying"
        );
      }
      if (plan.blockers.length > 0) {
        throw new StockAdjustmentInventoryRefusal("PLAN_BLOCKED", plan.blockers.map((b) => b.message).join("; "));
      }
      if (plan.vouchers.length === 0) {
        throw new StockAdjustmentInventoryRefusal("NOTHING_TO_APPLY", "There is no voucher to give an Inventory line");
      }

      let inventoryAccountId = plan.inventoryAccount.id;
      if (inventoryAccountId === null) {
        const created = await client.query<{ id: number }>(
          `INSERT INTO ledger_accounts
             (company_id, code, name, account_type, sub_type, opening_balance, opening_balance_side, active, is_hidden)
           VALUES ($1, 'INVENTORY', 'Inventory', 'Asset', 'Current Asset', '0', 'Dr', true, false)
           RETURNING id`,
          [companyId]
        );
        inventoryAccountId = created.rows[0].id;
      }

      const touched = plan.vouchers.map((row) => row.voucherId);
      const before = await voucherLines(client, companyId, touched);
      for (const row of plan.vouchers) {
        const debit = row.inventoryLine.side === "debit" ? row.inventoryLine.amount : "0.00";
        const credit = row.inventoryLine.side === "credit" ? row.inventoryLine.amount : "0.00";
        await client.query(
          `INSERT INTO voucher_entries
             (voucher_id, company_id, ledger_account_id, debit_amount, credit_amount,
              transaction_currency, transaction_debit_amount, transaction_credit_amount,
              base_debit_amount, base_credit_amount, historical_exchange_rate, rate_convention, narration)
           VALUES ($1, $2, $3, $4, $5, 'USD', $4, $5, $4, $5, 1, 'IDENTITY', $6)`,
          [row.voucherId, companyId, inventoryAccountId, debit, credit, STOCK_ADJUSTMENT_INVENTORY_NARRATION]
        );
        const check = await client.query<{ debit: string; credit: string }>(
          `SELECT round(COALESCE(SUM(ve.debit_amount), 0), 2)::text AS debit,
                  round(COALESCE(SUM(ve.credit_amount), 0), 2)::text AS credit
             FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
            WHERE v.company_id = $1 AND ve.voucher_id = $2`,
          [companyId, row.voucherId]
        );
        if (check.rows[0]?.debit !== check.rows[0]?.credit) {
          throw new Error(`Voucher ${row.voucherNumber} would not balance; nothing was applied`);
        }
      }
      const after = await voucherLines(client, companyId, touched);
      await client.query(
        `INSERT INTO audit_log (user_id, username, company_id, action, table_name, record_identifier, changes)
         VALUES ($1, $2, $3, 'update', 'voucher_entries', 'stock-adjustment-inventory-side', $4::jsonb)`,
        [
          options.actor.userId,
          options.actor.username,
          companyId,
          JSON.stringify({ lines: { old: before, new: after }, plan: { new: { ...plan, inventoryAccountId } } }),
        ]
      );
      return plan;
    },
    false
  );
}
