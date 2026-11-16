import type { Express, NextFunction, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { requireAuth } from "../../auth";
import { db } from "../../db";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { isGoldenCoastCompany } from "./spGoldenCoastCutoverFifoRoutes";
import { requireSpCompany } from "./spHelpers";

/**
 * Deciding whether the caller is Golden Coast means resolving their company and
 * reading its accounting setup, so the guard is rate limited before it does any
 * of that. The budget is sized for a shop floor rather than for a privileged
 * migration endpoint: several terminals sharing one address still sell far
 * below this, while an unauthenticated flood is bounded. Kept as a direct
 * express-rate-limit construction because CodeQL models that call directly.
 */
const legacySalesGuardRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      code: "SP_SALES_RATE_LIMITED",
      message: releaseDebtEnglish("Too many sale submissions. Try again in a moment."),
    });
  },
});

async function rejectGoldenCoastLegacySale(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const companyId = await requireSpCompany(req, res);
    if (!companyId) return;
    if (!(await isGoldenCoastCompany(db, companyId))) {
      next();
      return;
    }

    res.status(409).json({
      code: "GC_PHASE6_CANONICAL_POS_REQUIRED",
      message: releaseDebtEnglish(
        "Golden Coast sales must use the Phase 6 POS route so sale accounting and automatic HADI cash routing remain atomic."
      ),
    });
  } catch (error) {
    logger.error("Golden Coast legacy SP sales guard failed", { error });
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

/**
 * Old SP POS clients still know `/api/sp/sales`. Once a Supplier Partner company
 * has Golden Coast accounting configured, allowing that mutation would bypass
 * Phase 6 FIFO/revenue/COGS and its atomic automatic HADI collection. Refuse it
 * before the generic SP sales registrar gets a chance to handle the request.
 *
 * Mounted as middleware rather than a second POST registration on the same
 * path: a duplicate registration would shadow the real handler in the manifest,
 * and the write-route coverage audit classifies a path by the file registering
 * it, so a read-only guard winning that race would quietly drop a
 * voucher-posting path out of the sensitive set.
 */
export function registerSpGoldenCoastLegacySalesGuard(app: Express): void {
  app.use("/api/sp/sales", (req: Request, res: Response, next: NextFunction) => {
    // Express strips the mount path, so "/" is the collection itself. Anything
    // deeper — POST /api/sp/sales/:id/reverse, for one — is a different
    // operation and is none of this guard's business.
    if (req.method !== "POST" || req.path !== "/") {
      next();
      return;
    }

    legacySalesGuardRateLimit(req, res, (rateLimitError?: unknown) => {
      if (rateLimitError) {
        next(rateLimitError);
        return;
      }
      requireAuth(req, res, (authError?: unknown) => {
        if (authError) {
          next(authError);
          return;
        }
        void rejectGoldenCoastLegacySale(req, res, next);
      });
    });
  });
}
