/**
 * "Post due accruals now" (accounting audit wave 18 A, owner decision 3).
 *
 *   POST {prefix}/accruals/post-due   Admin/Owner
 *
 * The same code path as the daily scheduled job (services/rental/dueRentalPosting.ts):
 * the company's due scheduled payments and accruals, dated by its business
 * date, in its tenant scope, closed periods skipped and reported, every voucher
 * audited in its posting transaction with the signed-in user as the actor.
 * It replaces the posting `GET {prefix}/units` did on every page load.
 */
import type { Express, Request, Response } from "express";

import { requireAuth, requireRole } from "../../auth";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { postDueRentalForCompany } from "../../services/rental/dueRentalPosting";
import { resolveRequestCompanyId } from "../../services/security/requestCompanyScope";
import type { RentalModule } from "./shared";

export function registerDueRentalPostingRoutes(
  app: Express,
  module: RentalModule,
  urlPrefix: string,
  incomeAccountName: string,
  shopExpenseAccountName: string
): void {
  const route = `${urlPrefix}/accruals/post-due`;
  app.post(route, requireAuth, requireRole("Admin", "Owner"), async (req: Request, res: Response) => {
    try {
      const companyId = resolveRequestCompanyId(req);
      const result = await postDueRentalForCompany(companyId, module, {
        trigger: "manual",
        actor: {
          userId: String(req.session.userId ?? ""),
          username: req.session.username || String(req.session.userId ?? "unknown"),
        },
        incomeAccountName,
        shopExpenseAccountName,
      });
      res.json(result);
    } catch (error: unknown) {
      logger.error(`POST ${route} error`, { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
