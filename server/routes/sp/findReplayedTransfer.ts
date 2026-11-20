// Extracted from ./spGoldenCoastPhase7HadiTransferRoutes.ts to keep that module under the source-size cap.
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { bankAccounts, ledgerAccounts } from "@shared/schema";
import { resultRows } from "../../lib/queryResult";
import { GOLDEN_COAST_PHASE7_SOURCE_TYPE } from "../../services/accounting/goldenCoastPhase7HadiTransfer";
import { GoldenCoastPhase7RouteError, type DbLike } from "./spGoldenCoastPhase7HadiTransferRoutesResolveCompanyPair";

export async function listCashAccounts(conn: DbLike, companyId: number) {
  const [ledgerRows, bankRows] = await Promise.all([
    conn
      .select({ id: ledgerAccounts.id, name: ledgerAccounts.name, accountType: ledgerAccounts.accountType })
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.companyId, companyId),
          eq(ledgerAccounts.active, true),
          isNull(ledgerAccounts.deletedAt),
          inArray(ledgerAccounts.accountType, ["Cash", "Bank"])
        )
      )
      .orderBy(asc(ledgerAccounts.name)),
    conn
      .select({ id: bankAccounts.id, name: bankAccounts.name })
      .from(bankAccounts)
      .where(and(eq(bankAccounts.companyId, companyId), eq(bankAccounts.active, true), isNull(bankAccounts.deletedAt)))
      .orderBy(asc(bankAccounts.name)),
  ]);
  return [
    ...ledgerRows.map((row) => ({
      kind: "ledger" as const,
      id: Number(row.id),
      name: row.name,
      type: row.accountType,
    })),
    ...bankRows.map((row) => ({ kind: "bank" as const, id: Number(row.id), name: row.name, type: "Bank Account" })),
  ];
}

/**
 * Raw signed debit-minus-credit on GC Sales Cash. The account is credit-normal,
 * so callers convert this through `gcSalesCashPayableBalance` before reporting
 * or planning against what is still owed.
 */
export async function gcSalesCashSignedBalance(conn: DbLike, companyId: number, accountId: number): Promise<string> {
  const query = await conn.execute(sql`
    SELECT (
      CASE
        WHEN la.opening_balance_side = 'Cr' THEN -COALESCE(la.opening_balance, 0)::numeric
        ELSE COALESCE(la.opening_balance, 0)::numeric
      END
      + COALESCE((
        SELECT SUM(CAST(ve.debit_amount AS numeric) - CAST(ve.credit_amount AS numeric))
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id
        WHERE ve.ledger_account_id = ${accountId}
          AND v.company_id = ${companyId}
          AND v.deleted_at IS NULL
          AND v.optional = false
      ), 0)
    )::text AS debit_minus_credit
    FROM ledger_accounts la
    WHERE la.id = ${accountId}
      AND la.company_id = ${companyId}
      AND la.active = true
      AND la.deleted_at IS NULL
    LIMIT 1
  `);
  const row = resultRows(query)[0];
  if (!row) {
    throw new GoldenCoastPhase7RouteError(
      "GC Sales Cash disappeared while Phase 7 balances were being read",
      "GC_PHASE7_ACCOUNT_INVALID",
      409
    );
  }
  return String(row.debit_minus_credit ?? "0");
}

/**
 * Only Phase 7 collection/remittance vouchers participate in this outstanding
 * amount. The shared intercompany accounts also carry unrelated HADI agent
 * activity, which must never become remittable sales cash by accident.
 */
export async function outstandingPhase7HadiCollections(conn: DbLike, companyId: number): Promise<string> {
  const query = await conn.execute(sql`
    SELECT (
      COALESCE(SUM(CASE
        WHEN split_part(apr.source_id, ':', 1) = 'collect_via_hadi'
         AND split_part(apr.source_id, ':', 3) = 'golden_coast'
        THEN CAST(v.total_amount AS numeric) ELSE 0 END), 0)
      -
      COALESCE(SUM(CASE
        WHEN split_part(apr.source_id, ':', 1) = 'remit_from_hadi'
         AND split_part(apr.source_id, ':', 3) = 'golden_coast'
        THEN CAST(v.total_amount AS numeric) ELSE 0 END), 0)
    )::text AS outstanding
    FROM accounting_posting_requests apr
    JOIN vouchers v ON v.id = apr.voucher_id
    WHERE apr.company_id = ${companyId}
      AND apr.source_type = ${GOLDEN_COAST_PHASE7_SOURCE_TYPE}
      AND v.company_id = ${companyId}
      AND v.deleted_at IS NULL
  `);
  return String(resultRows(query)[0]?.outstanding ?? "0");
}
