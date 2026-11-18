// Extracted from ./spGoldenCoastPhase11MonthlyCloseRoutes.ts to keep that module under the source-size cap.
import type { Request, Response } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { accountingPostingRequests, spProfitSplits, vouchers } from "@shared/schema";
import { getLatestSpProfitCorrection, isDeveloperForProfitCorrection } from "./spProfitManualCorrections";
import { db } from "../../db";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { resultRows } from "../../lib/queryResult";
import { PostingValidationError } from "../../services/accounting/centralPostingEngine";
import {
  GOLDEN_COAST_PHASE11_SPLIT_PCT,
  GoldenCoastPhase11CloseError,
  goldenCoastPhase11IdempotencyKey,
  parseGoldenCoastPhase11CloseInput,
  planGoldenCoastPhase11MonthlyClose,
} from "../../services/accounting/goldenCoastPhase11MonthlyClose";
import { type DbLike, isGoldenCoastCompany } from "./spGoldenCoastPhase4CutoverFifoRoutes";
import { requireSpCompany } from "./spHelpers";
import {
  Phase11RouteError,
  accountPeriodActivity,
  monthBounds,
  resolveAccounts,
  salesItemsPeriodActivity,
  type DatabaseTransaction,
} from "./salesItemsPeriodActivity";

