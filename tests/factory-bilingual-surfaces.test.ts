import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routeSource = readFileSync(
  "server/routes/factory/factoryBilingualSurfaceRoutes.ts",
  "utf8"
);
const resolverSource = readFileSync(
  "server/services/factoryBilingualSurfaceResolver.ts",
  "utf8"
);
const shellSource = readFileSync("client/src/app/FactoryShell.tsx", "utf8");
const switchSource = readFileSync(
  "client/src/components/FactoryCatalogLanguageSwitch.tsx",
  "utf8"
);

describe("Factory bilingual Phase 8 remaining surfaces", () => {
  it("covers current and legacy Factory read surfaces", () => {
    for (const token of [
      "bales",
      "barcode",
      "stock-entry",
      "location-inventory",
      "customer-proformas",
      "customer-orders",
      "invoice-loading",
      "dispatch",
      "stock-allocation",
      "factory-pos",
      "backup",
      "offline",
      "bale-transfers",
      "bale-ledger",
      "container-loading",
    ]) {
      expect(routeSource).toContain(token);
    }
    expect(routeSource).toContain('app.use("/api/factory"');
    expect(routeSource).toContain('app.use("/api"');
  });

  it("uses product id before exact normalized article code", () => {
    expect(resolverSource).toContain("objectProductId");
    expect(resolverSource).toContain("normalizeFactoryArticleCode");
    expect(resolverSource).toContain("catalog.byId.get(productId)");
    expect(resolverSource).toContain("catalog.byArticleCode.get(articleCode)");
    expect(resolverSource).not.toContain("ilike");
  });

  it("uses the shared snapshot and category resolvers", () => {
    expect(resolverSource).toContain("resolveFactorySnapshotProductName");
    expect(resolverSource).toContain("resolveFactoryProductLanguage");
    expect(resolverSource).toContain("resolveFactoryCategoryName");
  });

  it("keeps preservation payload fields additive", () => {
    expect(routeSource).toContain("mutateLegacyDisplayFields: !isPreservationPayload(req)");
    expect(routeSource).toContain("backup|offline|prepare|import");
  });

  it("mounts one persistent Factory-wide language selector", () => {
    expect(shellSource).toContain("FactoryCatalogLanguageSwitch");
    expect(switchSource).toContain("persistFactoryCatalogLanguagePreference");
    expect(switchSource).toContain('startsWith("/api/factory")');
    expect(switchSource).toContain('refetchType: "active"');
  });
});
