import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted so the vi.mock factory below - which vitest lifts above this line -
// can close over it.
const writeAuditEventMock = vi.hoisted(() => vi.fn());

vi.mock("../../services/audit", () => ({
  writeAuditEvent: writeAuditEventMock,
}));

import { logAudit } from "./auditWriteAdapter";

describe("auditWriteAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writeAuditEventMock.mockResolvedValue(undefined);
  });

  it("forwards existing voucher and POS audit events to the shared framework", async () => {
    const event = {
      userId: "42",
      username: "Cashier",
      companyId: 7,
      action: "create" as const,
      tableName: "vouchers",
      recordId: 99,
      recordIdentifier: "SALES-99",
      changes: {
        totalAmount: { new: "125.00" },
        itemCount: { new: 3 },
      },
    };

    await logAudit(event);

    expect(writeAuditEventMock).toHaveBeenCalledTimes(1);
    // Wave 12: the executor (the caller's transaction) is forwarded; none here.
    expect(writeAuditEventMock).toHaveBeenCalledWith(event, undefined);
  });

  it("propagates audit failures so existing critical callers keep their current policy", async () => {
    const failure = new Error("audit unavailable");
    writeAuditEventMock.mockRejectedValue(failure);

    await expect(
      logAudit({
        userId: "42",
        username: "Admin",
        action: "delete",
        tableName: "vouchers",
        recordId: 99,
      })
    ).rejects.toBe(failure);
  });
});
