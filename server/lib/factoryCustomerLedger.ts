/**
 * The customer a ledger account belongs to.
 *
 * A ledger account linked to a customer (customers.ledger_account_id) has no
 * balance of its own: the one balance engine
 * (services/accounting/balances/ledgerBalanceEngine.ts) rolls its lines into
 * the customer, the lowest customer id owning an account linked to several,
 * and only when the account exists in the customer's company. Account views
 * of such a ledger (transactions, statement PDF, balance, pre-period) show
 * the owning customer's ledger statement.
 *
 * Wave 10 retired the factory composite that used to live here
 * (buildFactoryCustomerLedgerEntries), which rebuilt the balance from
 * finalized orders, the customer_balances cache and vouchers with the
 * CHARGE-/INV- journals skipped. Those operational amounts are now listed as
 * "not yet in the ledger" memo lines (balances/unpostedMemo.ts), never mixed
 * into the ledger rows.
 */
import { sql } from "drizzle-orm";

import { db } from "../db";
import { customerLinksBody } from "../services/accounting/balances/partyLineRules";

/** The customer owning a ledger account (id + companyId), or null. */
export async function getCustomerByLedgerId(
  ledgerAccountId: number
): Promise<{ id: number; companyId: number } | null> {
  const result = await db.execute<{ id: number; company_id: number } & Record<string, unknown>>(sql`
    SELECT link_owner.customer_id AS id, la.company_id
      FROM ledger_accounts la
      JOIN LATERAL (${sql.raw(customerLinksBody("la.company_id"))}) link_owner ON link_owner.ledger_account_id = la.id
     WHERE la.id = ${ledgerAccountId}
     LIMIT 1
  `);
  const row = result.rows[0];
  return row ? { id: Number(row.id), companyId: Number(row.company_id) } : null;
}
