import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearQueue,
  containsSensitiveCredentials,
  enqueueRequest,
  getDescriptionForRequest,
  getLastSynced,
  getQueue,
  isSafeToQueue,
  onQueueSizeWarning,
  removeFromQueue,
  setLastSynced,
  updateItemStatus,
} from "../../client/src/lib/offlineQueue";

describe("offline mutation queue behavior", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(Date, "now").mockReturnValue(1_723_366_800_000);
    vi.spyOn(Math, "random").mockReturnValue(0.25);
  });

  it("deduplicates edits, supersedes pending writes with deletes, and preserves failure evidence", () => {
    const firstId = enqueueRequest("/api/vouchers/10", "patch", '{"description":"first"}', "Voucher edit");
    const retryId = enqueueRequest("/api/vouchers/10", "PATCH", '{"description":"latest"}', "Latest edit");
    expect(retryId).toBe(firstId);
    expect(getQueue()).toEqual([
      expect.objectContaining({ id: firstId, method: "PATCH", body: '{"description":"latest"}', status: "pending" }),
    ]);

    updateItemStatus(firstId, "failed", "HTTP 409");
    expect(getQueue()[0]).toMatchObject({ status: "failed", failReason: "HTTP 409" });

    enqueueRequest("/api/suppliers/12", "PATCH", "{}", "Supplier edit", "2026-08-11");
    enqueueRequest("/api/suppliers/12", "DELETE", "", "Supplier delete");
    expect(getQueue().some((item) => item.url === "/api/suppliers/12" && item.method === "PATCH")).toBe(false);
    expect(getQueue().at(-1)).toMatchObject({ method: "DELETE" });

    removeFromQueue(firstId);
    expect(getQueue().every((item) => item.id !== firstId)).toBe(true);
    clearQueue();
    expect(getQueue()).toEqual([]);
  });

  it("warns exactly at the queue threshold and supports unsubscribe", () => {
    const warning = vi.fn();
    const unsubscribe = onQueueSizeWarning(warning);
    for (let index = 0; index < 50; index += 1) {
      enqueueRequest(`/api/customers?request=${index}`, "POST", "{}", `Customer ${index}`);
    }
    expect(warning).toHaveBeenCalledWith(50);
    unsubscribe();
    enqueueRequest("/api/customers?request=50", "POST", "{}", "Customer 50");
    expect(warning).toHaveBeenCalledOnce();
  });

  it("queues ordinary ERP/POS/factory writes but never lock-sensitive financial repair or replay actions", () => {
    const safe: Array<[string, string]> = [
      ["POST", "/api/auth/set-company"],
      ["POST", "/api/pos/sales"],
      ["PATCH", "/api/vouchers/5/payment-receipt"],
      ["POST", "/api/factory/supplier-fx-transfers"],
      ["POST", "/api/factory/containers/9/other-charges/sync"],
      ["PATCH", "/api/factory/payroll/7"],
      ["POST", "/api/stock-transfers"],
      ["POST", "/api/containers/8/reverse-offload"],
    ];
    for (const [method, url] of safe) expect(isSafeToQueue(method, `${url}?offline=1`)).toBe(true);

    expect(isSafeToQueue("POST", "/api/factory/raw-stock/recalc/secure-preview")).toBe(false);
    expect(isSafeToQueue("POST", "/api/factory/raw-stock/88/assign-to-bales")).toBe(false);
    expect(isSafeToQueue("GET", "/api/pos/sales")).toBe(false);
    expect(isSafeToQueue("POST", "/api/unknown")).toBe(false);
  });

  it("never replays credential-bearing requests from browser storage", () => {
    // Deny-list: manager approvals and password changes are online-only.
    expect(isSafeToQueue("POST", "/api/pos/retail/discount-approvals")).toBe(false);
    expect(isSafeToQueue("POST", "/api/auth/login")).toBe(false);
    expect(isSafeToQueue("POST", "/api/auth/change-password")).toBe(false);
    expect(isSafeToQueue("POST", "/api/user/change-password")).toBe(false);

    // Defence in depth: a payload carrying credentials is never persisted, even if a
    // future endpoint that accepts it is added to the queue allow-list.
    expect(containsSensitiveCredentials({ managerUsername: "m", managerPassword: "secret" })).toBe(true);
    expect(containsSensitiveCredentials({ currentPassword: "a", newPassword: "b" })).toBe(true);
    expect(containsSensitiveCredentials({ nested: { apiToken: "t" } })).toBe(true);
    expect(containsSensitiveCredentials({ lines: [{ variantId: 1, cvv: "123" }] })).toBe(true);
    expect(containsSensitiveCredentials({ approvalToken: "short-lived", customerId: 4, items: [] })).toBe(false);
    expect(containsSensitiveCredentials({ description: "password" })).toBe(false);
    expect(containsSensitiveCredentials(null)).toBe(false);
  });

  it("labels every high-use offline ERP domain for transparent replay review", () => {
    const cases: Array<[string, string]> = [
      ["/api/pos/sales", "POS Sale"],
      ["/api/pos/drafts/5", "POS Draft"],
      ["/api/vouchers/payment-receipt", "Payment / Receipt"],
      ["/api/vouchers/journal", "Journal Entry"],
      ["/api/vouchers/4/sales", "Sales Voucher Update"],
      ["/api/vouchers", "Voucher"],
      ["/api/factory/stock-entry/remove-by-product", "Remove Bales by Product"],
      ["/api/factory/stock-entry/remove", "Stock Entry Removal"],
      ["/api/factory/stock-entry", "Factory Stock Entry"],
      ["/api/factory/bale-products/4/cascade-update", "Bale Product Update"],
      ["/api/factory/bales/4/assign-worker", "Worker Assignment"],
      ["/api/factory/customer-orders/4/finalize-loading", "Finalize Loading"],
      ["/api/factory/vouchers/payment-receipt", "Factory Payment"],
      ["/api/factory/vouchers/journal", "Factory Journal"],
      ["/api/factory/mix-batches/4/assign-bales", "Mix Batch Bale Assignment"],
      ["/api/factory/daybook/entry/4/void", "Daybook Void"],
      ["/api/factory/supplier-payments", "Supplier Payment"],
      ["/api/factory/supplier-fx-transfers", "FX Transfer"],
      ["/api/factory/raw-stock/opening-balance", "Raw Stock Opening Balance"],
      ["/api/factory/containers/4/other-charges/sync", "Container Charges"],
      ["/api/factory/containers/4/reverse-offload", "Container Reverse Offload"],
      ["/api/factory/attendance/bulk", "Attendance"],
      ["/api/factory/workers/4/advances", "Worker Advance"],
      ["/api/factory/advances/4/repayments", "Advance Repayment"],
      ["/api/factory/employees/4/deposit", "Employee Deposit"],
      ["/api/factory/employees/4/withdraw", "Employee Withdrawal"],
      ["/api/factory/customer-proformas/4/apply-catalog-prices", "Proforma Catalog Pricing"],
      ["/api/factory/payrolls/4/mark-paid", "Payroll Payment"],
      ["/api/factory/payroll/4/undo", "Payroll Undo"],
      ["/api/stock-adjustments", "Stock Adjustment"],
      ["/api/stock-transfers", "Stock Transfer"],
      ["/api/not-labelled", "Action"],
    ];
    for (const [url, label] of cases) expect(getDescriptionForRequest(url)).toBe(label);
  });

  it("records the last successful replay timestamp", () => {
    expect(getLastSynced()).toBeNull();
    setLastSynced();
    expect(getLastSynced()).toBe(1_723_366_800_000);
  });
});
