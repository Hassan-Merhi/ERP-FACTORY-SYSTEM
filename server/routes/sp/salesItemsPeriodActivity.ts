// Extracted from ./spGoldenCoastMonthlyCloseRoutes.ts to keep that module under the source-size cap.
import type { Request } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";
import { ledgerAccounts } from "@shared/schema";
import { GC_MANUAL_PROFIT_SUSPENSE_SUBTYPE } from "./spProfitManualCorrections";
import { db } from "../../db";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import { resultRows } from "../../lib/queryResult";
import { privilegedRequestBudget } from "../../middleware/privilegedEndpointSecurity";
import type { PostingActor } from "../../services/accounting/centralPostingEngine";
import { createDatabasePostingDependencies } from "../../services/accounting/databasePostingDependencies";
import {
  getGoldenCoastAccountDefinition,
  type GoldenCoastAccountRole,
} from "../../services/accounting/goldenCoastAccounts";
import { GOLDEN_COAST_PHASE5_SOURCE_TYPE } from "../../services/accounting/goldenCoastPosSale";
import type { GoldenCoastPhase11Accounts } from "../../services/accounting/goldenCoastMonthlyClose";
import type { DbLike } from "./spGoldenCoastCutoverFifoRoutes";

export const postingDependencies = createDatabasePostingDependencies();

export const phase11RequestBudget = privilegedRequestBudget({ maxBodyBytes: 16 * 1024, maxCollectionItems: 10 });

export type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class Phase11RouteError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400
  ) {
    super(releaseDebtEnglish(message));
    this.name = "Phase11RouteError";
  }
}

export function actorFromRequest(req: Request): PostingActor {
  return {
    userId: req.user?.id ?? req.session.userId ?? null,
    username: req.session.username ?? null,
    reason: String(req.body?.reason ?? req.body?.reference ?? "Golden Coast monthly close").trim(),
  };
}

export function monthBounds(periodMonth: string): { start: string; end: string } {
  const [year, month] = periodMonth.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start: `${periodMonth}-01`, end: `${periodMonth}-${String(lastDay).padStart(2, "0")}` };
}

async function resolveCanonicalRole(conn: DbLike, companyId: number, role: GoldenCoastAccountRole): Promise<number> {
  const def = getGoldenCoastAccountDefinition(role);
  const rows = await conn
    .select({ id: ledgerAccounts.id, accountType: ledgerAccounts.accountType })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        eq(ledgerAccounts.subType, def.subType),
        eq(ledgerAccounts.active, true),
        isNull(ledgerAccounts.deletedAt)
      )
    )
    .limit(2);
  if (rows.length !== 1 || !def.acceptedAccountTypes.includes(String(rows[0]?.accountType ?? ""))) {
    throw new Phase11RouteError(
      `Golden Coast role ${role} is missing, ambiguous, or invalid`,
      "GC_PHASE11_ACCOUNT_INVALID",
      409
    );
  }
  return Number(rows[0].id);
}

async function resolveLegacyIncomeExpense(
  conn: DbLike,
  companyId: number,
  subType: string,
  acceptedTypes: readonly string[],
  required: boolean
): Promise<number | null> {
  const rows = await conn
    .select({ id: ledgerAccounts.id, accountType: ledgerAccounts.accountType })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        eq(ledgerAccounts.subType, subType),
        eq(ledgerAccounts.active, true),
        isNull(ledgerAccounts.deletedAt)
      )
    )
    .limit(2);
  if (rows.length === 0 && !required) return null;
  if (rows.length !== 1 || !acceptedTypes.includes(String(rows[0]?.accountType ?? ""))) {
    throw new Phase11RouteError(
      `${subType} account is missing, ambiguous, or invalid`,
      "GC_PHASE11_ACCOUNT_INVALID",
      409
    );
  }
  return Number(rows[0].id);
}

export async function resolveAccounts(conn: DbLike, companyId: number): Promise<GoldenCoastPhase11Accounts> {
  const [sales, cogs, shared, ppd, fresh, hassan, suspense] = await Promise.all([
    resolveLegacyIncomeExpense(conn, companyId, "sp_sales", ["Income", "Direct Income"], true),
    resolveLegacyIncomeExpense(conn, companyId, "sp_cogs", ["Direct Expense", "Expense"], true),
    resolveLegacyIncomeExpense(conn, companyId, "sp_shared_charges", ["Direct Expense", "Expense"], false),
    resolveCanonicalRole(conn, companyId, "profit_pending_distribution"),
    resolveCanonicalRole(conn, companyId, "fresh_start_equity"),
    resolveCanonicalRole(conn, companyId, "hassan_equity"),
    resolveLegacyIncomeExpense(conn, companyId, GC_MANUAL_PROFIT_SUSPENSE_SUBTYPE, ["Asset"], false),
  ]);
  return {
    salesAccountId: Number(sales),
    cogsAccountId: Number(cogs),
    sharedChargesAccountId: shared,
    profitPendingDistributionAccountId: ppd,
    freshStartEquityAccountId: fresh,
    hassanEquityAccountId: hassan,
    correctionSuspenseAccountId: suspense,
  };
}

