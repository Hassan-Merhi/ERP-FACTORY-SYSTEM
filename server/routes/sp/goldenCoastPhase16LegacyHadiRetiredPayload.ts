// Extracted from ./spGoldenCoastPhase16HadiTransferGuard.ts to keep that module under the source-size cap.
import Decimal from "decimal.js";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { bankAccounts, companies, ledgerAccounts, voucherEntries, vouchers } from "@shared/schema";
import { db } from "../../db";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import { resultRows } from "../../lib/queryResult";
import { privilegedRequestBudget } from "../../middleware/privilegedEndpointSecurity";
import type { CentralPostingResult } from "../../services/accounting/centralPostingEngine";
import { createDatabasePostingDependencies } from "../../services/accounting/databasePostingDependencies";
import { getGoldenCoastAccountDefinition } from "../../services/accounting/goldenCoastPhase2Accounts";
import type {
  GoldenCoastPhase7CashAccount,
  GoldenCoastPhase7RoleAccounts,
} from "../../services/accounting/goldenCoastPhase7HadiTransfer";
import { getCompanyRequestRuntimeContext } from "../../services/security/companyRequestRuntimeContext";
import { assertTransactionCompanyScope } from "../../services/security/transactionCompanyScope";

export const GOLDEN_COAST_PHASE16_LEGACY_HADI_PATH = "/api/sp/golden-coast/phase7/sales-cash-transfer";

export const GOLDEN_COAST_PHASE16_LEGACY_HADI_RETIRED_CODE = "GC_PHASE16_LEGACY_HADI_TRANSFER_RETIRED";

export const postingDependencies = createDatabasePostingDependencies();

export const phase16RequestBudget = privilegedRequestBudget({ maxBodyBytes: 16 * 1024, maxCollectionItems: 10 });

export type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type PersistedPostingResult = CentralPostingResult<
  typeof vouchers.$inferSelect,
  typeof voucherEntries.$inferSelect
>;

export type CompanyPair = {
  goldenCoastCompanyId: number;
  goldenCoastCompanyName: string;
  hadiCompanyId: number;
  hadiCompanyName: string;
};

export class GoldenCoastPhase16HadiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number
  ) {
    super(releaseDebtEnglish(message));
    this.name = "GoldenCoastPhase16HadiError";
  }
}

export function goldenCoastPhase16LegacyHadiRetiredPayload() {
  return {
    code: GOLDEN_COAST_PHASE16_LEGACY_HADI_RETIRED_CODE,
    message: releaseDebtEnglish(
      "Manual HADI collection is retired because Golden Coast sales already route to HADI automatically. Use Pay Fresh Start from HADI to settle the GC Sales Cash payable. HADI remittance back to Golden Coast remains available for proceeds that HADI still holds."
    ),
  };
}

export async function resolvePair(tx: DatabaseTransaction, companyId: number): Promise<CompanyPair> {
  await assertTransactionCompanyScope(tx, companyId);
  const [gc] = await tx
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
    throw new GoldenCoastPhase16HadiError(
      "Golden Coast company is missing or inactive",
      "GC_PHASE16_COMPANY_INVALID",
      409
    );
  const hadiCompanyId = Number(gc.parentCompanyId ?? 0);
  if (!Number.isInteger(hadiCompanyId) || hadiCompanyId <= 0 || hadiCompanyId === companyId) {
    throw new GoldenCoastPhase16HadiError(
      "Golden Coast must have a distinct active HADI parent company",
      "GC_PHASE16_PARENT_INVALID",
      409
    );
  }
  await assertTransactionCompanyScope(tx, hadiCompanyId);
  const [hadi] = await tx
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(and(eq(companies.id, hadiCompanyId), eq(companies.active, true)))
    .limit(1);
  await assertTransactionCompanyScope(tx, companyId);
  if (!hadi)
    throw new GoldenCoastPhase16HadiError(
      "Configured HADI company is missing or inactive",
      "GC_PHASE16_PARENT_INVALID",
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
    throw new GoldenCoastPhase16HadiError(
      `HADI company ${pair.hadiCompanyId} is not authorized for this request; send targetCompanyId=${pair.hadiCompanyId}`,
      "GC_PHASE16_HADI_SCOPE_UNAUTHORIZED",
      403
    );
  }
}

