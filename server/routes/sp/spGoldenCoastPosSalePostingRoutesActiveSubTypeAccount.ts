// Extracted from ./spGoldenCoastPosSalePostingRoutes.ts to keep that module under the source-size cap.
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { ledgerAccounts, locations, voucherEntries, vouchers } from "@shared/schema";
import { db } from "../../db";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import { resultRows } from "../../lib/queryResult";
import { privilegedRequestBudget } from "../../middleware/privilegedEndpointSecurity";
import type { CentralPostingResult } from "../../services/accounting/centralPostingEngine";
import { createDatabasePostingDependencies } from "../../services/accounting/databasePostingDependencies";
import {
  getGoldenCoastAccountDefinition,
  type GoldenCoastAccountRole,
  type GoldenCoastLedgerRow,
} from "../../services/accounting/goldenCoastAccounts";
import {
  GOLDEN_COAST_CUTOVER_DATE,
  GOLDEN_COAST_CUTOVER_FIFO_SOURCE,
} from "../../services/accounting/goldenCoastCutoverFifo";
import type { GoldenCoastPhase5RoleAccounts } from "../../services/accounting/goldenCoastPosSale";
import { loadGoldenCoastAccounts } from "./spGoldenCoastSetupRoutes";

export const postingDependencies = createDatabasePostingDependencies();

export const phase5RequestBudget = privilegedRequestBudget({ maxBodyBytes: 32 * 1024, maxCollectionItems: 50 });

export const PHASE5_MAX_SALE_LINES = 50;

export type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type DbLike = typeof db | DatabaseTransaction;

export type PersistedPostingResult = CentralPostingResult<
  typeof vouchers.$inferSelect,
  typeof voucherEntries.$inferSelect
>;

export class GoldenCoastPhase5RouteError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = "GC_PHASE5_SALE_INVALID", status = 400) {
    super(releaseDebtEnglish(message));
    this.name = "GoldenCoastPhase5RouteError";
    this.code = code;
    this.status = status;
  }
}

/** Canonical Phase 2 roles the Phase 5 journal posts against. */
const PHASE5_REQUIRED_ROLES = ["gc_sales_cash", "stock_in_hand"] as const satisfies readonly GoldenCoastAccountRole[];

/** Sales/COGS keep their canonical Supplier Partner sub types. */
const SALES_REVENUE_SUBTYPE = "sp_sales";

const COGS_SUBTYPE = "sp_cogs";

function activeCanonicalRoleAccount(
  accounts: readonly GoldenCoastLedgerRow[],
  role: GoldenCoastAccountRole
): GoldenCoastLedgerRow {
  const definition = getGoldenCoastAccountDefinition(role);
  const matches = accounts.filter(
    (account) => account.subType === definition.subType && account.active === true && account.deletedAt == null
  );
  if (matches.length !== 1) {
    throw new GoldenCoastPhase5RouteError(
      matches.length === 0
        ? `Golden Coast role ${role} is missing; run Golden Coast account setup first`
        : `Golden Coast role ${role} is ambiguous (${matches.length} active accounts share ${definition.subType})`,
      "GC_PHASE5_ROLES_INVALID",
      409
    );
  }
  return matches[0];
}

async function activeSubTypeAccount(
  conn: DbLike,
  companyId: number,
  subType: string,
  expectedAccountTypes: readonly string[]
): Promise<{ id: number; name: string; accountType: string }> {
  const rows = await conn
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

  if (rows.length !== 1) {
    throw new GoldenCoastPhase5RouteError(
      rows.length === 0
        ? `Golden Coast accounting role ${subType} is not configured for this company`
        : `Golden Coast accounting role ${subType} is ambiguous; repair duplicate canonical accounts first`,
      "GC_PHASE5_ROLES_INVALID",
      409
    );
  }
  const account = { id: Number(rows[0].id), name: rows[0].name, accountType: String(rows[0].accountType) };
  if (!expectedAccountTypes.includes(account.accountType)) {
    throw new GoldenCoastPhase5RouteError(
      `Golden Coast accounting role ${subType} must be one of ${expectedAccountTypes.join(", ")}; ` +
        `account "${account.name}" is ${account.accountType}`,
      "GC_PHASE5_ROLES_INVALID",
      409
    );
  }
  return account;
}

export async function resolvePhase5Accounts(
  conn: DbLike,
  companyId: number
): Promise<GoldenCoastPhase5RoleAccounts & { saleSideAccountName: string }> {
  const goldenCoastAccounts = await loadGoldenCoastAccounts(conn, companyId);
  for (const role of PHASE5_REQUIRED_ROLES) activeCanonicalRoleAccount(goldenCoastAccounts, role);

  const saleSide = activeCanonicalRoleAccount(goldenCoastAccounts, "gc_sales_cash");
  const stockInHand = activeCanonicalRoleAccount(goldenCoastAccounts, "stock_in_hand");
  const [salesRevenue, cogs] = await Promise.all([
    activeSubTypeAccount(conn, companyId, SALES_REVENUE_SUBTYPE, ["Income", "Direct Income"]),
    activeSubTypeAccount(conn, companyId, COGS_SUBTYPE, ["Direct Expense", "Expense"]),
  ]);

  return {
    saleSideAccountId: saleSide.id,
    saleSideAccountName: saleSide.name,
    salesRevenueAccountId: salesRevenue.id,
    cogsAccountId: cogs.id,
    stockInHandAccountId: stockInHand.id,
  };
}

/**
 * Phase 5 only runs on a company whose Phase 3 cutover and Phase 4 opening FIFO
 * bridge are already in place: without them a sale would consume lots that have
 * no reconciled acquisition cost behind them.
 */
export async function assertPhase4BridgePosted(conn: DbLike, companyId: number): Promise<number> {
  const rows = await conn.execute(sql`
    SELECT COUNT(*)::int AS lot_count
    FROM sp_stock_movements
    WHERE company_id = ${companyId}
      AND source_type = ${GOLDEN_COAST_CUTOVER_FIFO_SOURCE}
  `);
  const lotCount = Number(resultRows(rows)[0]?.lot_count ?? 0);
  if (lotCount <= 0) {
    throw new GoldenCoastPhase5RouteError(
      `The Golden Coast ${GOLDEN_COAST_CUTOVER_DATE} opening FIFO bridge has not been posted yet`,
      "GC_PHASE5_NOT_READY",
      409
    );
  }
  return lotCount;
}

export async function assertCompanyLocation(conn: DbLike, companyId: number, locationId: number): Promise<void> {
  const [row] = await conn
    .select({ id: locations.id })
    .from(locations)
    .where(
      and(
        eq(locations.id, locationId),
        eq(locations.companyId, companyId),
        eq(locations.active, true),
        isNull(locations.deletedAt)
      )
    )
    .limit(1);
  if (!row) {
    throw new GoldenCoastPhase5RouteError(
      `Location ${locationId} is not an active location in this company`,
      "GC_PHASE5_LOCATION_INVALID",
      400
    );
  }
}
