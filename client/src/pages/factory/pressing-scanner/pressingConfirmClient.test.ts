import { afterEach, describe, expect, it, vi } from "vitest";
import { submitPressingConfirmation } from "./pressingConfirmClient";
import { apiRequest } from "@/lib/queryClient";

vi.mock("@/lib/queryClient", () => ({ apiRequest: vi.fn() }));

const capture = {
  barcode: "REF300208",
  deviceCapturedAt: "2026-10-27T09:26:14.000Z",
  machineId: 1,
  assignmentId: 2,
};
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("server-confirmed physical pressing feedback", () => {
  it("only shows green confirmation after an accepted backend receipt", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => "c72872fc-3403-48dc-b915-bca0b82d0d68" });
    vi.mocked(apiRequest).mockResolvedValue({
      json: async () => ({
        id: 33, status: "PRESSING_COMPLETED", referenceNumber: "REF300208",
        weightKg: "45.000", machineName: "Press 01",
        confirmedAt: "2026-10-27T09:26:15.000Z", productionDate: "2026-10-27",
        timezoneName: "Africa/Lubumbashi", replayed: false, inventoryFinalized: false,
      }),
    } as Response);
    const outcome = await submitPressingConfirmation(capture);
    expect(outcome.kind).toBe("confirmed");
    expect(outcome.confirmationId).toBe(33);
    expect(outcome.confirmedAt).toBe("2026-10-27T09:26:15.000Z");
    expect(apiRequest).toHaveBeenCalledWith("POST", "/api/factory/pressing-machines/confirm", {
      barcode: "REF300208", deviceCapturedAt: capture.deviceCapturedAt,
      machineId: 1, assignmentId: 2,
      requestId: "c72872fc-3403-48dc-b915-bca0b82d0d68",
    });
  });
  it("does not show success for duplicate scans", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => "c72872fc-3403-48dc-b915-bca0b82d0d68" });
    const error = Object.assign(new Error("Bale already confirmed by Press 02"), {
      code: "PRESSING_ALREADY_CONFIRMED",
    });
    vi.mocked(apiRequest).mockRejectedValue(error);
    const outcome = await submitPressingConfirmation(capture);
    expect(outcome.kind).toBe("duplicate");
    expect(outcome.message).toContain("already confirmed");
  });
  it("does not show success for network failures with unknown server result", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => "c72872fc-3403-48dc-b915-bca0b82d0d68" });
    vi.mocked(apiRequest).mockRejectedValue(new TypeError("Failed to fetch"));
    const outcome = await submitPressingConfirmation(capture);
    expect(outcome.kind).toBe("rejected");
    expect(outcome.message).toContain("not verified");
  });
  it("rejects receipts missing the promised stock-separation marker", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => "c72872fc-3403-48dc-b915-bca0b82d0d68" });
    vi.mocked(apiRequest).mockResolvedValue({
      json: async () => ({ id: 33, status: "PRESSING_COMPLETED" }),
    } as Response);
    expect((await submitPressingConfirmation(capture)).kind).toBe("rejected");
  });
});
