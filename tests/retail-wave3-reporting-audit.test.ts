import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

describe("Retail Wave 3 reporting and reconciliation", () => {
  it("uses stable sale-time cost snapshots for COGS and profit", () => {
    const migration = read("migrations/0019_retail_reporting_audit.sql");
    const schema = read("shared/schema/retailPos.ts");
    const reporting = read("server/services/retail/retailReporting.ts");

    expect(migration).toContain("ADD COLUMN IF NOT EXISTS unit_cost");
    expect(migration).toContain("retail_snapshot_sale_item_cost");
    expect(schema).toContain('unitCost: decimal("unit_cost"');
    expect(reporting).toContain("si.unit_cost AS cogs");
    expect(reporting).toContain("SUM(revenue - cogs)");
  });

  it("reports every required retail business view from the movement ledger", () => {
    const reporting = read("server/services/retail/retailReporting.ts");
    const dashboard = read("client/src/pages/retail/RetailDashboard.tsx");

    for (const contract of [
      "bestSellingProducts",
      "bestSellingBrands",
      "bestSellingSizes",
      "salesByLocation",
      "lowStock",
      "outOfStock",
      "slowMoving",
      "profitByProduct",
      "profitByBrand",
      "inventory_quantity",
      "inventory_value",
      "revenue",
      "cogs",
      "gross_profit",
    ]) {
      expect(`${reporting}\n${dashboard}`).toContain(contract);
    }
    expect(reporting).toContain("m.movement_type IN ('sale', 'return', 'cancellation')");
  });

  it("audits POS deductions, returns, transfers, inventory totals and variant integrity", () => {
    const reporting = read("server/services/retail/retailReporting.ts");
    for (const issue of [
      "duplicate_barcodes",
      "negative_quantities",
      "orphan_variants",
      "products_without_valid_variants",
      "duplicate_pos_deductions",
      "return_stock_restoration",
      "transfer_conservation",
      "incorrect_inventory_totals",
      "movement_chain_break",
    ]) {
      expect(reporting).toContain(`"${issue}"`);
    }
    expect(reporting).toContain("COUNT(DISTINCT location_id)");
    expect(reporting).toContain("LAG(quantity_after)");
  });

  it("keeps large-catalog paths bounded and images lazy", () => {
    const migration = read("migrations/0019_retail_reporting_audit.sql");
    const reporting = read("server/services/retail/retailReporting.ts");
    const catalog = read("server/routes/retailCatalogRoutes.ts");
    const inventory = read("client/src/pages/retail/RetailInventory.tsx");
    const pos = read("client/src/pages/pos/RetailPOS.tsx");

    expect(reporting).toContain("Math.min(Math.max(filters.limit ?? 10, 1), 50)");
    expect(catalog).toContain("Math.min(positiveInteger(req.query.pageSize) ?? 60, 100)");
    expect(catalog).toContain("LIMIT ${limitParam} OFFSET ${offsetParam}");
    expect(catalog).toContain("p.id = ANY($2::int[])");
    expect(inventory).toContain("/api/retail/products-page?");
    expect(inventory).toContain("setDebouncedSearch(search.trim())");
    expect(inventory).toContain('loading="lazy"');
    expect(inventory).toContain('decoding="async"');
    expect(pos).toContain('loading="lazy"');
    expect(pos).toContain('decoding="async"');
    expect(migration).toContain("retail_stock_movements_company_variant_location_created_idx");
    expect(migration).toContain("retail_pos_sales_company_location_created_idx");
  });

  it("keeps the retail POS responsive for phone, tablet and desktop layouts", () => {
    const pos = read("client/src/pages/pos/RetailPOS.tsx");
    expect(pos).toContain("flex-col gap-3");
    expect(pos).toContain("md:flex-row");
    expect(pos).toContain("sm:grid-cols-2");
    expect(pos).toContain("lg:grid-cols-3");
    expect(pos).toContain("xl:grid-cols-[minmax(0,1.5fr)_minmax(360px,0.7fr)]");
  });

  it("keeps reporting available without replacing the standard ERP dashboard and accounting workspace", () => {
    const guard = read("client/src/app/authenticatedAppRouteGuard.ts");
    const routes = read("client/src/routes/AppRoutes.tsx");
    expect(guard).toContain('const isPropertiesCompany = companyType === "properties"');
    expect(guard).toContain('const isSupplierPartnerCompany = companyType === "supplier_partner"');
    expect(guard).toContain('const isFactoryCompany = companyType === "factory" || companyType === "factory_v2"');
    expect(guard).toContain('const isRetailCompany = companyType === "retail"');
    expect(guard).toContain('decision = { kind: "redirect", to: "/financial-overview" }');
    expect(guard).toContain('decision = { kind: "redirect", to: "/retail/inventory" }');
    expect(guard).toContain('decision = { kind: "redirect", to: "/retail/pos" }');
    expect(guard).toContain('decision = { kind: "redirect", to: "/properties/daybook" }');
    expect(guard).toContain('decision = { kind: "redirect", to: "/sp" }');
    expect(routes).toContain('location === "/retail/reports"');
    expect(routes).toContain("return <ErpRoutes user={user} />");
  });

  it("exposes authenticated dashboard, audit and production-readiness endpoints", () => {
    const routes = read("server/routes/retailReportingRoutes.ts");
    const catalog = read("server/routes/retailCatalogRoutes.ts");
    expect(routes).toContain("/api/retail/reporting/dashboard");
    expect(routes).toContain("/api/retail/reporting/audit");
    expect(routes).toContain("/api/retail/reporting/readiness");
    expect(routes.match(/requireAuth, requireNonPOS/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(routes).toContain("res.status(audit.ready ? 200 : 409)");
    expect(catalog).toContain("/api/retail/products-page");
    expect(catalog).toContain("/api/retail/catalog-facets");
  });

  it("records imports and manual product stock edits in movement history", () => {
    const routes = read("server/routes/retailRoutes.ts");
    expect(routes).toContain('movementType: "import"');
    expect(routes).toContain('referenceType: "retail_import"');
    expect(routes).toContain('referenceType: "retail_product_edit"');
    expect(routes).toContain("writeVariantInventoryWithMovement");
  });
});
