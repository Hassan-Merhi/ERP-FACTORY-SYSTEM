#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { readModuleFamily } from "./lib/readModuleFamily.mjs";

const root = process.cwd();
const read = (file) => readModuleFamily(path.join(root, file));
const failures = [];

const applicationRoutes = read("server/routes/applicationRoutes.ts");
const phase4Routes = read("server/routes/renderPhase4LazyRoutes.ts");

function assert(condition, message) {
  if (!condition) failures.push(message);
}

function collectTsFiles(relativePath) {
  const absolute = path.join(root, relativePath);
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return [absolute];

  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && child.endsWith(".ts")) files.push(child);
    }
  };
  visit(absolute);
  return files;
}

function collectDeclaredRoutes(relativePath) {
  const routes = [];
  const routePattern = /\bapp\.(?:get|post|put|patch|delete|use)\(\s*["'`]([^"'`]+)["'`]/g;
  for (const file of collectTsFiles(relativePath)) {
    const source = readModuleFamily(file);
    for (const match of source.matchAll(routePattern)) {
      routes.push({ file: path.relative(root, file), route: match[1] });
    }
  }
  return routes;
}

function assertCoveredRoutes(source, prefix, label) {
  const routes = collectDeclaredRoutes(source);
  assert(routes.length > 0, `${label} must declare at least one route`);
  for (const { file, route } of routes) {
    assert(
      route === prefix || route.startsWith(`${prefix}/`),
      `${label} route ${route} in ${file} is outside lazy prefix ${prefix}`
    );
  }
}

function assertRegistrationOrder(before, target, after, label) {
  const beforeIndex = applicationRoutes.indexOf(before);
  const targetIndex = applicationRoutes.indexOf(target);
  const afterIndex = applicationRoutes.indexOf(after);
  assert(beforeIndex !== -1, `${label} predecessor registration is missing`);
  assert(targetIndex !== -1, `${label} lazy registration is missing`);
  assert(afterIndex !== -1, `${label} successor registration is missing`);
  assert(beforeIndex < targetIndex && targetIndex < afterIndex, `${label} registration position changed`);
}

assert(
  applicationRoutes.includes('import { phase4LazyRoutes } from "./renderPhase4LazyRoutes";'),
  "applicationRoutes.ts must use the Phase 4 lazy-route boundary"
);

for (const [staticImport, label] of [
  ['from "./supplier-profit-check"', "supplier profit check"],
  ['from "./git"', "GIT"],
  ['from "./containerTrackingRoutes"', "container tracking"],
]) {
  assert(!applicationRoutes.includes(staticImport), `${label} must not be a static applicationRoutes import`);
}

for (const [specifier, prefix, label] of [
  ["./supplier-profit-check", "/api/supplier-profit-check", "supplier profit check"],
  ["./git", "/api/git", "GIT"],
  ["./containerTrackingRoutes", "/api/container-tracking", "container tracking"],
]) {
  assert(phase4Routes.includes(`import("${specifier}")`), `${label} must be dynamically imported`);
  assert(phase4Routes.includes(`prefixes: ["${prefix}"]`), `${label} must keep lazy prefix ${prefix}`);
}

assert(
  phase4Routes.includes("registerSupplierProfitCheckRoutes(lazyApp, requireAuth)"),
  "supplier profit check must preserve its requireAuth registrar argument"
);

assertRegistrationOrder(
  "registerSupplierProformaRoutes(app, requireAuth);",
  "await phase4LazyRoutes.supplierProfitCheck(app, requireAuth);",
  "registerGlobalTransactionRoutes(app, requireAuth);",
  "supplier profit check"
);
assertRegistrationOrder(
  'prefixes: ["/api/export"]',
  "await phase4LazyRoutes.git(app);",
  "await phase4LazyRoutes.containerTracking(app);",
  "GIT"
);
assertRegistrationOrder(
  "await phase4LazyRoutes.git(app);",
  "await phase4LazyRoutes.containerTracking(app);",
  "registerUserNotesRoutes(app);",
  "container tracking"
);

assertCoveredRoutes("server/routes/supplier-profit-check", "/api/supplier-profit-check", "supplier profit check");
assertCoveredRoutes("server/routes/git", "/api/git", "GIT");
assertCoveredRoutes("server/routes/containerTrackingRoutes.ts", "/api/container-tracking", "container tracking");

const gitImportRoutes = read("server/routes/git/gitImportRoutes.ts");
const supplierExportRoutes = read("server/routes/supplier-profit-check/export.ts");
const containerTrackingRoutes = read("server/routes/containerTrackingRoutes.ts");
assert(
  gitImportRoutes.includes('from "exceljs"') && gitImportRoutes.includes('from "xlsx-js-style"'),
  "GIT lazy graph must still contain its workbook dependencies"
);
assert(
  supplierExportRoutes.includes('from "exceljs"'),
  "supplier profit lazy graph must still contain its Excel export dependency"
);
assert(
  containerTrackingRoutes.includes('from "../services/container-tracking"'),
  "container tracking lazy graph must still contain its provider orchestration dependency"
);

const applicationLineCount = applicationRoutes.trimEnd().split("\n").length;
assert(applicationLineCount <= 220, `applicationRoutes.ts exceeds the 220-line architecture cap (${applicationLineCount})`);

if (failures.length) {
  console.error("Render Phase 4 operational-route residency verification failed:");
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}

console.log("Render Phase 4 operational-route residency boundaries verified.");
