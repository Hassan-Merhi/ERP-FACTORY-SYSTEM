/**
 * Shared posting helpers of the Retail cash and stock journals (accounting
 * audit wave 17 D). Vouchers go through the central posting engine
 * (postBalancedVoucherTx: balanced, closed-period checked, one posting
 * identity per source, audited in the transaction), in the company's base
 * currency like the Retail sale and refund journals, dated on the company's
 * business date unless a date is given.
 */
import type Decimal from "decimal.js";
import { and, eq, inArray } from "drizzle-orm";

import { companies, ledgerAccounts } from "@shared/schema";

import type { DbTransaction } from "../../db";
import { MoneyDecimal } from "../../lib/money";
import { postBalancedVoucherTx } from "../accounting/centralPostingEngine";
import { companyBusinessDate } from "../accounting/companyBusinessDate";
import { createDatabasePostingDependencies } from "../accounting/databasePostingDependencies";
import { ensureSystemAccounts, systemAccountDefinition } from "../accounting/systemAccounts";
import { RetailAccountConflictError, type RetailAccountConflict } from "./retailFinancialService";

const postingDependencies = createDatabasePostingDependencies();

export interface RetailJournalLine {
  ledgerAccountId?: number | null;
  bankAccountId?: number | null;
  /** Signed: positive debits, negative credits. */
  amount: Decimal;
  narration: string;
}

export interface RetailJournalActor {
  userId: string;
  username?: string | null;
}

export function cents(value: Decimal.Value): Decimal {
  return new MoneyDecimal(value).toDecimalPlaces(2, MoneyDecimal.ROUND_HALF_UP);
}

async function companyCurrency(tx: DbTransaction, companyId: number): Promise<string> {
  const [company] = await tx
    .select({ baseCurrency: companies.baseCurrency })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  return String(company?.baseCurrency || "USD")
    .slice(0, 3)
    .toUpperCase();
}

/**
 * The ids of Retail system accounts (registry codes), created when missing.
 * An existing account is never renamed, retyped or restored; one that is
 * deleted or has another type refuses (RetailAccountConflictError, 409).
 */
export async function retailSystemAccountIdsTx(
  tx: DbTransaction,
  companyId: number,
  codes: readonly string[]
): Promise<Map<string, number>> {
  const statuses = await ensureSystemAccounts(tx, companyId, codes);
  const byName = statuses.flatMap((status) => (status.state === "reused_by_name" ? [status.accountId] : []));
  const types = new Map<number, string>();
  if (byName.length) {
    const rows = await tx
      .select({ id: ledgerAccounts.id, accountType: ledgerAccounts.accountType })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.companyId, companyId), inArray(ledgerAccounts.id, byName)));
    for (const row of rows) types.set(row.id, String(row.accountType));
  }
  const conflicts: RetailAccountConflict[] = [];
  const ids = new Map<string, number>();
  for (const status of statuses) {
    const expectedType = systemAccountDefinition(status.code)?.accountType ?? "";
    if (status.state === "missing") throw new Error(`Could not resolve Retail accounting account ${status.code}`);
    if (status.state === "deleted") {
      conflicts.push({
        code: status.code,
        accountId: status.accountId,
        issue: "deleted",
        expectedType,
        actualType: null,
      });
      continue;
    }
    if (status.state === "type_differs") {
      conflicts.push({
        code: status.code,
        accountId: status.accountId,
        issue: "type_differs",
        expectedType,
        actualType: status.actualType,
      });
      continue;
    }
    if (status.state === "reused_by_name" && types.get(status.accountId) !== expectedType) {
      conflicts.push({
        code: status.code,
        accountId: status.accountId,
        issue: "type_differs",
        expectedType,
        actualType: types.get(status.accountId) ?? null,
      });
      continue;
    }
    ids.set(status.code, status.accountId);
  }
  if (conflicts.length) throw new RetailAccountConflictError(conflicts);
  return ids;
}

export async function retailSystemAccountIdTx(tx: DbTransaction, companyId: number, code: string): Promise<number> {
  const id = (await retailSystemAccountIdsTx(tx, companyId, [code])).get(code);
  if (!id) throw new Error(`Could not resolve Retail accounting account ${code}`);
  return id;
}

/**
 * Posts a balanced Retail journal from signed lines (zero lines dropped; lines
 * on the same target are netted). Returns the voucher id, or null when every
 * line nets to zero. A replay of the same source returns the voucher posted
 * the first time.
 */
export async function postRetailJournalTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    locationId?: number | null;
    voucherNumber: string;
    sourceType: string;
    sourceId: string;
    description: string;
    lines: RetailJournalLine[];
    actor: RetailJournalActor;
    reason: string;
    voucherDate?: string;
  }
): Promise<number | null> {
  const netted = new Map<string, RetailJournalLine>();
  for (const line of input.lines) {
    const key = line.bankAccountId ? `bank:${line.bankAccountId}` : `ledger:${line.ledgerAccountId}`;
    const existing = netted.get(key);
    netted.set(key, existing ? { ...existing, amount: existing.amount.plus(line.amount) } : { ...line });
  }
  const lines = [...netted.values()]
    .map((line) => ({ ...line, amount: cents(line.amount) }))
    .filter((line) => !line.amount.isZero());
  if (!lines.length) return null;
  const debit = lines.filter((line) => line.amount.gt(0)).reduce((acc, line) => acc.plus(line.amount), cents(0));
  const credit = lines.filter((line) => line.amount.lt(0)).reduce((acc, line) => acc.minus(line.amount), cents(0));
  if (!debit.eq(credit)) throw new Error(`Retail journal ${input.voucherNumber} does not balance`);

  const posted = await postBalancedVoucherTx(
    tx,
    {
      voucher: {
        companyId: input.companyId,
        voucherNumber: input.voucherNumber,
        voucherType: "Journal",
        voucherDate: input.voucherDate ?? (await companyBusinessDate(input.companyId, tx)),
        totalAmount: debit.toFixed(2),
        description: input.description,
        locationId: input.locationId ?? null,
        currency: await companyCurrency(tx, input.companyId),
        sourceModule: "Retail",
      },
      entries: lines.map((line) => ({
        ...(line.bankAccountId ? { bankAccountId: line.bankAccountId } : { ledgerAccountId: line.ledgerAccountId }),
        debitAmount: line.amount.gt(0) ? line.amount.toFixed(2) : "0",
        creditAmount: line.amount.lt(0) ? line.amount.negated().toFixed(2) : "0",
        narration: line.narration,
      })),
      source: {
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        idempotencyKey: `${input.sourceType}:${input.sourceId}`,
      },
      actor: { userId: input.actor.userId, username: input.actor.username ?? null, reason: input.reason },
    },
    postingDependencies
  );
  return posted.voucher.id;
}
