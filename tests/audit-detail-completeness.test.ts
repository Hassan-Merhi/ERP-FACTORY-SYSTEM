import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("audit detail completeness", () => {
  it("keeps stock-transfer revision items in create, approve and reject audit payloads", () => {
    const routes = read("server/routes/vouchers/immutableStockTransferRevisionRoutes.ts");
    const compatibility = read("server/routes/vouchers/adminPostUpdateStockTransferRevisionRoute.ts");

    expect(routes).toContain('items: { new: revisionItemsForAudit(result.items) }');
    expect(routes).toContain('items: { new: result.items }');
    expect(routes).toContain('"approve",');
    expect(compatibility).toContain("stockItemName: item.stockItemName");
    expect(compatibility).toContain("originalQuantity: item.originalQuantity");
    expect(compatibility).toContain("newQuantity: item.newQuantity");
    expect(compatibility).toContain("delta: item.delta");
  });

  it("returns item snapshots from the immutable revision lifecycle", () => {
    const service = read("server/services/immutableStockTransferRevisionLifecycle.ts");

    expect(service).toContain("export interface RevisionAuditItem");
    expect(service).toContain("items: RevisionAuditItem[]");
    expect(service).toContain("items: toRevisionAuditItems(revisionItems, auditRates)");
    expect(service).toContain("items: toRevisionAuditItems(rejectedRevisionItems)");
  });

  it("renders structured item arrays as a dedicated audit table", () => {
    const dialog = read("client/src/pages/settings/AuditLogDialog.tsx");
    const utils = read("client/src/pages/settings/AuditLogUtils.tsx");

    expect(dialog).toContain("function RevisionItemsTable");
    expect(dialog).toContain('["items", "lines", "lineItems", "affectedItems"]');
    expect(dialog).toContain('<RevisionItemsTable items={newItems.length > 0 ? newItems : oldItems} label="Items" />');
    expect(utils).toContain('stock_transfer_revisions: "Stock Transfer Revisions"');
    expect(utils).toContain('originalQuantity: "Before Qty"');
    expect(utils).toContain('newQuantity: "After Qty"');
  });

  it("preserves bounded structured item arrays in generic activity audits", () => {
    const middleware = read("server/middleware/activityAudit.ts");

    expect(middleware).toContain("const SAFE_ITEM_FIELDS");
    expect(middleware).toContain("value.slice(0, 100)");
    expect(middleware).toContain('["items", "lines", "lineItems", "affectedItems"]');
    expect(middleware).toContain('from "../routes/helpers/auditWriteAdapter"');
  });
});
