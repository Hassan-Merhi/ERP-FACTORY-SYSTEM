import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { registerRentalUnitsContractsRoutes } from "./rental/units-contracts";
import { registerCentralRentalPaymentDeletionRoute } from "./rental/centralRentalPaymentDeletionRoute";
import { registerRentalPaymentsAccrualRoutes } from "./rental/rentalPaymentsAccrualRoutes";
import { registerRentalAccrualConfigRoutes } from "./rental/rentalAccrualConfigRoutes";
import { runRentalReconciliation } from "../services/rental/rentalReconciliationService";
import { getHadiLinkedRentControl, HADI_LINKED_RENT } from "../services/rental/hadiLinkedRentProtection";
import { RentalAutoTransferScopeError } from "../services/rental/autoTransferScope";
import { registerDeferredRentReclassificationRoutes } from "./rental/deferredRentReclassificationRoutes";
import { registerDueRentalPostingRoutes } from "./rental/dueRentalPostingRoutes";
import { registerLegacyPrepaidRecognitionRoutes } from "./rental/legacyPrepaidRecognitionRoutes";
import { requireAuth } from "../auth";
import { requireRentalReconciliationPermission } from "./rental/rentalRoutePermissions";
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
  // Wave 18 A: the legacy prepaid shop rent recognition left the daily job and is
  // an Owner preview/apply tool; "post due accruals now" replaces the posting the
  // units page load did (Admin/Owner, same code path as the daily job).
  if (module === "ERP" || module === "FACTORY") {
    registerLegacyPrepaidRecognitionRoutes(app, module, urlPrefix, shopExpenseAccountName);
  }
  registerDueRentalPostingRoutes(app, module, urlPrefix, incomeAccountName, shopExpenseAccountName);

  registerRentalUnitsContractsRoutes(app, module, urlPrefix, incomeAccountName, shopExpenseAccountName);
  // The central route owns DELETE /payments/:id. Registration order keeps the
  // legacy creation, bulk, detail, and accrual handlers unchanged.
  registerCentralRentalPaymentDeletionRoute(app, module, urlPrefix);
  registerRentalPaymentsAccrualRoutes(app, module, urlPrefix, incomeAccountName, shopExpenseAccountName);
  registerRentalAccrualConfigRoutes(app, module, urlPrefix, incomeAccountName, shopExpenseAccountName);


  // HADI's linked Properties rent creates a liability in ERP but receipts
  // belong to the separate Properties company. Reconcile both *read-only*;
  // never manufacture historic correcting journals or mutate prepaid rent.
  if (module === "ERP") {
    app.get(`${urlPrefix}/linked-rent-control`, requireAuth, requireRentalReconciliationPermission, async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (companyId !== HADI_LINKED_RENT.payerCompanyId) return res.status(404).json({ message: "Not found" });
        const asOf = (req.query.asOf as string | undefined) || getClientDate(req);
        const result = await getHadiLinkedRentControl(companyId, asOf);
        return res.json(result);
      } catch (e: unknown) {
        if (e instanceof RentalAutoTransferScopeError) {
          return res.status(e.status).json({ code: e.code, message: e.message });
        }
        const error = getErrorMessage(e);
        if (error === "HADI_LINKED_RENT_INVALID_AS_OF_DATE") {
          return res.status(400).json({ code: error, message: "Use a valid YYYY-MM-DD asOf date." });
        }
        logger.error("[ERP/rental] HADI linked rent control:", { error: e });
        return res.status(500).json({ message: "Linked rent accounting check failed without changing any vouchers." });
      }
    });
  }

  // ── Reconciliation endpoint (Admin / Developer only) ──
  app.get(`${urlPrefix}/reconciliation`, requireAuth, requireRentalReconciliationPermission, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      // The guard checks the canonical active-company role before any accounting reads.
      const asOf = (req.query.asOf as string | undefined) || getClientDate(req);
      const result = await runRentalReconciliation(companyId, module, asOf);
      res.json(result);
    } catch (e: unknown) {
      logger.error(`[${module}/rental] reconciliation:`, { error: e });
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });
}
