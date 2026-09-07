import type { Express, Request, Response } from "express";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { accountingPostingRequests, ledgerAccounts, voucherEntries, vouchers } from "@shared/schema";
import { requireAuth, requireNonPOS } from "../../auth";
import { db } from "../../db";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { resultRows } from "../../lib/queryResult";
import {
  privilegedMutationRateLimit,
  privilegedReadRateLimit,
  privilegedRequestBudget,
} from "../../middleware/privilegedEndpointSecurity";
import {
  PostingValidationError,
  postBalancedVoucherTx,
  type PostingActor,
} from "../../services/accounting/centralPostingEngine";
import { createDatabasePostingDependencies } from "../../services/accounting/databasePostingDependencies";
import {
  getGoldenCoastAccountDefinition,
  type GoldenCoastAccountRole,
} from "../../services/accounting/goldenCoastPhase2Accounts";
import {
  GOLDEN_COAST_EQUITY_SALES_CASH_SOURCE_TYPE,
  GoldenCoastEquitySalesCashError,
  buildGoldenCoastEquitySalesCashPosting,
  goldenCoastEquitySalesCashDigest,
  goldenCoastEquitySalesCashIdempotencyKey,
  goldenCoastEquitySalesCashSourceId,
  parseGoldenCoastEquitySalesCashInput,
  planGoldenCoastEquitySalesCashSettlement,
  type GoldenCoastEquitySalesCashAccounts,
  type GoldenCoastEquitySalesCashInput,
} from "../../services/accounting/goldenCoastEquitySalesCashSettlement";
import {
  gcSalesCashConservativePayable,
  gcSalesCashPayableBalance,
  gcSalesCashSettleablePayable,
} from "../../services/accounting/goldenCoastSalesCashPayable";
import { isGoldenCoastCompany, type DbLike } from "./spGoldenCoastPhase4CutoverFifoRoutes";
import { requireSpCompany } from "./spHelpers";

/**
 * Golden Coast — settle the GC Sales Cash payable out of Hassan's own equity.
 *
 * The cash-funded alternative is Phase 10; this route posts the same relief of
 * the payable with no asset movement at all, taking the funding from Hassan
 * Dakik Equity and plugging Fresh Start FZ Equity. See the service module for
 * why the plug is twice the settlement amount.
 */
const postingDependencies = createDatabasePostingDependencies();
const equitySalesCashRequestBudget = privilegedRequestBudget({ maxBodyBytes: 16 * 1024, maxCollectionItems: 10 });

const ROLES = {
  gcSalesCash: "gc_sales_cash",
  hassanEquity: "hassan_equity",
  freshStartEquity: "fresh_start_equity",
} as const satisfies Record<string, GoldenCoastAccountRole>;

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface ResolvedAccount {
  id: number;
  name: string;
  accountType: string;
}

class GoldenCoastEquitySalesCashRouteError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = "GC_EQUITY_SALES_CASH_INVALID", status = 400) {
    super(releaseDebtEnglish(message));
    this.name = "GoldenCoastEquitySalesCashRouteError";
    this.code = code;
    this.status = status;
  }
}

