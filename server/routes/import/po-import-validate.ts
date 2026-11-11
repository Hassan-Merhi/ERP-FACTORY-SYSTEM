/**
 * importRoutes: the PO Import validation endpoint.
 *
 * Registered by registerPoImportRoutes ahead of the import endpoint, in the
 * original order.
 */


import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { storage } from "../../storage";
import { requireAuth } from "../../auth";




import { supplierService } from "../suppliers/supplierService";
import { collectPreviewItemErrors, findPreviewContainer } from "./po-import-preview";
import { applyExplicitImportCurrency } from "./poImportCurrency";
import {
  validateZmwContainerPreview,
} from "./poImportZambia";
import { validateFactoryDispatchPoImport } from "./factoryDispatchPoImportGuard";
import {
  FactoryTripPoReceiptError, inspectFactoryTripPoReceipt,
} from "./factoryDispatchPoImportReceipt";

export function registerPoImportValidateRoute(app: Express) {
  app.post("/api/po-import/validate", requireAuth, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const { containerNumber, supplierId, preview, freightPaidBy, freightParentAccountId } = req.body;

      // Missing supplier still reports a validation error, but item resolution
      // remains available while the operator is completing the import form.
      if (!containerNumber || !preview) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      const errors: string[] = [];
      const resolvedItems: { index: number; stockItemId: number; itemName: string }[] = [];

      // Supplier master data may be inherited from the explicitly linked parent
      // company, but the import records remain owned by the active company.
      const visibleSuppliers = await supplierService.list(req.session.currentCompanyId, "", true);
      const supplier = visibleSuppliers.find((s) => s.id === supplierId);
      if (!supplier) {
        errors.push("Selected supplier not found");
      }

      // A container number that already exists is only a problem if it already has
      // real financial data attached (i.e. it was already imported/offloaded/sold before).
      // A container that was manually added on the tracking page (container number typed
      // in ahead of the invoice, still status OTW with no PO/charges/sale yet) is treated
      // as a placeholder — the import will attach its PO/line items to that existing
      // record instead of creating a duplicate. Must be in the same company to be eligible.
      const existingContainer = await storage.getContainerByNumber(containerNumber);
      if (existingContainer) {
        if (existingContainer.companyId !== req.session.currentCompanyId) {
          errors.push(`Container number "${containerNumber}" already exists — it cannot be imported again`);
        } else if (existingContainer.status !== "OTW") {
          errors.push(`Container number "${containerNumber}" already exists — it cannot be imported again`);
        } else {
          const [existingPOs, existingCharges, existingSale] = await Promise.all([
            storage.getPurchaseOrdersByContainer(existingContainer.id),
            storage.getChargesByContainer(existingContainer.id),
            storage.getContainerSaleByContainerId(existingContainer.id, existingContainer.companyId),
          ]);
          if (existingPOs.length > 0 || existingCharges.length > 0 || existingSale) {
            errors.push(`Container number "${containerNumber}" already exists — it cannot be imported again`);
          }
        }
      }

      // Get all stock items for validation
      const allStockItems = await storage.getAllStockItems(req.session.currentCompanyId!);

      // Validate all items in the preview
      const parsedPreview = findPreviewContainer(preview, containerNumber);
      if (!parsedPreview) {
        errors.push("Container data not found in preview");
      } else {
        const containerPreview = parsedPreview.container;
        // The stated invoice currency is applied to every line before the
        // Kwacha checks below, so a sheet without a Currency column can never
        // be read as USD for a Kwacha-enabled company.
        const importCompany = await storage.getCompanyById(req.session.currentCompanyId!);
        errors.push(...applyExplicitImportCurrency(containerPreview.items, req.body.currency, importCompany));
        errors.push(
          ...(await validateZmwContainerPreview(containerPreview, {
            companyId: req.session.currentCompanyId!,
            date: req.body.importDate,
            exchangeRate: req.body.exchangeRate,
          }))
        );
        errors.push(
          ...(await collectPreviewItemErrors(
            containerPreview.items,
            req.session.currentCompanyId!,
            allStockItems,
            resolvedItems
          ))
        );
        // FD- trip workbooks have stricter rules than ordinary supplier POs:
        // company-owned stock CODE/ALIAS must match exactly; similar item
        // names are not permitted to silently substitute another article.
        const factoryTripCheck = await validateFactoryDispatchPoImport(
          req.session.currentCompanyId!, containerPreview, supplier, allStockItems
        );
        errors.push(...factoryTripCheck.errors);
        if (factoryTripCheck.identity) {
          resolvedItems.splice(0, resolvedItems.length, ...factoryTripCheck.resolvedItems);
          const previous = await inspectFactoryTripPoReceipt(
            req.session.currentCompanyId!, factoryTripCheck.identity
          );
          if (previous) {
            errors.push(previous.status === "IMPORTED"
              ? "This Factory dispatch truck has already been imported into ERP."
              : "An earlier Factory dispatch PO import requires reconciliation; do not retry or double post.");
          }
        }

        // Validate parent freight account when freight is present and paid by parent
        const containerFreight = containerPreview.charges?.freight || 0;
        if (freightPaidBy === "parent" && containerFreight > 0 && !freightParentAccountId) {
          errors.push("A parent company freight account must be selected when freight is paid by parent company");
        }
      }

      res.json({
        valid: errors.length === 0,
        errors,
        resolvedItems,
      });
    } catch (error: unknown) {
      if (error instanceof FactoryTripPoReceiptError) {
        return res.status(error.status).json({ code: error.code, message: error.message });
      }
      logger.error("PO Import validation error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
