import type { Express } from "express";

import { requireActionAccess, requireExportAccess, requireModuleAccess } from "../../lib/permissionMiddleware";
import { registerProtectedCorrectionMutationBoundary } from "../../middleware/protectedCorrectionMutation";

export function registerPermissionBoundaryRoutes(app: Express): void {
  registerProtectedCorrectionMutationBoundary(app);
  app.use("/api/factory", requireModuleAccess("mod_factory"));
  app.use("/api/pos", requireModuleAccess("mod_pos"));
  app.use("/api/properties", requireModuleAccess("mod_properties"));

  for (const path of ["/api/customers", "/api/suppliers", "/api/employees", "/api/purchase-orders", "/api/erp"]) {
    app.use(path, requireModuleAccess("mod_erp"));
  }

  for (const path of [
    "/api/vouchers",
    "/api/voucher-entries",
    "/api/voucher-detail",
    "/api/accounts",
    "/api/ledger-accounts",
    "/api/bank-accounts",
    "/api/fixed-assets",
    "/api/fiscal-period",
    "/api/financial",
    "/api/credit-notes",
    "/api/golden-coast/accounting",
  ]) {
    app.use(path, requireModuleAccess("mod_accounting"));
  }

  for (const path of [
    "/api/inventory",
    "/api/stock-items",
    "/api/stock-groups",
    "/api/bales",
    "/api/containers",
    "/api/locations",
    "/api/pending-barcodes",
    "/api/stock-transfers",
    "/api/stock-transfer-revisions",
    "/api/stock-summary",
    "/api/offload-item-search",
    "/api/location-price-groups",
  ]) {
    app.use(path, requireModuleAccess("mod_inventory"));
  }

  for (const path of ["/api/reports", "/api/stats", "/api/dashboard", "/api/sales-report"]) {
    app.use(path, requireModuleAccess("mod_analytics"));
  }

  app.post("/api/vouchers", requireActionAccess("act_create_voucher"));
  app.put("/api/vouchers/:id/with-entries", requireActionAccess("act_create_voucher"));
  app.patch("/api/vouchers/:id/sales", requireActionAccess("act_void_sale"));
  app.use("/api/golden-coast/accounting/phase1/post", requireActionAccess("act_create_voucher"));
  app.post("/api/inventory/quick-adjust", requireActionAccess("act_adjust_stock"));
  app.post("/api/stock-transfer-revisions/:id/approve", requireActionAccess("act_transfer_stock"));

  for (const path of [
    "/api/stock-items/import-opening-balances",
    "/api/bales/import",
    "/api/factory/workers/import-excel",
    "/api/containers/tracking/import",
  ]) {
    app.post(path, requireActionAccess("act_import_data"));
  }

  for (const path of [
    "/api/stock-items/bulk-delete",
    "/api/stock-items/bulk-update-prices",
    "/api/stock-items/bulk-update-uom",
    "/api/stock-items/bulk-rename",
    "/api/vouchers/bulk-delete",
  ]) {
    app.post(path, requireActionAccess("act_bulk_operations"));
  }

  for (const path of [
    "/api/factory/payroll/export-pdf",
    "/api/factory/payroll/export-excel",
    "/api/stats/net-position-excel",
    "/api/accounts/:type/:id/statement-pdf",
  ]) {
    app.use(path, requireExportAccess("exp_pdf"));
  }
}
