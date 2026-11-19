// Extracted from ./spGoldenCoastHadiTransferRoutes.ts to keep that module under the source-size cap.
import { and, asc, eq, isNull } from "drizzle-orm";
import { companies, ledgerAccounts, voucherEntries, vouchers } from "@shared/schema";
import { db } from "../../db";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import { privilegedRequestBudget } from "../../middleware/privilegedEndpointSecurity";
import type { CentralPostingResult } from "../../services/accounting/centralPostingEngine";
import { createDatabasePostingDependencies } from "../../services/accounting/databasePostingDependencies";
import {
  getGoldenCoastAccountDefinition,
  type GoldenCoastAccountRole,
  type GoldenCoastLedgerRow,
} from "../../services/accounting/goldenCoastAccounts";
import type { GoldenCoastPhase7RoleAccounts } from "../../services/accounting/goldenCoastHadiTransfer";
import { getCompanyRequestRuntimeContext } from "../../services/security/companyRequestRuntimeContext";
import { assertTransactionCompanyScope } from "../../services/security/transactionCompanyScope";
import { loadGoldenCoastAccounts } from "./spGoldenCoastSetupRoutes";

export const postingDependencies = createDatabasePostingDependencies();

export const phase7RequestBudget = privilegedRequestBudget({ maxBodyBytes: 16 * 1024, maxCollectionItems: 10 });

export type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type DbLike = typeof db | DatabaseTransaction;

export type PersistedPostingResult = CentralPostingResult<
  typeof vouchers.$inferSelect,
  typeof voucherEntries.$inferSelect
>;

export class GoldenCoastPhase7RouteError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = "GC_PHASE7_TRANSFER_INVALID", status = 400) {
    super(releaseDebtEnglish(message));
    this.name = "GoldenCoastPhase7RouteError";
    this.code = code;
    this.status = status;
  }
}

export interface GoldenCoastPhase7CompanyPair {
  goldenCoastCompanyId: number;
  goldenCoastCompanyName: string;
  hadiCompanyId: number;
  hadiCompanyName: string;
}

export interface ResolvedPhase7Accounts extends GoldenCoastPhase7RoleAccounts {
  gcSalesCashAccountName: string;
  goldenCoastHadiIntercompanyAccountName: string;
  hadiGoldenCoastIntercompanyAccountName: string;
}

/**
 * Fail-closed gate for the HADI side of a Phase 7 settlement.
 *
 * The tenant request boundary is the only component allowed to widen a request
 * past its active company: it membership-checks caller-supplied
 * `targetCompanyId` values and records the verified ids on the request runtime
 * context. Phase 7 never widens that scope itself. It only confirms the
 * boundary already authorized the company persisted as Golden Coast's
 * `parent_company_id`, so a caller can neither choose HADI nor reach it without
 * membership. Requests that omit `targetCompanyId`, or that name a different
 * company, are refused instead of being silently promoted.
 */
export function assertHadiCompanyAuthorized(pair: GoldenCoastPhase7CompanyPair): void {
  const requestContext = getCompanyRequestRuntimeContext();
  if (!requestContext) {
    throw new GoldenCoastPhase7RouteError(
      "Company request context is unavailable for HADI company authorization",
      "GC_PHASE7_HADI_SCOPE_UNAUTHORIZED",
      403
    );
  }
  if (!requestContext.authorizedCompanyIds?.includes(pair.hadiCompanyId)) {
    throw new GoldenCoastPhase7RouteError(
      `HADI company ${pair.hadiCompanyId} is not authorized for this request; send targetCompanyId=${pair.hadiCompanyId} so the tenant boundary verifies membership first`,
      "GC_PHASE7_HADI_SCOPE_UNAUTHORIZED",
      403
    );
  }
}

export async function resolveCompanyPair(conn: DbLike, companyId: number): Promise<GoldenCoastPhase7CompanyPair> {
  const [goldenCoast] = await conn
    .select({
      id: companies.id,
      name: companies.name,
      parentCompanyId: companies.parentCompanyId,
      active: companies.active,
    })
    .from(companies)
    .where(and(eq(companies.id, companyId), eq(companies.active, true)))
    .limit(1);

  if (!goldenCoast) {
    throw new GoldenCoastPhase7RouteError(
      "The selected Golden Coast company is missing or inactive",
      "GC_PHASE7_COMPANY_INVALID",
      409
    );
  }
  const parentCompanyId = Number(goldenCoast.parentCompanyId ?? 0);
  if (!Number.isInteger(parentCompanyId) || parentCompanyId <= 0 || parentCompanyId === companyId) {
    throw new GoldenCoastPhase7RouteError(
      "Golden Coast must have a distinct active parent company configured before HADI routing can be used",
      "GC_PHASE7_PARENT_COMPANY_INVALID",
      409
    );
  }

  const [hadi] = await conn
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(and(eq(companies.id, parentCompanyId), eq(companies.active, true)))
    .limit(1);
  if (!hadi) {
    throw new GoldenCoastPhase7RouteError(
      "The configured Golden Coast parent company is missing or inactive",
      "GC_PHASE7_PARENT_COMPANY_INVALID",
      409
    );
  }

  return {
    goldenCoastCompanyId: Number(goldenCoast.id),
    goldenCoastCompanyName: String(goldenCoast.name),
    hadiCompanyId: Number(hadi.id),
    hadiCompanyName: String(hadi.name),
  };
}

