import { describe, expect, it } from "vitest";
import {
  canNavigateProperties,
  findPropertiesNavigationEntry,
  getPropertiesParentRoute,
} from "../client/src/properties/config/propertiesNavigation";
import { gitContainerDetailPath } from "../client/src/pages/git-containers/gitTrackingPatchUrl";

const owner = { companyType: "properties" as const, role: "Owner" };
const viewer = { companyType: "properties" as const, role: "View Only" };
const erp = { companyType: "erp" as const, role: "Owner" };

describe("Properties intercompany trading Phase 1 navigation", () => {
  it.each(["/properties/suppliers", "/properties/containers", "/properties/tracking"])(
    "restores the %s workspace route without granting ERP-company access",
    (route) => {
      expect(findPropertiesNavigationEntry(route)?.capability).toBe("workspace");
      expect(canNavigateProperties(route, owner, owner)).toBe(true);
      expect(canNavigateProperties(route, viewer, viewer)).toBe(true);
      expect(canNavigateProperties(route, erp, erp)).toBe(false);
    }
  );

  it.each([
    ["/properties/suppliers/17/edit", "/properties/suppliers"],
    ["/properties/suppliers/17/proformas", "/properties/suppliers"],
    ["/properties/containers/25", "/properties/containers"],
    ["/properties/containers/25/verification", "/properties/containers"],
    ["/properties/purchase-orders/26/edit", "/properties/containers"],
    ["/properties/offloads/27", "/properties/containers"],
    ["/properties/master-data?entity=supplier", "/properties/suppliers"],
  ])("keeps deep-link %s inside the Properties navigation hierarchy", (route, parent) => {
    expect(getPropertiesParentRoute(route)).toBe(parent);
  });

  it("preserves ERP routes while adding Properties tracking detail links", () => {
    expect(gitContainerDetailPath(123)).toBe("/containers/123");
    expect(gitContainerDetailPath(123, true)).toBe("/properties/containers/123");
    expect(gitContainerDetailPath(-42, true)).toBe("/properties/containers/42");
    expect(() => gitContainerDetailPath(0, true)).toThrow("Invalid tracking container id");
  });

  it("does not expose intercompany trading action routes to View Only", () => {
    expect(canNavigateProperties("/properties/intercompany-payments", viewer, viewer)).toBe(false);
    expect(canNavigateProperties("/properties/container-trading", viewer, viewer)).toBe(false);
    expect(canNavigateProperties("/properties/container-trading", owner, owner)).toBe(true);
  });
});
