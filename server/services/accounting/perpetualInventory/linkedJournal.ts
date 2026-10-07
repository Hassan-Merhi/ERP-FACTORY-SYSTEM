/**
 * Linked journals for perpetual inventory (wave 8).
 *
 * The perpetual-inventory postings are separate journals linked to their
 * source document by a deterministic voucher number (COGS-{sale},
 * GIT-PO-{purchaseOrder}, STOCK-IN-{container}), so the source documents keep
 * the lines every existing reader expects. Each journal is derived from the
 * current state of its source and replaced whole when that source changes:
 * remove, then post again. Posting goes through the idempotent infrastructure
 * voucher writer; removal also removes the posting identity so the journal can
 * be posted again.
 */
import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import { voucherEntries } from "@shared/schema";

import type { DbTransaction } from "../../../db";
import { MoneyDecimal } from "../../../lib/money";
import {
  deleteInfrastructurePostingIdentityForVoucherTx,
  infrastructurePostingIdentity,
  insertInfrastructureVoucherTx,
} from "../infrastructureVoucherIdentity";
import { ensureSystemAccounts } from "../systemAccounts";

export interface LinkedJournalLine {
  ledgerAccountId: number;
  debit: Decimal;
  credit: Decimal;
  narration: string;
}

/** Supplier-partner companies carry their stock in their own sp_stock accounts and are not posted. */
export async function isSupplierPartnerCompany(tx: DbTransaction, companyId: number): Promise<boolean> {
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

/** Removes a linked journal and its posting identity, if any. */
export async function removeLinkedJournalTx(
  tx: DbTransaction,
  companyId: number,
  voucherNumber: string
): Promise<void> {
  const existing = await tx.execute<{ id: number } & Record<string, unknown>>(sql`
    SELECT id FROM vouchers WHERE company_id = ${companyId} AND voucher_number = ${voucherNumber}
  `);
  for (const { id } of existing.rows as unknown as { id: number }[]) {
    await deleteInfrastructurePostingIdentityForVoucherTx(tx, id);
    await tx.execute(sql`DELETE FROM voucher_entries WHERE voucher_id = ${id}`);
    await tx.execute(sql`DELETE FROM vouchers WHERE id = ${id} AND company_id = ${companyId}`);
  }
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
    }))
  );
  return voucher.id;
}
