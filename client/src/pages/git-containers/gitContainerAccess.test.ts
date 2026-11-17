import { describe, expect, it } from "vitest";
import { canEditTrackedContainer, type EnrichedContainerRow } from "./gitContainerTypes";

const shared = {
  companyId: 101,
  linkedDestinationCompanyIds: [202, 303],
} as EnrichedContainerRow;
const independent = {
  companyId: 101,
  linkedDestinationCompanyIds: [],
} as unknown as EnrichedContainerRow;

describe("intercompany Tracking edit permissions", () => {
  it("lets the parent edit the shared physical container", () => {
    expect(canEditTrackedContainer(shared, 101)).toBe(true);
  });

  it("lets each active linked destination edit that same container", () => {
    expect(canEditTrackedContainer(shared, 202)).toBe(true);
    expect(canEditTrackedContainer(shared, 303)).toBe(true);
  });

  it("does not let unrelated companies edit another company's tracking", () => {
    expect(canEditTrackedContainer(shared, 404)).toBe(false);
    expect(canEditTrackedContainer(independent, 202)).toBe(false);
  });

  it("preserves view-only protection for both parent and destination", () => {
    expect(canEditTrackedContainer(shared, 101, true)).toBe(false);
    expect(canEditTrackedContainer(shared, 202, true)).toBe(false);
  });

  it("supports the privileged all-companies view but not a missing selection", () => {
    expect(canEditTrackedContainer(shared, null)).toBe(true);
    expect(canEditTrackedContainer(null, 202)).toBe(false);
  });
});
