import { describe, expect, it } from "vitest";
import { classifyOperationalPermissionRoute } from "../server/services/security/operationalPermissionRoutePolicy";

describe("operational permission route policy", () => {
  it("classifies import workflows and excludes import-cycle reads", () => {
    expect(classifyOperationalPermissionRoute("POST", "/api/po-import/import")).toMatchObject({
      operation: "import",
      permissionKey: "act_import_data",
      deniedRoles: ["POS", "View Only"],
    });
    expect(classifyOperationalPermissionRoute("POST", "/api/stock-items/import")).toMatchObject({
      operation: "import",
      permissionKey: "act_import_data",
    });
    expect(classifyOperationalPermissionRoute("GET", "/api/stats/import-cycle-balance")).toBeNull();
  });

  it("allows POS-role access to the POS import workflow while keeping View Only blocked", () => {
    expect(classifyOperationalPermissionRoute("GET", "/api/pos-import/template")).toMatchObject({
      operation: "import",
      permissionType: "action",
      permissionKey: "act_import_data",
      deniedRoles: ["View Only"],
    });
    expect(classifyOperationalPermissionRoute("POST", "/api/pos-import/parse")).toMatchObject({
      operation: "import",
      permissionType: "action",
      permissionKey: "act_import_data",
      deniedRoles: ["View Only"],
    });
    expect(classifyOperationalPermissionRoute("POST", "/api/pos-import/validate")).toMatchObject({
      deniedRoles: ["View Only"],
    });
    expect(classifyOperationalPermissionRoute("POST", "/api/pos-import/import")).toMatchObject({
      deniedRoles: ["View Only"],
    });
  });

  it("protects the Arabic template through Excel export and import mutations through action access", () => {
    expect(
      classifyOperationalPermissionRoute("GET", "/api/factory/bale-products/arabic-template")
    ).toMatchObject({
      operation: "excel-export",
      permissionType: "export",
      permissionKey: "exp_excel",
    });
    expect(
      classifyOperationalPermissionRoute(
        "POST",
        "/api/factory/bale-products/arabic-import/apply"
      )
    ).toMatchObject({
      operation: "import",
      permissionType: "action",
      permissionKey: "act_import_data",
      deniedRoles: ["POS", "View Only"],
    });
  });

  it("classifies company-scoped repair and recalculation mutations", () => {
    expect(
      classifyOperationalPermissionRoute("POST", "/api/admin/recalculate-equity-adjustment")
    ).toMatchObject({
      operation: "bulk-maintenance",
      permissionKey: "act_bulk_operations",
    });
    expect(classifyOperationalPermissionRoute("GET", "/api/admin/repair-preview")).toBeNull();
  });

  it("makes the all-company export center Developer-only", () => {
    expect(classifyOperationalPermissionRoute("POST", "/api/export/start")).toEqual({
      operation: "global-export-center",
      permissionType: "export",
      permissionKey: "exp_backup_download",
      developerOnly: true,
    });
  });

  it("uses specific export permissions", () => {
    expect(classifyOperationalPermissionRoute("GET", "/api/reports/stock/export/excel")).toMatchObject({
      operation: "stock-export",
      permissionKey: "exp_stock_report",
    });
    expect(classifyOperationalPermissionRoute("GET", "/api/invoices/7/pdf")).toMatchObject({
      operation: "pdf-export",
      permissionKey: "exp_pdf",
    });
    expect(classifyOperationalPermissionRoute("GET", "/api/vouchers/7/print")).toMatchObject({
      operation: "print",
      permissionKey: "exp_print_invoice",
    });
  });

  it("classifies POS shift controls and summaries", () => {
    expect(classifyOperationalPermissionRoute("POST", "/api/pos/shifts/open")).toMatchObject({
      operation: "pos-shift-control",
      permissionType: "pos",
      permissionKey: "pos_perm_open_shift",
    });
    expect(classifyOperationalPermissionRoute("POST", "/api/pos/shifts/45/close")).toMatchObject({
      operation: "pos-shift-control",
      permissionKey: "pos_perm_open_shift",
    });
    expect(classifyOperationalPermissionRoute("GET", "/api/pos/shifts/history")).toMatchObject({
      operation: "pos-shift-summary",
      permissionKey: "pos_perm_view_shift_summary",
    });
  });

  it("ignores ordinary JSON report reads", () => {
    expect(classifyOperationalPermissionRoute("GET", "/api/reports/sales")).toBeNull();
  });
});
