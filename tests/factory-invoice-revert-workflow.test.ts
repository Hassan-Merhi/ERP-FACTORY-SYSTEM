import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("factory invoice revert workflow", () => {
  it("records Draft and Loading workflow origins before invoice finalization", () => {
    const loading = read("server/routes/factory/customer-orders/finalize-loading/loading.ts");
    const finalize = read("server/routes/factory/customer-orders/finalize-loading/finalize.ts");

    expect(loading).toContain('previousStatus: "LOADING"');
    expect(finalize).toContain('order.previousStatus === "LOADING" ? "LOADING" : "DRAFT"');
  });

  it("restores the persisted origin without clearing the invoice number", () => {
    const source = read("server/routes/factory/customer-orders/finalize-loading/unfinalize.ts");
    const updateBlock = source.slice(
      source.indexOf("// Restore the original workflow"),
      source.indexOf("// Daybook entry")
    );

    expect(source).toContain('order.previousStatus === "LOADING" || order.previousStatus === "DRAFT"');
    expect(source).toContain("order.loadingStartedAt || order.loadingFinalizedAt");
    expect(updateBlock).toContain("status: restoreStatus");
    expect(updateBlock).not.toContain("invoiceNumber: null");
  });

  it("keeps the accounting, voucher, bale, and transaction reversal guards", () => {
    const source = read("server/routes/factory/customer-orders/finalize-loading/unfinalize.ts");

    expect(source).toContain("await db.transaction");
    expect(source).toContain('.for("update")');
    expect(source).toContain('eq(customerBalances.transactionType, "SALE")');
    expect(source).toContain("linkedVoucherIds");
    expect(source).toContain('status: "RESERVED_FOR_ORDER"');
    expect(source).toContain('order.status !== "FINALIZED"');
  });

  it("uses a destination-neutral success message", () => {
    const model = read("client/src/pages/factory/factoryinvoicedetail/useFactoryInvoiceDetailModel.tsx");
    expect(model).toContain('title: "Invoice reverted successfully"');
    expect(model).not.toContain('title: "Reverted to Draft"');
  });
});
