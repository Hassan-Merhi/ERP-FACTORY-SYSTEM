import type { Express, Request, Response } from "express";
import { z } from "zod";
import { requireAuth, requireNonPOS } from "../auth";
import { getErrorMessage } from "../lib/httpHandlers";
import { emptyQuery, validateRequest, type RequestSchemas } from "../lib/validateRequest";
import { logger } from "../lib/logger";
import { getHistoricalCurrencyReadiness } from "../services/accounting/historicalCurrencyReadiness";
import {
  applyHistoricalCurrencyRepairPlan,
  listHistoricalRepairCases,
  planHistoricalCurrencyRepairs,
  type HistoricalRepairInput,
} from "../services/accounting/historicalCurrencyRepairCenter";
import {
  ExpiredRepairTokenError,
  InvalidRepairTokenError,
  REPAIR_TOKEN_TTL_MS,
  RepairTokenConfigurationError,
  signRepairToken,
  verifyRepairToken,
} from "../services/factory/repairToken";

const ALLOWED_ROLES = new Set(["Admin", "Owner", "Developer"]);

interface RepairCenterTokenPayload {
  purpose: "historical-currency-repair-center";
  companyId: number;
  userId: string;
  fingerprint: string;
  itemCount: number;
  expiresAt: number;
}

// One approved row (HistoricalRepairInput). planHistoricalCurrencyRepairs keeps the rules:
// at least one row, at most 200, positive ids, no duplicates, a currency and a rate.
const amount = z.union([z.number(), z.string()]).nullable().optional();
const repairRow = z.strictObject({
  kind: z.string(),
  id: z.union([z.number(), z.string()]),
  currency: z.string().nullable().optional(),
  historicalRate: amount,
  transactionDebitAmount: amount,
  transactionCreditAmount: amount,
  nativeAmount: amount,
  baseAmount: amount,
  side: z.string().optional(),
  note: z.string().optional(),
});
const planRepairsInput = {
  query: emptyQuery,
  body: z.strictObject({ repairs: z.array(repairRow).optional() }),
} satisfies RequestSchemas;
const applyRepairsInput = {
  query: emptyQuery,
  body: z.strictObject({ repairs: z.array(repairRow).optional(), confirmationToken: z.string().optional() }),
} satisfies RequestSchemas;

function requireRepairRole(req: Request, res: Response): boolean {
  const role = req.session?.currentRole;
  if (!role || !ALLOWED_ROLES.has(role)) {
    res.status(403).json({ message: "Admin, Owner, or Developer access is required" });
    return false;
  }
  return true;
}

function actorFromRequest(req: import("express").Request): { userId: string; username: string } {
  const userId = String(req.session?.userId ?? req.user?.id ?? "unknown");
  const username = String(req.session?.username ?? req.user?.username ?? userId);
  return { userId, username };
}

export function registerHistoricalCurrencyRepairCenterRoutes(app: Express) {
  app.get(
    "/api/accounts/multi-currency/repair-center",
    requireAuth,
    requireNonPOS,
    async (req: Request, res: Response) => {
      if (!requireRepairRole(req, res)) return;
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const [readiness, cases] = await Promise.all([
          getHistoricalCurrencyReadiness(companyId),
          listHistoricalRepairCases(companyId),
        ]);
        return res.json({
          generatedAt: new Date().toISOString(),
          companyId,
          readiness,
          totalCases: cases.length,
          cases,
          writePerformed: false,
        });
      } catch (error: unknown) {
        logger.error("Historical currency repair-center diagnostic failed", { error });
        return res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.post(
    "/api/accounts/multi-currency/repair-center/plan",
    requireAuth,
    requireNonPOS,
    validateRequest(planRepairsInput),
    async (req: Request, res: Response) => {
      if (!requireRepairRole(req, res)) return;
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const actor = actorFromRequest(req);
        const repairs = (req.body?.repairs ?? []) as HistoricalRepairInput[];
        const plan = await planHistoricalCurrencyRepairs(companyId, repairs);
        const confirmationToken = signRepairToken({
          purpose: "historical-currency-repair-center",
          companyId,
          userId: actor.userId,
          fingerprint: plan.fingerprint,
          itemCount: plan.itemCount,
          expiresAt: Date.now() + REPAIR_TOKEN_TTL_MS,
        } satisfies RepairCenterTokenPayload);
        return res.json({
          dryRun: true,
          writePerformed: false,
          confirmationToken,
          confirmationExpiresAt: new Date(Date.now() + REPAIR_TOKEN_TTL_MS).toISOString(),
          plan,
        });
      } catch (error: unknown) {
        const status = error instanceof RepairTokenConfigurationError ? 503 : 400;
        return res.status(status).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.post(
    "/api/accounts/multi-currency/repair-center/apply",
    requireAuth,
    requireNonPOS,
    validateRequest(applyRepairsInput),
    async (req: Request, res: Response) => {
      if (!requireRepairRole(req, res)) return;
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const actor = actorFromRequest(req);
        const token = verifyRepairToken<RepairCenterTokenPayload>(req.body?.confirmationToken);
        if (token.purpose !== "historical-currency-repair-center") {
          throw new InvalidRepairTokenError("wrong repair purpose");
        }
        if (token.companyId !== companyId || token.userId !== actor.userId) {
          throw new InvalidRepairTokenError("company or user mismatch");
        }
        const repairs = (req.body?.repairs ?? []) as HistoricalRepairInput[];
        const plan = await planHistoricalCurrencyRepairs(companyId, repairs);
        if (plan.fingerprint !== token.fingerprint || plan.itemCount !== token.itemCount) {
          return res.status(409).json({
            code: "STALE_REPAIR_PLAN",
            message: "The approved rows or current database state changed after preview. Run the dry-run again.",
          });
        }
        const result = await applyHistoricalCurrencyRepairPlan(plan, actor);
        const readiness = await getHistoricalCurrencyReadiness(companyId);
        return res.json({
          dryRun: false,
          writePerformed: true,
          result,
          readiness,
        });
      } catch (error: unknown) {
        if (error instanceof InvalidRepairTokenError || error instanceof ExpiredRepairTokenError) {
          return res.status(409).json({ code: "INVALID_REPAIR_CONFIRMATION", message: getErrorMessage(error) });
        }
        if (error instanceof RepairTokenConfigurationError) {
          return res.status(503).json({ message: getErrorMessage(error) });
        }
        const message = getErrorMessage(error);
        const status = /changed after preview|stale/i.test(message) ? 409 : 400;
        logger.error("Historical currency repair-center apply failed", {
          error,
          companyId: req.session.currentCompanyId,
        });
        return res.status(status).json({ message });
      }
    }
  );
}
