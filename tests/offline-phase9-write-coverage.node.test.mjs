import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import { auditPhase9WriteCoverage } from "../scripts/edge/audit-phase9-write-coverage.mjs";
import { edgeBlocksWrite } from "../server/edge/edgeRuntimePolicy.mjs";

const manifest = {
  routes: [
    "GET /api/vouchers [requireAuth]",
    "POST /api/vouchers/with-entries [protected]",
    "POST /api/vouchers/with-entries [duplicate]",
    "POST /api/auth/login [session]",
    "POST /api/pos/sales [business]",
    "POST /api/factory/bales [business]",
    "POST /api/inventory/quick-adjust [business]",
    "POST /api/suppliers/create [business]",
    "POST /api/documents/upload [multipart]",
    "PUT /api/payments/:id [business]",
  ],
};
test("every unique API write has explicit capture, session-only or blocked disposition", () => {
  const report = auditPhase9WriteCoverage(manifest);
  assert.equal(report.summary.uniqueApiWriteRoutes, 8);
  assert.equal(report.summary.approvedCapture, 1);
  assert.equal(report.summary.sessionOnly, 1);
  assert.equal(report.summary.blocked, 6);
  assert.equal(report.summary.productionComplete, false);
  const byPath = new Map(report.routes.map((r) => [r.path, r]));
  for (const path of [
    "/api/pos/sales",
    "/api/factory/bales",
    "/api/inventory/quick-adjust",
    "/api/suppliers/create",
    "/api/documents/upload",
    "/api/payments/:id",
  ]) {
    assert.equal(byPath.get(path).disposition, "blocked");
  }
  assert.equal(byPath.get("/api/vouchers/with-entries").policy, "voucher.with-entries.v1");
});
test("policy drift from an accidental LAN write bypass fails the audit", () => {
  const unsafeGuard = (config, method, path) =>
    path === "/api/pos/sales" ? false : edgeBlocksWrite(config, method, path);
  assert.throws(() => auditPhase9WriteCoverage(manifest, unsafeGuard), /PHASE9_WRITE_GUARD_DRIFT/);
});
test("missing vetted route, bad manifest and unexpected allowed route are refused", () => {
  assert.throws(() => auditPhase9WriteCoverage({ routes: ["POST /api/pos/sales"] }), /PHASE9_APPROVED_ROUTE_MISSING/);
  assert.throws(
    () => auditPhase9WriteCoverage({ routes: ["POST /api", ...manifest.routes] }),
    /PHASE9_MANIFEST_ROUTE_INVALID/
  );
  assert.throws(() => auditPhase9WriteCoverage({}), /PHASE9_MANIFEST_MISSING/);
});
test("real route manifest has explicit accounting/stock/POS/factory/attachment gaps", () => {
  const real = JSON.parse(fs.readFileSync(new URL("../config/route-manifest.json", import.meta.url), "utf8"));
  const report = auditPhase9WriteCoverage(real);
  assert.equal(report.summary.approvedCapture, 1);
  assert.ok(report.summary.blocked > 0);
  assert.ok(report.routes.some((r) => r.module === "retail-pos" && r.disposition === "blocked"));
  assert.ok(report.routes.some((r) => r.module === "factory-production" && r.disposition === "blocked"));
  assert.ok(report.routes.some((r) => r.module === "inventory-stock" && r.disposition === "blocked"));
});