function actorFromRequest(req: Request): PostingActor {
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

async function resolveAccounts(
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

function postingAccounts(accounts: {
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
async function creditBalance(
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
async function conservativePayable(
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

function amountEquals(left: unknown, right: string): boolean {
  try {
    return new Decimal(String(left ?? "0")).equals(new Decimal(right));
  } catch {
    return false;
  }
}

async function loadVoucherEntries(tx: DatabaseTransaction, voucherId: number) {
  return tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, voucherId));
}

async function findReplayedSettlement(
  tx: DatabaseTransaction,
  companyId: number,
  settlement: GoldenCoastEquitySalesCashInput,
  accounts: GoldenCoastEquitySalesCashAccounts,
  settlementDigest: string
) {
  const idempotencyKey = goldenCoastEquitySalesCashIdempotencyKey(companyId, settlement.clientRequestId);
  const [marker] = await tx
    .select({ voucherId: accountingPostingRequests.voucherId, sourceId: accountingPostingRequests.sourceId })
    .from(accountingPostingRequests)
    .where(
      and(
        eq(accountingPostingRequests.companyId, companyId),
        eq(accountingPostingRequests.idempotencyKey, idempotencyKey)
      )
    )
    .limit(1);
  if (!marker) return null;

  const expectedSourceId = goldenCoastEquitySalesCashSourceId(settlementDigest);
  if (String(marker.sourceId ?? "") !== expectedSourceId) {
    throw new GoldenCoastEquitySalesCashRouteError(
      "clientRequestId was already used for a different equity settlement payload",
      "GC_EQUITY_SALES_CASH_IDEMPOTENCY_CONFLICT",
      409
    );
  }

  const [voucher] = await tx
    .select()
    .from(vouchers)
    .where(
      and(eq(vouchers.id, Number(marker.voucherId)), eq(vouchers.companyId, companyId), isNull(vouchers.deletedAt))
    )
    .limit(1);
  if (!voucher) {
    throw new GoldenCoastEquitySalesCashRouteError(
      "The equity settlement idempotency marker references a missing or deleted voucher",
      "GC_EQUITY_SALES_CASH_IDEMPOTENCY_INCONSISTENT",
      409
    );
  }

  const entries = await loadVoucherEntries(tx, Number(voucher.id));
  const freshStartCreditUsd = new Decimal(settlement.amountUsd).times(2).toFixed(2);
  if (entries.length !== 3 || !amountEquals(voucher.totalAmount, freshStartCreditUsd)) {
    throw new GoldenCoastEquitySalesCashRouteError(
      "The persisted equity settlement voucher no longer matches its idempotency marker",
      "GC_EQUITY_SALES_CASH_IDEMPOTENCY_INCONSISTENT",
      409
    );
  }

  const debitOn = (accountId: number) =>
    entries.some(
      (entry) =>
        Number(entry.ledgerAccountId ?? 0) === accountId &&
        amountEquals(entry.debitAmount, settlement.amountUsd) &&
        amountEquals(entry.creditAmount, "0")
    );
  const freshStartCredit = entries.some(
    (entry) =>
      Number(entry.ledgerAccountId ?? 0) === accounts.freshStartEquityAccountId &&
      amountEquals(entry.creditAmount, freshStartCreditUsd) &&
      amountEquals(entry.debitAmount, "0")
  );
  if (!debitOn(accounts.gcSalesCashAccountId) || !debitOn(accounts.hassanEquityAccountId) || !freshStartCredit) {
    throw new GoldenCoastEquitySalesCashRouteError(
      "The persisted equity settlement voucher entries no longer match the requested routing",
      "GC_EQUITY_SALES_CASH_IDEMPOTENCY_INCONSISTENT",
      409
    );
  }
  return { voucher, entries };
}

function respondKnownError(res: Response, error: unknown): boolean {
  if (error instanceof GoldenCoastEquitySalesCashRouteError) {
    res.status(error.status).json({ code: error.code, message: error.message });
    return true;
  }
  if (error instanceof GoldenCoastEquitySalesCashError) {
    const status =
      error.code === "GC_EQUITY_SALES_CASH_EXCEEDS_PAYABLE" ||
      error.code === "GC_EQUITY_SALES_CASH_EXCEEDS_EQUITY" ||
      error.code === "GC_EQUITY_SALES_CASH_BALANCE_INVALID"
        ? 409
        : 400;
    res.status(status).json({ code: error.code, message: error.message });
    return true;
  }
  if (error instanceof PostingValidationError) {
    res.status(400).json({ code: error.code, message: releaseDebtEnglish(error.message) });
    return true;
  }
  return false;
}

async function handleReadiness(req: Request, res: Response): Promise<void> {
  try {
    const companyId = await requireSpCompany(req, res);
    if (!companyId) return;
    if (!(await isGoldenCoastCompany(db, companyId))) {
      res.status(409).json({
        code: "GC_EQUITY_SALES_CASH_NOT_CONFIGURED",
        message: releaseDebtEnglish("Golden Coast account setup is not configured."),
      });
      return;
    }
    const accounts = await resolveAccounts(db, companyId);
    const [payableUsd, hassanEquityUsd, freshStartEquityUsd] = await Promise.all([
      conservativePayable(db, companyId, accounts.gcSalesCash.id),
      creditBalance(db, companyId, accounts.hassanEquity.id, accounts.hassanEquity.name),
      creditBalance(db, companyId, accounts.freshStartEquity.id, accounts.freshStartEquity.name),
    ]);
    const hassanEquity = new Decimal(hassanEquityUsd).toDecimalPlaces(2);
    // One input drives both debits, so the settleable amount is whichever of
    // the two credit-normal balances runs out first.
    const maxSettlementUsd = Decimal.max(Decimal.min(new Decimal(payableUsd), hassanEquity), 0).toFixed(2);

    res.json({
      ready: new Decimal(maxSettlementUsd).gt(0),
      companyId,
      gcSalesCashAccount: accounts.gcSalesCash,
      hassanEquityAccount: accounts.hassanEquity,
      freshStartEquityAccount: accounts.freshStartEquity,
      payableSalesCashUsd: payableUsd,
      availableHassanEquityUsd: hassanEquity.toFixed(2),
      freshStartEquityUsd: new Decimal(freshStartEquityUsd).toDecimalPlaces(2).toFixed(2),
      maxSettlementUsd,
      sourceType: GOLDEN_COAST_EQUITY_SALES_CASH_SOURCE_TYPE,
    });
  } catch (error: unknown) {
    logger.error("Golden Coast equity sales-cash readiness failed", { error });
    if (respondKnownError(res, error)) return;
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

async function handleSettlement(req: Request, res: Response): Promise<void> {
  try {
    const companyId = await requireSpCompany(req, res);
    if (!companyId) return;
    if (!(await isGoldenCoastCompany(db, companyId))) {
      res.status(409).json({
        code: "GC_EQUITY_SALES_CASH_NOT_CONFIGURED",
        message: releaseDebtEnglish("Golden Coast account setup is not configured."),
      });
      return;
    }
    const settlement = parseGoldenCoastEquitySalesCashInput({ companyId, body: req.body });
    const actor = actorFromRequest(req);

    const outcome = await db.transaction(async (tx) => {
      // Phase 7, Phase 10 and this route all reduce the same GC Sales Cash
      // tracker, so they serialize against the same company locks.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`golden-coast-phase7:${companyId}`}))`);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`golden-coast-phase10:${companyId}`}))`);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`golden-coast-equity-sales-cash:${companyId}:${settlement.clientRequestId}`}))`
      );
      if (!(await isGoldenCoastCompany(tx, companyId))) {
        throw new GoldenCoastEquitySalesCashRouteError(
          "Golden Coast account setup is not configured",
          "GC_EQUITY_SALES_CASH_NOT_CONFIGURED",
          409
        );
      }

      const accounts = await resolveAccounts(tx, companyId);
      const posting = postingAccounts(accounts);
      const settlementDigest = goldenCoastEquitySalesCashDigest({ settlement, accounts: posting });
      const replayed = await findReplayedSettlement(tx, companyId, settlement, posting, settlementDigest);
      if (replayed) {
        const [payableUsd, hassanEquityUsd] = await Promise.all([
          conservativePayable(tx, companyId, accounts.gcSalesCash.id),
          creditBalance(tx, companyId, accounts.hassanEquity.id, accounts.hassanEquity.name),
        ]);
        return {
          replayed: true as const,
          settlement,
          accounts,
          gcSalesCashPayableAfterUsd: payableUsd,
          hassanEquityAfterUsd: new Decimal(hassanEquityUsd).toDecimalPlaces(2).toFixed(2),
          freshStartEquityCreditUsd: new Decimal(settlement.amountUsd).times(2).toFixed(2),
          voucher: replayed.voucher,
          entries: replayed.entries,
        };
      }

      // Keep any concurrent voucher writer from moving either capped balance
      // between the reads and this posting's commit.
      await tx.execute(sql`LOCK TABLE voucher_entries IN SHARE ROW EXCLUSIVE MODE`);

      const [gcSalesCashPayableUsd, hassanEquityCreditBalanceUsd] = await Promise.all([
        conservativePayable(tx, companyId, accounts.gcSalesCash.id, settlement.settlementDate),
        creditBalance(tx, companyId, accounts.hassanEquity.id, accounts.hassanEquity.name, settlement.settlementDate),
      ]);
      const plan = planGoldenCoastEquitySalesCashSettlement({
        settlement,
        gcSalesCashPayableUsd,
        hassanEquityCreditBalanceUsd,
      });
      const request = buildGoldenCoastEquitySalesCashPosting({
        plan,
        accounts: posting,
        settlementDigest,
        actor,
      });
      const posted = await postBalancedVoucherTx(tx, request, postingDependencies);
      return {
        replayed: posted.replayed,
        settlement,
        accounts,
        gcSalesCashPayableAfterUsd: plan.gcSalesCashPayableAfterUsd,
        hassanEquityAfterUsd: plan.hassanEquityAfterUsd,
        freshStartEquityCreditUsd: plan.freshStartEquityCreditUsd,
        voucher: posted.voucher,
        entries: posted.entries,
      };
    });

    res.status(outcome.replayed ? 200 : 201).json({
      ok: true,
      replayed: outcome.replayed,
      companyId,
      clientRequestId: outcome.settlement.clientRequestId,
      amountUsd: outcome.settlement.amountUsd,
      gcSalesCashPayableAfterUsd: outcome.gcSalesCashPayableAfterUsd,
      hassanEquityAfterUsd: outcome.hassanEquityAfterUsd,
      freshStartEquityCreditUsd: outcome.freshStartEquityCreditUsd,
      gcSalesCashAccountId: outcome.accounts.gcSalesCash.id,
      hassanEquityAccountId: outcome.accounts.hassanEquity.id,
      freshStartEquityAccountId: outcome.accounts.freshStartEquity.id,
      voucher: outcome.voucher,
      entries: outcome.entries,
    });
  } catch (error: unknown) {
    logger.error("Golden Coast equity sales-cash settlement failed", { error });
    if (respondKnownError(res, error)) return;
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

export function registerSpGoldenCoastEquitySalesCashSettlementRoutes(app: Express): void {
  app.get(
    "/api/sp/golden-coast/equity-sales-cash-settlement/readiness",
    privilegedReadRateLimit,
    requireAuth,
    requireNonPOS,
    (req, res) => void handleReadiness(req, res)
  );

  app.post(
    "/api/sp/golden-coast/equity-sales-cash-settlement",
    privilegedMutationRateLimit,
    equitySalesCashRequestBudget,
    requireAuth,
    requireNonPOS,
    (req, res) => void handleSettlement(req, res)
  );
}
