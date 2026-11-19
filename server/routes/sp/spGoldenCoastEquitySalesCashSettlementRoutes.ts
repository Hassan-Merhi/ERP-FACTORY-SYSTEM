import type { Express, Request, Response } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { accountingPostingRequests, voucherEntries, vouchers } from "@shared/schema";
import { requireAuth, requireNonPOS } from "../../auth";
import { db } from "../../db";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { privilegedMutationRateLimit, privilegedReadRateLimit } from "../../middleware/privilegedEndpointSecurity";
import { postBalancedVoucherTx } from "../../services/accounting/centralPostingEngine";
import {
  buildGoldenCoastEquitySalesCashPosting,
  conservativeCreditBalanceUsd,
  goldenCoastEquitySalesCashDigest,
  goldenCoastEquitySalesCashIdempotencyKey,
  goldenCoastEquitySalesCashSourceId,
  parseGoldenCoastEquitySalesCashInput,
  planGoldenCoastEquitySalesCashSettlement,
  type GoldenCoastEquitySalesCashAccounts,
  type GoldenCoastEquitySalesCashInput,
} from "../../services/accounting/goldenCoastEquitySalesCashSettlement";
import { isGoldenCoastCompany, type DbLike } from "./spGoldenCoastPhase4CutoverFifoRoutes";
import { requireSpCompany } from "./spHelpers";
import {
  GoldenCoastEquitySalesCashRouteError,
  actorFromRequest,
  conservativePayable,
  creditBalance,
  equitySalesCashRequestBudget,
  postingAccounts,
  postingDependencies,
  resolveAccounts,
  type DatabaseTransaction,
} from "./spGoldenCoastEquitySalesCashSettlementRoutesCreditBalance";
import { respondKnownError, handleReadiness } from "./spGoldenCoastEquitySalesCashSettlementRoutesHelpers";

/**
 * Reads both balances the conservative ceiling needs. The rule itself lives in
 * `conservativeCreditBalanceUsd` so it can be unit tested; callers hold the
 * voucher-entries lock across both reads.
 */
async function conservativeCreditBalance(
  conn: DbLike,
  companyId: number,
  accountId: number,
  accountLabel: string,
  cutoffDate?: string
): Promise<string> {
  const dated = await creditBalance(conn, companyId, accountId, accountLabel, cutoffDate);
  const allPosted = await creditBalance(conn, companyId, accountId, accountLabel);
  return conservativeCreditBalanceUsd(dated, allPosted);
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
        conservativeCreditBalance(
          tx,
          companyId,
          accounts.hassanEquity.id,
          accounts.hassanEquity.name,
          settlement.settlementDate
        ),
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
