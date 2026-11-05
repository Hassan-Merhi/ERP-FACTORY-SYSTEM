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
const STOCK_ITEM_EDIT = Object.freeze({
  policy: "stock.item-edit.v1",
  limitations:
    "Existing items only, whitelisted fields (name, unit, prices, category, group, active, opening balances, " +
    "location prices, new barcodes); a field the cloud changed meanwhile is held for an Admin/Developer " +
    "decision; creating, deleting, merging and re-coding items stay cloud-only",
});
// Phase 10 operator controls: not business data, written only through a
// DBA-owned database function that re-checks the user (plan batch 1).
const OPERATOR_CONTROL_WRITES = new Set(["POST /api/edge/operator/sync-control"]);
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
  ["POST /api/inventory/quick-adjust", {
    policy: "stock.quick-adjust.v1",
    limitations:
      "Replayed as a quantity delta on the cloud balance; a below-zero result is held for an " +
      "Admin/Developer approve/reject decision",
  }],
  ["POST /api/stock-transfers", {
    policy: "stock.transfer.v1",
    limitations:
      "New transfers only (the existing-voucher form is refused on the LAN); replayed on the LAN request id " +
      "with a cloud voucher number; a cloud shortfall is held for an Admin/Developer decision",
  }],
  ["POST /api/stock-items/bulk-update-prices", STOCK_ITEM_EDIT],
  ["POST /api/stock-items/bulk-assign-category", STOCK_ITEM_EDIT],
  ["POST /api/stock-items/bulk-rename", STOCK_ITEM_EDIT],
  ["POST /api/stock-items/bulk-update-uom", STOCK_ITEM_EDIT],
  ["POST /api/stock-items/update-categories", STOCK_ITEM_EDIT],
  ["POST /api/stock-items/update-names-by-code", STOCK_ITEM_EDIT],
  ["POST /api/stock-items/import-barcodes", STOCK_ITEM_EDIT],
  ["POST /api/stock-items/import-opening-balances", STOCK_ITEM_EDIT],
  ["POST /api/stock-items/:id/location-prices", STOCK_ITEM_EDIT],
  ["PATCH /api/stock-items/:id", STOCK_ITEM_EDIT],
  ["POST /api/pos/sales", {
    policy: "pos.sale.v1",
    limitations:
      "Cash, USD, non-supplier-partner sales with a client sale id; LAN invoice series; replayed through " +
      "the sale service on clientSaleId; below-zero stock or a changed till account is held for review",
  }],
  ["POST /api/containers/:id/offload", {
    policy: "receiving.container-offload.v1",
    limitations:
      "Offload against existing purchase orders with its duties, charges, cost corrections and agent lines " +
      "as entered; cloud prices apply; changed order quantities are held for review",
  }],
  ["PATCH /api/containers/:id/offload", {
    policy: "receiving.container-offload.v1",
    limitations: "Offload edit replayed as entered (replace-only); the cloud must already hold the offload",
  }],
  ["POST /api/files/upload", {
    policy: "attachment.file.v1",
    limitations:
      "Files up to 10 MB; the record syncs first, then the SHA-256-verified bytes; renames, moves and " +
      "deletes stay cloud-only; a missing cloud folder is held for review",
  }],
  ["PUT /api/vouchers/:id/sales", {
    policy: "pos.sale-edit.v1",
    limitations:
      "POS returns/corrections replayed on the sale's stream through the sale-edit core; the sale is found by " +
      "client sale id or (pre-outage) voucher id; below-zero stock is held for review",
  }],
  ["PATCH /api/vouchers/:id/sales", {
    policy: "pos.sale-edit.v1",
    limitations: "Compatibility alias of the sale edit (same handler and replay)",
  }],
  ["DELETE /api/vouchers/:id", {
    policy: "pos.sale-cancel.v1",
    limitations:
      "Offline only for POS sales (other voucher deletes are refused on the LAN); replayed through the same " +
      "delete code on the sale's stream; a missing or already-cancelled sale is reject-only",
  }],
  ["POST /api/vouchers/payment-receipt", {
    policy: "voucher.payment-receipt.v1",
    limitations:
      "Supplier, customer, employee and bank payments/receipts replayed through the same posting code at " +
      "the LAN rate; edits and deletes stay cloud-only; posting refusals are reject-only conflicts",
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
    const operatorControl = OPERATOR_CONTROL_WRITES.has(key);
    const blockedByGuard = guard(config, method, path);
    // The guard must match the reviewed capture map EXACTLY; otherwise a
    // new route could commit locally without a durable cloud apply protocol.
    if (blockedByGuard === Boolean(supported || sessionExempt || operatorControl)) {
      throw new Error("PHASE9_WRITE_GUARD_DRIFT: " + key);
    }
    routes.push({
      method,
      path,
      module: moduleForPath(path),
      disposition: supported
        ? "approved-capture"
        : sessionExempt
          ? "session-only"
          : operatorControl
            ? "operator-control"
            : "blocked",
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
    operatorControl: routes.filter((r) => r.disposition === "operator-control").length,
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
