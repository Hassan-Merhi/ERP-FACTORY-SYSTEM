import fs from "node:fs/promises";
import path from "node:path";

/**
 * Derive the Duo regression inventory from the mounted route registries, not a
 * hand-maintained shortlist. The report exposes every parameterized route that
 * still needs a seeded record rather than silently treating it as covered.
 *
 * Read-only: this module never calls production APIs or seeds records.
 */
const ROOT = process.cwd();
const SOURCES = {
  erp: "client/src/routes/ErpRoutes.tsx",
  factory: "client/src/components/FactoryRoutes.tsx",
  properties: "client/src/app/PropertiesRoutes.tsx",
  pos: "client/src/routes/PosRoutes.tsx",
  app: "client/src/routes/AppRoutes.tsx",
};

const unique = (values) => [...new Set(values)];
const routePattern = /<Route\s+path=["']([^"']+)["']/g;
const wrapperPattern = /\bR\(\s*["']([^"']+)["']/g;
const routeMatches = (source, pattern) => [...source.matchAll(pattern)].map((match) => match[1]);
const splitRoutes = (routes) => ({
  static: unique(routes.filter((value) => value.startsWith("/") && !/:\w+|\*/.test(value))),
  parameterized: unique(routes.filter((value) => /:\w+|\*/.test(value))),
});

export async function discoverDuoRouteInventory() {
  const entries = await Promise.all(
    Object.entries(SOURCES).map(async ([name, relative]) => {
      const content = await fs.readFile(path.join(ROOT, relative), "utf8");
      return [name, content];
    }),
  );
  const sources = Object.fromEntries(entries);
  const erpAll = unique([...routeMatches(sources.erp, routePattern), ...routeMatches(sources.erp, wrapperPattern)]);
  const erp = splitRoutes(erpAll.filter((route) => !route.startsWith("/sp")));
  const supplier = splitRoutes([
    ...erpAll.filter((route) => route.startsWith("/sp")),
    "/sp/golden-coast",
  ]);
  const factory = splitRoutes(routeMatches(sources.factory, routePattern).filter((route) => route.startsWith("/factory/")));
  const properties = splitRoutes(routeMatches(sources.properties, routePattern));

  // The POS router has two mutually exclusive trees, selected by company type.
  const posDivider = sources.pos.indexOf('if (selectedCompany?.companyType === "retail")');
  const posSecondTree = sources.pos.indexOf("  return (", posDivider + 60);
  if (posDivider < 0 || posSecondTree < 0) {
    throw new Error("POS route dispatch layout changed; update the Duo inventory extractor");
  }
  const retailPos = splitRoutes(routeMatches(sources.pos.slice(posDivider, posSecondTree), routePattern));
  const pos = splitRoutes(routeMatches(sources.pos.slice(posSecondTree), routePattern));
  // The developer/non-POS retail routes are dispatched directly in AppRoutes.
  const retailAdmin = splitRoutes([
    "/retail", "/retail/inventory", "/retail/pos", "/retail/stock-count",
    "/retail/history", "/retail/reports",
  ]);
  const retailAdminDynamic = ["/retail/products/:id"];
  retailAdmin.parameterized.push(...retailAdminDynamic);

  const groups = [
    { workspace: "erp", companyCode: "PHASE9-ERP", requiredRole: "Developer", ...erp },
    { workspace: "factory", companyCode: "PHASE9-FACTORY", requiredRole: "Developer", ...factory },
    { workspace: "properties", companyCode: "PHASE9-PROPERTIES", requiredRole: "Developer", ...properties },
    { workspace: "supplier-partner", companyCode: "PHASE9-SP", requiredRole: "Developer", ...supplier },
    { workspace: "retail-admin", companyCode: "PHASE9-RETAIL", requiredRole: "Developer", ...retailAdmin },
    { workspace: "pos", companyCode: "PHASE9-ERP", requiredRole: "POS", ...pos },
    { workspace: "retail-pos", companyCode: "PHASE9-RETAIL", requiredRole: "POS", ...retailPos },
  ].map((group) => ({ ...group, static: unique(group.static), parameterized: unique(group.parameterized) }));

  // Explicit exclusions are *only* for routes handled by a different role or
  // requiring URL parameters; both are listed in the inventory report.
  const unresolved = groups.flatMap((group) => group.parameterized.map((route) => ({
    workspace: group.workspace,
    route,
    category: "needs-seeded-route-parameters",
  })));
  const summary = groups.map((group) => ({
    workspace: group.workspace,
    companyCode: group.companyCode,
    requiredRole: group.requiredRole,
    staticRoutes: group.static.length,
    parameterizedRoutes: group.parameterized.length,
  }));
  return { sources: SOURCES, groups, summary, unresolved };
}
