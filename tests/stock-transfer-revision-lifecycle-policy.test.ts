import { describe, expect, it } from "vitest";
import { readModuleFamily } from "../scripts/lib/readModuleFamily.mjs";

const service = readModuleFamily("server/services/immutableStockTransferRevisionLifecycle.ts");
const routes = readModuleFamily("server/routes/vouchers/immutableStockTransferRevisionRoutes.ts");

describe("stock transfer revision lifecycle policy", () => {
  it("locks lifecycle rows and guards status transitions", () => {
    expect(service).toContain("FOR UPDATE OF revision, transfer, voucher");
    expect(service).toContain("WHERE id = ${revisionId} AND status = 'pending'");
  });

  it("rejects stale, cross-company, and non-pending approvals", () => {
    expect(service).toContain("STOCK_TRANSFER_REVISION_STALE");
    expect(service).toContain("STOCK_TRANSFER_REVISION_SCOPE");
    expect(service).toContain("STOCK_TRANSFER_REVISION_STATUS");
  });

  it("supersedes competing pending revisions after approval", () => {
    expect(service).toContain("status = 'superseded'");
    expect(service).toContain("superseded_by_revision_id = ${revisionId}");
    expect(service).toContain("AND id <> ${revisionId}");
  });

  it("protects review endpoints from POS and unauthorized users", () => {
    expect(routes).toContain("requireNonPOS");
    expect(routes).toContain('requireActionAccess("act_transfer_stock")');
    expect(routes).toContain("/api/stock-transfer-revisions/:id/reject");
  });
});
