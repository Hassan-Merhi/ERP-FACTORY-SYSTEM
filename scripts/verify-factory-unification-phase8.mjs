/**
 * Phase 8 source-only audit. No app startup, CI, DB, server or write endpoints.
 * Run from repository root: node scripts/verify-factory-unification-phase8.mjs
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const source = (path) => readFileSync(resolve(process.cwd(), path), "utf8");
const fixture = JSON.parse(source("docs/factory-unification/phase-1-source-fixture.json"));
const registry = source("shared/factoryAccessRegistry.ts");
const router = source("client/src/components/FactoryRoutes.tsx");
const keys = [...registry.matchAll(/^\s*key:\s*"(factory\/[^"]+)"/gm)];
const pages = keys.map((item, index) => {
  const end = keys[index + 1]?.index ?? registry.indexOf("] as const;", item.index);
  const block = registry.slice(item.index, end);
  const route = block.match(/^\s*route:\s*"([^"]+)"/m)?.[1];
  assert.ok(route, "Missing route for " + item[1]);
  return {
    key: item[1],
    route,
    accessLevel: block.match(/^\s*accessLevel:\s*"([^"]+)"/m)?.[1] ?? "user",
    sidebar: /^\s*sidebar:\s*true/m.test(block),
    pinned: /^\s*pinned:\s*true/m.test(block),
  };
});
const routes = [...router.matchAll(/<Route\b[^>]*?\bpath="([^"]+)"/g)].map((m) => m[1]);
assert.deepEqual(pages, fixture.registry, "Factory access registry drift");
assert.deepEqual(routes, fixture.routerPaths, "Factory routes changed relative to Phase 1 source baseline");
assert.equal(pages.length, 62);
assert.equal(routes.length, 151);
assert.equal(new Set(routes).size, routes.length);
for (const page of pages) assert.ok(routes.includes(page.route), page.key + " has no routed destination");
for (const path of [
  "/factory/stock-allocation",
  "/factory/stock-allocation-v3",
  "/factory/stock-allocation-v5",
  "/factory/invoicing/proformas/:id/edit",
  "/factory/sales/loading/dispatch/:orderId/:dispatchId/report",
]) assert.ok(routes.includes(path), "Missing preserved route: " + path);

const checks = [
  ["client/src/pages/factory/FactoryAttendance.tsx", [
    'companyQueryKey("/api/factory/attendance", selectedCompany?.id, selectedDate)',
  ]],
  ["client/src/pages/factory/FactoryProductionTargets.tsx", [
    'companyQueryKey("/api/factory/staff-tracking", selectedCompany?.id',
    "access?.companyId === selectedCompany?.id && access?.hasFactoryAccess === true",
    "[selectedCompany?.id, periodType, period.start, period.end]",
  ]],
  ["client/src/pages/factory/factoryworkers/useFactoryWorkersModel.tsx", [
    'companyQueryKey("/api/factory/workers/amount-due", selectedCompany?.id)',
    'companyQueryKey("/api/factory/cash-accounts", selectedCompany?.id)',
    "myAccess?.hasFactoryAccess",
  ]],
  ["client/src/pages/factory/factoryproformas/useFactoryProformasModel.ts", [
    'companyQueryKey("/api/factory/customer-price-lists", selectedCompany?.id',
    'companyQueryKey("/api/locations", selectedCompany?.id)',
    "const hideProformaPrice = !accessReady",
  ]],
  ["client/src/pages/factory/FactoryStockAllocationV5CreateProforma.tsx", [
    "toFactoryProformaAllocationArticles(",
  ]],
  ["client/src/pages/factory/FactoryStockAllocationV5EditProforma.tsx", [
    "toFactoryProformaAllocationArticles(",
  ]],
  ["client/src/pages/factory/FactoryNetPositionDetails.tsx", [
    'import { shiftDate, formatDateLabel } from "./factorynetposition/utils";',
  ]],
  ["server/services/factory/netPositionAsOf.ts", [
    "netPositionRecordedThrough(",
    'historyBasis: "known-at-cutoff"',
  ]],
  ["server/routes/factory/attendanceEditPolicy.ts", ["factoryLocalDate"]],
];
let assertions = pages.length + routes.length;
for (const [path, fragments] of checks) {
  const file = source(path);
  for (const fragment of fragments) {
    assert.ok(file.includes(fragment), path + " missing " + fragment);
    assertions++;
  }
}
const phaseTests = [
  "tests/factory-unification-phase1-baseline.test.ts",
  "tests/factory-unification-phase2.test.ts",
  "tests/factory-unification-phase2-continuation.test.ts",
  "tests/factory-unification-phase3.test.ts",
  "tests/factory-unification-phase4-navigation.test.ts",
  "tests/factory-unification-phase5.test.ts",
  "tests/factory-unification-phase6.test.ts",
  "tests/factory-unification-phase7.test.ts",
];
for (const path of phaseTests) {
  assert.ok(source(path).includes("describe("), path + " lacks test suite");
  assertions++;
}
console.log(JSON.stringify({
  result: "SOURCE_ONLY_PASS",
  branchBaseline: fixture.branch,
  registryPages: pages.length,
  declaredRoutes: routes.length,
  preservedSourceAssertions: assertions,
  authoredTestSuites: phaseTests.length,
  runtimeTestsExecuted: false,
  note: "No CI, tests, server, database, browser or financial parity checks were run by this script.",
}, null, 2));
