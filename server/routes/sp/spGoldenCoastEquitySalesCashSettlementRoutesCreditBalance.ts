// Extracted from ./spGoldenCoastEquitySalesCashSettlementRoutes.ts to keep that module under the source-size cap.
import type { Request } from "express";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { ledgerAccounts } from "@shared/schema";
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
import type { GoldenCoastEquitySalesCashAccounts } from "../../services/accounting/goldenCoastEquitySalesCashSettlement";
import {
  gcSalesCashConservativePayable,
  gcSalesCashPayableBalance,
  gcSalesCashSettleablePayable,
} from "../../services/accounting/goldenCoastSalesCashPayable";
import type { DbLike } from "./spGoldenCoastCutoverFifoRoutes";

/**
 * Golden Coast — settle the GC Sales Cash payable out of Hassan's own equity.
 *
 * The cash-funded alternative is Phase 10; this route posts the same relief of
 * the payable with no asset movement at all, taking the funding from Hassan
 * Dakik Equity and plugging Fresh Start FZ Equity. See the service module for
 * why the plug is twice the settlement amount.
 */
export const postingDependencies = createDatabasePostingDependencies();

export const equitySalesCashRequestBudget = privilegedRequestBudget({
  maxBodyBytes: 16 * 1024,
  maxCollectionItems: 10,
});

const ROLES = {
  gcSalesCash: "gc_sales_cash",
  hassanEquity: "hassan_equity",
  freshStartEquity: "fresh_start_equity",
} as const satisfies Record<string, GoldenCoastAccountRole>;

export type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface ResolvedAccount {
  id: number;
  name: string;
  accountType: string;
}

export class GoldenCoastEquitySalesCashRouteError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = "GC_EQUITY_SALES_CASH_INVALID", status = 400) {
    super(releaseDebtEnglish(message));
    this.name = "GoldenCoastEquitySalesCashRouteError";
    this.code = code;
    this.status = status;
  }
}

export function actorFromRequest(req: Request): PostingActor {
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  return {
    userId: req.user?.id ?? req.session.userId ?? null,
    username: req.session.username ?? null,
    reason: reason || "Golden Coast GC Sales Cash settlement from equity",
  };
}

async function resolveCanonicalAccount(
  conn: DbLike,
  companyId: number,
  role: GoldenCoastAccountRole
): Promise<ResolvedAccount> {
  const definition = getGoldenCoastAccountDefinition(role);
  const rows = await conn
    .select({ id: ledgerAccounts.id, name: ledgerAccounts.name, accountType: ledgerAccounts.accountType })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        eq(ledgerAccounts.subType, definition.subType),
        eq(ledgerAccounts.active, true),
        isNull(ledgerAccounts.deletedAt)
      )
    )
    .orderBy(asc(ledgerAccounts.id))
    .limit(2);

  if (rows.length !== 1) {
    throw new GoldenCoastEquitySalesCashRouteError(
      rows.length === 0
        ? `${definition.name} is not configured; run Golden Coast account setup first`
        : `${definition.name} is ambiguous; repair duplicate canonical accounts before settling`,
      "GC_EQUITY_SALES_CASH_ACCOUNT_INVALID",
      409
    );
  }
  const account = { id: Number(rows[0].id), name: String(rows[0].name), accountType: String(rows[0].accountType) };
  if (!definition.acceptedAccountTypes.includes(account.accountType)) {
    throw new GoldenCoastEquitySalesCashRouteError(
      `${definition.name} must use account type ${definition.acceptedAccountTypes.join(" or ")}, not ${account.accountType}`,
      "GC_EQUITY_SALES_CASH_ACCOUNT_INVALID",
      409
    );
  }
  return account;
}

