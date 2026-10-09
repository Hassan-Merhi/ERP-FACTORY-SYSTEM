import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { registerRentalUnitsContractsRoutes } from "./rental/units-contracts";
import { registerCentralRentalPaymentDeletionRoute } from "./rental/centralRentalPaymentDeletionRoute";
import { registerRentalPaymentsAccrualRoutes } from "./rental/rentalPaymentsAccrualRoutes";
import { registerRentalAccrualConfigRoutes } from "./rental/rentalAccrualConfigRoutes";
import { runRentalReconciliation } from "../services/rental/rentalReconciliationService";
import { registerDeferredRentReclassificationRoutes } from "./rental/deferredRentReclassificationRoutes";
import { requireAuth } from "../auth";
import { getClientDate } from "../lib/dateUtils";
import { getCompanyId } from "./rental/shared";
export { ensureMonthlyForCompany, postRentAccrualForCompany } from "./rental/shared";

type RentalModule = "PROPERTIES" | "ERP" | "FACTORY";

export function registerRentalRoutes(
  app: Express,
  module: RentalModule,
  urlPrefix: string,
  incomeAccountName: string,
  shopExpenseAccountName: string = "Rent Expense - Shops"
) {
  // Properties-mode landlord accounting recognises rent on receipt. The legacy
  // Deferred Rent Revenue reclassification no longer runs at registration or on
  // requests (accounting audit wave 16 A, owner decision of 2026-10-09): it is an
  // Owner preview/apply tool (deferredRentReclassificationRoutes.ts).
  if (module === "PROPERTIES") registerDeferredRentReclassificationRoutes(app, urlPrefix);

  registerRentalUnitsContractsRoutes(app, module, urlPrefix, incomeAccountName, shopExpenseAccountName);
  // The central route owns DELETE /payments/:id. Registration order keeps the
  // legacy creation, bulk, detail, and accrual handlers unchanged.
  registerCentralRentalPaymentDeletionRoute(app, module, urlPrefix);
  registerRentalPaymentsAccrualRoutes(app, module, urlPrefix, incomeAccountName, shopExpenseAccountName);
  registerRentalAccrualConfigRoutes(app, module, urlPrefix, incomeAccountName, shopExpenseAccountName);

  // ── Reconciliation endpoint (Admin / Developer only) ──
  app.get(`${urlPrefix}/reconciliation`, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      // Authentication stores the active role in currentRole. Keep the legacy
      // role fallback for older sessions while enforcing the same Admin/Developer gate.
      const session = req.session;
      const userRole = session?.currentRole ?? session?.role;
      if (userRole !== "Admin" && userRole !== "Developer") {
        return res.status(403).json({ message: "Administrator or Developer role required" });
      }
      const asOf = (req.query.asOf as string | undefined) || getClientDate(req);
      const result = await runRentalReconciliation(companyId, module, asOf);
      res.json(result);
    } catch (e: unknown) {
      logger.error(`[${module}/rental] reconciliation:`, { error: e });
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });
}
