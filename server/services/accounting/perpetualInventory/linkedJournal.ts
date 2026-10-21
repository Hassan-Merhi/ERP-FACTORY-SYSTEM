/**
 * Linked journals for perpetual inventory (wave 8).
 *
 * The perpetual-inventory postings are separate journals linked to their
 * source document by a deterministic voucher number (COGS-{sale},
 * GIT-PO-{purchaseOrder}, STOCK-IN-{container}), so the source documents keep
 * the lines every existing reader expects. Each journal is derived from the
 * current state of its source and replaced whole when that source changes:
 * remove, then post again. Posting goes through the idempotent infrastructure
 * voucher writer. Removal retires the old journal (wave 16 A,
 * voucherRetirement.ts): soft-deleted with its lines, audited, its number and
 * posting identity given up, so the journal can be posted again and the old
 * one stays in the history.
 */
import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import { voucherEntries } from "@shared/schema";

import type { DatabaseOrTransaction, DbTransaction } from "../../../db";
import { MoneyDecimal } from "../../../lib/money";
import { infrastructurePostingIdentity, insertInfrastructureVoucherTx } from "../infrastructureVoucherIdentity";
import { retireVouchersByNumberTx } from "../voucherRetirement";
import { ensureSystemAccounts } from "../systemAccounts";

export interface LinkedJournalLine {
  ledgerAccountId: number;
  debit: Decimal;
  credit: Decimal;
  narration: string;
  /** Set on a receivable line, as the customer-ledger readers expect. */
  customerId?: number;
}

/** Supplier-partner companies carry their stock in their own sp_stock accounts and are not posted. */
export async function isSupplierPartnerCompany(tx: DatabaseOrTransaction, companyId: number): Promise<boolean> {
  const result = await tx.execute<{ company_type: string | null } & Record<string, unknown>>(
    sql`SELECT company_type FROM companies WHERE id = ${companyId}`
  );
  return (result.rows[0] as { company_type: string | null } | undefined)?.company_type === "supplier_partner";
}

/** The ids of registry system accounts, created when missing. */
export async function systemAccountIdsTx(
  tx: DbTransaction,
  companyId: number,
  codes: readonly string[]
): Promise<Map<string, number>> {
  const ids = new Map<string, number>();
  for (const status of await ensureSystemAccounts(tx, companyId, codes)) {
    if (status.state === "missing" || status.state === "deleted") {
      throw new Error("A required system account is not available");
    }
    ids.set(status.code, status.accountId);
  }
  return ids;
}

/** Retires a linked journal (soft delete, audited, number and posting identity released), if any. */
export async function removeLinkedJournalTx(
  tx: DbTransaction,
  companyId: number,
  voucherNumber: string
): Promise<void> {
  await retireVouchersByNumberTx(tx, { companyId, voucherNumbers: [voucherNumber], reason: "linked-journal-replaced" });
}

/**
 * Posts a balanced linked journal. Zero lines are dropped; a journal whose
 * lines do not balance to the cent is refused.
 */
export async function postLinkedJournalTx(
  tx: DbTransaction,
  params: {
    companyId: number;
    voucherNumber: string;
    voucherDate: string;
    description: string;
    identity: { sourceType: string; sourceId: string | number };
    lines: LinkedJournalLine[];
    locationId?: number | null;
    optional?: boolean;
  }
): Promise<number | null> {
  const lines = params.lines
    .map((line) => ({ ...line, debit: line.debit.toDecimalPlaces(2), credit: line.credit.toDecimalPlaces(2) }))
    .filter((line) => !line.debit.isZero() || !line.credit.isZero());
  if (lines.length === 0) return null;
  const debits = lines.reduce((sum, line) => sum.plus(line.debit), new MoneyDecimal(0));
  const credits = lines.reduce((sum, line) => sum.plus(line.credit), new MoneyDecimal(0));
  if (!debits.eq(credits)) throw new Error("A perpetual-inventory journal does not balance");

  const { voucher } = await insertInfrastructureVoucherTx(
    tx,
    {
      companyId: params.companyId,
      voucherNumber: params.voucherNumber,
      voucherType: "Journal",
      voucherDate: params.voucherDate,
      description: params.description,
      totalAmount: debits.toFixed(2),
      currency: "USD",
      exchangeRate: "1",
      locationId: params.locationId ?? null,
      optional: params.optional === true,
    },
    infrastructurePostingIdentity(params.identity.sourceType, params.identity.sourceId)
  );
  await tx.insert(voucherEntries).values(
    lines.map((line) => ({
      voucherId: voucher.id,
      ledgerAccountId: line.ledgerAccountId,
      debitAmount: line.debit.toFixed(2),
      creditAmount: line.credit.toFixed(2),
      narration: line.narration,
      ...(line.customerId ? { customerId: line.customerId } : {}),
    }))
  );
  return voucher.id;
}

/** The company's live ledger account with a code, created with the given name and type when missing. */
export async function ledgerAccountByCodeTx(
  tx: DbTransaction,
  companyId: number,
  code: string,
  name: string,
  accountType: string
): Promise<number> {
  const existing = await tx.execute<{ id: number } & Record<string, unknown>>(sql`
    SELECT id FROM ledger_accounts WHERE company_id = ${companyId} AND code = ${code} AND deleted_at IS NULL
     ORDER BY id LIMIT 1
  `);
  const found = (existing.rows as unknown as { id: number }[])[0];
  if (found) return found.id;
  const created = await tx.execute<{ id: number } & Record<string, unknown>>(sql`
    INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
    VALUES (${companyId}, ${code}, ${name}, ${accountType}, 0, 'Dr')
    RETURNING id
  `);
  return (created.rows as unknown as { id: number }[])[0].id;
}

/**
 * What the ledger holds on the company's accounts with the given codes as of a
 * date (debit positive): their opening balances and every active posting
 * booked on or before it (the voucher's effective date when it has one, as
 * the balance engine books it, else its voucher date).
 */
export async function ledgerBalancesByCode(
  executor: DatabaseOrTransaction,
  companyId: number,
  codes: readonly string[],
  asOf: string
): Promise<Map<string, Decimal>> {
  const balances = new Map<string, Decimal>();
  if (codes.length === 0) return balances;
  const held = await executor.execute<{ code: string; balance: string } & Record<string, unknown>>(sql`
    SELECT la.code,
           (COALESCE(SUM(CASE WHEN la.opening_balance_side = 'Cr' THEN -la.opening_balance ELSE la.opening_balance END), 0)
            + COALESCE(SUM(posted.balance), 0))::text AS balance
      FROM ledger_accounts la
      LEFT JOIN LATERAL (
        SELECT SUM(ve.debit_amount - ve.credit_amount) AS balance
          FROM voucher_entries ve
          JOIN vouchers v ON v.id = ve.voucher_id AND v.company_id = ${companyId} AND v.deleted_at IS NULL
                         AND COALESCE(v.optional, false) = false
                         AND COALESCE(v.effective_date, v.voucher_date) <= ${asOf}
         WHERE ve.ledger_account_id = la.id
      ) posted ON true
     WHERE la.company_id = ${companyId} AND la.deleted_at IS NULL AND la.code IN (${sql.join(
       codes.map((code) => sql`${code}`),
       sql`, `
     )})
     GROUP BY la.code
  `);
  for (const row of held.rows as unknown as { code: string; balance: string }[]) {
    balances.set(row.code, new MoneyDecimal(row.balance).toDecimalPlaces(2));
  }
  return balances;
}
