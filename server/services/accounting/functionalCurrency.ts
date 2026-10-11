/**
 * Functional currency (accounting audit phase 23, G15/M12; decided by
 * default, owner can override).
 *
 * A company's functional currency is its `companies.base_currency` (USD for
 * every company today): the currency its general ledger is kept in, every
 * posted base amount (debit_amount / credit_amount) and every report total.
 * `companies.display_currency` is separate: it only changes how figures are
 * shown and never what is posted.
 *
 * Once a company has posted a voucher its functional currency is fixed: a
 * change would re-denominate every posted amount without a single journal.
 * Changing it requires an empty company (or a reviewed translation, which is
 * not built).
 */
import { sql } from "drizzle-orm";

import { db, type DatabaseOrTransaction } from "../../db";

export const FUNCTIONAL_CURRENCY_LOCKED = "FUNCTIONAL_CURRENCY_LOCKED" as const;
export const FUNCTIONAL_CURRENCY_LOCKED_MESSAGE =
  "The company has posted vouchers, so its base (functional) currency cannot be changed. Change the display currency instead.";

export class FunctionalCurrencyLockedError extends Error {
  readonly code = FUNCTIONAL_CURRENCY_LOCKED;
  constructor() {
    super(FUNCTIONAL_CURRENCY_LOCKED_MESSAGE);
    this.name = "FunctionalCurrencyLockedError";
  }
}

const normalized = (currency: string | null | undefined) => {
  const value = (currency ?? "").trim().toUpperCase();
  return value === "XOF" ? "CFA" : value || "USD";
};

/** The company's functional currency: its base currency, USD when unset. */
export async function companyFunctionalCurrency(
  companyId: number,
  executor: DatabaseOrTransaction = db
): Promise<string> {
  const result = await executor.execute(sql`SELECT base_currency FROM companies WHERE id = ${companyId}`);
  return normalized((result.rows[0] as { base_currency: string | null } | undefined)?.base_currency);
}

/**
 * Refuses a base-currency change of a company that has posted vouchers. The
 * executor must see the company's vouchers (its tenant scope).
 */
export async function assertFunctionalCurrencyChangeAllowed(
  companyId: number,
  requested: unknown,
  executor: DatabaseOrTransaction = db
): Promise<void> {
  if (requested === undefined || requested === null || requested === "") return;
  const current = await companyFunctionalCurrency(companyId, executor);
  if (normalized(String(requested)) === current) return;
  const posted = await executor.execute(sql`SELECT 1 FROM vouchers WHERE company_id = ${companyId} LIMIT 1`);
  if (posted.rows.length > 0) throw new FunctionalCurrencyLockedError();
}