async function singleLedgerAccount(
  tx: DatabaseTransaction,
  companyId: number,
  subType: string,
  label: string,
  acceptedAccountTypes: readonly string[]
): Promise<{ id: number; name: string }> {
  await assertTransactionCompanyScope(tx, companyId);
  const rows = await tx
    .select({ id: ledgerAccounts.id, name: ledgerAccounts.name, accountType: ledgerAccounts.accountType })
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
  if (rows.length !== 1 || !acceptedAccountTypes.includes(rows[0].accountType)) {
    throw new GoldenCoastPhase16HadiError(
      `${label} is missing, ambiguous, or has the wrong account type`,
      "GC_PHASE16_ACCOUNT_INVALID",
      409
    );
  }
  return { id: Number(rows[0].id), name: String(rows[0].name) };
}

export async function resolveAccounts(
  tx: DatabaseTransaction,
  pair: CompanyPair
): Promise<GoldenCoastPhase7RoleAccounts> {
  const gcSalesDefinition = getGoldenCoastAccountDefinition("gc_sales_cash");
  const gcSalesCash = await singleLedgerAccount(
    tx,
    pair.goldenCoastCompanyId,
    gcSalesDefinition.subType,
    "GC Sales Cash",
    gcSalesDefinition.acceptedAccountTypes
  );
  const gcHadi = await singleLedgerAccount(
    tx,
    pair.goldenCoastCompanyId,
    "sp_hadi_intercompany",
    "Golden Coast HADI intercompany",
    ["Intercompany"]
  );
  const hadiGc = await singleLedgerAccount(
    tx,
    pair.hadiCompanyId,
    "hadi_sp_intercompany",
    "HADI Golden Coast intercompany",
    ["Intercompany"]
  );
  await assertTransactionCompanyScope(tx, pair.goldenCoastCompanyId);
  return {
    gcSalesCashAccountId: gcSalesCash.id,
    goldenCoastHadiIntercompanyAccountId: gcHadi.id,
    hadiGoldenCoastIntercompanyAccountId: hadiGc.id,
  };
}

export async function validateCashAccount(
  tx: DatabaseTransaction,
  companyId: number,
  account: GoldenCoastPhase7CashAccount,
  label: string
): Promise<void> {
  await assertTransactionCompanyScope(tx, companyId);
  if (account.kind === "bank") {
    const [row] = await tx
      .select({ id: bankAccounts.id })
      .from(bankAccounts)
      .where(
        and(
          eq(bankAccounts.id, account.id),
          eq(bankAccounts.companyId, companyId),
          eq(bankAccounts.active, true),
          isNull(bankAccounts.deletedAt)
        )
      )
      .limit(1);
    if (!row) throw new GoldenCoastPhase16HadiError(`${label} is unavailable`, "GC_PHASE16_CASH_INVALID", 400);
    return;
  }
  const [row] = await tx
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.id, account.id),
        eq(ledgerAccounts.companyId, companyId),
        inArray(ledgerAccounts.accountType, ["Cash", "Bank"]),
        eq(ledgerAccounts.active, true),
        isNull(ledgerAccounts.deletedAt)
      )
    )
    .limit(1);
  if (!row) throw new GoldenCoastPhase16HadiError(`${label} is unavailable`, "GC_PHASE16_CASH_INVALID", 400);
}

export async function debitBalance(tx: DatabaseTransaction, companyId: number, accountId: number): Promise<Decimal> {
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
  const raw = String(resultRows(result)[0]?.balance ?? "0");
  const parsed = new Decimal(raw);
  if (!parsed.isFinite())
    throw new GoldenCoastPhase16HadiError("HADI intercompany balance is invalid", "GC_PHASE16_BALANCE_INVALID", 409);
  return parsed;
}
