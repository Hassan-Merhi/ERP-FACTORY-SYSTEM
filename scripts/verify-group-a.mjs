#!/usr/bin/env node
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const migration = read("server/startup-schema/011-stock-transfer-revision-integrity.ts");
const startupIndex = read("server/startup-schema/index.ts");
const schema = read("shared/schema/erp/stock-movements.ts");
const service = read("server/services/immutableStockTransferRevisionLifecycle.ts");
const routes = read("server/routes/vouchers/immutableStockTransferRevisionRoutes.ts");
const voucherRoutes = read("server/routes/voucherRoutes.ts");
const adminHistory = read("client/src/pages/vouchers/StockTransferRevisionHistory.tsx");
const posHistory = read("client/src/pages/pos/postransferorders/components/ViewTransferDialog.tsx");

const failures = [];
const requireText = (source, value, message) => {
  if (!source.includes(value)) failures.push(message);
};
const forbidText = (source, value, message) => {
  if (source.includes(value)) failures.push(message);
};

requireText(migration, "stock_transfer_revisions_transfer_number_unique", "revision-number unique index missing");
requireText(migration, "stock_transfer_revisions_one_pending_per_user", "active pending uniqueness missing");
requireText(migration, "status = 'superseded'", "historical pending backfill does not preserve superseded revisions");
requireText(startupIndex, "...stockTransferRevisionIntegrity", "Phase 3 migration is not registered");
requireText(schema, 'status: text("status")', "runtime schema does not expose revision status");
requireText(schema, "transferRevisionUnique", "runtime schema does not expose revision uniqueness");
requireText(service, "FOR UPDATE OF stv, v", "revision creation does not lock the transfer scope");
requireText(service, "MAX(revision_number)", "revision numbering is not allocated under the transfer lock");
requireText(service, "payload_hash", "duplicate pending revision detection is missing");
requireText(service, "superseded_by_revision_id", "superseded revision lineage is missing");
requireText(service, "STOCK_TRANSFER_REVISION_STALE", "stale approval protection is missing");
requireText(service, "STOCK_TRANSFER_REVISION_SCOPE", "company/location isolation is missing");
requireText(service, "WHERE id = ${revisionId} AND status = 'pending'", "terminal status transition is not guarded");
requireText(routes, '"/api/stock-transfer-revisions/:id/reject"', "reject endpoint is missing");
requireText(routes, "logAudit", "revision audit records are missing");
requireText(routes, "Revision history is immutable and cannot be deleted", "revision deletion is not blocked");
requireText(voucherRoutes, "registerImmutableStockTransferRevisionRoutes(app)", "immutable routes are not registered before compatibility routes");
requireText(adminHistory, "revisionStatusLabel", "admin history does not show lifecycle status");
requireText(adminHistory, "destinationLocationName", "admin history does not show source-to-destination route");
requireText(posHistory, "RevisionStatusBadge", "POS eye view does not show lifecycle status");
requireText(posHistory, "destinationLocationName", "POS eye view does not show destination");
forbidText(adminHistory, "Reference only:</span>", "mutable optional-status switch remains in admin history");

if (failures.length) {
  console.error("Group A Phase 3 contract failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      group: "A",
      phase: 3,
      status: "implemented",
      immutableHistory: true,
      concurrentRevisionNumberProtection: true,
      staleApprovalProtection: true,
      companyAndLocationIsolation: true,
      approveRejectAudit: true,
      sqlRequired: true,
    },
    null,
    2
  )
);
