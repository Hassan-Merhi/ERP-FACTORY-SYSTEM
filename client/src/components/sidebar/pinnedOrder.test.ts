import { describe, expect, it } from "vitest";
import { reconcilePinnedOrder } from "./pinnedOrder";

const defaults = [
  "/properties/daybook",
  "/properties/agents",
  "/properties/rentals",
  "/properties/accounts",
  "/properties/vouchers",
  "/properties/analytics",
];

describe("reconcilePinnedOrder", () => {
  it("keeps the user's old ordering and appends newly promoted pages", () => {
    expect(reconcilePinnedOrder(["/properties/agents", "/properties/daybook"], defaults)).toEqual([
      "/properties/agents",
      "/properties/daybook",
      "/properties/rentals",
      "/properties/accounts",
      "/properties/vouchers",
      "/properties/analytics",
    ]);
  });

  it("preserves an arbitrary saved arrangement of all six pages", () => {
    const chosen = [
      "/properties/analytics",
      "/properties/vouchers",
      "/properties/rentals",
      "/properties/daybook",
      "/properties/accounts",
      "/properties/agents",
    ];
    expect(reconcilePinnedOrder(chosen, defaults)).toEqual(chosen);
  });

  it("removes retired, duplicate, and invalid entries", () => {
    expect(reconcilePinnedOrder(["/retired", "/properties/agents", 44, "/properties/agents"], defaults)).toEqual([
      "/properties/agents",
      "/properties/daybook",
      "/properties/rentals",
      "/properties/accounts",
      "/properties/vouchers",
      "/properties/analytics",
    ]);
  });

  it("uses default order for malformed stored values", () => {
    expect(reconcilePinnedOrder({ routes: defaults }, defaults)).toEqual(defaults);
    expect(reconcilePinnedOrder(null, defaults)).toEqual(defaults);
  });
});
