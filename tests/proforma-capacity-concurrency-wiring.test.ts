import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function count(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

function expectBefore(source: string, first: string, second: string) {
  const firstIndex = source.indexOf(first);
  const secondIndex = source.indexOf(second);
  expect(firstIndex).toBeGreaterThanOrEqual(0);
  expect(secondIndex).toBeGreaterThan(firstIndex);
}

describe("Phase 3 proforma capacity mutation lock coverage", () => {
  it("manual scans lock proforma capacity before order and bale row locks", () => {
    const source = read("server/routes/factory/customer-orders/bale-scanning/scan.ts");
    expectBefore(source, "acquireProformaCapacityTransactionLock(tx", 'const [currentOrder] = await tx');
    expectBefore(source, 'const [currentOrder] = await tx', 'const [bale] = await tx');
  });

  it("both bulk import mutation modes acquire the proforma lock", () => {
    const source = read("server/routes/factory/customer-orders/bale-scanning/bulk-import.ts");
    expect(count(source, "acquireProformaCapacityTransactionLock(tx")).toBe(2);
    expect(count(source, 'const [currentOrder] = await tx')).toBe(2);
  });

  it("automatic loading creation is one locked transaction with physical bale row locks", () => {
    const source = read("server/routes/factory/customer-proformas/createLoadingAtomic.ts");
    expectBefore(source, "db.transaction(async (tx)", "acquireProformaCapacityTransactionLock(tx");
    expect(source).toContain('.for("update")');
  });

  it("all proforma-linked empty order/container creation paths lock before checking capacity and inserting", () => {
    const directLoading = read("server/routes/factory/customer-orders/finalize-loading/loading.ts");
    expectBefore(directLoading, "acquireProformaCapacityTransactionLock(tx", "guardProformaOrderCreation(tx");
    expectBefore(directLoading, "guardProformaOrderCreation(tx", ".insert(customerOrders)");

    const genericOrder = read("server/routes/factory/customer-orders/orderCrudRoutes.ts");
    expectBefore(genericOrder, "acquireProformaCapacityTransactionLock(tx", "guardProformaOrderCreation(tx");
    expectBefore(genericOrder, "guardProformaOrderCreation(tx", "tx.insert(customerOrders)");

    const v5Containers = read("server/routes/factory/stock-allocation-v5/proforma-create.ts");
    expectBefore(v5Containers, "acquireProformaCapacityTransactionLock(tx", "guardProformaOrderCreation(tx");
    expectBefore(v5Containers, "guardProformaOrderCreation(tx", "tx.insert(customerOrders)");
  });

  it("proforma linking, recovery, exchange, and cancelled restore use the shared lock", () => {
    for (const path of [
      "server/routes/factory/customer-orders/linkProformaAtomic.ts",
      "server/routes/factory/customer-orders/verify-recover/recoverBalesAtomic.ts",
      "server/routes/factory/customer-orders/bale-scanning/exchange.ts",
      "server/routes/factory/stock-allocation-v5/restoreCancelledContainerAtomic.ts",
    ]) {
      expect(read(path)).toContain("acquireProformaCapacityTransactionLock");
    }
  });

  it("dispatch invoicing, cancellation, and finalization serialize against scanners", () => {
    expect(read("server/routes/factory/dispatch-batches/invoicing.ts")).toContain(
      "acquireProformaCapacityTransactionLock(tx"
    );
    expect(read("server/routes/factory/customer-orders/finalize-loading/cancel.ts")).toContain(
      "acquireProformaCapacityTransactionLock(tx"
    );
    expect(read("server/routes/factory/customer-orders/finalize-loading/loading.ts")).toContain(
      "acquireProformaCapacityTransactionLock(tx"
    );
  });
});
