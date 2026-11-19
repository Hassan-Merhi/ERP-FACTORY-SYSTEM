// Extracted from ./spGoldenCoastFreshStartHadiPaymentRoutesResolvePair.ts
import { sql } from "drizzle-orm";
import { voucherEntries, vouchers } from "@shared/schema";
import { db } from "../../db";
import { resultRows } from "../../lib/queryResult";
import type { CentralPostingResult } from "../../services/accounting/centralPostingEngine";
import { assertTransactionCompanyScope } from "../../services/security/transactionCompanyScope";

export type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type DbLike = typeof db | DatabaseTransaction;

export type PersistedPostingResult = CentralPostingResult<
  typeof vouchers.$inferSelect,
  typeof voucherEntries.$inferSelect
>;

export interface CompanyPair {
  goldenCoastCompanyId: number;
  goldenCoastCompanyName: string;
  hadiCompanyId: number;
  hadiCompanyName: string;
}

export async function debitBalance(tx: DatabaseTransaction, companyId: number, accountId: number): Promise<string> {
  await assertTransactionCompanyScope(tx, companyId);
  const result = await tx.execute(sql`
    SELECT (
      CASE WHEN la.opening_balance_side = 'Cr'
        THEN -COALESCE(la.opening_balance, 0)::numeric
        ELSE COALESCE(la.opening_balance, 0)::numeric
      END
      + COALESCE((
        SELECT SUM(CAST(ve.debit_amount AS numeric) - CAST(ve.credit_amount AS numeric))
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id
        WHERE ve.ledger_account_id = ${accountId}
          AND v.company_id = ${companyId}
          AND v.deleted_at IS NULL
          AND COALESCE(v.optional, false) = false
      ), 0)
    )::text AS balance
    FROM ledger_accounts la
    WHERE la.id = ${accountId}
      AND la.company_id = ${companyId}
      AND la.active = true
      AND la.deleted_at IS NULL
    LIMIT 1
  `);
  return String(resultRows(result)[0]?.balance ?? "0");
}
