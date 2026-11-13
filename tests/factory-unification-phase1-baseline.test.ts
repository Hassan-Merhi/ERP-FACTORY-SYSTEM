import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FACTORY_ACCESS_REGISTRY,
  factoryPageAllowsRole,
  resolveFactoryPage,
} from "../shared/factoryAccessRegistry";
import { companyQueryKey, isCompanySessionQueryKey, isGlobalQueryKey } from "../client/src/lib/companyQueryScope";
import { factoryActionCapabilities } from "../shared/factoryActionCapabilities";

type BaselineRegistryPage = {
  key: string;
  route: string;
  accessLevel: string;
  sidebar: boolean;
  pinned: boolean;
};
type Phase1Fixture = {
  counts: { registryPages: number; routerDeclarations: number; uniqueRouterPaths: number; nonFactoryRouterPaths: string[] };
  registry: BaselineRegistryPage[];
  routerPaths: string[];
};

const readSource = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const fixture = JSON.parse(readSource("docs/factory-unification/phase-1-source-fixture.json")) as Phase1Fixture;

function registryFromSource(): BaselineRegistryPage[] {
  const source = readSource("shared/factoryAccessRegistry.ts");
  const keys = [...source.matchAll(/^\s*key:\s*"(factory\/[^"]+)"/gm)];
  return keys.map((item, index) => {
    // Key-anchored rather than object-start parsing: comments within an object
    // and between entries must not silently drop security-sensitive pages.
    const end = keys[index + 1]?.index ?? source.indexOf("] as const;", item.index);
    const block = source.slice(item.index, end);
    const route = block.match(/^\s*route:\s*"([^"]+)"/m)?.[1];
    expect(route, `missing canonical route for ${item[1]}`).toBeDefined();
    return {
      key: item[1],
      route: route!,
      accessLevel: block.match(/^\s*accessLevel:\s*"([^"]+)"/m)?.[1] ?? "user",
      sidebar: /^\s*sidebar:\s*true/m.test(block),
      pinned: /^\s*pinned:\s*true/m.test(block),
    };
  });
}

function routesFromSource(): string[] {
  return Array.from(
    readSource("client/src/components/FactoryRoutes.tsx").matchAll(/<Route\b[^>]*?\bpath="([^"]+)"/g),
    (match) => match[1],
  );
}

describe("Factory Phase 1 pinned source baseline (not a browser/API fixture)", () => {
  it("reproduces the complete 62-page registry including guarded Production Bonuses", () => {
    const actual = registryFromSource();
    expect(actual).toEqual(fixture.registry);
    expect(actual.length).toBe(fixture.counts.registryPages);
    expect(new Set(actual.map((p) => p.key)).size).toBe(actual.length);
    expect(actual.find((p) => p.key === "factory/production-bonuses")?.accessLevel).toBe("admin");
    expect(FACTORY_ACCESS_REGISTRY.length).toBe(actual.length);
  });

  it("pins all 151 declared route paths, including four non-Factory utility routes", () => {
    const paths = routesFromSource();
    expect(paths).toEqual(fixture.routerPaths);
    expect(paths.length).toBe(fixture.counts.routerDeclarations);
    expect(new Set(paths).size).toBe(fixture.counts.uniqueRouterPaths);
    expect(paths.filter((path) => !path.startsWith("/factory/"))).toEqual(fixture.counts.nonFactoryRouterPaths);
    for (const page of fixture.registry) expect(paths, page.key).toContain(page.route);
  });

  it("captures safety-critical URL compatibility and role restrictions without widening access", () => {
    const paths = routesFromSource();
    for (const path of [
      "/factory/stock-allocation",
      "/factory/stock-allocation-v3",
      "/factory/stock-allocation-v5",
      "/factory/invoicing/proformas/:id/edit",
      "/factory/stock-allocation-v5/proformas/new",
      "/factory/sales/loading/dispatch/:orderId/:dispatchId",
      "/factory/sales/loading/dispatch/:orderId/:dispatchId/report",
    ]) {
      expect(paths).toContain(path);
    }
    expect(resolveFactoryPage("/factory/others?tab=comparison")?.key).toBe("factory/production-report");
    const bonuses = resolveFactoryPage("/factory/production-bonuses");
    expect(bonuses).not.toBeNull();
    expect(factoryPageAllowsRole(bonuses!, "Developer")).toBe(false);
    expect(factoryPageAllowsRole(bonuses!, "Admin")).toBe(true);
    expect(factoryPageAllowsRole(bonuses!, "Owner")).toBe(true);
  });

  it("captures selected-company cache and fail-closed action policy contracts", () => {
    expect(companyQueryKey("/api/factory/my-access", 1)).not.toEqual(
      companyQueryKey("/api/factory/my-access", 2),
    );
    expect(isCompanySessionQueryKey(["/api/factory/stock-allocation"])).toBe(true);
    expect(isGlobalQueryKey(["/api/user/companies"])).toBe(true);
    const viewOnly = factoryActionCapabilities({ role: "View Only", hasFactoryAccess: true });
    expect(viewOnly["dispatch.close"]).toBe(false);
    expect(viewOnly["dispatch.reopen"]).toBe(false);
    expect(factoryActionCapabilities({ role: "Developer" })["production.manage-bonuses"]).toBe(false);
  });

  it("retires the sample-data inventory mockup but preserves the developer-only bookmark", () => {
    const routes = readSource("client/src/components/FactoryRoutes.tsx");
    const lazyPages = readSource("client/src/lazyPages.ts");
    expect(routes).toContain('<Route path="/factory/location-inventory-mockup">');
    expect(routes).toContain('<Redirect replace to="/factory/location-inventory" />');
    expect(routes).not.toContain("component={FactoryLocationInventoryMockup}");
    expect(lazyPages).not.toContain("FactoryLocationInventoryMockup");
    const retiredMockupPath = resolve(process.cwd(), "client/src/pages/factory/FactoryLocationInventoryMockup.tsx");
    expect(existsSync(retiredMockupPath)).toBe(false);

    const legacyPage = resolveFactoryPage("/factory/location-inventory-mockup");
    expect(legacyPage?.key).toBe("factory/location-inventory-mockup");
    expect(legacyPage).not.toBeNull();
    expect(factoryPageAllowsRole(legacyPage!, "Developer")).toBe(true);
    expect(factoryPageAllowsRole(legacyPage!, "Admin")).toBe(false);
    expect(resolveFactoryPage("/factory/location-inventory")?.key).toBe("factory/location-inventory");
  });
});