export async function resolveAccounts(
  conn: DbLike,
  companyId: number
): Promise<{ gcSalesCash: ResolvedAccount; hassanEquity: ResolvedAccount; freshStartEquity: ResolvedAccount }> {
  const [gcSalesCash, hassanEquity, freshStartEquity] = await Promise.all([
    resolveCanonicalAccount(conn, companyId, ROLES.gcSalesCash),
    resolveCanonicalAccount(conn, companyId, ROLES.hassanEquity),
    resolveCanonicalAccount(conn, companyId, ROLES.freshStartEquity),
  ]);
  const distinct = new Set([gcSalesCash.id, hassanEquity.id, freshStartEquity.id]);
  if (distinct.size !== 3) {
    throw new GoldenCoastEquitySalesCashRouteError(
      "GC Sales Cash, Hassan Dakik Equity and Fresh Start FZ Equity must resolve to three distinct accounts",
      "GC_EQUITY_SALES_CASH_ACCOUNT_INVALID",
      409
    );
  }
  return { gcSalesCash, hassanEquity, freshStartEquity };
}

export function postingAccounts(accounts: {
  gcSalesCash: ResolvedAccount;
  hassanEquity: ResolvedAccount;
  freshStartEquity: ResolvedAccount;
}): GoldenCoastEquitySalesCashAccounts {
  return {
    gcSalesCashAccountId: accounts.gcSalesCash.id,
    hassanEquityAccountId: accounts.hassanEquity.id,
    freshStartEquityAccountId: accounts.freshStartEquity.id,
  };
}

/**
 * Credit-normal balance (credits minus debits, opening balance signed by its
 * own side). Both accounts this route draws down are credit-normal, so one
 * reader serves them both.
 */
export async function creditBalance(
  conn: DbLike,
  companyId: number,
  accountId: number,
  accountLabel: string,
  cutoffDate?: string
): Promise<string> {
  const query = await conn.execute(sql`
    SELECT (
      CASE
        WHEN la.opening_balance_side = 'Dr' THEN -COALESCE(la.opening_balance, 0)::numeric
        ELSE COALESCE(la.opening_balance, 0)::numeric
      END
      + COALESCE((
        SELECT SUM(CAST(ve.credit_amount AS numeric) - CAST(ve.debit_amount AS numeric))
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id
        WHERE ve.ledger_account_id = ${accountId}
          AND v.company_id = ${companyId}
          AND v.deleted_at IS NULL
          AND COALESCE(v.optional, false) = false
          AND (
            ${cutoffDate ?? null}::date IS NULL
            OR COALESCE(v.effective_date, v.voucher_date) <= ${cutoffDate ?? null}::date
          )
      ), 0)
    )::text AS credit_minus_debit
    FROM ledger_accounts la
    WHERE la.id = ${accountId}
      AND la.company_id = ${companyId}
      AND la.active = true
      AND la.deleted_at IS NULL
    LIMIT 1
  `);
  const row = resultRows(query)[0];
  if (!row) {
    throw new GoldenCoastEquitySalesCashRouteError(
      `${accountLabel} disappeared while its balance was being read`,
      "GC_EQUITY_SALES_CASH_ACCOUNT_INVALID",
      409
    );
  }
  return String(row.credit_minus_debit ?? "0");
}

/**
 * The GC Sales Cash payable at the requested accounting date, read the same
 * conservative way Phase 10 reads it: a future-dated sale must not be settled
 * early, and an already-posted later payment must never be ignored.
 */
export async function conservativePayable(
  conn: DbLike,
  companyId: number,
  gcSalesCashAccountId: number,
  settlementDate?: string
): Promise<string> {
  const dated = await creditBalance(conn, companyId, gcSalesCashAccountId, "GC Sales Cash", settlementDate);
  const allPosted = await creditBalance(conn, companyId, gcSalesCashAccountId, "GC Sales Cash");
  // `creditBalance` already returns the credit-normal figure, so it is the
  // payable directly; `gcSalesCashPayableBalance` expects the signed Dr-minus-Cr
  // reading, hence the negation on the way in.
  return gcSalesCashSettleablePayable(
    gcSalesCashConservativePayable({
      datedPayableUsd: gcSalesCashPayableBalance(new Decimal(dated).negated().toFixed()),
      allPostedPayableUsd: gcSalesCashPayableBalance(new Decimal(allPosted).negated().toFixed()),
    })
  );
}
