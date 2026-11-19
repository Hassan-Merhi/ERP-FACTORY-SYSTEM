import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("Phase 2 backend module separation", () => {
  it("keeps the public route entry point as a composition root", () => {
    const source = read("server/routes.ts");
    expect(source).toContain("registerApplicationRoutes(app)");
    expect(source).not.toContain("app.get(");
    expect(source).not.toContain("app.post(");
    expect(source.split("\n").length).toBeLessThanOrEqual(30);
  });

  it("keeps supplier routes transport-only", () => {
    const source = read("server/routes/supplierRoutes.ts");
    expect(source).toContain("supplierService");
    expect(source).not.toContain('from "../db"');
    expect(source).not.toContain('from "../storage"');
    expect(source).not.toContain("@shared/schema");
    expect(source).not.toContain("drizzle-orm");
  });

  it("composes inventory read, adjustment, and movement modules", () => {
    const source = read("server/routes/inventoryRoutes.ts");
    expect(source).toContain("registerInventoryListRoutes(app)");
    expect(source).toContain("registerInventoryQuickAdjustRoutes(app)");
    expect(source).toContain("registerInventoryMovementRoutes(app)");
    expect(source).not.toContain("db.transaction");
  });

  it("composes focused customer domains without a compatibility registrar", () => {
    const source = read("server/routes/customerRoutes.ts");
    expect(source).toContain("registerCustomerMasterRoutes(app)");
    expect(source).toContain("registerContainerSalesRoutes(app)");
    expect(source).toContain("registerCompanyTransferRoutes(app)");
    expect(source).not.toContain("registerCustomerLegacyRoutes");
  });

  it("preserves container-sale and transfer accounting invariants", () => {
    const containerSales = read("server/routes/containers/containerSalesService.ts");
    const interCompany = read("server/routes/transfers/interCompanyTransferService.ts");
    const simpleTransfer = read("server/routes/transfers/simpleCompanyTransferService.ts");

    expect(containerSales).toContain("db.transaction");
    expect(containerSales).toContain('status: "SOLD"');
    expect(interCompany).toContain("IC-TO-");
    expect(interCompany).toContain("IC-FROM-");
    expect(simpleTransfer).toContain("TRANSFER-CLEARING");
    expect(simpleTransfer).toContain("deleteTransferVoucher");
  });

  it("composes session and focused reporting routes without compatibility registrars", () => {
    const auth = read("server/routes/authRoutes.ts");
    const reports = read("server/routes/reportsRoutes.ts");

    expect(auth).toContain("registerSessionRoutes(app)");
    expect(auth).not.toContain("registerLegacyAuthRoutes");
    expect(reports).toContain("registerReportsNetProfitStatementRoutes(app)");
    expect(reports).toContain("registerReportsClosingStockRoutes(app)");
    expect(reports).toContain("registerDashboardAccountRoutes(app)");
    expect(reports).not.toContain("registerLegacyReportsRoutes");
  });

  it("keeps retired compatibility registries deleted", () => {
    for (const path of [
      "server/routesLegacy.ts",
      "server/routes/authRoutesLegacy.ts",
      "server/routes/customerRoutesLegacy.ts",
      "server/routes/reportsRoutesLegacy.ts",
    ]) {
      expect(existsSync(resolve(process.cwd(), path))).toBe(false);
    }
  });
});
