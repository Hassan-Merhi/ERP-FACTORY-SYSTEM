import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const resolve = (file) => path.join(root, file);
const read = (file) => fs.readFileSync(resolve(file), "utf8");
const lines = (file) => read(file).split(/\r?\n/).length;
const failures = [];

const facadePath = "server/routes/debugRoutes.ts";
const facade = read(facadePath);
const expectedRegistrars = [
  "registerInventoryDebugRoutes(app);",
  "registerImportCycleDiagnosticRoutes(app);",
  "registerOrphanedChargeVoucherRoutes(app);",
  "registerOffloadRoutes(app);",
  "registerFactoryOrderRepairRoutes(app);",
];

if (lines(facadePath) > 20) failures.push(`${facadePath} must remain at or below 20 lines`);
for (const forbidden of ["app.get(", "app.post(", "drizzle-orm", "@shared/schema", "../db"]) {
  if (facade.includes(forbidden)) failures.push(`${facadePath} contains forbidden implementation marker: ${forbidden}`);
}
for (const registrar of expectedRegistrars) {
  if (!facade.includes(registrar)) failures.push(`${facadePath} is missing ${registrar}`);
}
const registrationOffsets = expectedRegistrars.map((registrar) => facade.indexOf(registrar));
if (registrationOffsets.some((offset) => offset < 0) || registrationOffsets.some((offset, index) => index > 0 && offset <= registrationOffsets[index - 1])) {
  failures.push("debug route registration order changed");
}

const routeContracts = [
  {
    file: "server/routes/debug/inventoryDebugRoutes.ts",
    path: "/api/debug/inventory/:stockItemId",
    role: 'requireRole("Admin", "Developer", "Owner")',
    maxLines: 180,
  },
  {
    file: "server/routes/debug/importCycleDiagnosticRoutes.ts",
    path: "/api/debug/import-cycle",
    role: 'requireRole("Admin")',
    maxLines: 60,
  },
  {
    file: "server/routes/debug/orphanedChargeVoucherRoutes.ts",
    path: "/api/debug/orphaned-charge-vouchers",
    role: 'requireRole("Admin", "Owner", "Manager")',
    maxLines: 240,
  },
  {
    file: "server/routes/debug/orphanedChargeVoucherRoutes.ts",
    path: "/api/admin/fix-orphaned-charge-vouchers",
    role: 'requireRole("Admin")',
    maxLines: 240,
  },
  {
    file: "server/routes/debug/factoryOrderRepairRoutes.ts",
    path: "/api/admin/recalculate-factory-order-totals",
    role: 'requireRole("Admin", "Developer")',
    maxLines: 80,
  },
];

for (const contract of routeContracts) {
  const source = read(contract.file);
  if (!source.includes(contract.path)) failures.push(`${contract.file} is missing ${contract.path}`);
  if (!source.includes(contract.role)) failures.push(`${contract.file} changed the role contract for ${contract.path}`);
  if (lines(contract.file) > contract.maxLines) failures.push(`${contract.file} exceeds ${contract.maxLines} lines`);
}

const foundationPath = "server/routes/debug/importCycleDiagnosticFoundation.ts";
const analysisPath = "server/routes/debug/importCycleDiagnosticAnalysis.ts";
const foundation = read(foundationPath);
const analysis = read(analysisPath);
if (lines(foundationPath) > 650) failures.push(`${foundationPath} exceeds 650 lines`);
if (lines(analysisPath) > 700) failures.push(`${analysisPath} exceeds 700 lines`);
for (const marker of [
  "negative_inventory",
  "orphaned_inventory",
  "unbalanced_voucher",
  "stale_otw_container",
  "duplicate_inventory",
  "netImportCycleBalance",
]) {
  if (!foundation.includes(marker)) failures.push(`${foundationPath} is missing diagnostic marker ${marker}`);
}
for (const marker of [
  "uncategorized-accounts",
  "component-variance",
  "container-discrepancy",
  "reconciliation",
  "containerAudit",
]) {
  if (!analysis.includes(marker)) failures.push(`${analysisPath} is missing analysis marker ${marker}`);
}

const debugDirectory = "server/routes/debug";
for (const file of fs.readdirSync(resolve(debugDirectory)).filter((name) => name.endsWith(".ts"))) {
  const relative = path.join(debugDirectory, file);
  if (lines(relative) > 900) failures.push(`${relative} exceeds the repository soft god-file boundary`);
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("Phase 7 debug route extraction verified: five route groups, bounded import-cycle modules, and stable registration order.");