export async function accountPeriodActivity(
  conn: DbLike,
  companyId: number,
  accountId: number | null,
  start: string,
  end: string
): Promise<{ debit: string; credit: string }> {
  if (!accountId) return { debit: "0", credit: "0" };
  const result = await conn.execute(sql`
    SELECT
      COALESCE(SUM(CAST(ve.debit_amount AS numeric)), 0)::text AS debit,
      COALESCE(SUM(CAST(ve.credit_amount AS numeric)), 0)::text AS credit
    FROM voucher_entries ve
    JOIN vouchers v ON v.id = ve.voucher_id
    WHERE ve.ledger_account_id = ${accountId}
      AND v.company_id = ${companyId}
      AND v.deleted_at IS NULL
      AND COALESCE(v.optional, false) = false
      AND COALESCE(v.effective_date, v.voucher_date) >= ${start}::date
      AND COALESCE(v.effective_date, v.voucher_date) <= ${end}::date
      AND v.voucher_number NOT LIKE 'GC-MC-C%'
  `);
  const row = resultRows(result)[0];
  return { debit: String(row?.debit ?? "0"), credit: String(row?.credit ?? "0") };
}

export async function salesItemsPeriodActivity(
  conn: DbLike,
  companyId: number,
  salesAccountId: number,
  cogsAccountId: number,
  start: string,
  end: string
): Promise<{ revenue: string; cogs: string }> {
  const result = await conn.execute(sql`
    WITH itemized AS (
      SELECT
        COALESCE(SUM(CAST(si.total_sales AS numeric)), 0)::numeric AS revenue,
        COALESCE(SUM(CAST(si.total_cost AS numeric)), 0)::numeric AS cogs
      FROM sales_items si
      JOIN vouchers v ON v.id = si.voucher_id
      WHERE v.company_id = ${companyId}
        AND v.voucher_type = 'Sales'
        AND v.deleted_at IS NULL
        AND COALESCE(v.optional, false) = false
        AND v.voucher_date >= ${start}::date
        AND v.voucher_date <= ${end}::date
    ),
    legacy_phase6 AS (
      SELECT
        COALESCE(SUM(
          CASE WHEN ve.ledger_account_id = ${salesAccountId}
            THEN CAST(ve.credit_amount AS numeric) - CAST(ve.debit_amount AS numeric)
            ELSE 0
          END
        ), 0)::numeric AS revenue,
        COALESCE(SUM(
          CASE WHEN ve.ledger_account_id = ${cogsAccountId}
            THEN CAST(ve.debit_amount AS numeric) - CAST(ve.credit_amount AS numeric)
            ELSE 0
          END
        ), 0)::numeric AS cogs
      FROM accounting_posting_requests apr
      JOIN vouchers v ON v.id = apr.voucher_id
      JOIN voucher_entries ve ON ve.voucher_id = v.id
      WHERE apr.company_id = ${companyId}
        AND apr.source_type = ${GOLDEN_COAST_PHASE5_SOURCE_TYPE}
        AND v.company_id = ${companyId}
        AND v.deleted_at IS NULL
        AND COALESCE(v.optional, false) = false
        AND COALESCE(v.effective_date, v.voucher_date) >= ${start}::date
        AND COALESCE(v.effective_date, v.voucher_date) <= ${end}::date
        AND NOT EXISTS (
          SELECT 1
          FROM sales_items si2
          WHERE si2.voucher_id = v.id
        )
    )
    SELECT
      (itemized.revenue + legacy_phase6.revenue)::text AS revenue,
      (itemized.cogs + legacy_phase6.cogs)::text AS cogs
    FROM itemized
    CROSS JOIN legacy_phase6
  `);
  const row = resultRows(result)[0];
  return {
    revenue: String(row?.revenue ?? "0"),
    cogs: String(row?.cogs ?? "0"),
  };
}
