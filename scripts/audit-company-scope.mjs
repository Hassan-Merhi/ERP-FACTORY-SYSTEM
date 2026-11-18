#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { moduleFamilyRoot } from "./lib/readModuleFamily.mjs";

const root = process.cwd();
const serverRoot = path.join(root, "server");
const reviewConfigPath = path.join(root, "config", "company-scope-review.json");
const failOnFindings = process.argv.includes("--fail-on-findings");
const json = process.argv.includes("--json");
const reviewConfig = JSON.parse(fs.readFileSync(reviewConfigPath, "utf8"));
const reviewedFiles = new Map(reviewConfig.reviews.map((review) => [review.path, review]));
// A module split under the source-size policy keeps its review: findings in an
// extracted sibling are reviewed when the original (family root) module is.
const familyRootOf = (file) => relative(moduleFamilyRoot(path.join(root, file)));
const isReviewed = (finding) => reviewedFiles.has(finding.file) || reviewedFiles.has(familyRootOf(finding.file));

const HIGH_RISK_TABLES = [
  "vouchers",
  "customers",
  "ledger_accounts",
  "bank_accounts",
  "fixed_assets",
  "stock_groups",
  "stock_items",
  "inventory",
  "containers",
  "offloads",
  "factory_workers",
  "payroll_runs",
  "pos_sales",
  "stock_transfers",
];

const COMPANY_AUTH_MARKERS = [
  "resolveRequestCompanyId",
  "assertRequestCompanyMatchesSession",
  "resolveAuthorizedCompanyId",
  "getActiveCompanyPermissionContext",
  "enforceCompanyResourceScope",
  "establishCompanyScope",
  "resolveActiveCompanyId",
  "resolveCompanyIdForPath",
  "resolveSessionCompanyActor",
  "authorizeCompanyIdParam",
  "getFactoryCompanyId",
  "getActiveSupplierCompanyId",
  "getActiveCustomerCompanyId",
  "enforceSupplierCompanyQuery",
  "req.session.currentCompanyId",
  "req.session.factoryCompanyId",
];

function walk(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walk(absolute));
    else if (entry.isFile() && /\.(ts|tsx|mjs)$/.test(entry.name)) result.push(absolute);
  }
  return result;
}

function relative(file) {
  return path.relative(root, file).replaceAll(path.sep, "/");
}

function lineFor(source, index) {
  return source.slice(0, index).split("\n").length;
}

function hasCompanyAuthorizationMarker(source) {
  return COMPANY_AUTH_MARKERS.some((marker) => source.includes(marker));
}

function isExecutableDataSql(template) {
  // Backtick strings are also used for prompts, error messages, migration DDL,
  // and schema comments. Only inspect templates that begin with a data
  // statement; this keeps the audit focused on query paths that can expose or
  // mutate tenant data.
  const normalized = template
    .replace(/^\s*(?:\/\*[\s\S]*?\*\/\s*)+/, "")
    .replace(/^\s*(?:--[^\n]*\n\s*)+/, "")
    .trim();
  return /^(?:select|insert|update|delete|with)\b/i.test(normalized);
}

const findings = [];
for (const file of walk(serverRoot)) {
  const source = fs.readFileSync(file, "utf8");
  const rel = relative(file);

  // Request-supplied company identity is only a requested target. Any route that
  // reads it must also contain a canonical authorization marker.
  const requestCompany = /req\.(?:body|query)(?:\?\.)?\.companyId|req\.(?:body|query)\?\[?["']companyId["']\]?/g;
  for (const match of source.matchAll(requestCompany)) {
    if (!hasCompanyAuthorizationMarker(source)) {
      findings.push({
        kind: "request-company-without-canonical-marker",
        file: rel,
        line: lineFor(source, match.index ?? 0),
        detail: match[0],
      });
      break;
    }
  }

  // Direct SQL is the most dangerous escape hatch because it bypasses typed
  // storage helpers. Inspect individual SQL template bodies that touch a high-
  // risk tenant table and require either a company_id predicate or a join to a
  // parent table that carries company_id.
  const sqlTemplates = /`([\s\S]*?)`/g;
  for (const template of source.matchAll(sqlTemplates)) {
    if (!isExecutableDataSql(template[1])) continue;
    const sql = template[1].toLowerCase();
    const touched = HIGH_RISK_TABLES.filter((table) => new RegExp(`\\b${table}\\b`, "i").test(sql));
    if (touched.length === 0) continue;
    if (!/company_id|current_company_id|app\.current_company_id/.test(sql)) {
      findings.push({
        kind: "direct-sql-high-risk-without-company-marker",
        file: rel,
        line: lineFor(source, template.index ?? 0),
        detail: touched.join(","),
      });
    }
  }

  // Drizzle queries can still become unscoped. This is intentionally a review
  // audit rather than a parser-level proof: files touching high-risk tables but
  // containing neither a companyId column reference nor a canonical resource
  // ownership guard are surfaced for manual inspection.
  for (const table of HIGH_RISK_TABLES) {
    const drizzleFrom = new RegExp(`\\.from\\(\\s*${table}\\s*\\)`, "m");
    if (!drizzleFrom.test(source)) continue;
    const hasCompanyColumn = new RegExp(`${table}\\.companyId|companyId`, "m").test(source);
    const guarded = hasCompanyAuthorizationMarker(source) || source.includes("authorizeCompanyScopedResourceTx");
    if (!hasCompanyColumn && !guarded) {
      findings.push({
        kind: "drizzle-high-risk-without-company-marker",
        file: rel,
        line: 1,
        detail: table,
      });
    }
  }
}

findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.kind.localeCompare(b.kind));
const reviewedFindings = findings.filter(isReviewed);
const unreviewedFindings = findings.filter((finding) => !isReviewed(finding));
const staleReviews = reviewConfig.reviews.filter(
  (review) => !fs.existsSync(path.join(root, review.path)) || !review.reason?.trim()
);

const report = {
  generatedAt: new Date().toISOString(),
  scannedRoot: "server",
  highRiskTables: HIGH_RISK_TABLES,
  findingCount: unreviewedFindings.length,
  findings: unreviewedFindings,
  reviewedFindingCount: reviewedFindings.length,
  reviewedFiles: [...new Set(reviewedFindings.map((finding) => finding.file))].sort(),
  staleReviews,
};

if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else if (unreviewedFindings.length === 0 && staleReviews.length === 0) {
  console.log(`Company-scope audit: no unreviewed findings (${reviewedFindings.length} reviewed finding(s)).`);
} else {
  console.log(`Company-scope audit: ${unreviewedFindings.length} unreviewed finding(s), ${reviewedFindings.length} reviewed finding(s).`);
  for (const finding of unreviewedFindings) {
    console.log(` - ${finding.file}:${finding.line} [${finding.kind}] ${finding.detail}`);
  }
  for (const review of staleReviews) console.log(` - stale or invalid review registry entry: ${review.path}`);
}

if (failOnFindings && (unreviewedFindings.length > 0 || staleReviews.length > 0)) process.exit(1);
