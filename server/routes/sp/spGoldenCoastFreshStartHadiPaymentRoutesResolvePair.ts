// Extracted from ./spGoldenCoastFreshStartHadiPaymentRoutes.ts to keep that module under the source-size cap.
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { bankAccounts, companies, ledgerAccounts, voucherEntries, vouchers } from "@shared/schema";
import { db } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { privilegedRequestBudget } from "../../middleware/privilegedEndpointSecurity";
import type { CentralPostingResult } from "../../services/accounting/centralPostingEngine";
import { createDatabasePostingDependencies } from "../../services/accounting/databasePostingDependencies";
import {
  GOLDEN_COAST_FRESH_START_HADI_PAYMENT_SOURCE_TYPE,
  type GoldenCoastFreshStartHadiCashAccount,
  type GoldenCoastFreshStartHadiPaymentAccounts,
} from "../../services/accounting/goldenCoastFreshStartHadiPayment";
import { GOLDEN_COAST_PHASE7_SOURCE_TYPE } from "../../services/accounting/goldenCoastPhase7HadiTransfer";
import { getCompanyRequestRuntimeContext } from "../../services/security/companyRequestRuntimeContext";
import { assertTransactionCompanyScope } from "../../services/security/transactionCompanyScope";

export const postingDependencies = createDatabasePostingDependencies();

export const requestBudget = privilegedRequestBudget({
  maxBodyBytes: 16 * 1024,
  maxCollectionItems: 10,
});

export type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type DbLike = typeof db | DatabaseTransaction;

export type PersistedPostingResult = CentralPostingResult<
  typeof vouchers.$inferSelect,
  typeof voucherEntries.$inferSelect
>;

export class FreshStartHadiRouteError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number
  ) {
    super(message);
    this.name = "FreshStartHadiRouteError";
  }
}

export interface CompanyPair {
  goldenCoastCompanyId: number;
  goldenCoastCompanyName: string;
  hadiCompanyId: number;
  hadiCompanyName: string;
}

export async function resolvePair(conn: DbLike, companyId: number): Promise<CompanyPair> {
  const [gc] = await conn
    .select({
      id: companies.id,
      name: companies.name,
      parentCompanyId: companies.parentCompanyId,
      active: companies.active,
    })
    .from(companies)
    .where(and(eq(companies.id, companyId), eq(companies.active, true)))
    .limit(1);
  if (!gc)
    throw new FreshStartHadiRouteError(
      "Golden Coast company is missing or inactive",
      "GC_FS_HADI_COMPANY_INVALID",
      409
    );
  const hadiCompanyId = Number(gc.parentCompanyId ?? 0);
  if (!Number.isInteger(hadiCompanyId) || hadiCompanyId <= 0 || hadiCompanyId === companyId) {
    throw new FreshStartHadiRouteError(
      "Golden Coast must have a distinct active HADI parent company",
      "GC_FS_HADI_PARENT_INVALID",
      409
    );
  }
  const [hadi] = await conn
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(and(eq(companies.id, hadiCompanyId), eq(companies.active, true)))
    .limit(1);
  if (!hadi)
    throw new FreshStartHadiRouteError(
      "Configured HADI company is missing or inactive",
      "GC_FS_HADI_PARENT_INVALID",
      409
    );
  return {
    goldenCoastCompanyId: Number(gc.id),
    goldenCoastCompanyName: String(gc.name),
    hadiCompanyId: Number(hadi.id),
    hadiCompanyName: String(hadi.name),
  };
}

export function assertHadiAuthorized(pair: CompanyPair): void {
  const context = getCompanyRequestRuntimeContext();
  if (!context?.authorizedCompanyIds?.includes(pair.hadiCompanyId)) {
    throw new FreshStartHadiRouteError(
      `HADI company ${pair.hadiCompanyId} is not authorized for this request; send targetCompanyId=${pair.hadiCompanyId}`,
      "GC_FS_HADI_SCOPE_UNAUTHORIZED",
      403
    );
  }
}

async function singleLedgerAccount(
  tx: DatabaseTransaction,
  companyId: number,
  subType: string,
  accountType: string,
  label: string
): Promise<{ id: number; name: string }> {
  await assertTransactionCompanyScope(tx, companyId);
  const rows = await tx
    .select({
      id: ledgerAccounts.id,
      name: ledgerAccounts.name,
      accountType: ledgerAccounts.accountType,
    })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        eq(ledgerAccounts.subType, subType),
        eq(ledgerAccounts.active, true),
        isNull(ledgerAccounts.deletedAt)
      )
    )
    .orderBy(asc(ledgerAccounts.id))
    .limit(2);
  if (rows.length !== 1 || rows[0].accountType !== accountType) {
    throw new FreshStartHadiRouteError(
      `${label} is missing, ambiguous, or has the wrong account type`,
      "GC_FS_HADI_ACCOUNT_INVALID",
      409
    );
  }
  return { id: Number(rows[0].id), name: String(rows[0].name) };
}

