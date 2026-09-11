import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { transformSalesReportBandwidthSource } from "../build/viteSalesReportBandwidthPlugin";

/**
 * The Sales Report page does not request the endpoints written in its source.
 * build/viteSalesReportInvalidationPlugin.ts rewrites the module at build time
 * to the compact SQL-aggregated routes, and it does that unconditionally — so a
 * compact route that exists but is never mounted is invisible to `npm run dev`
 * smoke checks and fatal in a production build: the request falls through to the
 * SPA index.html fallback, the summary fetch rejects, and the page shows
 * "Sales report unavailable".
 *
 * These tests therefore run the real transform, take the URLs the built client
 * actually fetches, and require the registry the server mounts to serve them.
 */

const repoRoot = path.resolve(__dirname, "..");
const read = (relativePath: string) => readFileSync(path.join(repoRoot, relativePath), "utf8");

const REGISTER_RE = /import\s*\{([^}]*)\}\s*from\s*"\.\/([^"]+)"/g;
const APP_ROUTE_RE = /app\s*\.\s*(?:get|post|put|patch|delete|all|use)\s*\(\s*"([^"]+)"/g;

/**
 * Files whose routes actually reach the mounted Express app: a module counts only
 * when the registry *invokes* its registration function, not merely imports it.
 */
function mountedRouteFiles(entryRelative: string, seen = new Set<string>()): string[] {
  const normalized = entryRelative.replace(/\.tsx?$/, "");
  const candidates = [`${normalized}.ts`, `${normalized}/index.ts`].map((rel) => path.join(repoRoot, rel));
  const existing = candidates.find((abs) => {
    try {
      readFileSync(abs);
      return true;
    } catch {
      return false;
    }
  });
  if (!existing) return [];
  const repoRelative = path.relative(repoRoot, existing).split(path.sep).join("/");
  if (seen.has(repoRelative)) return [];
  seen.add(repoRelative);

  const source = read(repoRelative);

  const importedFrom = new Map<string, string>();
  for (const match of source.matchAll(REGISTER_RE)) {
    for (const specifier of match[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      importedFrom.set(specifier, match[2]);
    }
  }

  const invoked = new Set<string>();
  for (const match of source.matchAll(/\b(register\w+)\s*\(\s*app\s*\)/g)) invoked.add(match[1]);

  const base = path.posix.dirname(repoRelative);
  const nested: string[] = [];
  for (const name of invoked) {
    const module = importedFrom.get(name);
    // No import to follow means the function is declared in this same file.
    if (module) nested.push(...mountedRouteFiles(path.posix.join(base, module), seen));
  }
  return [repoRelative, ...nested];
}

function registeredPaths(files: string[]): Set<string> {
  const out = new Set<string>();
  for (const file of files) {
    for (const match of read(file).matchAll(APP_ROUTE_RE)) out.add(match[1]);
  }
  return out;
}

/** Sales-report URLs the built Sales Report pages fetch (raw lines included). */
function clientRequestedSalesReportUrls(): string[] {
  const pageSources: Array<[string, string]> = [
    ["client/src/pages/SalesReportLegacy.tsx", read("client/src/pages/SalesReportLegacy.tsx")],
    [
      "client/src/pages/salesreportdetail/useSalesReportDetailModel.ts",
      read("client/src/pages/salesreportdetail/useSalesReportDetailModel.ts"),
    ],
    ["client/src/pages/SalesReportComparison.tsx", read("client/src/pages/SalesReportComparison.tsx")],
  ];

  const urls = new Set<string>();
  for (const [file, source] of pageSources) {
    const built = transformSalesReportBandwidthSource(source, path.join(repoRoot, file)) ?? source;
    for (const match of built.matchAll(/["'`](\/api\/[a-z0-9\-/]+)/gi)) {
      if (match[1].includes("sales-report")) urls.add(match[1]);
    }
  }
  return [...urls].sort();
}

describe("compact sales-report routes are mounted by the live registry", () => {
  const statsRegistryImport = read("server/routes/applicationRoutes.ts").match(
    /import\s*\{\s*registerStatsRoutes\s*\}\s*from\s*"\.\/([^"]+)"/
  )?.[1];

  it("the application mounts exactly one stats registry", () => {
    expect(statsRegistryImport, "applicationRoutes.ts must import registerStatsRoutes").toBeTruthy();
  });

  it("every sales-report URL the built client fetches is registered by that registry", () => {
    expect(statsRegistryImport).toBeTruthy();
    const mounted = mountedRouteFiles(`server/routes/${statsRegistryImport}`);
    const registered = registeredPaths(mounted);
    const requested = clientRequestedSalesReportUrls();

    // Sanity: the transform must be producing the compact routes at all, and the
    // mount graph must be resolving real files.
    expect(requested.length).toBeGreaterThan(3);
    expect(registered.size).toBeGreaterThan(10);

    const missing = requested.filter((url) => !registered.has(url));
    expect(missing, `unmounted sales-report endpoints: ${missing.join(", ")}`).toEqual([]);
  });

  it("registers the compact summary routes before the legacy raw report route", () => {
    const registry = read(`server/routes/${statsRegistryImport}.ts`);
    const compact = registry.indexOf("registerSalesReportBandwidthRoutes(app)");
    const raw = registry.indexOf("registerStatsDataRoutes(app)");
    expect(compact).toBeGreaterThan(-1);
    expect(raw).toBeGreaterThan(-1);
    expect(compact).toBeLessThan(raw);
  });

  it("keeps a single registration list for the stats folder", () => {
    // A second `registerStatsRoutes` in server/routes/stats/ is what allowed the
    // compact routes to be "registered" in a file nothing imports.
    const barrel = read("server/routes/stats/index.ts");
    expect(barrel).not.toMatch(/export function registerStatsRoutes/);
    expect(barrel).not.toMatch(/register\w+Routes?\(app\)/);
  });
});
