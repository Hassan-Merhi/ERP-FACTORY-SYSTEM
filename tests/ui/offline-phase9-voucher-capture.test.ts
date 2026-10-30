import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  state: "needs_review",
  deliver: vi.fn(async () => undefined),
  queue: vi.fn(async () => ({ id: "e53cdbd1-7c4b-4b5c-9a60-b4f9de710b8c" })),
}));
vi.mock("@/lib/offline/durableOutbox", () => ({
  queueOfflineOperation: state.queue,
  deliverOfflineOperations: state.deliver,
}));
vi.mock("@/lib/db", () => ({
  db: { offlineOperations: { get: async () => ({ state: state.state }) } },
}));

import { submitDurableVoucherWithEntries } from "@/lib/offline/voucherCapture";

beforeEach(() => {
  state.queue.mockClear();
  state.deliver.mockClear();
  state.state = "needs_review";
});

describe("Phase 9 voucher capture communicates ambiguous post state", () => {
  it("does not call an unverified HTTP success a merely pending request", async () => {
    await expect(submitDurableVoucherWithEntries(
      { companyId: 3, userId: "operator-1" }, {}, "2026-10-30"
    )).rejects.toMatchObject({
      name: "OfflineOperationRejected", message: "OFFLINE_VOUCHER_REVIEW_REQUIRED",
    });
    expect(state.queue).toHaveBeenCalledTimes(1);
    expect(state.deliver).toHaveBeenCalledTimes(1);
  });

  it("keeps a real pending delivery distinctly pending", async () => {
    state.state = "pending";
    await expect(submitDurableVoucherWithEntries(
      { companyId: 3, userId: "operator-1" }, {}, "2026-10-30"
    )).rejects.toMatchObject({
      name: "OfflineQueued", message: "OFFLINE_VOUCHER_PENDING",
    });
  });
});
