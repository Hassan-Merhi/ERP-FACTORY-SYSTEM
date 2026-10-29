import { describe, expect, it } from "vitest";
import {
  classifyOfflineResponse,
  isAutoReplayAllowed,
  offlineRetryDelay,
  validateOfflinePayload,
} from "@/lib/offline/operationContract";

describe("offline phase 1 operation contract", () => {
  it("only permits the verified transactional voucher endpoint for automatic replay", () => {
    expect(isAutoReplayAllowed("POST", "/api/vouchers/with-entries")).toBe(true);
    expect(isAutoReplayAllowed("POST", "/api/vouchers")).toBe(false);
    expect(isAutoReplayAllowed("POST", "/api/pos/sales")).toBe(false);
    expect(isAutoReplayAllowed("POST", "/api/factory/customer-orders/1/bales")).toBe(false);
    expect(isAutoReplayAllowed("DELETE", "/api/vouchers/1")).toBe(false);
    expect(isAutoReplayAllowed("POST", "//evil.example/api/vouchers/with-entries")).toBe(false);
    expect(isAutoReplayAllowed("POST", "/api/vouchers/with-entries?companyId=2")).toBe(false);
  });

  it("does not persist credentials as queued JSON", () => {
    expect(validateOfflinePayload({ entries: [{ amount: 10 }] })).toBe(true);
    expect(validateOfflinePayload({ nested: [{ password: "secret" }] })).toBe(false);
    expect(validateOfflinePayload({ authorization: "Bearer token" })).toBe(false);
    expect(validateOfflinePayload({ nested: [{ cardNumber: "4111" }] })).toBe(false);
    expect(validateOfflinePayload({ value: new Uint8Array([1]) })).toBe(false);
  });

  it("preserves retryable failures indefinitely with bounded delay", () => {
    expect(classifyOfflineResponse(200)).toBe("acknowledged");
    expect(classifyOfflineResponse(401)).toBe("paused");
    expect(classifyOfflineResponse(403)).toBe("rejected");
    expect(classifyOfflineResponse(409)).toBe("conflict");
    expect(classifyOfflineResponse(408)).toBe("retry");
    expect(classifyOfflineResponse(429)).toBe("retry");
    expect(classifyOfflineResponse(503)).toBe("retry");
    expect(classifyOfflineResponse(422)).toBe("rejected");
    expect(offlineRetryDelay(1)).toBe(3000);
    expect(offlineRetryDelay(2)).toBe(6000);
    expect(offlineRetryDelay(200)).toBe(300000);
  });
});
