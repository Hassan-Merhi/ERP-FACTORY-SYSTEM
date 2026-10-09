/**
 * Period-report rule (accounting audit wave 17 A): the fiscal closing journal
 * is not part of any period's profit.
 *
 * A fiscal close (storage/accounting/fiscal-periods.ts) posts one journal on
 * the period end that moves every income and expense balance to retained
 * earnings. The journal is identified by its closure row
 * (fiscal_period_closures.closing_voucher_id), not by its FISCAL-CLOSE-*
 * number. A reopened period soft-deletes its journal and removes the closure
 * row, so it is excluded by the live-voucher filter anyway.
 *
 *   - Period reports (P&L, income statement, ratios, dashboard profit and
 *     expense breakdown, the net-profit workbook and statement, the chat P&L
 *     reports) leave the closing journal out, so a closed year still shows the
 *     profit it made and the closing month is not reported as a loss.
 *   - Balances (trial balance, balance sheet, party balances, net positions)
 *     keep it: it is what moves the year's profit into retained earnings.
 */
import { sql, type SQL } from "drizzle-orm";
import * as schema from "@shared/schema";

/** drizzle form on the un-aliased vouchers table: the voucher is not a fiscal closing journal. */
export const notFiscalClosingVoucherSql: SQL = sql`NOT EXISTS (SELECT 1 FROM fiscal_period_closures fpc_close WHERE fpc_close.closing_voucher_id = ${schema.vouchers.id})`;

/** Raw-SQL form on a voucher alias (`v`, `vo`, ...): the voucher is not a fiscal closing journal. */
export function notFiscalClosingVoucher(alias: string): SQL {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error("period_report_rules_unsafe_alias");
  return sql.raw(
    `NOT EXISTS (SELECT 1 FROM fiscal_period_closures fpc_close WHERE fpc_close.closing_voucher_id = ${alias}.id)`
  );
}

/** Plain SQL text form for pool.query strings, on a voucher alias. */
export function notFiscalClosingVoucherText(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error("period_report_rules_unsafe_alias");
  return `NOT EXISTS (SELECT 1 FROM fiscal_period_closures fpc_close WHERE fpc_close.closing_voucher_id = ${alias}.id)`;
}
