import { describe, expect, it } from "vitest";
import { computeFactoryGuardRedirect, type MyAccess } from "./factoryAccessGuard";

const restricted: MyAccess = {
  fullAccess: false,
  pageKeys: ["factory/stock-entry"],
  hasErpAccess: false,
  hasFactoryAccess: true,
};

describe("Factory Help & Training access", () => {
  it("lets an authenticated restricted user read safe Help content", () => {
    expect(computeFactoryGuardRedirect({
      isFactoryRoute: true, isAdminOwner: false, userRole: "Worker", myAccess: restricted,
      factorySettings: {}, factoryDefaultPage: "/factory/stock-entry",
      currentLocation: "/factory/help-training",
    })).toBeNull();
  });
  it("keeps hidden transactional pages blocked", () => {
    expect(computeFactoryGuardRedirect({
      isFactoryRoute: true, isAdminOwner: false, userRole: "Worker", myAccess: restricted,
      factorySettings: {}, factoryDefaultPage: "/factory/stock-entry",
      currentLocation: "/factory/accounts",
    })).toBe("/factory/stock-entry");
  });
});