function activeCanonicalGoldenCoastRole(
  accounts: readonly GoldenCoastLedgerRow[],
  companyId: number,
  role: GoldenCoastAccountRole
): GoldenCoastLedgerRow {
  const definition = getGoldenCoastAccountDefinition(role);
  const matches = accounts.filter(
    (account) =>
      Number(account.companyId) === companyId &&
      account.subType === definition.subType &&
      account.active === true &&
      account.deletedAt == null
  );
  if (matches.length !== 1) {
    throw new GoldenCoastPhase7RouteError(
      matches.length === 0
        ? `Golden Coast role ${role} is missing; run Golden Coast account setup first`
        : `Golden Coast role ${role} is ambiguous (${matches.length} active accounts share ${definition.subType})`,
      "GC_PHASE7_ACCOUNT_INVALID",
      409
    );
  }
  const account = matches[0];
  if (!definition.acceptedAccountTypes.includes(account.accountType)) {
    throw new GoldenCoastPhase7RouteError(
      `Golden Coast role ${role} has invalid account type ${account.accountType}`,
      "GC_PHASE7_ACCOUNT_INVALID",
      409
    );
  }
  return account;
}

async function activeIntercompanyAccount(
  conn: DbLike,
  companyId: number,
  subType: "sp_hadi_intercompany" | "hadi_sp_intercompany",
  label: string
): Promise<{ id: number; name: string }> {
  const rows = await conn
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

  if (rows.length !== 1) {
    throw new GoldenCoastPhase7RouteError(
      rows.length === 0
        ? `${label} is not configured for company ${companyId}`
        : `${label} is ambiguous; repair duplicate active ${subType} accounts first`,
      "GC_PHASE7_INTERCOMPANY_INVALID",
      409
    );
  }
  if (rows[0].accountType !== "Intercompany") {
    throw new GoldenCoastPhase7RouteError(
      `${label} must have account type Intercompany, not ${rows[0].accountType}`,
      "GC_PHASE7_INTERCOMPANY_INVALID",
      409
    );
  }
  return { id: Number(rows[0].id), name: String(rows[0].name) };
}

export async function resolvePhase7Accounts(
  tx: DatabaseTransaction,
  pair: GoldenCoastPhase7CompanyPair
): Promise<ResolvedPhase7Accounts> {
  // Each side is read under its own PostgreSQL tenant scope, and the Golden
  // Coast scope is restored before the caller continues. Sequential switching
  // is required: the two sides cannot share one transaction-local scope.
  await assertTransactionCompanyScope(tx, pair.goldenCoastCompanyId);
  const goldenCoastAccounts = await loadGoldenCoastAccounts(tx, pair.goldenCoastCompanyId);
  const gcSalesCash = activeCanonicalGoldenCoastRole(goldenCoastAccounts, pair.goldenCoastCompanyId, "gc_sales_cash");
  const goldenCoastIntercompany = await activeIntercompanyAccount(
    tx,
    pair.goldenCoastCompanyId,
    "sp_hadi_intercompany",
    "Golden Coast HADI intercompany account"
  );

  await assertTransactionCompanyScope(tx, pair.hadiCompanyId);
  const hadiIntercompany = await activeIntercompanyAccount(
    tx,
    pair.hadiCompanyId,
    "hadi_sp_intercompany",
    "HADI Golden Coast intercompany account"
  );
  await assertTransactionCompanyScope(tx, pair.goldenCoastCompanyId);

  return {
    gcSalesCashAccountId: gcSalesCash.id,
    gcSalesCashAccountName: gcSalesCash.name,
    goldenCoastHadiIntercompanyAccountId: goldenCoastIntercompany.id,
    goldenCoastHadiIntercompanyAccountName: goldenCoastIntercompany.name,
    hadiGoldenCoastIntercompanyAccountId: hadiIntercompany.id,
    hadiGoldenCoastIntercompanyAccountName: hadiIntercompany.name,
  };
}
