import { describe, expect, it, vi } from "vitest";
import type { DbTransaction } from "../server/db";

vi.mock("../server/edge/edgeRuntimePolicy.mjs", () => ({
  readFactoryEdgeConfiguration: () => ({
    mode: "lan", primary: true,
    siteId: "027d7472-4a29-4bb3-a4aa-5b30e4ad631f",
  }),
}));

import { captureEdgeVoucherTx } from "../server/edge/edgeVoucherOutbox";

const base = {
  companyId: 3,
  localVoucherId: 17,
  actorUserId: "operator-1",
  voucher: { voucherType: "Journal", voucherDate: "2026-10-30" },
  entries: [{ ledgerAccountId: 11, debitAmount: "10.00" }, { ledgerAccountId: 12, creditAmount: "10.00" }],
};

function transaction() {
  const execute = vi.fn(async () => undefined);
  return { execute, tx: { execute } as unknown as DbTransaction };
}

describe("Phase 9 LAN immutable outbox identity", () => {
  it("refuses to write when an original operation ID is missing or malformed", async () => {
    for (const requestId of [undefined, null, "", "not-a-uuid", "phase8-test-1"]) {
      const { tx, execute } = transaction();
      await expect(captureEdgeVoucherTx(tx, { ...base, requestId })).rejects.toThrow(
        "EDGE_OUTBOX_OPERATION_ID_INVALID"
      );
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it("uses the original UUID and preserves atomic transaction ownership", async () => {
    const { tx, execute } = transaction();
    await captureEdgeVoucherTx(tx, {
      ...base,
      requestId: "e53cdbd1-7c4b-4b5c-9a60-b4f9de710b8c",
    });
    expect(execute).toHaveBeenCalledTimes(2);
    // No independent pool transaction or asynchronous fallback ID exists.
    expect(execute.mock.calls.every((call) => call.length === 1)).toBe(true);
  });
});
