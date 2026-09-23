#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";

const failures = [];

function read(file) {
  if (!fs.existsSync(file)) {
    failures.push("Missing required file: " + file);
    return "";
  }
  return fs.readFileSync(file, "utf8");
}

function requireMarkers(file, markers) {
  const source = read(file);
  for (const marker of markers) {
    if (!source.includes(marker)) {
      failures.push(file + ": missing required marker: " + marker);
    }
  }
  return source;
}

const registrar = requireMarkers("server/routes/tenantBoundaryRegistrar.ts", [
  "enforcePrivilegedMaintenanceScope",
  "app.use(enforcePrivilegedMaintenanceScope)",
]);

const policy = requireMarkers("server/services/security/privilegedMaintenanceRoutePolicy.ts", [
  '"administration.repair"',
  '"POST", "PUT", "PATCH", "DELETE"',
  "PRIVILEGED_MAINTENANCE_ROLE_REQUIRED",
  "PRIVILEGED_MAINTENANCE_PERMISSION_REQUIRED",
  'input.role === "Developer" && input.developerBypass',
]);

requireMarkers("server/middleware/privilegedMaintenanceScope.ts", [
  "getActiveCompanyPermissionContext",
  "getCompanyRequestRuntimeContext",
  "loadNamedPermissions",
  "SecuritySchemaUnavailableError",
  "privilegedMutationRateLimit",
  "privileged_maintenance_denied",
]);

const rls = requireMarkers("migrations/0016_company_scope_rls_readiness.sql", [
  "ENABLE ROW LEVEL SECURITY",
  "FORCE ROW LEVEL SECURITY",
  "erp_current_company_id()",
  "erp_authorized_company_ids()",
  "erp_company_scope_matches",
  "voucher_entries_company_scope_policy",
  "voucher_entries_company_idx",
  "voucher_entries_sync_company_id",
  "vouchers_sync_entry_company_id",
  "USING (erp_company_scope_matches(company_id))",
]);

for (const table of [
  "vouchers",
  "customers",
  "ledger_accounts",
  "bank_accounts",
  "fixed_assets",
  "stock_groups",
  "stock_items",
  "inventory",
]) {
  if (!rls.includes("'" + table + "'")) {
    failures.push("RLS migration no longer protects required tenant table: " + table);
  }
}

const backup = requireMarkers(".github/workflows/backup-restore-verification.yml", [
  "Require a configured backup source",
  "rolbypassrls",
  "pg_dump",
  "Restore into isolated PostgreSQL service",
  "Restored fingerprint",
]);
if (/pg_dump[^\n]*--enable-row-security/.test(backup)) {
  failures.push("Live backup must not use pg_dump --enable-row-security.");
}
if (/ALTER TABLE[^\n]*NO FORCE ROW LEVEL SECURITY/i.test(backup)) {
  failures.push("Backup workflow must never disable FORCE ROW LEVEL SECURITY.");
}

const securityWorkflow = requireMarkers(".github/workflows/security.yml", [
  "Block unreviewed high and critical production vulnerabilities",
  "npm run verify:dependency-audit",
  "Checkout full history",
  "--results=verified",
  "Focused security readiness",
  "npm run check:security",
]);

const dependencyAudit = requireMarkers("scripts/verify-dependency-audit.mjs", [
  'new Set(["high", "critical"])',
  "reviewOn",
  "fixAvailable",
  "npm audit",
]);

const permissionsDoc = read("docs/permissions-security.md");
const architectureDoc = read("docs/architecture.md");
for (const [file, source] of [
  ["docs/permissions-security.md", permissionsDoc],
  ["docs/architecture.md", architectureDoc],
]) {
  if (/no (?:db-level )?row-level security/i.test(source) || /only by application-level filtering/i.test(source)) {
    failures.push(file + ": stale pre-RLS tenant-isolation wording remains.");
  }
}

requireMarkers("docs/security-company-isolation-wave3.md", [
  "FORCES ROW LEVEL SECURITY",
  "administration.repair",
  "BYPASSRLS",
  "TruffleHog",
  "npm run check:security",
]);

requireMarkers(".github/maintenance-bots.md", [
  "fails loudly",
  "BYPASSRLS",
]);

const packageJson = JSON.parse(read("package.json") || "{}");
if (
  packageJson.scripts?.["verify:security-wave3"] !==
  "node scripts/verify-security-wave3-closeout.mjs"
) {
  failures.push("package.json is missing the exact verify:security-wave3 script.");
}

const focusedRunner = requireMarkers("scripts/run-program-6-focused-security-checks.mjs", [
  "scripts/verify-security-wave3-closeout.mjs",
  "tests/phase33e-tenant-isolation-boundary.test.ts",
  "tests/global-maintenance-route-policy.test.ts",
  "tests/operational-permission-route-policy.test.ts",
  "tests/privileged-maintenance-route-policy.test.ts",
]);

requireMarkers("config/doc-index.json", [
  '"docs/security-company-isolation-wave3.md": "reference"',
]);

if (!registrar || !policy || !securityWorkflow || !dependencyAudit || !focusedRunner) {
  failures.push("Wave 3 closeout source set is incomplete.");
}

if (failures.length) {
  console.error("Security + Company Isolation Wave 3 closeout verification failed:");
  for (const failure of failures) console.error("- " + failure);
  process.exit(1);
}

console.log(
  "Security + Company Isolation Wave 3 closeout verified: tenant RLS, privileged maintenance, backup/BYPASSRLS, dependency and secret gates are pinned."
);
