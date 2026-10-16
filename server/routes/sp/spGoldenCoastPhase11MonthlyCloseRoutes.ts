import type { Express, NextFunction, Request, Response } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { accountingPostingRequests, ledgerAccounts, spProfitSplits, vouchers } from "@shared/schema";
import { getLatestSpProfitCorrection, ensureSpProfitManualCorrectionStorage, isDeveloperForProfitCorrection, GC_MANUAL_PROFIT_SUSPENSE_SUBTYPE } from "./spProfitManualCorrections";
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
import { GOLDEN_COAST_PHASE5_SOURCE_TYPE } from "../../services/accounting/goldenCoastPhase5PosSale";
import {
  GOLDEN_COAST_PHASE11_SPLIT_PCT,
  GoldenCoastPhase11CloseError,
  buildGoldenCoastPhase11MonthlyClosePosting,
  goldenCoastPhase11CloseDigest,
  goldenCoastPhase11IdempotencyKey,
  parseGoldenCoastPhase11CloseInput,
  planGoldenCoastPhase11MonthlyClose,
  type GoldenCoastPhase11Accounts,
} from "../../services/accounting/goldenCoastPhase11MonthlyClose";
import { isGoldenCoastCompany, type DbLike } from "./spGoldenCoastPhase4CutoverFifoRoutes";
import { requireSpCompany } from "./spHelpers";

const postingDependencies = createDatabasePostingDependencies();
const phase11RequestBudget = privilegedRequestBudget({ maxBodyBytes: 16 * 1024, maxCollectionItems: 10 });
type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

class Phase11RouteError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400
  ) {
    super(releaseDebtEnglish(message));
    this.name = "Phase11RouteError";
  }
}

function actorFromRequest(req: Request): PostingActor {
  return {
    userId: req.user?.id ?? req.session.userId ?? null,
    username: req.session.username ?? null,
    reason: String(req.body?.reason ?? req.body?.reference ?? "Golden Coast monthly close").trim(),
  };
}

