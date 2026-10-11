/**
 * rawStockRecalcRoutesLegacy: RawStockAutoApplyFx endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 *
 * Accounting audit phase 22 (C), decided by default (owner can override):
 * `POST /api/factory/raw-stock/recalc/auto-apply-fx` is retired (410
 * FACTORY_AUTO_APPLY_FX_RETIRED). It wrote a rate onto each listed container
 * (container, freight and commission rates, marked confirmed) with nothing
 * posted: the container's FACTORY-IMPORT / FREIGHT / COMM journals stayed at
 * their old rate, so the container and its ledger disagreed. It fell back to
 * today's rate when the container had no import date (a rate later than the
 * document, against the phase 19 C rule), wrote outside a transaction with the
 * audit after each write, and its UPDATE built `column = 2` instead of the
 * `$2` placeholder, so it never ran (the boolean flag took an integer). A
 * container's rate is set on the container (edit), which takes the recorded
 * dated factory rate and re-posts its journals in the same transaction.
 */
import type { Express, Request, Response } from "express";
import { requireAuth, requireRole } from "../../../../auth";

import { ADMIN_ROLES } from "./_helpers";

export const FACTORY_AUTO_APPLY_FX_RETIRED = "FACTORY_AUTO_APPLY_FX_RETIRED" as const;
export const FACTORY_AUTO_APPLY_FX_RETIRED_MESSAGE =
  "Rates are no longer applied to containers here. Set the rate on the container itself: it uses the recorded factory rate dated on or before the container and updates its journals.";

export function registerRawStockAutoApplyFxRoutes(app: Express) {
  app.post(
    "/api/factory/raw-stock/recalc/auto-apply-fx",
    requireAuth,
    requireRole(...ADMIN_ROLES),
    async (_req: Request, res: Response) => {
      res.status(410).json({ code: FACTORY_AUTO_APPLY_FX_RETIRED, message: FACTORY_AUTO_APPLY_FX_RETIRED_MESSAGE });
    }
  );
}
