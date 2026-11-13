/**
 * Regression coverage for removing an unshipped bale from a Factory loading
 * after an earlier truck has already posted. These structural contracts run
 * without database access; the live database/financial posting still requires
 * an end-to-end acceptance check before claiming production verification.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (name: string) => fs.readFileSync(path.join(process.cwd(), name), "utf8");
const middleware = read("server/routes/factoryRoutes.ts");
const removal = read("server/routes/factory/customer-orders/bale-scanning/remove.ts");
const databaseGuard = read("docs/sql/manual/2026-11-10-factory-dispatch-trip-financial-phase4-guards.sql");

describe("Factory delete one unshipped bale after a trip has posted", () => {
  const handlerStart = removal.indexOf('app.delete("/api/factory/customer-orders/:id/bales/:baleId"');
  const handlerEnd = removal.indexOf("// POST /api/factory/bales/:id/release-from-loading", handlerStart);
  const handler = removal.slice(handlerStart, handlerEnd);

  it("does not short circuit normal single-bale deletion at the global financial gate", () => {
    expect(middleware).toContain('const continuingUnshippedRemoval = req.method === "DELETE"');
    expect(middleware).toContain('/^bales\\/\\d+$/.test(suffix)');
    expect(middleware).toContain('!continuingLoadingScan && !continuingUnshippedRemoval');
    expect(middleware).toContain('code: "POSTED_DISPATCH_LOCK"');
  });

  it("serializes with posting and only permits changes on still-open loadings", () => {
    expect(handlerStart).toBeGreaterThan(0);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    expect(handler).toContain("await lockCustomerOrderTx(tx, companyId, orderId)");
    expect(handler).toContain("const postedTrips = await hasLiveFinancialTripTx(tx, companyId, orderId)");
    expect(handler).toContain('!["DRAFT", "LOADING"].includes(currentOrder.status)');
    expect(handler).toContain("currentOrder.invoiceNumber");
    expect(handler).not.toContain("Only authorized Pending Loading reconciliation may remove unshipped bales");
  });

  it("cannot remove a posted bale or one scanned on any active truck", () => {
    expect(handler).toContain("await isPostedDispatchBaleTx(tx, companyId, orderId, orderBale.baleId)");
    expect(handler).toContain("FROM factory_loading_dispatch_scans s");
    expect(handler).toContain("AND s.removed_at IS NULL");
    expect(handler).toContain("AND d.status <> 'CANCELLED'");
    expect(handler).toContain("This item is scanned on a dispatch trip");
    expect(databaseGuard).toContain("Financially posted dispatch bale cannot be removed");
  });

  it("recalculates the pending load but never re-posts a legacy invoice over posted trip journals", () => {
    expect(handler).toContain("await recalculateOrderTotals(tx, orderId)");
    expect(handler).toMatch(/if \(!postedTrips\) \{\s*await syncOrderTotalsTx\(tx, companyId, orderId\);/);
    expect(handler).toContain("await tx.insert(customerOrderBaleRemovals).values");
    expect(handler).toContain("await reversePriorityAllocationForDeletedBaleTx");
  });
});
