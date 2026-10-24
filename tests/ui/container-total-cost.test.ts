import { describe, expect, it } from "vitest";
import { getContainerOffloadingCost, getContainerTotalCost } from "../../client/src/pages/containers/containerTotalCost";
import type { ContainerWithOffloadingCost } from "../../client/src/pages/containers/containerTotalCost";

const container = (data: Record<string, unknown>): ContainerWithOffloadingCost =>
  ({
    status: "OFFLOADED",
    grandTotal: "100.25",
    itemsTotal: "90",
    ...data,
  }) as ContainerWithOffloadingCost;

describe("container tracking landed cost", () => {
  it("adds the offloading charges once to the full PO grand total", () => {
    expect(getContainerTotalCost(container({ offloadingCost: "16.55" }))).toBe(116.8);
  });

  it("does not add offloading charges before the container is offloaded", () => {
    const otw = container({ status: "OTW", offloadingCost: "16.55" });
    expect(getContainerOffloadingCost(otw)).toBe(0);
    expect(getContainerTotalCost(otw)).toBe(100.25);
  });

  it("preserves old zero/empty PO total fallback and handles absent offload costs", () => {
    expect(getContainerTotalCost(container({ grandTotal: "0", itemsTotal: "90", offloadingCost: null }))).toBe(90);
    expect(getContainerTotalCost(container({ offloadingCost: undefined }))).toBe(100.25);
  });

  it("rounds to cents", () => {
    expect(getContainerTotalCost(container({ grandTotal: "1.10", offloadingCost: "2.20" }))).toBe(3.3);
  });
});
