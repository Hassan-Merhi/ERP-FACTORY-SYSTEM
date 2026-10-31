import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/featureFlags", () => ({ OFFLINE_MODE_ENABLED: true }));

import { enqueueRequest, getQueue, isSafeToQueue } from "@/lib/offlineQueue";
import { addToSyncQueue, db } from "@/lib/db";

beforeEach(() => {
  localStorage.clear();
});

describe("Phase 9 legacy queue admission policy", () => {
  it("does not store new unverified POS, inventory or voucher requests in legacy localStorage", () => {
    const original = {
      id: "old-1",
      url: "/api/factory/bales/10",
      method: "PATCH",
      body: "old",
      description: "Old pending adjustment",
      timestamp: 1,
      status: "pending",
    };
    localStorage.setItem("erp_offline_queue", JSON.stringify([original]));
    for (const [method, url] of [
      ["POST", "/api/pos/sales"],
      ["POST", "/api/inventory/quick-adjust"],
      ["POST", "/api/vouchers/with-entries"],
      ["POST", "/api/factory/supplier-payments"],
      ["PATCH", "/api/factory/bales/10"],
    ]) {
      expect(() => enqueueRequest(url, method, JSON.stringify({ qty: 1 }), "Unverified")).toThrow(
        "OFFLINE_LEGACY_QUEUE_BLOCKED"
      );
    }
    expect(getQueue()).toEqual([original]);
  });

  it("does not advertise any old replay pattern as Phase 9 safe", () => {
    for (const [method, url] of [
      ["POST", "/api/pos/sales"],
      ["POST", "/api/inventory/quick-adjust"],
      ["POST", "/api/vouchers/with-entries"],
      ["PATCH", "/api/factory/bales/10"],
      ["POST", "/api/auth/set-company"],
    ]) {
      expect(isSafeToQueue(method, url)).toBe(false);
    }
  });

  it("rejects legacy IndexedDB admission without touching the sync table", async () => {
    const add = vi.spyOn(db.syncQueue, "add");
    await expect(
      addToSyncQueue({
        idempotencyKey: "untrusted",
        mode: "factory",
        entityType: "bale",
        operation: "update",
        payload: JSON.stringify({ status: "sold" }),
        url: "/api/factory/bales/10",
        method: "PATCH",
        companyId: 3,
        locationId: null,
        tempId: null,
        description: "Stale stock update",
      })
    ).rejects.toThrow("OFFLINE_LEGACY_IDB_QUEUE_BLOCKED");
    expect(add).not.toHaveBeenCalled();
    add.mockRestore();
  });
});
