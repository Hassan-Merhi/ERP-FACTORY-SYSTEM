import type { Express, NextFunction, Request, Response } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { ledgerAccounts, spProfitSplits } from "@shared/schema";
import {
  getLatestSpProfitCorrection,
  ensureSpProfitManualCorrectionStorage,
  isDeveloperForProfitCorrection,
  GC_MANUAL_PROFIT_SUSPENSE_SUBTYPE,
} from "./spProfitManualCorrections";
import { requireAuth, requireNonPOS } from "../../auth";
import { db } from "../../db";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { resultRows } from "../../lib/queryResult";
import { privilegedMutationRateLimit, privilegedReadRateLimit } from "../../middleware/privilegedEndpointSecurity";
import { postBalancedVoucherTx } from "../../services/accounting/centralPostingEngine";
import {
  GOLDEN_COAST_PHASE11_SPLIT_PCT,
  buildGoldenCoastPhase11MonthlyClosePosting,
  goldenCoastPhase11CloseDigest,
  parseGoldenCoastPhase11CloseInput,
} from "../../services/accounting/goldenCoastPhase11MonthlyClose";
import { isGoldenCoastCompany } from "./spGoldenCoastPhase4CutoverFifoRoutes";
import { requireSpCompany } from "./spHelpers";
import {
  Phase11RouteError,
  actorFromRequest,
  phase11RequestBudget,
  postingDependencies,
} from "./salesItemsPeriodActivity";
import {
  buildPlan,
  findReplay,
  ppdBalance,
  readiness,
  respondKnownError,
} from "./spGoldenCoastPhase11MonthlyCloseRoutesReadiness";

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
    const history = resultRows(
      await db.execute(sql`
      SELECT id, target_net_profit, original_net_profit, reason, actor_name, created_at
      FROM sp_profit_manual_corrections
      WHERE company_id = ${companyId} AND period_month = ${periodMonth}
      ORDER BY id DESC LIMIT 25
    `)
    ).map((item) => ({
      id: Number(item.id),
      targetNetProfit: String(item.target_net_profit),
      originalNetProfit: String(item.original_net_profit),
      reason: String(item.reason),
      actorName: item.actor_name == null ? null : String(item.actor_name),
      createdAt: String(item.created_at),
    }));
    const [closed] = await db
      .select({ id: spProfitSplits.id })
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
      const [closed] = await tx
        .select({ id: spProfitSplits.id })
        .from(spProfitSplits)
        .where(and(eq(spProfitSplits.companyId, companyId), eq(spProfitSplits.periodMonth, periodMonth)))
        .limit(1);
      if (closed) {
        throw new Phase11RouteError(
          "This month is finalized and cannot be manually edited",
          "GC_PROFIT_PERIOD_CLOSED",
          409
        );
      }
      const { plan } = await buildPlan(tx, companyId, { periodMonth, clientRequestId: "developer-override" }, false);
      const sourceNet = new Decimal(plan.netProfitLossUsd);
      const difference = new Decimal(target).minus(sourceNet);
      // A signed profit difference needs a real counterparty in its closing Journal.
      // This suspense account remains reconcilable as an asset / contra-asset.
      if (!difference.isZero()) {
        const existing = await tx
          .select({ id: ledgerAccounts.id })
          .from(ledgerAccounts)
          .where(
            and(
              eq(ledgerAccounts.companyId, companyId),
              eq(ledgerAccounts.subType, GC_MANUAL_PROFIT_SUSPENSE_SUBTYPE),
              eq(ledgerAccounts.active, true),
              isNull(ledgerAccounts.deletedAt)
            )
          )
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
      const row = resultRows(
        await tx.execute(sql`
        INSERT INTO sp_profit_manual_corrections (
          company_id, period_month, target_net_profit, original_net_profit,
          reason, actor_id, actor_name
        ) VALUES (
          ${companyId}, ${periodMonth}, ${target}, ${sourceNet.toFixed(2)},
          ${reason}, ${actorId}, ${String(req.session.username ?? req.user?.username ?? "")}
        )
        RETURNING id
      `)
      )[0];
      return {
        correctionId: Number(row?.id),
        sourceNetProfit: sourceNet.toFixed(2),
        effectiveNetProfit: target,
        difference: difference.toFixed(2),
      };
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
