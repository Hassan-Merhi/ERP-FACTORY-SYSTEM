#!/usr/bin/env node

import fs from "node:fs";

const read = (file) => fs.readFileSync(file, "utf8");
const browser = read("scripts/verify-mobile-responsive-wave4-browser.mjs");
const workflow = read(".github/workflows/mobile-responsive.yml");
const phase11 = read("scripts/verify-mobile-responsive-phase11-regression.mjs");
const erpRoutes = read("client/src/routes/ErpRoutes.tsx");
const factoryRoutes = read("client/src/components/FactoryRoutes.tsx");

const failures = [];
const requireText = (source, value, label) => {
  if (!source.includes(value)) failures.push(`${label}: missing ${value}`);
};
const forbidText = (source, value, label) => {
  if (source.includes(value)) failures.push(`${label}: must not include ${value}`);
};

const requiredViewports = [
  'name: "phone-320", width: 320, height: 568',
  'name: "phone-360", width: 360, height: 800',
  'name: "phone-390", width: 390, height: 844',
  'name: "phone-landscape", width: 844, height: 390',
  'name: "tablet-768", width: 768, height: 1024',
  'name: "desktop-1440", width: 1440, height: 900',
];
for (const viewport of requiredViewports) requireText(browser, viewport, "Wave 4 browser viewport matrix");

const criticalErpRoutes = [
  "/tracking",
  "/accounts",
  "/daybook",
  "/vouchers",
  "/opening-stock",
  "/closing-stock-summary",
  "/import-stock-items",
  "/pos",
];

const criticalFactoryRoutes = [
  "/factory/raw-stock",
  "/factory/location-inventory",
  "/factory/containers-hub",
  "/factory/accounts",
  "/factory/parties",
  "/factory/vouchers",
  "/factory/payroll-hub",
  "/factory/sales/loading/new",
  "/factory/stock-allocation-v5",
  "/factory/bale-tracking",
  "/factory/import",
  "/factory/bale-relabeling",
  "/factory/bale-product-images",
];

for (const route of criticalErpRoutes) {
  requireText(browser, `path: "${route}"`, "Wave 4 ERP rendered route set");
  requireText(erpRoutes, route.split("?")[0], "Live ERP route table");
}
for (const route of criticalFactoryRoutes) {
  requireText(browser, `path: "${route}"`, "Wave 4 Factory rendered route set");
  requireText(factoryRoutes, route.split("?")[0], "Live Factory route table");
}

// Wave 3 is still an independent PR and owns these operational surfaces. Wave 4
// must not duplicate or gate those files before Wave 3 lands; its own dedicated
// rendered verifier covers them.
const wave3OwnedRoutes = [
  "/parties",
  "/containers",
  "/inventory?tab=by-location",
  "/stock?tab=items",
  "/transaction-journal",
  "/sales-tools?tab=transfers",
];
for (const route of wave3OwnedRoutes) {
  forbidText(browser, `path: "${route}"`, "Wave 4 / Wave 3 independence contract");
}

for (const contract of [
  "isPhoneClassViewport",
  "horizontalOverflow",
  "hoverOnlyInteractive",
  "HOVER_CRITICAL_ROUTES",
  "criticalTouchViolations",
  "dialogViewportViolations",
  "stickyFixedViewportViolations",
  "focusedTextControl",
  "scannerContract",
  "loadingSetupVisible",
  "phoneLandscapeMedia",
]) {
  requireText(browser, contract, "Wave 4 interaction contract");
}

requireText(
  workflow,
  "run_smoke scripts/verify-mobile-responsive-wave4-browser.mjs",
  "Mobile Responsiveness workflow",
);
requireText(phase11, "scripts/verify-mobile-responsive-wave4-regression.mjs", "Phase 11 responsive matrix");

const erpLiteralRouteCount = (erpRoutes.match(/(?:<Route\s+path=|G\()\s*["']\//g) || []).length;
const factoryLiteralRouteCount = (factoryRoutes.match(/<Route\s+path=["']\/factory\//g) || []).length;
if (erpLiteralRouteCount < 40) failures.push(`Live ERP route table unexpectedly shrank to ${erpLiteralRouteCount} literal routes`);
if (factoryLiteralRouteCount < 55) failures.push(`Live Factory route table unexpectedly shrank to ${factoryLiteralRouteCount} literal routes`);

if (failures.length > 0) {
  console.error(`Mobile Wave 4 regression contract failed with ${failures.length} issue(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      wave: 4,
      status: "complete",
      viewports: requiredViewports.length,
      renderedErpRoutes: criticalErpRoutes.length,
      renderedFactoryRoutes: criticalFactoryRoutes.length,
      wave3RoutesDeliberatelyExcluded: wave3OwnedRoutes.length,
      liveRouteTableCounts: { erp: erpLiteralRouteCount, factory: factoryLiteralRouteCount },
      contracts: [
        "root overflow",
        "landscape-phone classification",
        "44px critical touch targets",
        "hover-only actions on Wave 2 touch-critical routes",
        "dialogs",
        "sticky/fixed viewport bounds",
        "text-control focus/font size",
        "scanner/setup state",
        "tablet/desktop preservation",
      ],
      sqlRequired: false,
    },
    null,
    2,
  ),
);
