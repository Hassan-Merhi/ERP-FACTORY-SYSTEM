// Extracted from ./spGoldenCoastPhase11MonthlyCloseRoutes.ts
import type { Request, Response } from "express";
import { and, eq, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { spProfitSplits } from "@shared/schema";
import { isDeveloperForProfitCorrection } from "./spProfitManualCorrections";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { postBalancedVoucherTx } from "../../services/accounting/centralPostingEngine";
import {
  GOLDEN_COAST_PHASE11_SPLIT_PCT,
  buildGoldenCoastPhase11MonthlyClosePosting,
  goldenCoastPhase11CloseDigest,
  parseGoldenCoastPhase11CloseInput,
} from "../../services/accounting/goldenCoastPhase11MonthlyClose";
import { isGoldenCoastCompany } from "./spGoldenCoastPhase4CutoverFifoRoutes";
import { requireSpCompany } from "./spHelpers";
import { Phase11RouteError, actorFromRequest, postingDependencies } from "./salesItemsPeriodActivity";
import {
  buildPlan,
  findReplay,
  ppdBalance,
  respondKnownError,
} from "./spGoldenCoastPhase11MonthlyCloseRoutesReadiness";

export async function closeMonth(req: Request, res: Response): Promise<void> {
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

export const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export const TARGET_RE = /^-?\d{1,10}(?:\.\d{1,2})?$/;
