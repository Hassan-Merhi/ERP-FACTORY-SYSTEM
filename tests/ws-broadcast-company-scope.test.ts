import {
  normalizeBroadcastCompanyIds,
  normalizeBroadcastUserId,
  shouldDeliverBroadcast,
  shouldDeliverBroadcastToCompanies,
  shouldDeliverBroadcastToUser,
} from "../server/lib/broadcastScope";

/**
 * Every write broadcast used to reach every connected client, so a sale in one
 * company made clients in every other company refetch everything on screen.
 */
describe("WebSocket broadcast scope", () => {
  it("normalizes ERP and Factory company ids and removes invalid/duplicate values", () => {
    expect(normalizeBroadcastCompanyIds([7, "12", 7, 0, -1, 2.5, undefined, "bad"])).toEqual([7, 12]);
  });

  it("normalizes authenticated user ids", () => {
    expect(normalizeBroadcastUserId(" user-7 ")).toBe("user-7");
    expect(normalizeBroadcastUserId(7)).toBeNull();
    expect(normalizeBroadcastUserId("   ")).toBeNull();
    expect(normalizeBroadcastUserId(undefined)).toBeNull();
  });

  it("delivers a company's writes to that company", () => {
    expect(shouldDeliverBroadcast(7, 7)).toBe(true);
  });

  it("does not deliver a company's writes to another company", () => {
    expect(shouldDeliverBroadcast(7, 9)).toBe(false);
  });

  it("delivers to either authenticated ERP or Factory company context", () => {
    expect(shouldDeliverBroadcastToCompanies([7, 12], 7)).toBe(true);
    expect(shouldDeliverBroadcastToCompanies([7, 12], 12)).toBe(true);
    expect(shouldDeliverBroadcastToCompanies([7, 12], 9)).toBe(false);
  });

  it("delivers unscoped company messages to everyone", () => {
    expect(shouldDeliverBroadcast(7, null)).toBe(true);
    expect(shouldDeliverBroadcast(7, undefined)).toBe(true);
    expect(shouldDeliverBroadcastToCompanies(null, null)).toBe(true);
  });

  it("fails closed for a socket whose company is not resolved yet", () => {
    expect(shouldDeliverBroadcast(null, 7)).toBe(false);
    expect(shouldDeliverBroadcast(undefined, 7)).toBe(false);
    expect(shouldDeliverBroadcastToCompanies([], 7)).toBe(false);
    expect(shouldDeliverBroadcastToCompanies(null, 7)).toBe(false);
  });

  it("delivers user-targeted broadcasts only to named authenticated users", () => {
    expect(shouldDeliverBroadcastToUser("user-a", ["user-a", "user-b"])).toBe(true);
    expect(shouldDeliverBroadcastToUser("user-c", ["user-a", "user-b"])).toBe(false);
    expect(shouldDeliverBroadcastToUser(null, ["user-a"])).toBe(false);
    expect(shouldDeliverBroadcastToUser("user-a", [])).toBe(false);
  });

  it("does not apply a user filter when no recipients were requested", () => {
    expect(shouldDeliverBroadcastToUser("user-a", undefined)).toBe(true);
    expect(shouldDeliverBroadcastToUser(null, null)).toBe(true);
  });
});