export async function ppdBalance(conn: DbLike, companyId: number, accountId: number): Promise<Decimal> {
  const result = await conn.execute(sql`
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
  return new Decimal(String(resultRows(result)[0]?.balance ?? "0"));
}

export async function buildPlan(conn: DbLike, companyId: number, body: unknown, applyManualCorrection = true) {
  const close = parseGoldenCoastPhase11CloseInput({ companyId, body });
  const accounts = await resolveAccounts(conn, companyId);
  const { start, end } = monthBounds(close.periodMonth);
  const [salesItems, shared, approvedCorrection] = await Promise.all([
    salesItemsPeriodActivity(conn, companyId, accounts.salesAccountId, accounts.cogsAccountId, start, end),
    accountPeriodActivity(conn, companyId, accounts.sharedChargesAccountId, start, end),
    applyManualCorrection ? getLatestSpProfitCorrection(conn, companyId, close.periodMonth) : Promise.resolve(null),
  ]);
  const revenue = new Decimal(salesItems.revenue);
  const totalCogs = new Decimal(salesItems.cogs);
  // Shared Charges are a P&L expense magnitude. Settlement flows can post the
  // account on either side, so normalize net period activity before subtraction.
  const totalShared = new Decimal(shared.debit).minus(shared.credit).abs();
  const baseNet = revenue.minus(totalCogs).minus(totalShared);
  const manualAdjustment = approvedCorrection
    ? new Decimal(approvedCorrection.targetNetProfit).minus(baseNet)
    : new Decimal(0);
  if (!manualAdjustment.isZero() && !accounts.correctionSuspenseAccountId) {
    throw new Phase11RouteError("Profit correction suspense account missing", "GC_PHASE11_ACCOUNT_INVALID", 409);
  }
  const plan = planGoldenCoastPhase11MonthlyClose({
    close,
    totalRevenueUsd: revenue.toFixed(2),
    totalCogsUsd: totalCogs.toFixed(2),
    totalSharedChargesUsd: totalShared.toFixed(2),
    manualAdjustmentUsd: manualAdjustment.toFixed(2),
  });
  return { accounts, plan };
}

export async function findReplay(tx: DatabaseTransaction, companyId: number, periodMonth: string) {
  const key = goldenCoastPhase11IdempotencyKey(companyId, periodMonth);
  const [marker] = await tx
    .select({ voucherId: accountingPostingRequests.voucherId, sourceId: accountingPostingRequests.sourceId })
    .from(accountingPostingRequests)
    .where(and(eq(accountingPostingRequests.companyId, companyId), eq(accountingPostingRequests.idempotencyKey, key)))
    .limit(1);
  if (!marker) return null;
  const [split] = await tx
    .select()
    .from(spProfitSplits)
    .where(and(eq(spProfitSplits.companyId, companyId), eq(spProfitSplits.periodMonth, periodMonth)))
    .limit(1);
  const [voucher] = await tx
    .select()
    .from(vouchers)
    .where(
      and(eq(vouchers.id, Number(marker.voucherId)), eq(vouchers.companyId, companyId), isNull(vouchers.deletedAt))
    )
    .limit(1);
  if (!split || !voucher) {
    throw new Phase11RouteError(
      "Persisted Phase 11 close state is inconsistent",
      "GC_PHASE11_IDEMPOTENCY_INCONSISTENT",
      409
    );
  }
  return { split, voucher, sourceId: String(marker.sourceId ?? "") };
}

export function respondKnownError(res: Response, error: unknown): boolean {
  if (error instanceof Phase11RouteError) {
    res.status(error.status).json({ code: error.code, message: error.message });
    return true;
  }
  if (error instanceof GoldenCoastPhase11CloseError) {
    res
      .status(error.code === "GC_PHASE11_NOTHING_TO_CLOSE" ? 409 : 400)
      .json({ code: error.code, message: error.message });
    return true;
  }
  if (error instanceof PostingValidationError) {
    res.status(400).json({ code: error.code, message: releaseDebtEnglish(error.message) });
    return true;
  }
  return false;
}

export async function readiness(req: Request, res: Response): Promise<void> {
  try {
    const companyId = await requireSpCompany(req, res);
    if (!companyId) return;
    if (!(await isGoldenCoastCompany(db, companyId))) {
      throw new Phase11RouteError("Golden Coast is not configured", "GC_PHASE11_NOT_CONFIGURED", 409);
    }
    const periodMonth = String(req.query.periodMonth ?? "");
    const probe = parseGoldenCoastPhase11CloseInput({ companyId, body: { periodMonth, clientRequestId: "readiness" } });
    const existing = await db
      .select()
      .from(spProfitSplits)
      .where(and(eq(spProfitSplits.companyId, companyId), eq(spProfitSplits.periodMonth, probe.periodMonth)))
      .limit(1);
    if (existing.length) {
      // A finalized split must be traceable to its posted Journal voucher.
      // Legacy split rows lacking a Phase 11 marker remain visible for review,
      // but never imply that a journal was posted.
      const [marker] = await db
        .select({ voucherId: accountingPostingRequests.voucherId })
        .from(accountingPostingRequests)
        .where(
          and(
            eq(accountingPostingRequests.companyId, companyId),
            eq(accountingPostingRequests.idempotencyKey, goldenCoastPhase11IdempotencyKey(companyId, probe.periodMonth))
          )
        )
        .limit(1);
      const [journal] = marker
        ? await db
            .select({ id: vouchers.id, voucherNumber: vouchers.voucherNumber, voucherType: vouchers.voucherType })
            .from(vouchers)
            .where(
              and(
                eq(vouchers.id, Number(marker.voucherId)),
                eq(vouchers.companyId, companyId),
                isNull(vouchers.deletedAt)
              )
            )
            .limit(1)
        : [];
      const voucher =
        journal?.voucherType === "Journal" ? { id: journal.id, voucherNumber: journal.voucherNumber } : null;
      res.json({ ready: false, alreadyClosed: true, split: existing[0], voucher, journalVerified: Boolean(voucher) });
      return;
    }
    const { accounts, plan } = await buildPlan(db, companyId, { periodMonth, clientRequestId: "readiness" });
    const pending = await ppdBalance(db, companyId, accounts.profitPendingDistributionAccountId);
    res.json({
      ready: pending.isZero(),
      alreadyClosed: false,
      plan: isDeveloperForProfitCorrection(req)
        ? plan
        : (() => {
            const { manualAdjustmentUsd: _privateCorrection, ...publicPlan } = plan;
            return publicPlan;
          })(),
      splitPct: GOLDEN_COAST_PHASE11_SPLIT_PCT,
      profitPendingDistributionBalanceUsd: pending.toFixed(2),
    });
  } catch (error: unknown) {
    logger.error("Golden Coast Phase 11 readiness failed", { error });
    if (respondKnownError(res, error)) return;
    res.status(500).json({ message: getErrorMessage(error) });
  }
}
