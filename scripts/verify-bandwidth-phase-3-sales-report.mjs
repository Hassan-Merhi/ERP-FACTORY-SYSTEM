#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();

async function read(relativePath) {
  return fs.readFile(path.join(ROOT, relativePath), "utf8");
}

const [
  routes,
  statsIndex,
  client,
  bandwidthPlugin,
  invalidationPlugin,
  viteConfig,
  salesReport,
  salesDetail,
  salesComparison,
  queryClient,
] = await Promise.all([
  read("server/routes/stats/salesReportBandwidthRoutes.ts"),
  read("server/routes/stats/index.ts"),
  read("client/src/lib/salesReportBandwidthClient.ts"),
  read("build/viteSalesReportBandwidthPlugin.ts"),
  read("build/viteSalesReportInvalidationPlugin.ts"),
  read("vite.config.ts"),
  read("client/src/pages/SalesReportLegacy.tsx"),
  read("client/src/pages/salesreportdetail/useSalesReportDetailModel.ts"),
  read("client/src/pages/SalesReportComparison.tsx"),
  read("client/src/lib/queryClient.ts"),
]);

assert.match(routes, /\/api\/sales-report\/summary/, "current-company compact summary route is required");
assert.match(
  routes,
  /\/api\/dashboard\/sales-report-all\/summary/,
  "all-company compact summary route is required"
);
assert.match(
  routes,
  /\/api\/dashboard\/sales-report-comparison/,
  "compact company-comparison route is required"
);
assert.match(routes, /GROUP BY \$\{dateKey\}/, "main report aggregation must happen in SQL");
assert.match(
  routes,
  /COALESCE\(SUM\(COALESCE\(sales\.total_sales/,
  "summary totals must be calculated server-side with null-safe aggregation"
);
assert.match(routes, /getAccessibleCompanyIds/, "all-company routes must retain company access scoping");
assert.match(routes, /stockGroupNames/, "all-company stock groups must filter by cross-company names");

assert.ok(
  statsIndex.indexOf("registerSalesReportBandwidthRoutes(app)") < statsIndex.indexOf("registerStatsDataRoutes(app)"),
  "compact Sales Report routes must register before legacy raw routes"
);

assert.match(client, /fetchSalesReportSummary/, "compact summary client is required");
assert.match(client, /fetchSalesReportRows/, "explicit raw-row fetch helper is required for export");

assert.match(
  bandwidthPlugin,
  /\/api\/sales-report\/summary/,
  "main Sales Report transform must target the compact summary endpoint"
);
assert.match(
  bandwidthPlugin,
  /\/api\/dashboard\/sales-report-all\/summary/,
  "multi-company Sales Report transform must use the compact summary endpoint"
);
assert.match(
  bandwidthPlugin,
  /fetchSalesReportRows\(isMultiCompanyMode \? multiCompanyRawUrl : singleCompanyRawUrl\)/,
  "raw sales rows must be fetched only by the explicit export path"
);
assert.match(bandwidthPlugin, /debouncedSearchTerm/, "search must be debounced before server requests");
assert.match(
  bandwidthPlugin,
  /SALES_DETAIL_SUFFIX = "\/client\/src\/pages\/salesreportdetail\/useSalesReportDetailModel\.ts"/,
  "detail transform must follow the current refactored detail model"
);
assert.match(
  bandwidthPlugin,
  /\/api\/dashboard\/sales-report-comparison\?\\\$\{queryString\}/,
  "comparison filters must be encoded into the compact comparison URL"
);
assert.match(bandwidthPlugin, /stockGroupName/, "all-company drill-down must preserve stock-group scope by name");
assert.match(
  bandwidthPlugin,
  /isError: isErrorSingle/,
  "compact main report must preserve current error and retry state"
);

assert.match(
  invalidationPlugin,
  /transformSalesReportBandwidthSource/,
  "the always-on Sales Report hardening plugin must activate the compact transform"
);
assert.match(
  invalidationPlugin,
  /normalizedId\.endsWith\(SALES_REPORT_SUFFIX\)/,
  "main Sales Report must be compact without an environment flag"
);
assert.match(
  invalidationPlugin,
  /key\.startsWith\("\/api\/sales-report"\)/,
  "Sales Report writes must invalidate current-company raw and compact keys"
);
assert.match(
  invalidationPlugin,
  /key\.startsWith\("\/api\/dashboard\/sales-report"\)/,
  "Sales Report writes must invalidate all-company summary/comparison keys"
);
assert.match(invalidationPlugin, /expectedCount/, "legacy mutation transforms must fail loudly on source drift");

assert.match(
  viteConfig,
  /salesReportInvalidationPlugin\(\)/,
  "Vite must install the always-on Sales Report hardening plugin"
);

assert.match(
  salesReport,
  /const singleCompanyQueryKey = queryString \? `\/api\/sales-report\?\$\{queryString\}` : "\/api\/sales-report";/,
  "current Sales Report source marker must remain available for the fail-loud transform"
);
assert.match(
  salesReport,
  /const handleExportExcel = \(\) => exportSalesReportExcel\(salesData\);/,
  "current export source marker must remain available for on-demand raw-row transformation"
);
assert.match(
  salesDetail,
  /const stockGroupId = params\.get\("stockGroupId"\)/,
  "refactored Sales Report detail source marker must remain available"
);
assert.match(
  salesComparison,
  /queryKey: \["\/api\/dashboard\/sales-report-all", queryString\]/,
  "comparison source marker must remain available for compact transform"
);
assert.match(
  queryClient,
  /const url = queryKey\[0\] as string/,
  "verification assumes the global query function fetches the first key element"
);

console.log(
  JSON.stringify(
    {
      ok: true,
      phase: 3,
      area: "sales-report-bandwidth",
      checks: [
        "server-side current-company summary aggregation",
        "server-side all-company summary aggregation",
        "server-side product/company comparison aggregation",
        "company access boundaries",
        "production-default compact main-list activation",
        "server-side filter adoption and search debounce",
        "raw rows isolated to drill-down/export",
        "comparison query URL filter correctness",
        "refactored all-company stock-group drill-down scope",
        "error/retry state preservation",
        "mutation cache invalidation",
        "fail-loud current-source transform markers",
      ],
    },
    null,
    2
  )
);