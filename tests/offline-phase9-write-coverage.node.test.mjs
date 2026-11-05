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
    "POST /api/factory/pressing-machines/confirm [requireAuth]",
    "POST /api/auth/login [session]",
    "POST /api/pos/sales [business]",
    "POST /api/factory/bales [business]",
    "POST /api/inventory/quick-adjust [business]",
    "POST /api/containers/:id/offload [business]",
    "PATCH /api/containers/:id/offload [business]",
    "POST /api/files/upload [multipart]",
    "POST /api/vouchers/payment-receipt [business]",
    "PUT /api/vouchers/:id/sales [business]",
    "PATCH /api/vouchers/:id/sales [business]",
    "DELETE /api/vouchers/:id [admin]",
    "POST /api/suppliers/create [business]",
    "POST /api/documents/upload [multipart]",
    "PUT /api/payments/:id [business]",
    "POST /api/edge/operator/sync-control [operator]",
    "POST /api/edge/operator/conflicts/decide [operator]",
    "POST /api/stock-transfers [business]",
    "POST /api/stock-items/bulk-update-prices [business]",
    "POST /api/stock-items/bulk-assign-category [business]",
    "POST /api/stock-items/bulk-rename [business]",
    "POST /api/stock-items/bulk-update-uom [business]",
    "POST /api/stock-items/update-categories [business]",
    "POST /api/stock-items/update-names-by-code [business]",
    "POST /api/stock-items/import-barcodes [business]",
    "POST /api/stock-items/import-opening-balances [business]",
    "POST /api/stock-items/:id/location-prices [business]",
    "PATCH /api/stock-items/:id [business]",
    "POST /api/stock-items [business]",
    "DELETE /api/stock-items/:id [business]",
    "PUT /api/stock-transfers/:id [business]",
    "POST /api/stock-transfers/:id/approve [business]",
    "POST /api/vouchers/:id/finalize [business]",
    "POST /api/stock-transfers/:transferId/revisions [business]",
    "POST /api/stock-transfer-revisions/:id/approve [business]",
    "POST /api/stock-transfer-revisions/:id/reject [business]",
    "POST /api/stock-transfer-import/parse [business]",
    "POST /api/stock-transfer-import/validate [business]",
    "POST /api/stock-transfer-import/import [business]",
    "POST /api/stock-transfer-import/parse-multi-source [business]",
    "POST /api/stock-transfer-import/validate-multi-source [business]",
    "POST /api/stock-transfer-import/import-multi-source [business]",
    "POST /api/locations/:locationId/import-inventory [business]",
  ],
};
test("every unique API write has explicit capture, session-only or blocked disposition", () => {
  const report = auditPhase9WriteCoverage(manifest);
  assert.equal(report.summary.uniqueApiWriteRoutes, 44);
  assert.equal(report.summary.approvedCapture, 37);
  assert.equal(report.summary.sessionOnly, 1);
  // Phase 10: pause/resume is an operator control on the LAN; the cloud-only
  // decision route stays blocked there.
  assert.equal(report.summary.operatorControl, 1);
  // Plan-batch routes in the sample: they count as captured, and wait for their drill approval on the LAN.
  assert.equal(report.summary.awaitingDrillApproval, 15);
  assert.equal(report.summary.blocked, 5);
  assert.equal(report.summary.productionComplete, false);
  const byPath = new Map(report.routes.map((r) => [r.path, r]));
  for (const path of ["/api/factory/bales", "/api/suppliers/create", "/api/documents/upload", "/api/payments/:id"]) {
    assert.equal(byPath.get(path).disposition, "blocked");
  }
  assert.equal(byPath.get("/api/vouchers/with-entries").policy, "voucher.with-entries.v1");
  assert.equal(byPath.get("/api/factory/pressing-machines/confirm").policy, "pressing.confirmation.v1");
  assert.equal(byPath.get("/api/inventory/quick-adjust").policy, "stock.quick-adjust.v1");
  assert.equal(byPath.get("/api/pos/sales").policy, "pos.sale.v1");
  assert.equal(byPath.get("/api/containers/:id/offload").policy, "receiving.container-offload.v1");
  assert.equal(byPath.get("/api/files/upload").policy, "attachment.file.v1");
  assert.equal(byPath.get("/api/stock-transfers").policy, "stock.transfer.v1");
  assert.equal(byPath.get("/api/stock-items/bulk-update-prices").policy, "stock.item-edit.v1");
  const route = (method, path) => report.routes.find((r) => r.method === method && r.path === path);
  assert.equal(route("PATCH", "/api/stock-items/:id").policy, "stock.item-edit.v1");
  assert.equal(route("POST", "/api/stock-items").policy, "stock.item-create.v1");
  assert.equal(route("DELETE", "/api/stock-items/:id").policy, "stock.item-delete.v1");
  assert.equal(route("PUT", "/api/stock-transfers/:id").policy, "stock.transfer-edit.v1");
  assert.equal(route("PUT", "/api/stock-transfers/:id").planBatch, 3);
  assert.equal(route("POST", "/api/stock-items").planBatch, 2);
  assert.equal(route("PATCH", "/api/stock-items/:id").planBatch, undefined);
  assert.equal(route("POST", "/api/stock-transfer-revisions/:id/reject").policy, "stock.transfer-revision-review.v1");
});
test("policy drift from an accidental LAN write bypass fails the audit", () => {
  const unsafeGuard = (config, method, path) =>
    path === "/api/factory/bales" ? false : edgeBlocksWrite(config, method, path);
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
  assert.equal(report.summary.approvedCapture, 37);
  assert.ok(report.summary.blocked > 0);
  assert.ok(report.routes.some((r) => r.module === "retail-pos" && r.disposition === "blocked"));
  assert.ok(report.routes.some((r) => r.module === "factory-production" && r.disposition === "blocked"));
  assert.ok(report.routes.some((r) => r.module === "inventory-stock" && r.disposition === "blocked"));
});
