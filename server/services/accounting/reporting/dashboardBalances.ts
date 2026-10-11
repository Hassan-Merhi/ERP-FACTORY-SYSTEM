/**
 * Dashboard cash and payable cards on the one balance engine (accounting
 * audit phase 27, RP-10).
 *
 * The cards summed every line naming a ledger account or a bank, so a line
 * naming both was counted on both; took a sideless opening as Dr; summed in
 * floats; and fetched the accounts by id with no company filter. Now each
 * selected account's balance is its engine row's closing (debit positive):
 * this company's vouchers, each line owned once (a line naming a ledger and a
 * bank is the ledger's), the engine's side rule for sideless openings. A
 * ledger account linked to a customer reads its customer's row (the engine
 * gives the account no row of its own).
 */
import { sql } from "drizzle-orm";
import type Decimal from "decimal.js";

import { db, type DatabaseOrTransaction } from "../../../db";
import { MoneyDecimal } from "../../../lib/money";
import { loadBalanceRows, type BalanceRow } from "../balances/ledgerBalanceEngine";

function closingOf(row: BalanceRow): Decimal {
  return row.masterOpening.plus(row.carriedForward).plus(row.periodDebit).minus(row.periodCredit);
}

/** Engine closings of the company's ledger accounts, by account id (debit positive). */
export async function ledgerAccountClosings(
  companyId: number,
  accountIds: readonly number[],
  executor: DatabaseOrTransaction = db
): Promise<Map<number, Decimal>> {
  const ids = [...new Set(accountIds)].filter((id) => Number.isSafeInteger(id));
  const closings = new Map<number, Decimal>();
  if (ids.length === 0) return closings;
  const ledgerRows = await loadBalanceRows(executor, { companyId, kind: "ledger", ids });
  for (const row of ledgerRows) if (row.id !== null) closings.set(row.id, closingOf(row));

  const linked = ids.filter((id) => !closings.has(id));
  if (linked.length > 0) {
    const owners = await executor.execute<{ ledger_account_id: number; customer_id: number }>(sql`
      SELECT DISTINCT ON (c.ledger_account_id) c.ledger_account_id, c.id AS customer_id
        FROM customers c
        JOIN ledger_accounts la ON la.id = c.ledger_account_id AND la.company_id = c.company_id
       WHERE c.company_id = ${companyId}
         AND c.ledger_account_id IN (${sql.join(
           linked.map((id) => sql`${id}`),
           sql`, `
         )})
       ORDER BY c.ledger_account_id, c.id
    `);
    const customerIds = owners.rows.map((row) => Number(row.customer_id));
    if (customerIds.length > 0) {
      const customerRows = await loadBalanceRows(executor, { companyId, kind: "customer", ids: customerIds });
      const byCustomer = new Map(customerRows.map((row) => [row.id, closingOf(row)] as const));
      for (const owner of owners.rows) {
        closings.set(Number(owner.ledger_account_id), byCustomer.get(Number(owner.customer_id)) ?? new MoneyDecimal(0));
      }
    }
  }
  return closings;
}

/** Engine closings of the company's bank accounts, by id (debit positive). */
export async function bankAccountClosings(
  companyId: number,
  bankIds: readonly number[],
  executor: DatabaseOrTransaction = db
): Promise<Map<number, Decimal>> {
  const ids = [...new Set(bankIds)].filter((id) => Number.isSafeInteger(id));
  if (ids.length === 0) return new Map();
  const rows = await loadBalanceRows(executor, { companyId, kind: "bank", ids });
  return new Map(rows.filter((row) => row.id !== null).map((row) => [row.id as number, closingOf(row)] as const));
}
