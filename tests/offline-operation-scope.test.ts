import { describe, expect, it } from "vitest";
import { matchesOfflineOperationScope } from "../server/middleware/offlineOperationScope";

const id = "8ec41a1f-1bf4-4c73-8dc2-c4246bcad5cc";
const valid = {
  operationId: id,
  idempotencyKey: id,
  bodyRequestId: id,
  headerCompanyId: "6",
  headerUserId: "operator-1",
  sessionCompanyId: 6,
  sessionUserId: "operator-1",
};

describe("offline operation server scope gate", () => {
  it("accepts an identical UUID, session user and company", () => {
    expect(matchesOfflineOperationScope(valid)).toBe(true);
  });

  it("refuses cross-company, cross-user and changed payload submissions", () => {
    expect(matchesOfflineOperationScope({ ...valid, sessionCompanyId: 7 })).toBe(false);
    expect(matchesOfflineOperationScope({ ...valid, sessionUserId: "operator-2" })).toBe(false);
    expect(matchesOfflineOperationScope({ ...valid, bodyRequestId: "some-other-id" })).toBe(false);
    expect(matchesOfflineOperationScope({ ...valid, idempotencyKey: "different" })).toBe(false);
    expect(matchesOfflineOperationScope({ ...valid, operationId: "invalid" })).toBe(false);
    expect(matchesOfflineOperationScope({ ...valid, headerUserId: undefined })).toBe(false);
  });
});
