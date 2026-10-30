import { afterEach, describe, expect, it, vi } from "vitest";
import { isPressingDuplicate, sendQueuedPressingScan } from "./pressingConfirmClient";
import { apiRequest } from "@/lib/queryClient";
import type { PressingQueuedScan } from "./pressingOfflineQueue";

vi.mock("@/lib/queryClient", () => ({ apiRequest: vi.fn() }));

const row: PressingQueuedScan = {
  companyId: 8, userId: "employee-1",
  requestId: "c72872fc-3403-48dc-b915-bca0b82d0d68",
  barcode: "REF300208",
  payload: {
    barcode: "REF300208", machineId: 1, assignmentId: 2,
    deviceCapturedAt: "2026-10-27T09:26:14.000Z",
    requestId: "c72872fc-3403-48dc-b915-bca0b82d0d68",
  },
  state: "pending", createdAt: "2026-10-27T09:26:14.000Z",
  updatedAt: "2026-10-27T09:26:14.000Z", attempts: 0, nextAttemptAt: 0,
};
const receipt = {
  id: 33, status: "PRESSING_COMPLETED",
  referenceNumber: "REF300208", weightKg: "45.000", machineName: "Press 01",
  confirmedAt: "2026-10-27T09:26:15.000Z", productionDate: "2026-10-27",
  timezoneName: "Africa/Lubumbashi", replayed: false, inventoryFinalized: false,
  machineId: 1, assignmentId: 2, operatorUserId: "employee-1",
  requestId: "c72872fc-3403-48dc-b915-bca0b82d0d68",
};

afterEach(() => vi.clearAllMocks());

describe("Phase 5 pressing scan transport", () => {
  it("preserves original requestId and only returns confirmed with a genuine receipt", async () => {
    vi.mocked(apiRequest).mockResolvedValue({ json: async () => receipt } as Response);
    const outcome = await sendQueuedPressingScan(row);
    expect(outcome.kind).toBe("confirmed");
    if (outcome.kind === "confirmed") expect(outcome.receipt.confirmedAt).toBe(receipt.confirmedAt);
    expect(apiRequest).toHaveBeenCalledWith(
      "POST", "/api/factory/pressing-machines/confirm", row.payload, false, 12000
    );
  });

  it("treats duplicate 409 as terminal rejection, never success", async () => {
    const error = Object.assign(new Error("Already confirmed on Press 02"), {
      code: "PRESSING_ALREADY_CONFIRMED", status: 409,
    });
    vi.mocked(apiRequest).mockRejectedValue(error);
    const outcome = await sendQueuedPressingScan(row);
    expect(isPressingDuplicate(error.code)).toBe(true);
    expect(outcome).toEqual({
      kind: "rejected", code: error.code,
      message: "Already scanned — original user unavailable", previousScan: undefined,
    });
  });

  it("returns the original worker display name from the server on a duplicate", async () => {
    const error = Object.assign(new Error("Already pressed"), {
      code: "PRESSING_ALREADY_CONFIRMED", status: 409,
      previous: { operatorName: "Samir Haddad", operatorUserId: "user-p2", confirmedAt: "2026-10-28T06:39:35.000Z" },
    });
    vi.mocked(apiRequest).mockRejectedValue(error);
    const outcome = await sendQueuedPressingScan(row);
    expect(outcome).toMatchObject({
      kind: "rejected", code: "PRESSING_ALREADY_CONFIRMED",
      message: "Already scanned by Samir Haddad", previousScan: { operatorName: "Samir Haddad" },
    });
  });

  it("treats lost response or network timeout as retry, not confirmed", async () => {
    vi.mocked(apiRequest).mockRejectedValue(new TypeError("Failed to fetch"));
    const outcome = await sendQueuedPressingScan(row);
    expect(outcome.kind).toBe("retry");
    expect(apiRequest).toHaveBeenCalledWith(
      "POST", "/api/factory/pressing-machines/confirm", row.payload, false, 12000
    );
  });

  it("retries 5xx with the same request and leaves unauthorized rows pending for original operator", async () => {
    vi.mocked(apiRequest).mockRejectedValueOnce(
      Object.assign(new Error("Service unavailable"), { status: 503 })
    ).mockRejectedValueOnce(
      Object.assign(new Error("Session expired"), { status: 401 })
    );
    expect((await sendQueuedPressingScan(row)).kind).toBe("retry");
    const second = await sendQueuedPressingScan(row);
    expect(second.kind).toBe("retry");
    if (second.kind === "retry") expect(second.needsAuth).toBe(true);
    expect(vi.mocked(apiRequest).mock.calls[0][2]).toEqual(vi.mocked(apiRequest).mock.calls[1][2]);
  });

  it("does not retry invalid barcode, inactive machine or other terminal rejections", async () => {
    vi.mocked(apiRequest).mockRejectedValue(
      Object.assign(new Error("Machine inactive"), { status: 422, code: "PRESSING_MACHINE_INACTIVE" })
    );
    expect((await sendQueuedPressingScan(row)).kind).toBe("rejected");
  });

  it("does not accept malformed, mismatched or unverified receipts", async () => {
    vi.mocked(apiRequest).mockResolvedValueOnce({
      json: async () => ({ id: 33, status: "PRESSING_COMPLETED" }),
    } as Response).mockResolvedValueOnce({
      json: async () => ({ ...receipt, referenceNumber: "REF300299" }),
    } as Response);
    expect((await sendQueuedPressingScan(row)).kind).toBe("retry");
    expect((await sendQueuedPressingScan(row)).kind).toBe("retry");
  });
});
