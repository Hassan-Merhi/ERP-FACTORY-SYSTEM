// Extracted from ./postOffloadPhase6SafetyImplBuildSnapshot.ts
import { type ReplayQueryExecutor } from "./historicalCostReplay";
import {
  count,
  decimal,
  type IntegrityRow,
  type PostOffloadPhase6Integrity,
} from "./postOffloadPhase6SafetyImplParseReplayScope";

export async function loadIntegrity(
  executor: ReplayQueryExecutor,
  companyId: number
): Promise<PostOffloadPhase6Integrity> {
  const result = await executor.query<IntegrityRow>(
    `WITH charge_integrity AS (
       SELECT
         COUNT(*) FILTER (WHERE charge.deleted_at IS NULL)::text AS active_charges,
         COUNT(*) FILTER (WHERE charge.deleted_at IS NOT NULL)::text AS deleted_charges,
         COUNT(*) FILTER (
           WHERE charge.deleted_at IS NULL
             AND UPPER(COALESCE(charge.currency_code, 'USD')) <> 'USD'
             AND COALESCE(charge.fx_rate_to_usd, 0) <= 0
         )::text AS unresolved_fx_charges,
         COUNT(*) FILTER (
           WHERE charge.deleted_at IS NULL
             AND (charge.daybook_entry_id IS NULL OR original_daybook.id IS NULL)
         )::text AS missing_daybook_links,
         COUNT(*) FILTER (
           WHERE charge.deleted_at IS NULL
             AND (charge.ledger_account_id IS NOT NULL OR charge.supplier_id IS NOT NULL)
             AND (charge.voucher_id IS NULL OR voucher.id IS NULL OR voucher.deleted_at IS NOT NULL)
         )::text AS missing_voucher_links,
         COUNT(*) FILTER (
           WHERE charge.deleted_at IS NULL
             AND charge.voucher_id IS NOT NULL
             AND EXISTS (
               SELECT 1
               FROM voucher_entries entry
               WHERE entry.voucher_id = charge.voucher_id
                 AND (
                   entry.transaction_currency IS NULL
                   OR entry.transaction_debit_amount IS NULL
                   OR entry.transaction_credit_amount IS NULL
                   OR entry.base_debit_amount IS NULL
                   OR entry.base_credit_amount IS NULL
                   OR entry.historical_exchange_rate IS NULL
                   OR entry.rate_convention IS NULL
                 )
             )
         )::text AS incomplete_voucher_currency_rows,
         COUNT(*) FILTER (
           WHERE charge.deleted_at IS NOT NULL
             AND (charge.daybook_entry_id IS NOT NULL OR charge.voucher_id IS NOT NULL)
             AND (charge.reversal_daybook_entry_id IS NULL OR reversal_daybook.id IS NULL)
         )::text AS missing_reversal_links
       FROM factory_offload_additional_charges charge
       LEFT JOIN vouchers voucher ON voucher.id = charge.voucher_id
       LEFT JOIN factory_daybook_entries original_daybook ON original_daybook.id = charge.daybook_entry_id
       LEFT JOIN factory_daybook_entries reversal_daybook ON reversal_daybook.id = charge.reversal_daybook_entry_id
       WHERE charge.company_id = $1
     ),
     raw_drift AS (
       SELECT
         COUNT(*) FILTER (
           WHERE ABS(COALESCE(raw_stock.cost_per_kg_usd, 0) - COALESCE(container.rate_per_kg_usd, 0)) > 0.000001
         )::text AS raw_stock_cost_drift_rows,
         MAX(ABS(COALESCE(raw_stock.cost_per_kg_usd, 0) - COALESCE(container.rate_per_kg_usd, 0)))::text
           AS max_raw_stock_cost_drift
       FROM factory_raw_stock raw_stock
       JOIN factory_containers container
         ON container.id = raw_stock.container_id
        AND container.company_id = raw_stock.company_id
       WHERE raw_stock.company_id = $1
         AND raw_stock.deleted_at IS NULL
         AND container.deleted_at IS NULL
     )
     SELECT charge_integrity.*, raw_drift.*
     FROM charge_integrity CROSS JOIN raw_drift`,
    [companyId]
  );
  const row = result.rows[0];
  const integrity: PostOffloadPhase6Integrity = {
    activeCharges: count(row?.active_charges),
    deletedCharges: count(row?.deleted_charges),
    unresolvedFxCharges: count(row?.unresolved_fx_charges),
    missingDaybookLinks: count(row?.missing_daybook_links),
    missingVoucherLinks: count(row?.missing_voucher_links),
    incompleteVoucherCurrencyRows: count(row?.incomplete_voucher_currency_rows),
    missingReversalLinks: count(row?.missing_reversal_links),
    rawStockCostDriftRows: count(row?.raw_stock_cost_drift_rows),
    maxRawStockCostDriftUsdPerKg: decimal(row?.max_raw_stock_cost_drift).toFixed(6),
    issueCount: 0,
  };
  integrity.issueCount =
    integrity.unresolvedFxCharges +
    integrity.missingDaybookLinks +
    integrity.missingVoucherLinks +
    integrity.incompleteVoucherCurrencyRows +
    integrity.missingReversalLinks +
    integrity.rawStockCostDriftRows;
  return integrity;
}
