/**
 * Permissions Control Center V2 — frontend page audit.
 *
 * Verifies the shared page catalog (shared/permissionPageCatalog.ts) against
 * the source tree and prints the page-by-page gating report:
 *   - every catalogued path is a registered client route;
 *   - every page marked "component" names files that exist and read the
 *     shared role helpers;
 *   - every "change" page is unavailable to View Only and Create Only, and
 *     every "create" page is unavailable to Create Only unless it submits to a
 *     handler-verified create.
 *
 * Usage:
 *   npx tsx scripts/permissions/audit-frontend-page-catalog.ts          # check
 *   npx tsx scripts/permissions/audit-frontend-page-catalog.ts --write  # also regenerate the report
 *
 * Read-only apart from --write; touches no database or permission data.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PERMISSION_PAGE_CATALOG,
  decideReadOnlyRoleRoute,
  permissionPageCatalogSummary,
  type PermissionPageEntry,
} from "../../shared/permissionPageCatalog";

const root = process.cwd();
const ROUTE_SOURCES = [
  "client/src/routes/ErpRoutes.tsx",
  "client/src/routes/AppRoutes.tsx",
  "client/src/routes/PosRoutes.tsx",
  "client/src/components/FactoryRoutes.tsx",
  "client/src/app/PropertiesRoutes.tsx",
  "client/src/app/authenticatedAppRouteGuard.ts",
];
// "/retail/products/:id" is dispatched with startsWith("/retail/products/").
const PREFIX_ROUTES: Record<string, string> = { "/retail/products/:id": '"/retail/products/"' };
const GATING_EVIDENCE =
  /useExistingRecordChangeAccess|isExistingRecordReadOnlyRole|isCreateOnlyRole|\buseCan\(|<Can\b|canScan|changeDisabledReason/;
const REPORT_PATH = "docs/permissions-v2-frontend-page-audit.md";

const CATALOG_PATH = "config/permissions-v2-page-catalog.json";
const catalogRows = (
  JSON.parse(readFileSync(resolve(root, CATALOG_PATH), "utf8")) as {
    pages: Array<{ id: string; label?: string; note?: string }>;
  }
).pages;
const notes = { pages: Object.fromEntries(catalogRows.map((row) => [row.id, { label: row.label, note: row.note }])) };
const routeSource = ROUTE_SOURCES.map((file) => readFileSync(resolve(root, file), "utf8")).join("\n");
const failures: string[] = [];

function concrete(pattern: string): string {
  return pattern.replace(/:[A-Za-z]+/g, "101");
}

function routeOutcome(role: string, entry: PermissionPageEntry): string {
  const outcomes = new Set(
    entry.paths.map((pattern) => {
      const decision = decideReadOnlyRoleRoute(role, concrete(pattern));
      if (decision.kind === "allow") return "opens";
      if (decision.kind === "redirect") return "read view";
      return decision.reason === "unverified_create" ? "explained (create not verified)" : "explained";
    })
  );
  return [...outcomes].join(" / ");
}

for (const entry of PERMISSION_PAGE_CATALOG) {
  if (!notes.pages[entry.id]?.label) failures.push(`${entry.id}: missing label in ${CATALOG_PATH}`);
  for (const pattern of entry.paths) {
    const needle = PREFIX_ROUTES[pattern] ?? `"${pattern}"`;
    if (!routeSource.includes(needle)) failures.push(`${entry.id}: route ${pattern} is not registered`);
  }
  if (entry.inPage === "component") {
    if (!entry.files?.length) failures.push(`${entry.id}: component gating needs files`);
    for (const file of entry.files ?? []) {
      const path = resolve(root, file);
      if (!existsSync(path)) {
        failures.push(`${entry.id}: ${file} does not exist`);
        continue;
      }
      if (!GATING_EVIDENCE.test(readFileSync(path, "utf8"))) {
        failures.push(`${entry.id}: ${file} has no shared role gating`);
      }
    }
  }
  for (const pattern of entry.paths) {
    const path = concrete(pattern);
    const createOnly = decideReadOnlyRoleRoute("Create Only", path);
    const viewOnly = decideReadOnlyRoleRoute("View Only", path);
    const owner = decideReadOnlyRoleRoute("Owner", path);
    if (owner.kind !== "allow") failures.push(`${entry.id}: Owner must never be affected (${pattern})`);
    if (entry.mode === "change") {
      if (createOnly.kind === "allow" || viewOnly.kind === "allow") {
        failures.push(`${entry.id}: change page ${pattern} is open to a read-only role`);
      }
    }
    if (entry.mode === "create") {
      if (viewOnly.kind !== "allow") failures.push(`${entry.id}: View Only legacy create page ${pattern} changed`);
      const expectOpen = entry.createOnlyCreate !== undefined;
      if ((createOnly.kind === "allow") !== expectOpen) {
        failures.push(`${entry.id}: Create Only outcome for ${pattern} does not match the verified catalog`);
      }
    }
    if (entry.mode === "browse" && (createOnly.kind !== "allow" || viewOnly.kind !== "allow")) {
      failures.push(`${entry.id}: browse page ${pattern} must stay open`);
    }
  }
}

const summary = permissionPageCatalogSummary();
const AREA_LABEL: Record<string, string> = {
  erp: "ERP",
  factory: "Factory",
  pos_retail: "POS and Retail",
  properties: "Properties",
  supplier_partner: "Supplier Partner",
};
const GATING_LABEL: Record<string, string> = {
  component: "Gated in page",
  route: "Gated at route",
  role_restricted: "Admin/Owner/Developer only",
  server_enforced: "Server and request guard only (UI work remaining)",
};

const lines: string[] = [];
lines.push("# Permissions V2 — frontend page audit");
lines.push("");
lines.push(
  "Generated by `npx tsx scripts/permissions/audit-frontend-page-catalog.ts --write` from `config/permissions-v2-page-catalog.json`. Do not edit by hand."
);
lines.push("");
lines.push(
  "Read-only roles are View Only and Create Only. The server refuses every write these roles are not allowed, whatever this table says; the table records what the browser shows."
);
lines.push("");
lines.push("| Measure | Count |");
lines.push("|---|---|");
lines.push(`| Pages catalogued | ${summary.pages} |`);
lines.push(`| Routes catalogued | ${summary.routes} |`);
for (const [key, label] of Object.entries(GATING_LABEL)) {
  lines.push(`| ${label} | ${summary.byInPage[key as keyof typeof summary.byInPage]} |`);
}
lines.push(`| Audit failures | ${failures.length} |`);
lines.push("");
for (const area of Object.keys(AREA_LABEL)) {
  const entries = PERMISSION_PAGE_CATALOG.filter((entry) => entry.area === area);
  if (entries.length === 0) continue;
  lines.push(`## ${AREA_LABEL[area]}`);
  lines.push("");
  lines.push("| Page | Routes | Controlled actions | View Only | Create Only | In-page gating |");
  lines.push("|---|---|---|---|---|---|");
  for (const entry of entries) {
    const { label = entry.id, note } = notes.pages[entry.id] ?? {};
    lines.push(
      `| ${label} | ${entry.paths.map((p) => `\`${p}\``).join("<br>")} | ${entry.actions.join(", ")} | ${routeOutcome("View Only", entry)} | ${routeOutcome("Create Only", entry)}${entry.createOnlyCreate ? ` (verified create: ${entry.createOnlyCreate})` : ""} | ${GATING_LABEL[entry.inPage]}${note ? `. ${note}` : ""} |`
    );
  }
  lines.push("");
}
const report = `${lines.join("\n")}\n`;

if (process.argv.includes("--write")) {
  writeFileSync(resolve(root, REPORT_PATH), report);
  console.log(`wrote ${REPORT_PATH}`);
}
console.log(JSON.stringify({ ...summary, failures }, null, 2));
if (failures.length > 0) process.exit(1);
