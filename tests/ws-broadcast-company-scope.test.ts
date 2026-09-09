import {
  normalizeBroadcastCompanyIds,
  shouldDeliverBroadcast,
  shouldDeliverBroadcastToCompanies,
} from "../server/lib/broadcastScope";

/**
 * Every write broadcast used to reach every connected client, so a sale in one
 * company made clients in every other company refetch everything on screen.
 */
describe("WebSocket broadcast company scope", () => {
  it("normalizes ERP and Factory company ids and removes invalid/duplicate values", () => {
    expect(normalizeBroadcastCompanyIds([7, "12", 7, 0, -1, 2.5, undefined, "bad"])).toEqual([7, 12]);
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

  it("delivers unscoped messages to everyone", () => {
    // Chat crosses companies, and server-wide notices must not be filtered.
    expect(shouldDeliverBroadcast(7, null)).toBe(true);
    expect(shouldDeliverBroadcast(7, undefined)).toBe(true);
    expect(shouldDeliverBroadcastToCompanies(null, null)).toBe(true);
  });

  it("fails closed for a socket whose company is not resolved yet", () => {
    // Tenant-scoped signals must not cross an unresolved trust boundary. Once
    // the authenticated socket resolves its company, later invalidations are
    // delivered normally.
    expect(shouldDeliverBroadcast(null, 7)).toBe(false);
    expect(shouldDeliverBroadcast(undefined, 7)).toBe(false);
    expect(shouldDeliverBroadcastToCompanies([], 7)).toBe(false);
    expect(shouldDeliverBroadcastToCompanies(null, 7)).toBe(false);
  });
});
