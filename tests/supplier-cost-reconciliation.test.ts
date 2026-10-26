import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { transformSalesReportBandwidthSource } from "../build/viteSalesReportBandwidthPlugin";

const root = path.resolve(__dirname, "..");
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

describe("supplier landed-cost reconciliation", () => {
  const route = read("server/routes/stats/supplierCostReconciliationRoutes.ts");
  const registry = read("server/routes/statsRoutes.ts");

  it("mounts authenticated current-company read-only endpoints", () => {
    expect(registry).toContain("registerSupplierCostReconciliationRoutes(app)");
    expect(route).toContain('"/api/sales-report/supplier-reconciliation/options"');
    expect(route).toContain('"/api/sales-report/supplier-reconciliation"');
    expect(route).toContain('requirePageAccess("page_sales_report")');
    expect(route).toContain("req.session.currentCompanyId");
    expect(route).toContain('readOnly: true');
    expect(route).toContain('completeness: "partial"');
    expect(route).not.toMatch(/\b(?:UPDATE|DELETE FROM|INSERT INTO|TRUNCATE)\b/i);
  });

  it("validates supplier/group scope and filters all source tables by company", () => {
    for (const condition of [
      "s.company_id = $1 AND s.id = $2",
      "g.company_id = $1 AND g.id = $3",
      "company_id = $1 AND stock_group_id = $3",
      "c.company_id = $1 AND c.supplier_id = $2",
      "v.company_id = $1 AND v.optional = false AND v.deleted_at IS NULL",
      "i.company_id = $1",
      "cm.company_id = $1",
    ]) expect(route).toContain(condition);
    expect(route).toContain("positiveId(req.query.supplierId)");
    expect(route).toContain("positiveId(req.query.stockGroupId)");
  });

  it("keeps the backend and JSX panel syntactically valid", () => {
    for (const file of [
      "server/routes/stats/supplierCostReconciliationRoutes.ts",
      "client/src/pages/salesreportlegacy/SupplierCostReconciliationPanel.tsx",
    ]) {
      const ast = ts.createSourceFile(
        file, read(file), ts.ScriptTarget.Latest, true,
        file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
      );
      expect(ast.parseDiagnostics, file).toHaveLength(0);
    }
  });
});

describe("Sales Report booked-profit arithmetic", () => {
  it("derives profit from recorded sales and recorded costs on both report routes", () => {
    const compact = read("server/routes/stats/salesReportBandwidthRoutes.ts");
    const raw = read("server/routes/stats/statsDataRoutes.ts");
    const legacy = read("server/routes/stats/statsReportsRoutes.ts");
    expect(compact).toContain("sales.total_sales, 0)::numeric - COALESCE(sales.total_cost, 0)::numeric");
    expect(raw).toContain("subtractInventoryValues(totalSales, toInventoryDecimal(item.totalCost))");
    expect(legacy).toContain("salesItems.totalSales");
    expect(legacy).toContain("salesItems.totalCost");
  });

  it("keeps the compact build transform and new reconciliation UI", () => {
    const file = "client/src/pages/SalesReportLegacy.tsx";
    const built = transformSalesReportBandwidthSource(read(file), path.join(root, file));
    expect(built).toBeTruthy();
    expect(built).toContain("const displayedCostProfit = totals.costProfit;");
    expect(built).toContain("<SupplierCostReconciliationPanel />");
  });

  it("reproduces the HMD gap without any writes", () => {
    const sales = 339200.81;
    const cogs = 303022.84;
    const landed = 372853.70;
    const currentStockAtRoundedRate = 69909.75;
    const bookedProfit = sales - cogs;
    const manualProfit = sales - (landed - currentStockAtRoundedRate);
    expect(Number(bookedProfit.toFixed(2))).toBe(36177.97);
    expect(Number(manualProfit.toFixed(2))).toBe(36256.86);
    expect(Number((manualProfit - bookedProfit).toFixed(2))).toBe(78.89);
  });
});