export async function resolveAccounts(tx: DatabaseTransaction, pair: CompanyPair) {
  const gcSalesCash = await singleLedgerAccount(
    tx,
    pair.goldenCoastCompanyId,
    "sp_payable",
    "Liability",
    "GC Sales Cash"
  );
  const gcHadi = await singleLedgerAccount(
    tx,
    pair.goldenCoastCompanyId,
    "sp_hadi_intercompany",
    "Intercompany",
    "Golden Coast HADI intercompany"
  );
  const hadiGc = await singleLedgerAccount(
    tx,
    pair.hadiCompanyId,
    "hadi_sp_intercompany",
    "Intercompany",
    "HADI Golden Coast intercompany"
  );
  await assertTransactionCompanyScope(tx, pair.goldenCoastCompanyId);
  return {
    ids: {
      gcSalesCashAccountId: gcSalesCash.id,
      goldenCoastHadiIntercompanyAccountId: gcHadi.id,
      hadiGoldenCoastIntercompanyAccountId: hadiGc.id,
    } satisfies GoldenCoastFreshStartHadiPaymentAccounts,
    names: {
      gcSalesCash: gcSalesCash.name,
      goldenCoastHadiIntercompany: gcHadi.name,
      hadiGoldenCoastIntercompany: hadiGc.name,
    },
  };
}

export async function listHadiCashAccounts(tx: DatabaseTransaction, hadiCompanyId: number) {
  await assertTransactionCompanyScope(tx, hadiCompanyId);
  const [ledgerRows, bankRows] = await Promise.all([
    tx
      .select({
        id: ledgerAccounts.id,
        name: ledgerAccounts.name,
        accountType: ledgerAccounts.accountType,
      })
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.companyId, hadiCompanyId),
          inArray(ledgerAccounts.accountType, ["Cash", "Bank"]),
          eq(ledgerAccounts.active, true),
          isNull(ledgerAccounts.deletedAt)
        )
      )
      .orderBy(asc(ledgerAccounts.name)),
    tx
      .select({ id: bankAccounts.id, name: bankAccounts.name })
      .from(bankAccounts)
      .where(
        and(eq(bankAccounts.companyId, hadiCompanyId), eq(bankAccounts.active, true), isNull(bankAccounts.deletedAt))
      )
      .orderBy(asc(bankAccounts.name)),
  ]);
  return [
    ...ledgerRows.map((row) => ({
      kind: "ledger" as const,
      id: Number(row.id),
      name: String(row.name),
      type: row.accountType,
    })),
    ...bankRows.map((row) => ({
      kind: "bank" as const,
      id: Number(row.id),
      name: String(row.name),
      type: "Bank Account",
    })),
  ];
}

export async function validateHadiCashAccount(
  tx: DatabaseTransaction,
  hadiCompanyId: number,
  account: GoldenCoastFreshStartHadiCashAccount
): Promise<void> {
  await assertTransactionCompanyScope(tx, hadiCompanyId);
  if (account.kind === "bank") {
    const [row] = await tx
      .select({ id: bankAccounts.id })
      .from(bankAccounts)
      .where(
        and(
          eq(bankAccounts.id, account.id),
          eq(bankAccounts.companyId, hadiCompanyId),
          eq(bankAccounts.active, true),
          isNull(bankAccounts.deletedAt)
        )
      )
      .limit(1);
    if (!row)
      throw new FreshStartHadiRouteError("Selected HADI bank account is unavailable", "GC_FS_HADI_CASH_INVALID", 400);
    return;
  }
  const [row] = await tx
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.id, account.id),
        eq(ledgerAccounts.companyId, hadiCompanyId),
        inArray(ledgerAccounts.accountType, ["Cash", "Bank"]),
        eq(ledgerAccounts.active, true),
        isNull(ledgerAccounts.deletedAt)
      )
    )
    .limit(1);
  if (!row)
    throw new FreshStartHadiRouteError("Selected HADI cash account is unavailable", "GC_FS_HADI_CASH_INVALID", 400);
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

export async function outstandingHadiSalesCash(tx: DatabaseTransaction, companyId: number): Promise<string> {
  await assertTransactionCompanyScope(tx, companyId);
  const result = await tx.execute(sql`
    SELECT GREATEST(
      COALESCE(SUM(CASE
        WHEN apr.source_type = ${GOLDEN_COAST_PHASE7_SOURCE_TYPE}
         AND split_part(apr.source_id, ':', 1) = 'collect_via_hadi'
         AND split_part(apr.source_id, ':', 3) = 'golden_coast'
        THEN CAST(v.total_amount AS numeric) ELSE 0 END), 0)
      - COALESCE(SUM(CASE
        WHEN apr.source_type = ${GOLDEN_COAST_PHASE7_SOURCE_TYPE}
         AND split_part(apr.source_id, ':', 1) = 'remit_from_hadi'
         AND split_part(apr.source_id, ':', 3) = 'golden_coast'
        THEN CAST(v.total_amount AS numeric) ELSE 0 END), 0)
      - COALESCE(SUM(CASE
        WHEN apr.source_type = ${GOLDEN_COAST_FRESH_START_HADI_PAYMENT_SOURCE_TYPE}
         AND split_part(apr.source_id, ':', 1) = 'payment'
         AND split_part(apr.source_id, ':', 3) = 'golden_coast'
        THEN CAST(v.total_amount AS numeric) ELSE 0 END), 0),
      0
    )::text AS outstanding
    FROM accounting_posting_requests apr
    JOIN vouchers v ON v.id = apr.voucher_id
    WHERE apr.company_id = ${companyId}
      AND v.company_id = ${companyId}
      AND v.deleted_at IS NULL
      AND apr.source_type IN (${GOLDEN_COAST_PHASE7_SOURCE_TYPE}, ${GOLDEN_COAST_FRESH_START_HADI_PAYMENT_SOURCE_TYPE})
  `);
  return String(resultRows(result)[0]?.outstanding ?? "0");
}
