import fs from "node:fs";

const service = fs.readFileSync("server/services/immutableStockTransferRevisionLifecycle.ts", "utf8");
const routes = fs.readFileSync("server/routes/vouchers/immutableStockTransferRevisionRoutes.ts", "utf8");
const registry = fs.readFileSync("server/routes/voucherRoutes.ts", "utf8");

const checks = [
  [service.includes("FOR UPDATE OF revision, transfer, voucher"), "approval locks revision, transfer, and voucher"],
  [service.includes("requested.status !== \"pending\""), "non-pending revisions are blocked"],
  [service.includes("STOCK_TRANSFER_REVISION_STALE"), "stale revision protection exists"],
  [service.includes("STOCK_TRANSFER_REVISION_SCOPE"), "company and location scope protection exists"],
  [service.includes("status = 'superseded'") && service.includes("superseded_by_revision_id"), "superseded revisions are recorded"],
  [service.includes("WHERE id = ${revisionId} AND status = 'pending'"), "status transition is guarded"],
  [routes.includes("requireNonPOS") && routes.includes("requireActionAccess(\"act_transfer_stock\")"), "review actions require authorization"],
  [routes.includes("/api/stock-transfer-revisions/:id/reject"), "rejection route exists"],
  [routes.includes("Revision history is immutable and cannot be deleted"), "revision deletion is blocked"],
  [registry.includes("registerImmutableStockTransferRevisionRoutes(app)") && !registry.includes("registerStockTransferRevisionLifecycleRoutes(app)"), "immutable routes own every revision endpoint (shadowed legacy handlers stay retired)"],
];

const failures = checks.filter(([ok]) => !ok).map(([, label]) => label);
if (failures.length) {
  console.error("Stock-transfer revision lifecycle verification failed:");
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log(`Stock-transfer revision lifecycle verified (${checks.length} safeguards).`);
