/** DELETE /api/purchase-orders/:id (split out of containerFreightWriteRoutes.ts, registered at the same position). */
import type { Express } from "express";

import { requireAuth, requireRole } from "../../auth";
import { getErrorMessage } from "../../lib/httpHandlers";
import { parseId } from "../../lib/parseId";
import { sessionRetirementActor } from "../../services/accounting/voucherRetirement";
import { storage } from "../../storage";
import { logAudit } from "../_helpers";

export function registerPurchaseOrderDeleteRoute(app: Express): void {
  // Delete a purchase order (Admin only)
  app.delete("/api/purchase-orders/:id", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });
      if (isNaN(id)) {
        return res.status(400).json({ message: "Invalid purchase order ID" });
      }

      const existingPO = await storage.getPurchaseOrderByIdForCompany(id, req.session.currentCompanyId!);
      if (!existingPO) {
        return res.status(404).json({ message: "Purchase order not found" });
      }

      // Verify purchase order belongs to current company
      if (existingPO.companyId !== req.session.currentCompanyId) {
        return res.status(403).json({
          message: "Access denied: Purchase order belongs to a different company",
        });
      }

      await storage.deletePurchaseOrder(id, sessionRetirementActor(req));
      try {
        await logAudit({
          userId: req.session.userId!,
          username: req.session.username || "unknown",
          companyId: req.session.currentCompanyId!,
          action: "delete",
          tableName: "purchase_orders",
          recordId: existingPO.id,
          recordIdentifier: existingPO.poNumber || `PO #${id}`,
          changes: {
            poNumber: { old: existingPO.poNumber },
            supplier: { old: existingPO.supplierId },
            itemsTotal: { old: existingPO.itemsTotal || "0" },
            status: { old: existingPO.status },
          },
        });
      } catch {
        /* non-fatal */
      }
      res.json({ message: "Purchase order deleted successfully" });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
