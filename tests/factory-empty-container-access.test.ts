import { describe, expect, it } from "vitest";
import {
  FACTORY_EMPTY_CONTAINER_GRANT_KEY,
  canEmptyFactoryLoadingContainer,
  normalizeFactoryHiddenFields,
} from "@shared/factoryPermissionCatalog";

const granted = {
  role: "Manager",
  hasFactoryAccess: true,
  pageKeys: ["factory/invoicing"],
  hiddenCostFields: [FACTORY_EMPTY_CONTAINER_GRANT_KEY],
};

describe("Factory Empty Container action permission", () => {
  it("defaults to denied for non-privileged users", () => {
    expect(canEmptyFactoryLoadingContainer({ ...granted, hiddenCostFields: [] })).toBe(false);
  });

  it("allows an explicitly granted Manager without giving other permissions", () => {
    expect(canEmptyFactoryLoadingContainer(granted)).toBe(true);
    expect(normalizeFactoryHiddenFields(granted.hiddenCostFields)).toContain(FACTORY_EMPTY_CONTAINER_GRANT_KEY);
  });

  it("refuses when Factory access is disabled", () => {
    expect(canEmptyFactoryLoadingContainer({ ...granted, hasFactoryAccess: false })).toBe(false);
  });

  it("refuses when the user cannot access the Container Loading page", () => {
    expect(canEmptyFactoryLoadingContainer({ ...granted, pageKeys: ["factory/stock-entry"] })).toBe(false);
  });

  it("refuses for View Only even if a grant is accidentally persisted", () => {
    expect(canEmptyFactoryLoadingContainer({ ...granted, role: "View Only" })).toBe(false);
  });

  it.each(["Admin", "Owner", "Developer"])("preserves %s access", (role) => {
    expect(canEmptyFactoryLoadingContainer({ role })).toBe(true);
  });
});
