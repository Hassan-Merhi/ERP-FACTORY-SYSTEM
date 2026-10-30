#!/usr/bin/env node
/**
 * Phase 9: exact, manifest-derived ERP/Factory/POS write inventory.
 *
 * This does NOT claim unsupported operations can replicate. Each write is
 * classified as an approved atomic capture, a narrowly allowed session
 * action, or blocked in LAN-primary. The report is an honest release backlog.
 *
 * node scripts/edge/audit-phase9-write-coverage.mjs --json
 * node scripts/edge/audit-phase9-write-coverage.mjs --require-complete
 *
 * --require-complete intentionally fails until EVERY business write is
 * captured/posted with independently reviewed cloud and tenant proofs.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { edgeBlocksWrite } from "../../server/edge/edgeRuntimePolicy.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST = resolve(ROOT, "config/route-manifest.json");
const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SAFE_SESSION_WRITES = new Set([
  "POST /api/auth/login", "POST /api/auth/logout",
  "POST /api/auth/set-company", "POST /api/csp-report",
]);
const SUPPORTED = new Map([
  ["POST /api/vouchers/with-entries", {
    policy: "voucher.with-entries.v1",
    limitations: "USD Journal ledger-only; staged is not cloud-applied",
  }],
  ["POST /api/factory/pressing-machines/confirm", {
    policy: "pressing.confirmation.v1",
    limitations:
      "Physical scan only (no stock/voucher/bale state); existing assignments only; " +
      "voids/corrections and assignment changes stay cloud-only; conflicts block for a DBA decision",
  }],
]);

function moduleForPath(path) {
  if (/^\/api\/(?:pos|retail)(?:\/|$)/i.test(path)) return "retail-pos";
  if (/^\/api\/(?:factory|bales|containers|pressing|production)(?:\/|$)/i.test(path)) return "factory-production";
  if (/^\/api\/(?:inventory|stock|stock-items|stock-transfers|warehouse)(?:\/|$)/i.test(path)) return "inventory-stock";
  if (/^\/api\/(?:supplier|suppliers|purchas|purchase|orders)(?:\/|$)/i.test(path)) return "purchasing";
  if (/\/(?:payments?|bank|payroll|salary|wages|advances?)(?:\/|$)/i.test(path)) return "payments-finance";
  if (/\/(?:upload|download|attachment|document|file|photo|image|pdf|import|export)(?:s?\/|$)/i.test(path)) return "attachments-documents";
  if (/^\/api\/(?:voucher|vouchers|ledger|accounts|accounting)(?:\/|$)/i.test(path)) return "accounting";
  return "other-erp-admin";
}

export function auditPhase9WriteCoverage(manifest, guard = edgeBlocksWrite) {
  if (!manifest || !Array.isArray(manifest.routes)) throw new Error("PHASE9_MANIFEST_MISSING");
  const config = { mode: "lan", writeMode: "lan-primary", primary: true };
  const seen = new Set();
  const routes = [];
  for (const route of manifest.routes) {
    if (typeof route !== "string") throw new Error("PHASE9_MANIFEST_ROUTE_INVALID");
    const match = /^(POST|PUT|PATCH|DELETE) (\/api\/[^ ]+)(?: |$)/.exec(route);
    if (!match) {
      // Read-only and non-API routes are excluded. Unknown write verbs cannot
      // be silently assigned an approved capture policy.
      if (/^(POST|PUT|PATCH|DELETE) \/api(?: |$)/.test(route)) throw new Error("PHASE9_MANIFEST_ROUTE_INVALID");
      continue;
    }
    const [, method, path] = match;
    if (!WRITES.has(method)) throw new Error("PHASE9_MANIFEST_METHOD_INVALID");
    const key = method + " " + path;
    if (seen.has(key)) continue;
    seen.add(key);
    const supported = SUPPORTED.get(key);
    const sessionExempt = SAFE_SESSION_WRITES.has(key);
    const blockedByGuard = guard(config, method, path);
    // The guard must match the reviewed capture map EXACTLY; otherwise a
    // new route could commit locally without a durable cloud apply protocol.
    if (blockedByGuard === Boolean(supported || sessionExempt)) {
      throw new Error("PHASE9_WRITE_GUARD_DRIFT: " + key);
    }
    routes.push({
      method,
      path,
      module: moduleForPath(path),
      disposition: supported ? "approved-capture" : sessionExempt ? "session-only" : "blocked",
      ...(supported ? { policy: supported.policy, limitations: supported.limitations } : {}),
    });
  }
  for (const key of SUPPORTED.keys()) {
    if (!seen.has(key)) throw new Error("PHASE9_APPROVED_ROUTE_MISSING: " + key);
  }
  const byModule = Object.fromEntries(
    [...new Set(routes.map((route) => route.module))].sort().map((module) => [
      module, {
        total: routes.filter((route) => route.module === module).length,
        blocked: routes.filter((route) => route.module === module && route.disposition === "blocked").length,
      },
    ])
  );
  const summary = {
    manifestRoutes: manifest.routes.length,
    uniqueApiWriteRoutes: routes.length,
    approvedCapture: routes.filter((r) => r.disposition === "approved-capture").length,
    sessionOnly: routes.filter((r) => r.disposition === "session-only").length,
    blocked: routes.filter((r) => r.disposition === "blocked").length,
    byModule,
    productionComplete: routes.every((r) => r.disposition !== "blocked"),
  };
  return { schemaVersion: 1, summary, routes };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
    const report = auditPhase9WriteCoverage(manifest);
    if (process.argv.includes("--json")) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    } else {
      console.log("Phase 9 write coverage: " + JSON.stringify(report.summary));
      console.log("Production completeness: " + (report.summary.productionComplete ? "CERTIFICATION STILL REQUIRED" : "BLOCKED"));
    }
    if (process.argv.includes("--require-complete") && !report.summary.productionComplete) {
      console.error("PHASE9_UNSUPPORTED_WRITES: " + report.summary.blocked);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error("PHASE9_COVERAGE_AUDIT_FAILED:", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
