import { db } from "../db";
import { sql } from "drizzle-orm";
import { toMoney } from "./money";

/**
 * Fire-and-forget: checks which of the supplied ledger account IDs are
 * Loans-type and re-runs FIFO payment allocation for each one.
 * Errors are swallowed so a failure never breaks the calling voucher save.
 */
export async function autoReallocateLoansAccounts(
  companyId: number,
  ledgerAccountIds: (number | null | undefined)[]
): Promise<void> {
  const ids = [...new Set(ledgerAccountIds.filter((id): id is number => typeof id === "number" && id > 0))];
  if (!ids.length) return;

  const result = await db.execute(
    sql`SELECT id FROM ledger_accounts
        WHERE id = ANY(ARRAY[${sql.raw(ids.join(","))}]::integer[])
          AND account_type = 'Loans'
          AND deleted_at IS NULL`
  );

  for (const row of result.rows as { id: number }[]) {
    await runFifoAllocation(companyId, row.id).catch(() => {});
  }
}

async function runFifoAllocation(companyId: number, accountId: number): Promise<void> {
  const entryRows = await db.execute(sql`
    SELECT ve.id, ve.debit_amount, ve.credit_amount
    FROM voucher_entries ve
    JOIN vouchers v ON v.id = ve.voucher_id
    WHERE ve.ledger_account_id = ${accountId}
      AND v.company_id = ${companyId}
      AND v.deleted_at IS NULL
      AND (v.optional IS DISTINCT FROM true)
    ORDER BY v.voucher_date ASC, ve.id ASC
  `);

  const entries = entryRows.rows as Array<{
    id: number;
    debit_amount: string;
    credit_amount: string;
  }>;
  if (!entries.length) return;

  const creditEntries = entries
    .filter((e) => toMoney(e.credit_amount).toNumber() > 0)
    .map((e) => ({ id: e.id, remaining: toMoney(e.credit_amount).toNumber() }));

  const debitEntries = entries
    .filter((e) => toMoney(e.debit_amount).toNumber() > 0)
    .map((e) => ({ id: e.id, remaining: toMoney(e.debit_amount).toNumber() }));

  // Clear existing allocations for all entries in this account
  const allIds = entries.map((e) => e.id);
  await db.execute(sql`
    DELETE FROM transporter_payment_allocations
    WHERE company_id = ${companyId}
      AND (
        credit_entry_id = ANY(ARRAY[${sql.raw(allIds.join(","))}]::integer[])
        OR debit_entry_id = ANY(ARRAY[${sql.raw(allIds.join(","))}]::integer[])
      )
  `);

  // FIFO distribution: oldest credits first
  const newAllocations: Array<{ debitId: number; creditId: number; amount: number }> = [];
  for (const debit of debitEntries) {
    let remaining = debit.remaining;
    for (const credit of creditEntries) {
      if (remaining < 0.005) break;
      if (credit.remaining < 0.005) continue;
      const alloc = Math.min(remaining, credit.remaining);
      newAllocations.push({ debitId: debit.id, creditId: credit.id, amount: alloc });
      remaining -= alloc;
      credit.remaining -= alloc;
    }
  }

  for (const a of newAllocations) {
    await db.execute(sql`
      INSERT INTO transporter_payment_allocations
        (company_id, debit_entry_id, credit_entry_id, allocated_amount)
      VALUES (${companyId}, ${a.debitId}, ${a.creditId}, ${a.amount})
    `);
  }
}
