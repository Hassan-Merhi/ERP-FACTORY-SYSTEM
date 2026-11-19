import type { Express, NextFunction, Request, Response } from "express";
import { requireAuth, requireNonPOS, requireRole } from "../auth";
import { releaseDebtEnglish } from "../i18n/finalCloseoutEnglish";
import { privilegedMutationRateLimit } from "../middleware/privilegedEndpointSecurity";

const requireDeveloper = requireRole("Developer");

/** The 410 every retired Phase 1 mutation answers (also used by the old routes themselves). */
export function respondGoldenCoastPhase1Retired(_req: Request, res: Response): void {
  res.status(410).json({
    code: "GC_PHASE1_POSTING_RETIRED",
    message: releaseDebtEnglish(
      "Golden Coast Phase 1 mutation posting is retired. The September 1, 2026 cutover and canonical Supplier Partner accounting flows are the only supported posting model."
    ),
  });
}

function retireLegacyPhase1Mutations(req: Request, res: Response, next: NextFunction): void {
  const isSetupMutation = req.method === "POST" && req.path === "/setup-accounts";
  const isPostingMutation = req.method === "POST" && req.path === "/post";
  if (!isSetupMutation && !isPostingMutation) {
    next();
    return;
  }

  privilegedMutationRateLimit(req, res, (rateLimitError?: unknown) => {
    if (rateLimitError) {
      next(rateLimitError);
      return;
    }
    requireAuth(req, res, (authError?: unknown) => {
      if (authError) {
        next(authError);
        return;
      }
      const authorization = isSetupMutation ? requireDeveloper : requireNonPOS;
      authorization(req, res, (authorizationError?: unknown) => {
        if (authorizationError) {
          next(authorizationError);
          return;
        }
        respondGoldenCoastPhase1Retired(req, res);
      });
    });
  });
}

export function registerGoldenCoastLegacyPostingRetirement(app: Express): void {
  // Intercept only the superseded Phase 1 writes before the legacy registrar.
  // Using a middleware mount instead of duplicate app.post registrations keeps
  // the historical/read-only handlers available without adding shadow routes.
  app.use("/api/golden-coast/accounting/phase1", retireLegacyPhase1Mutations);
}
