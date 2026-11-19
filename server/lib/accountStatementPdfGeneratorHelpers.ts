// Extracted from ./accountStatementPdfGenerator.ts: shared helpers.
import { db } from "../db";
import { loadCustomerLedgerLines } from "../services/accounting/balances/customerLedgerStatement";
import { projectCustomerStatementLines } from "../routes/factory/customers-core/heldUnfinalizedCustomerCharges";
import type { StatementSourceEntry } from "./accountStatementPdfGenerator";

/** The account is not a master of this company (wave 18 C): the route answers 404. */
export class StatementAccountNotFoundError extends Error {
  readonly status = 404;
  constructor(accountType: string, accountId: number) {
    super(`Account not found: ${accountType} ${accountId}`);
    this.name = "StatementAccountNotFoundError";
  }
}

/** The customer's ledger lines (balance engine rules) as statement rows. */
export async function customerStatementEntries(
  companyId: number,
  customerId: number,
  startDate: string | undefined,
  endDate: string | undefined
): Promise<StatementSourceEntry[]> {
  const lines = await loadCustomerLedgerLines(db, {
    companyId,
    customerId,
    from: startDate ?? null,
    to: endDate ?? null,
  });
  const projected = await projectCustomerStatementLines(companyId, customerId, lines, startDate, endDate);
  return projected.rows;
}