function monthBounds(periodMonth: string): { start: string; end: string } {
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

async function resolveAccounts(conn: DbLike, companyId: number): Promise<GoldenCoastPhase11Accounts> {
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

async function accountPeriodActivity(
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

async function salesItemsPeriodActivity(
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

async function ppdBalance(conn: DbLike, companyId: number, accountId: number): Promise<Decimal> {
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

async function buildPlan(conn: DbLike, companyId: number, body: unknown, applyManualCorrection = true) {
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

async function findReplay(tx: DatabaseTransaction, companyId: number, periodMonth: string) {
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

function respondKnownError(res: Response, error: unknown): boolean {
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

async function readiness(req: Request, res: Response): Promise<void> {
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
      const voucher = journal?.voucherType === "Journal"
        ? { id: journal.id, voucherNumber: journal.voucherNumber }
        : null;
      res.json({ ready: false, alreadyClosed: true, split: existing[0], voucher, journalVerified: Boolean(voucher) });
      return;
    }
    const { accounts, plan } = await buildPlan(db, companyId, { periodMonth, clientRequestId: "readiness" });
    const pending = await ppdBalance(db, companyId, accounts.profitPendingDistributionAccountId);
    res.json({
      ready: pending.isZero(),
      alreadyClosed: false,
      plan: isDeveloperForProfitCorrection(req) ? plan : (() => {
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

async function closeMonth(req: Request, res: Response): Promise<void> {
  try {
    const companyId = await requireSpCompany(req, res);
    if (!companyId) return;
    if (!(await isGoldenCoastCompany(db, companyId))) {
      throw new Phase11RouteError("Golden Coast is not configured", "GC_PHASE11_NOT_CONFIGURED", 409);
    }
    const parsed = parseGoldenCoastPhase11CloseInput({ companyId, body: req.body });

    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(73111, ${companyId})`);
      await tx.execute(sql`LOCK TABLE voucher_entries IN SHARE ROW EXCLUSIVE MODE`);
      const replay = await findReplay(tx, companyId, parsed.periodMonth);
      if (replay) return { replayed: true, ...replay };

      const existing = await tx
        .select()
        .from(spProfitSplits)
        .where(and(eq(spProfitSplits.companyId, companyId), eq(spProfitSplits.periodMonth, parsed.periodMonth)))
        .limit(1);
      if (existing.length) {
        throw new Phase11RouteError(
          `Profit split for ${parsed.periodMonth} already exists without a Phase 11 posting marker`,
          "GC_PHASE11_EXISTING_LEGACY_SPLIT",
          409
        );
      }

      const { accounts, plan } = await buildPlan(tx, companyId, req.body);
      const pendingBefore = await ppdBalance(tx, companyId, accounts.profitPendingDistributionAccountId);
      if (!pendingBefore.isZero()) {
        throw new Phase11RouteError(
          "Profit Pending Distribution must be zero before a new monthly close",
          "GC_PHASE11_PPD_NOT_ZERO",
          409
        );
      }

      const digest = goldenCoastPhase11CloseDigest({ plan, accounts });
      const postingRequest = buildGoldenCoastPhase11MonthlyClosePosting({
        plan,
        accounts,
        digest,
        actor: actorFromRequest(req),
      });
      const posted = await postBalancedVoucherTx(tx, postingRequest, postingDependencies);
      const pendingAfter = await ppdBalance(tx, companyId, accounts.profitPendingDistributionAccountId);
      if (!pendingAfter.isZero()) {
        throw new Phase11RouteError(
          "Profit Pending Distribution did not return to zero; monthly close rolled back",
          "GC_PHASE11_PPD_NOT_ZERO",
          409
        );
      }

      const [split] = await tx
        .insert(spProfitSplits)
        .values({
          companyId,
          periodMonth: plan.periodMonth,
          totalRevenue: plan.totalRevenueUsd,
          totalCogs: plan.totalCogsUsd,
          totalSharedCharges: plan.totalSharedChargesUsd,
          grossProfit: new Decimal(plan.totalRevenueUsd).minus(plan.totalCogsUsd).toFixed(2),
          splitPct: GOLDEN_COAST_PHASE11_SPLIT_PCT,
          ourShare: plan.hassanShareUsd,
          supplierShare: plan.freshStartShareUsd,
          finalizedAt: new Date(),
        })
        .returning();
      return { replayed: false, split, voucher: posted.voucher, plan };
    });
    if (!isDeveloperForProfitCorrection(req) && "plan" in result && result.plan) {
      const { manualAdjustmentUsd: _privateCorrection, ...publicPlan } = result.plan;
      res.json({ ...result, plan: publicPlan });
    } else {
      res.json(result);
    }
  } catch (error: unknown) {
    logger.error("Golden Coast Phase 11 monthly close failed", { error });
    if (respondKnownError(res, error)) return;
    res.status(500).json({ message: getErrorMessage(error) });
  }
}


const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const TARGET_RE = /^-?\d{1,10}(?:\.\d{1,2})?$/;

function requireDeveloperProfitEdit(req: Request, res: Response): boolean {
  if (!isDeveloperForProfitCorrection(req)) {
    res.status(403).json({ code: "SP_DEVELOPER_ONLY", message: "Developer access required" });
    return false;
  }
  return true;
}

async function readProfitCorrection(req: Request, res: Response): Promise<void> {
  try {
    if (!requireDeveloperProfitEdit(req, res)) return;
    const companyId = await requireSpCompany(req, res);
    if (!companyId) return;
    if (!(await isGoldenCoastCompany(db, companyId))) {
      res.status(409).json({ message: "Monthly profit correction is available for Golden Coast only" });
      return;
    }
    const periodMonth = String(req.query.periodMonth ?? "");
    if (!PERIOD_RE.test(periodMonth)) {
      res.status(400).json({ message: "Select a valid month in YYYY-MM format" });
      return;
    }
    const { plan } = await buildPlan(db, companyId, { periodMonth, clientRequestId: "developer-preview" }, false);
    const latest = await getLatestSpProfitCorrection(db, companyId, periodMonth);
    const history = resultRows(await db.execute(sql`
      SELECT id, target_net_profit, original_net_profit, reason, actor_name, created_at
      FROM sp_profit_manual_corrections
      WHERE company_id = ${companyId} AND period_month = ${periodMonth}
      ORDER BY id DESC LIMIT 25
    `)).map((item) => ({
      id: Number(item.id),
      targetNetProfit: String(item.target_net_profit),
      originalNetProfit: String(item.original_net_profit),
      reason: String(item.reason),
      actorName: item.actor_name == null ? null : String(item.actor_name),
      createdAt: String(item.created_at),
    }));
    const [closed] = await db.select({ id: spProfitSplits.id })
      .from(spProfitSplits)
      .where(and(eq(spProfitSplits.companyId, companyId), eq(spProfitSplits.periodMonth, periodMonth)))
      .limit(1);
    const rawNet = new Decimal(plan.netProfitLossUsd);
    const adjustedNet = latest ? new Decimal(latest.targetNetProfit) : rawNet;
    res.setHeader("Cache-Control", "private, no-store");
    res.json({
      periodMonth,
      sourceNetProfit: rawNet.toFixed(2),
      effectiveNetProfit: adjustedNet.toFixed(2),
      adjustment: adjustedNet.minus(rawNet).toFixed(2),
      correction: latest,
      history,
      finalized: Boolean(closed),
    });
  } catch (error) {
    logger.error("Developer SP profit correction read failed", { error });
    if (respondKnownError(res, error)) return;
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

async function writeProfitCorrection(req: Request, res: Response): Promise<void> {
  try {
    if (!requireDeveloperProfitEdit(req, res)) return;
    const companyId = await requireSpCompany(req, res);
    if (!companyId) return;
    if (!(await isGoldenCoastCompany(db, companyId))) {
      res.status(409).json({ message: "Manual correction is available for Golden Coast only" });
      return;
    }
    const periodMonth = String(req.body?.periodMonth ?? "");
    const rawTarget = String(req.body?.targetNetProfit ?? "").trim();
    const reason = String(req.body?.reason ?? "").trim();
    if (!PERIOD_RE.test(periodMonth) || !TARGET_RE.test(rawTarget) || reason.length < 5 || reason.length > 500) {
      res.status(400).json({
        message: "Valid month, final profit with at most 2 decimals, and a 5–500 character reason are required",
      });
      return;
    }
    await ensureSpProfitManualCorrectionStorage();
    const target = new Decimal(rawTarget).toFixed(2);
    const actorId = String(req.user?.id ?? req.session.userId ?? "");
    if (!actorId) {
      res.status(403).json({ message: "Authenticated developer identity required" });
      return;
    }
    const saved = await db.transaction(async (tx) => {
      // Same company lock as the actual Phase 11 close prevents corrections racing splits.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(73111, ${companyId})`);
      const [closed] = await tx.select({ id: spProfitSplits.id })
        .from(spProfitSplits)
        .where(and(eq(spProfitSplits.companyId, companyId), eq(spProfitSplits.periodMonth, periodMonth)))
        .limit(1);
      if (closed) {
        throw new Phase11RouteError("This month is finalized and cannot be manually edited", "GC_PROFIT_PERIOD_CLOSED", 409);
      }
      const { plan } = await buildPlan(tx, companyId, { periodMonth, clientRequestId: "developer-override" }, false);
      const sourceNet = new Decimal(plan.netProfitLossUsd);
      const difference = new Decimal(target).minus(sourceNet);
      // A signed profit difference needs a real counterparty in its closing Journal.
      // This suspense account remains reconcilable as an asset / contra-asset.
      if (!difference.isZero()) {
        const existing = await tx.select({ id: ledgerAccounts.id })
          .from(ledgerAccounts)
          .where(and(
            eq(ledgerAccounts.companyId, companyId),
            eq(ledgerAccounts.subType, GC_MANUAL_PROFIT_SUSPENSE_SUBTYPE),
            eq(ledgerAccounts.active, true),
            isNull(ledgerAccounts.deletedAt)
          ))
          .limit(2);
        if (existing.length > 1) {
          throw new Phase11RouteError("Ambiguous SP profit correction account", "GC_PROFIT_ACCOUNT_AMBIGUOUS", 409);
        }
        if (!existing.length) {
          await tx.insert(ledgerAccounts).values({
            companyId,
            code: "SP-PROFIT-ADJ-SUSPENSE",
            name: "SP Profit Correction Suspense",
            accountType: "Asset",
            subType: GC_MANUAL_PROFIT_SUSPENSE_SUBTYPE,
            openingBalance: "0.00",
            openingBalanceSide: "Dr",
            isHidden: true,
            active: true,
          });
        }
      }
      const row = resultRows(await tx.execute(sql`
        INSERT INTO sp_profit_manual_corrections (
          company_id, period_month, target_net_profit, original_net_profit,
          reason, actor_id, actor_name
        ) VALUES (
          ${companyId}, ${periodMonth}, ${target}, ${sourceNet.toFixed(2)},
          ${reason}, ${actorId}, ${String(req.session.username ?? req.user?.username ?? "")}
        )
        RETURNING id
      `))[0];
      return { correctionId: Number(row?.id), sourceNetProfit: sourceNet.toFixed(2), effectiveNetProfit: target, difference: difference.toFixed(2) };
    });
    res.setHeader("Cache-Control", "private, no-store");
    res.json(saved);
  } catch (error) {
    logger.error("Developer SP profit correction save failed", { error });
    if (respondKnownError(res, error)) return;
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

async function retireLegacyGoldenCoastProfitSplit(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const companyId = await requireSpCompany(req, res);
    if (!companyId) return;
    if (!(await isGoldenCoastCompany(db, companyId))) {
      next();
      return;
    }
    res.status(409).json({
      code: "GC_PHASE11_LEGACY_PROFIT_SPLIT_RETIRED",
      message: releaseDebtEnglish(
        "Golden Coast profit splits must use the Phase 11 ledger-derived monthly close; client-supplied profit totals are retired."
      ),
    });
  } catch (error: unknown) {
    next(error);
  }
}

export function registerSpGoldenCoastPhase11MonthlyCloseRoutes(app: Express) {
  app.get(
    "/api/sp/golden-coast/profit-correction",
    privilegedReadRateLimit,
    requireAuth,
    requireNonPOS,
    readProfitCorrection
  );
  app.post(
    "/api/sp/golden-coast/profit-correction",
    privilegedMutationRateLimit,
    phase11RequestBudget,
    requireAuth,
    requireNonPOS,
    writeProfitCorrection
  );
  app.get(
    "/api/sp/golden-coast/phase11/profit-splits/monthly-close/readiness",
    privilegedReadRateLimit,
    requireAuth,
    requireNonPOS,
    readiness
  );
  app.post(
    "/api/sp/golden-coast/phase11/profit-splits/monthly-close",
    privilegedMutationRateLimit,
    phase11RequestBudget,
    requireAuth,
    requireNonPOS,
    closeMonth
  );
  app.post(
    "/api/sp/profit-splits",
    privilegedMutationRateLimit,
    phase11RequestBudget,
    requireAuth,
    retireLegacyGoldenCoastProfitSplit
  );
}
