import type { Pool, PoolClient } from "pg";
import { logger } from "../lib/logger";
import { getErrorMessage } from "../lib/httpHandlers";

/**
 * Balance old stock adjustment vouchers against Inventory, once, on boot.
 *
 * Production, Consumption and Mixed adjustments used to post only the Stock
 * Adjustment side (or, on the oldest vouchers, the legacy PRODUCTION_ADJUSTMENT
 * and CONSUMPTION_EXPENSE accounts), so each voucher was out of balance by its
 * own value. New adjustments now post both sides
 * (storage/stock-ops/adjustmentLedgerEntries.ts). This gives every old one the
 * same shape: each adjustment line gets a mirror line on the canonical INVENTORY
 * account with debit and credit swapped, so the voucher balances.
 *
 * Only live, non-optional vouchers that carry a stock adjustment, consist of
 * adjustment and Inventory lines alone and are out of balance are touched. Their
 * Inventory side is rebuilt from the adjustment lines, so a voucher an older
 * instance edited after it was backfilled (leaving stale Inventory lines) is
 * repaired too. Once balanced they no longer match, so later boots find nothing
 * to do.
 *
 * Each voucher is locked FOR UPDATE and re-checked before it is written. Edits
 * take the same lock, and a second instance booting at the same time waits,
 * then finds the voucher balanced and leaves it. Each voucher is written under
 * its own savepoint: one the closed-period guard refuses is skipped and logged,
 * and boot carries on.
 */

const ADJUSTMENT_CODES = ["STOCK_ADJUSTMENT", "PRODUCTION_ADJUSTMENT", "CONSUMPTION_EXPENSE"];
const REBUILDABLE_CODES = [...ADJUSTMENT_CODES, "INVENTORY"];

/** Live, non-optional adjustment vouchers made of adjustment and Inventory lines only, out of balance. */
const UNBALANCED_ADJUSTMENT_VOUCHERS = `
  SELECT v.id
    FROM vouchers v
    JOIN voucher_entries ve ON ve.voucher_id = v.id
    LEFT JOIN ledger_accounts la ON la.id = ve.ledger_account_id
   WHERE v.company_id = $1
     AND v.deleted_at IS NULL
     AND v.optional = false
     AND EXISTS (SELECT 1 FROM stock_adjustment_vouchers sav WHERE sav.voucher_id = v.id)
     AND ($3::int IS NULL OR v.id = $3)
   GROUP BY v.id
  HAVING bool_and(COALESCE(la.code = ANY($2::text[]), false))
     AND bool_or(la.code <> 'INVENTORY')
     AND SUM(COALESCE(ve.debit_amount, 0)) <> SUM(COALESCE(ve.credit_amount, 0))
   ORDER BY v.id`;

export type StockAdjustmentBackfillResult = { balanced: number; skipped: number };

async function ensureInventoryAccount(client: PoolClient, companyId: number): Promise<number> {
  // Same normalisation as getOrCreateInventoryControlAccount: INVENTORY is a
  // current asset, and an old row created as the credit-note expense is renamed.
  const { rows } = await client.query<{ id: number }>(
    `INSERT INTO ledger_accounts
       (company_id, code, name, account_type, sub_type, opening_balance, opening_balance_side, active, is_hidden)
     VALUES ($1, 'INVENTORY', 'Inventory', 'Asset', 'Current Asset', '0', 'Dr', true, false)
     ON CONFLICT (company_id, code) DO UPDATE SET
       name = CASE WHEN lower(trim(ledger_accounts.name)) = 'credit note - customer return'
                   THEN 'Inventory' ELSE ledger_accounts.name END,
       account_type = 'Asset',
       sub_type = 'Current Asset',
       active = true,
       is_hidden = false,
       deleted_at = NULL
     RETURNING id`,
    [companyId]
  );
  return rows[0].id;
}

async function backfillCompany(client: PoolClient, companyId: number): Promise<StockAdjustmentBackfillResult> {
  const result: StockAdjustmentBackfillResult = { balanced: 0, skipped: 0 };
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [String(companyId)]);
    const { rows: candidates } = await client.query<{ id: number }>(UNBALANCED_ADJUSTMENT_VOUCHERS, [
      companyId,
      REBUILDABLE_CODES,
      null,
    ]);
    if (candidates.length === 0) {
      await client.query("COMMIT");
      return result;
    }

    const inventoryAccountId = await ensureInventoryAccount(client, companyId);
    for (const { id: voucherId } of candidates) {
      await client.query("SAVEPOINT stock_adjustment_backfill");
      try {
        // Lock the voucher as edits do, then re-check it: another instance or an
        // edit may have balanced or changed it since the candidate scan.
        await client.query("SELECT id FROM vouchers WHERE id = $1 FOR UPDATE", [voucherId]);
        const { rowCount: stillUnbalanced } = await client.query(UNBALANCED_ADJUSTMENT_VOUCHERS, [
          companyId,
          REBUILDABLE_CODES,
          voucherId,
        ]);
        if (!stillUnbalanced) {
          await client.query("RELEASE SAVEPOINT stock_adjustment_backfill");
          continue;
        }
        await client.query(
          `DELETE FROM voucher_entries ve
             USING ledger_accounts la
            WHERE la.id = ve.ledger_account_id AND ve.voucher_id = $1 AND la.code = 'INVENTORY'`,
          [voucherId]
        );
        await client.query(
          `INSERT INTO voucher_entries
             (voucher_id, company_id, ledger_account_id, debit_amount, credit_amount, narration,
              transaction_currency, transaction_debit_amount, transaction_credit_amount,
              base_debit_amount, base_credit_amount, historical_exchange_rate)
           SELECT ve.voucher_id, ve.company_id, $2, ve.credit_amount, ve.debit_amount,
                  'Inventory side (backfill) - ' || COALESCE(ve.narration, ''),
                  ve.transaction_currency, ve.transaction_credit_amount, ve.transaction_debit_amount,
                  ve.base_credit_amount, ve.base_debit_amount, ve.historical_exchange_rate
             FROM voucher_entries ve
             JOIN ledger_accounts la ON la.id = ve.ledger_account_id
            WHERE ve.voucher_id = $1
              AND la.code = ANY($3::text[])
            ORDER BY ve.id`,
          [voucherId, inventoryAccountId, ADJUSTMENT_CODES]
        );
        await client.query("RELEASE SAVEPOINT stock_adjustment_backfill");
        result.balanced += 1;
      } catch (error: unknown) {
        await client.query("ROLLBACK TO SAVEPOINT stock_adjustment_backfill");
        result.skipped += 1;
        logger.warn("[StockAdjInventory] Voucher left unbalanced", {
          companyId,
          voucherId,
          error: getErrorMessage(error),
        });
      }
    }
    await client.query("COMMIT");
    return result;
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function backfillStockAdjustmentInventorySide(pool: Pool): Promise<StockAdjustmentBackfillResult> {
  const total: StockAdjustmentBackfillResult = { balanced: 0, skipped: 0 };
  const client = await pool.connect();
  try {
    const { rows: companies } = await client.query<{ id: number }>("SELECT id FROM companies ORDER BY id");
    for (const { id: companyId } of companies) {
      const result = await backfillCompany(client, companyId);
      total.balanced += result.balanced;
      total.skipped += result.skipped;
      if (result.balanced > 0 || result.skipped > 0) {
        logger.info("[StockAdjInventory] Balanced stock adjustment vouchers against Inventory", {
          companyId,
          ...result,
        });
      }
    }
    return total;
  } finally {
    client.release();
  }
}
