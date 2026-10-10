import type { Express, Request, Response } from "express";
import { RentalAutoTransferScopeError } from "../../services/rental/autoTransferScope";
import { requireAuth } from "../../auth";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { deleteRentalPaymentGroup, type RentalModule } from "../../services/rental/rentalPaymentDeletionService";
import { getCompanyId } from "./shared";

export function registerCentralRentalPaymentDeletionRoute(app: Express, module: RentalModule, urlPrefix: string): void {
  app.delete(`${urlPrefix}/payments/:id`, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = Number(getCompanyId(req));
      if (!Number.isInteger(companyId) || companyId <= 0) {
        return res.status(400).json({ message: "No company selected" });
      }

      const paymentId = Number(req.params.id);
      if (!Number.isInteger(paymentId) || paymentId <= 0) {
        return res.status(400).json({ message: "Invalid payment id" });
      }

      const result = await deleteRentalPaymentGroup({ companyId, module, paymentId });
      if (!result.found) return res.status(404).json({ message: "Payment not found" });

      return res.json({
        ok: true,
        deletedCount: result.deletedCount,
        paymentGroupId: result.paymentGroupId,
      });
    } catch (error: unknown) {
      if (error instanceof RentalAutoTransferScopeError) {
        return res.status(error.status).json({ message: error.message });
      }
      logger.error(`[${module}/rental] atomic delete-payment failed`, { error });
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
